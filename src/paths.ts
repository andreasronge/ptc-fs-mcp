/**
 * The relative-path contract, shared by every tool and by the root walker.
 *
 * Paths are rejected rather than resolved. Nothing here touches the
 * filesystem: a string either satisfies the contract or it does not, and that
 * decision is made before any `stat` or `open`.
 */

const MAX_PATH_LENGTH = 1_024

/**
 * Returns the canonical relative POSIX form of `value`, or `null` when the
 * string is not a relative path inside a confined root.
 *
 * Absolute paths, `.`/`..` segments, NUL bytes, backslashes, and Windows drive
 * prefixes are all rejected. The empty string normalizes to the root itself.
 */
export function normalizeRelative(value: string): string | null {
  if (value === '') return ''
  if (value.includes('\0') || value.startsWith('/') || value.includes('\\')) return null
  if (value.length > MAX_PATH_LENGTH || /^[a-zA-Z]:/.test(value)) return null

  const segments = value.split('/').filter((segment) => segment !== '')
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  return segments.join('/')
}

/** Joins a relative POSIX prefix and a single entry name. */
export function posixJoin(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}/${name}`
}

/**
 * Compiles one glob into an anchored regular expression.
 *
 * `*` matches within a segment, `**` crosses segments, and a trailing slash
 * after `**` additionally matches zero directories, so `lib/**` selects
 * `lib/a.ts` as well as `lib/deep/a.ts`. Every other character is literal.
 */
export function compileGlob(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:[^/]+/)*'
        } else source += '.*'
      } else source += '[^/]*'
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

/** Decides which relative paths a root serves. The default is no files. */
export interface Selector {
  /** True when the path is inside at least one include and no exclude. */
  readonly selects: (path: string) => boolean
  /** True when the path is excluded, so a directory walk may skip it whole. */
  readonly excludes: (path: string) => boolean
}

export function createSelector(include: readonly string[], exclude: readonly string[]): Selector {
  const included = include.map(compileGlob)
  const excluded = exclude.map(compileGlob)
  const matches = (patterns: readonly RegExp[], path: string): boolean =>
    patterns.some((pattern) => pattern.test(path))

  return {
    selects: (path) => matches(included, path) && !matches(excluded, path),
    excludes: (path) => matches(excluded, path),
  }
}
