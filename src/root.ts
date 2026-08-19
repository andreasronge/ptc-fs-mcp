/**
 * Live, confined access to one filesystem root.
 *
 * Every call re-reads the filesystem, so a write is visible to the next read.
 * Confinement is enforced here and nowhere else: paths are normalized before
 * any syscall, symbolic links are skipped rather than followed, and the final
 * `open` uses `O_NOFOLLOW` so a link swapped in after the check still fails.
 */

import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, opendirSync, openSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { ConfigError, ToolError } from './errors.js'
import { createSelector, normalizeRelative, posixJoin, type Selector } from './paths.js'

/** Bounds on what a single traversal may visit. Exceeding one fails the call. */
export interface Limits {
  readonly maxFiles: number
  readonly maxDepth: number
  readonly maxDirectories: number
  readonly maxEntries: number
  /** Files larger than this are not served at all, in listings or in reads. */
  readonly maxFileBytes: number
  /** The largest `write_text_file` payload, in UTF-8 bytes. */
  readonly maxWriteBytes: number
}

export const DEFAULT_LIMITS: Limits = {
  maxFiles: 4_096,
  maxDepth: 32,
  maxDirectories: 8_192,
  maxEntries: 100_000,
  maxFileBytes: Number.MAX_SAFE_INTEGER,
  maxWriteBytes: 65_536,
}

export interface RootOptions {
  /** Host path to confine to. Resolved once; never re-resolved from input. */
  readonly root: string
  /** At least one glob is required. The default is no files. */
  readonly include: readonly string[]
  /** Globs that may only narrow what the includes selected. */
  readonly exclude?: readonly string[]
  readonly limits?: Partial<Limits>
}

export interface Root {
  /** The resolved host path. Never disclosed in a result or an error. */
  readonly absolute: string
  readonly selector: Selector
  readonly limits: Limits
}

/** One selected regular file, as observed by the most recent walk. */
export interface FileFact {
  readonly path: string
  readonly bytes: number
  /**
   * An inode observation that changes whenever the file's bytes could have.
   * Size and mtime catch ordinary edits; ctime and the inode number catch an
   * in-place rewrite that preserves both, and a replacement via rename.
   */
  readonly identity: string
}

/** An open read descriptor. The caller owns closing it. */
export interface OpenFile {
  readonly descriptor: number
  readonly bytes: number
  readonly identity: string
}

const WRITE_BASENAME = /^[a-z0-9][a-z0-9._-]{0,254}$/
const NO_FOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

/**
 * Validates the configuration and pins the root. Startup failures are
 * configuration errors; nothing here is reachable from a tool call.
 */
export function openRoot(options: RootOptions): Root {
  if (options.include.length === 0) throw new ConfigError('at least one --include pattern is required')

  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  validateLimits(limits)

  const absolute = resolve(options.root)
  const stat = lstatSync(absolute, { throwIfNoEntry: false })
  if (!stat) throw new ConfigError('root does not exist')
  if (stat.isSymbolicLink()) throw new ConfigError('root must not be a symbolic link')
  if (!stat.isDirectory()) throw new ConfigError('root is not a directory')

  return { absolute, selector: createSelector(options.include, options.exclude ?? []), limits }
}

/**
 * Walks the live root and returns every selected regular file under `scope`,
 * sorted by path.
 *
 * The sort is what makes an index-based cursor position meaningful: a cursor
 * also carries a digest of this result, so a resumed page indexes into the
 * same list or is rejected.
 */
export function inventory(root: Root, scope = ''): FileFact[] {
  const files: FileFact[] = []
  const counters = { directories: 0, entries: 0 }
  walk(root, root.absolute, '', 0, scope, counters, files)
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

function walk(
  root: Root,
  directory: string,
  prefix: string,
  depth: number,
  scope: string,
  counters: { directories: number; entries: number },
  files: FileFact[],
): void {
  if (depth > root.limits.maxDepth) throw new ToolError('directory depth limit exceeded')
  counters.directories += 1
  if (counters.directories > root.limits.maxDirectories) throw new ToolError('directory limit exceeded')

  let entries
  try {
    entries = opendirSync(directory)
  } catch {
    // A directory that vanished between the parent listing and this open is
    // an ordinary consequence of reading live bytes, not a failure.
    return
  }

  try {
    for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
      counters.entries += 1
      if (counters.entries > root.limits.maxEntries) throw new ToolError('directory entry limit exceeded')

      const path = posixJoin(prefix, entry.name)
      if (normalizeRelative(path) !== path) continue
      if (root.selector.excludes(path)) continue

      const absolute = join(directory, entry.name)
      const stat = lstatSync(absolute, { throwIfNoEntry: false, bigint: true })
      if (!stat || stat.isSymbolicLink()) continue

      if (stat.isDirectory()) {
        if (withinScope(path, scope) || scope.startsWith(`${path}/`) || scope === path) {
          walk(root, absolute, path, depth + 1, scope, counters, files)
        }
        continue
      }

      if (!stat.isFile() || !withinScope(path, scope) || !root.selector.selects(path)) continue
      const bytes = Number(stat.size)
      if (bytes > root.limits.maxFileBytes) continue
      if (files.length >= root.limits.maxFiles) throw new ToolError('file limit exceeded')
      files.push({ path, bytes, identity: identityOf(stat) })
    }
  } finally {
    entries.closeSync()
  }
}

function withinScope(path: string, scope: string): boolean {
  return scope === '' || path === scope || path.startsWith(`${scope}/`)
}

function identityOf(stat: { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint; dev: bigint }): string {
  return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}`
}

/**
 * Opens one selected regular file for reading, refusing a symbolic link at
 * the final component even if it appeared after the walk observed the path.
 */
export function openFileForRead(root: Root, path: string): OpenFile {
  if (!root.selector.selects(path)) throw new ToolError('path is not served by this root')

  let descriptor: number
  try {
    descriptor = openSync(join(root.absolute, path), constants.O_RDONLY | NO_FOLLOW)
  } catch {
    throw new ToolError('path is not a readable regular file')
  }

  try {
    const stat = fstatSync(descriptor, { bigint: true })
    if (!stat.isFile()) throw new ToolError('path is not a readable regular file')
    const bytes = Number(stat.size)
    if (bytes > root.limits.maxFileBytes) throw new ToolError('file exceeds the configured size limit')
    return { descriptor, bytes, identity: identityOf(stat) }
  } catch (error) {
    closeSync(descriptor)
    throw error instanceof ToolError ? error : new ToolError('path is not a readable regular file')
  }
}

/**
 * Replaces one regular file in the root and returns the bytes written.
 *
 * The destination is confirmed to be a regular file through the descriptor
 * that will be written, not through a separate `stat` that a symlink could
 * outrace. Only then is the file truncated.
 */
export function writeTextFile(root: Root, basename: string, content: Buffer): number {
  if (!WRITE_BASENAME.test(basename)) {
    throw new ToolError('path must be one lowercase basename of letters, digits, dots, underscores, or hyphens')
  }
  if (content.byteLength > root.limits.maxWriteBytes) {
    throw new ToolError(`content exceeds the ${root.limits.maxWriteBytes}-byte write limit`)
  }
  if (!root.selector.selects(basename)) {
    throw new ToolError('path is not served by this root')
  }

  let descriptor: number
  try {
    descriptor = openSync(join(root.absolute, basename), constants.O_WRONLY | constants.O_CREAT | NO_FOLLOW, 0o600)
  } catch {
    throw new ToolError('destination is not a writable regular file')
  }

  try {
    if (!fstatSync(descriptor).isFile()) throw new ToolError('destination is not a writable regular file')
    ftruncateSync(descriptor, 0)
    for (let offset = 0; offset < content.byteLength; ) {
      offset += writeSync(descriptor, content, offset, content.byteLength - offset)
    }
    return content.byteLength
  } catch (error) {
    throw error instanceof ToolError ? error : new ToolError('write failed')
  } finally {
    closeSync(descriptor)
  }
}

function validateLimits(limits: Limits): void {
  const positive = [
    limits.maxFiles,
    limits.maxDirectories,
    limits.maxEntries,
    limits.maxFileBytes,
    limits.maxWriteBytes,
  ]
  if (
    positive.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 0
  ) {
    throw new ConfigError('limits are not valid')
  }
}
