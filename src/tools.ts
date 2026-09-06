/**
 * The five tools, served from live bytes.
 *
 * Every call re-reads the filesystem, so `write_text_file` is visible to the
 * next `read_text_file`. Two consequences are handled explicitly here:
 *
 * - A paginated traversal can straddle a change. Each tool digests the state
 *   its result depends on and binds that digest into the cursor it issues, so
 *   a resumed page either indexes into the same data or fails. Only the state
 *   the result actually depends on is bound: editing a file's bytes does not
 *   invalidate a path listing, because a path listing cannot tear on it.
 * - There is no whole-tree hash to cite. Instead every result carries
 *   `content_hash`, the digest of the bytes that call returned, so a citation
 *   names what was read rather than a tree that existed at some other time.
 */

import { createHash } from 'node:crypto'
import { closeSync, readSync } from 'node:fs'
import { types } from 'node:util'
import { fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server'

import { createCursorCodec, PROCESS_CURSOR_CODEC, scopeOf, stateOf, type CursorCodec } from './cursor.js'
import { ConfigError, ToolError } from './errors.js'
import { normalizeRelative } from './paths.js'
import {
  assertOpenFileIdentity,
  directoryListing,
  inventory,
  openFileForRead,
  writeTextFile,
  type FileFact,
  type OpenFile,
  type Root,
} from './root.js'

const MAX_PAGE = 200
const READ_CHUNK_BYTES = 2_048
const SEARCH_BUFFER_BYTES = 8_192
const BINARY_SNIFF_BYTES = 8_192
const MAX_QUERY_BYTES = 256
const MAX_TERMS = 16
const MAX_EVIDENCE_BYTES = 1_024
const SIZING_HASH = `sha256:${'0'.repeat(64)}`

/** Where a text scan is paused: a file index and a byte offset inside it. */
interface SearchPosition {
  file: number
  offset: number
  lineStart: number
  line: number
  matched: boolean
}

/**
 * One item that may or may not survive the result-size fit.
 *
 * `bytes` is what this item contributes to `content_hash`, and `position` is
 * the cursor to issue if this item is the last one kept.
 */
interface Candidate<T> {
  readonly item: T
  readonly position: unknown
  readonly bytes: Buffer
}

interface ResultBudget {
  readonly maxBytes: number
  readonly identity: ServerIdentity
}

export interface ServerIdentity {
  readonly name: string
  readonly version: string
}

export interface ServerOptions {
  /** Stable HMAC key enabling replay-safe deterministic cursors. Minimum 32 bytes. */
  readonly cursorKey?: Uint8Array
  /** Maximum file bytes hashed to establish semantic cursor state in one call. */
  readonly maxCursorHashBytes?: number
}

const DEFAULT_MAX_CURSOR_HASH_BYTES = 16_777_216

/**
 * Builds the MCP server for one live root. Exported so a host can embed the
 * server in its own process instead of spawning the stdio binary.
 */
export function createServer(root: Root, identity: ServerIdentity, options: ServerOptions = {}): McpServer {
  let cursorKey: Buffer | undefined
  if (options.cursorKey !== undefined) {
    if (!types.isUint8Array(options.cursorKey)) throw new ConfigError('cursor key must be a byte array')
    cursorKey = Buffer.from(options.cursorKey)
    if (cursorKey.byteLength < 32) throw new ConfigError('cursor key must contain at least 32 bytes')
  }
  const maxCursorHashBytes = options.maxCursorHashBytes ?? DEFAULT_MAX_CURSOR_HASH_BYTES
  if (!Number.isSafeInteger(maxCursorHashBytes) || maxCursorHashBytes < 1) {
    throw new ConfigError('maxCursorHashBytes must be a positive integer')
  }
  const deterministic = cursorKey !== undefined
  const cursors = cursorKey === undefined ? PROCESS_CURSOR_CODEC : createCursorCodec(cursorKey)
  const digestCache = new Map<string, { bytes: number; digest: string }>()
  const serverIdentity: ServerIdentity = { name: identity.name, version: identity.version }
  const server = new McpServer(serverIdentity, {
    instructions:
      'Read and write files under one confined root. Paths are relative to that root. Reads reflect the ' +
      'filesystem at call time, so a write is visible to the next read. Follow next_cursor until it is null; a ' +
      'cursor is rejected if the data it was issued against changed.',
  })

  const meta = { 'io.modelcontextprotocol/cacheScope': 'private' as const }
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const resultBudget: ResultBudget = { maxBytes: root.limits.maxResultBytes, identity: serverIdentity }

  server.registerTool(
    'list_directory',
    {
      title: 'List directory',
      description: 'Sorted entries directly under a relative prefix. Follow next_cursor until null.',
      annotations: readOnly,
      _meta: meta,
      outputSchema: fromJsonSchema<Record<string, unknown>>(
        pagedOutput({ name: { type: 'string' }, kind: { type: 'string' }, path: { type: 'string' } }),
      ),
      inputSchema: fromJsonSchema<Record<string, unknown>>({
        type: 'object',
        properties: { path: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
        additionalProperties: false,
      }),
    },
    async (args: Record<string, unknown>) => {
      const prefix = args.path === undefined ? '' : requirePath(args.path, 'path')
      const items = directoryListing(root, prefix)
      const scope = scopeOf('list_directory', { path: prefix })
      const state = stateOf(items.map((entry) => `${entry.kind}\0${entry.path}`))
      const offset = cursors.decode(scope, state, args.cursor, isOffset, 0)
      const candidates = items.map((item, index) => ({
        item,
        position: index + 1,
        bytes: Buffer.from(`${item.kind}\0${item.path}\n`, 'utf8'),
      }))
      return structured(arrayPage(cursors, scope, state, candidates, offset, boundedPage(args.limit), resultBudget))
    },
  )

  server.registerTool(
    'search_files',
    {
      title: 'Search files',
      description:
        'Sorted paths containing a literal substring. Pass any_of instead of query to match any of several ' +
        'substrings, and case_insensitive to fold ASCII letters. Follow next_cursor until null.',
      annotations: readOnly,
      _meta: meta,
      outputSchema: fromJsonSchema<Record<string, unknown>>(pagedOutput({ path: { type: 'string' } })),
      inputSchema: fromJsonSchema<Record<string, unknown>>({
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          any_of: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
            maxItems: MAX_TERMS,
          },
          case_insensitive: { type: 'boolean' },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      }),
    },
    async (args: Record<string, unknown>) => {
      const terms = requireTerms(args)
      const needles = terms.values.map((term) => (terms.caseInsensitive ? foldString(term) : term))
      const paths = inventory(root)
        .map((file) => file.path)
        .filter((path) => {
          const candidate = terms.caseInsensitive ? foldString(path) : path
          return needles.some((needle) => candidate.includes(needle))
        })
      const scope = scopeOf('search_files', { terms: terms.values, caseInsensitive: terms.caseInsensitive })
      const state = stateOf(paths)
      const offset = cursors.decode(scope, state, args.cursor, isOffset, 0)
      const candidates = paths.map((path, index) => ({
        item: { path },
        position: index + 1,
        bytes: Buffer.from(`${path}\n`, 'utf8'),
      }))
      return structured(arrayPage(cursors, scope, state, candidates, offset, boundedPage(args.limit), resultBudget))
    },
  )

  server.registerTool(
    'search_text',
    {
      title: 'Search text',
      description:
        'Streaming literal line search. Pass any_of instead of query to match any of several substrings, and ' +
        'case_insensitive to fold ASCII letters. Empty progress pages may carry next_cursor; follow it until null.',
      annotations: readOnly,
      _meta: meta,
      outputSchema: fromJsonSchema<Record<string, unknown>>(
        pagedOutput({ path: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } }),
      ),
      inputSchema: fromJsonSchema<Record<string, unknown>>({
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          any_of: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
            maxItems: MAX_TERMS,
          },
          case_insensitive: { type: 'boolean' },
          path: { type: 'string' },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      }),
    },
    async (args: Record<string, unknown>) => {
      const terms = requireTerms(args)
      const prefix = args.path === undefined ? '' : requirePath(args.path, 'path')
      const files = inventory(root, prefix)
      const scope = scopeOf('search_text', {
        path: prefix,
        terms: terms.values,
        caseInsensitive: terms.caseInsensitive,
      })
      // Content is what a text search tears on. Default mode binds physical
      // observations; deterministic mode binds semantic content identities.
      const stateFiles = deterministic
        ? semanticFiles(root, files, maxCursorHashBytes, digestCache, root.limits.maxFiles)
        : files.map((file) => ({ file, identity: file.identity }))
      const state = stateOf(stateFiles.map(({ file, identity }) => `${file.path}\0${identity}`))
      const first: SearchPosition = { file: 0, offset: 0, lineStart: 0, line: 1, matched: false }
      const start = cursors.decode(
        scope,
        state,
        args.cursor,
        (value): value is SearchPosition => isSearchPosition(value, files.length),
        first,
      )
      const scan = scanText(root, files, terms, start, boundedPage(args.limit), deterministic)
      return structured(pageValue(cursors, scope, state, start, scan.candidates, scan.next, resultBudget))
    },
  )

  server.registerTool(
    'read_text_file',
    {
      title: 'Read text file',
      description:
        'Bounded exact UTF-8 chunks of live bytes. Concatenate item text and follow next_cursor. Pass start_line ' +
        'to begin at a 1-based line instead of the start of the file.',
      annotations: readOnly,
      _meta: meta,
      outputSchema: fromJsonSchema<Record<string, unknown>>(
        pagedOutput({ byte_offset: { type: 'integer' }, text: { type: 'string' } }),
      ),
      inputSchema: fromJsonSchema<Record<string, unknown>>({
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1 },
          start_line: { type: 'integer', minimum: 1 },
          cursor: { type: 'string' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: Math.ceil(root.limits.maxReadBytes / READ_CHUNK_BYTES),
          },
        },
        required: ['path'],
        additionalProperties: false,
      }),
    },
    async (args: Record<string, unknown>) => {
      const path = requirePath(args.path, 'path')
      if (path === '') throw new ToolError('path must name a file')
      const startLine = requireLine(args.start_line)
      const file = openFileForRead(root, path)
      try {
        // `undefined` drops out of the digested arguments, so a call without
        // start_line keeps the scope every earlier cursor was issued against.
        const scope = scopeOf('read_text_file', {
          path,
          ...(startLine === undefined ? {} : { start_line: startLine }),
        })
        const semanticIdentity = deterministic
          ? `${file.bytes}:${contentDigest(file, { remaining: maxCursorHashBytes }, digestCache, root.limits.maxFiles)}`
          : file.identity
        const state = stateOf([semanticIdentity])
        // Locating a line means counting newlines from the start, so it is done
        // only for the page that has no cursor to resume from. Every later page
        // reads its byte offset straight out of the cursor.
        const first =
          args.cursor !== undefined || startLine === undefined
            ? 0
            : byteOfLine(file.descriptor, file.bytes, startLine, root.limits.maxScanBytes)
        const offset = cursors.decode(scope, state, args.cursor, isOffset, first)
        const maxChunks = Math.ceil(root.limits.maxReadBytes / READ_CHUNK_BYTES)
        const limit = boundedPage(args.limit, maxChunks)
        const page = readPage(
          cursors,
          file.descriptor,
          file.bytes,
          scope,
          state,
          offset,
          limit,
          root.limits.maxReadBytes,
          resultBudget,
        )
        assertOpenFileIdentity(file)
        return structured(page)
      } finally {
        closeSync(file.descriptor)
      }
    },
  )

  server.registerTool(
    'write_text_file',
    {
      title: 'Write text file',
      description:
        'Replaces one regular file named by a single lowercase basename in the root. The next read sees it.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: meta,
      outputSchema: fromJsonSchema<Record<string, unknown>>({
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer', minimum: 0 },
          content_hash: { type: 'string' },
        },
        required: ['path', 'bytes', 'content_hash'],
        additionalProperties: false,
      }),
      inputSchema: fromJsonSchema<Record<string, unknown>>({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            description: 'A basename of lowercase letters, digits, dots, underscores, or hyphens.',
          },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      }),
    },
    async (args: Record<string, unknown>) => {
      if (typeof args.path !== 'string') throw new ToolError('path must be a string')
      if (typeof args.content !== 'string') throw new ToolError('content must be a string')
      const content = Buffer.from(args.content, 'utf8')
      const bytes = writeTextFile(root, args.path, content)
      return structured({ path: args.path, bytes, content_hash: digest([content]) })
    },
  )

  return server
}

interface HashBudget {
  remaining: number
}

function semanticFiles(
  root: Root,
  files: readonly FileFact[],
  maximum: number,
  cache: Map<string, { bytes: number; digest: string }>,
  maxCacheEntries: number,
): Array<{ file: FileFact; identity: string }> {
  const budget = { remaining: maximum }
  return files.map((file) => {
    const open = openFileForRead(root, file.path)
    try {
      if (open.identity !== file.identity) throw new ToolError('filesystem changed while reading')
      return { file, identity: `${open.bytes}:${contentDigest(open, budget, cache, maxCacheEntries)}` }
    } finally {
      closeSync(open.descriptor)
    }
  })
}

function contentDigest(
  file: OpenFile,
  budget: HashBudget,
  cache: Map<string, { bytes: number; digest: string }>,
  maxCacheEntries: number,
): string {
  const cached = cache.get(file.identity)
  if (cached?.bytes === file.bytes) return cached.digest
  if (file.bytes > budget.remaining) {
    throw new ToolError('deterministic cursor hashing exceeds the configured byte ceiling')
  }

  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(65_536, Math.max(file.bytes, 1)))
  let offset = 0
  while (offset < file.bytes) {
    const wanted = Math.min(buffer.length, file.bytes - offset)
    const count = readSync(file.descriptor, buffer, 0, wanted, offset)
    if (count <= 0) throw new ToolError('read failed')
    hash.update(buffer.subarray(0, count))
    offset += count
  }
  assertOpenFileIdentity(file)
  budget.remaining -= file.bytes
  const digest = hash.digest('hex')
  if (cache.size >= maxCacheEntries) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(file.identity, { bytes: file.bytes, digest })
  return digest
}

/**
 * Derives one directory level from the selected files beneath it.
 *
 * Deriving rather than reading the directory keeps `--include` the whole
 * access model: a directory appears only because it holds something served,
 * so an unserved directory's name never leaks through a listing.
 */
function readPage(
  cursors: CursorCodec,
  descriptor: number,
  size: number,
  scope: string,
  state: string,
  offset: number,
  limit: number,
  maxReadBytes: number,
  resultBudget: ResultBudget,
) {
  if (offset > size) throw new ToolError('cursor position is not valid')
  const candidates: Array<Candidate<{ byte_offset: number; text: string }>> = []
  let position = offset

  while (position < size && position - offset < maxReadBytes && candidates.length < limit) {
    const requested = Math.min(READ_CHUNK_BYTES, size - position, maxReadBytes - (position - offset))
    const buffer = Buffer.allocUnsafe(requested)
    const count = readSync(descriptor, buffer, 0, requested, position)
    if (count <= 0) throw new ToolError('read failed')

    const bytes = buffer.subarray(0, count)
    const atEnd = position + count === size
    const safeLength = validUtf8Prefix(bytes)
    if (safeLength <= 0) {
      if (!atEnd && candidates.length > 0) break
      throw new ToolError('file is not valid UTF-8')
    }
    if (atEnd && safeLength !== count) throw new ToolError('file is not valid UTF-8')

    const chunk = bytes.subarray(0, safeLength)
    candidates.push({
      item: { byte_offset: position, text: chunk.toString('utf8') },
      position: position + safeLength,
      bytes: chunk,
    })
    position += safeLength
  }

  return pageValue(cursors, scope, state, offset, candidates, position < size ? position : null, resultBudget)
}

/**
 * Scans files for a literal byte sequence, one page at a time.
 *
 * The scan is byte-oriented so a huge file costs bounded memory, but evidence
 * is text: a match is reported only when its line decodes as UTF-8, which
 * makes a line either fully reported or fully skipped regardless of where the
 * traversal resumed.
 */
function scanText(
  root: Root,
  files: readonly FileFact[],
  terms: Terms,
  start: SearchPosition,
  limit: number,
  failOnObservationChange: boolean,
) {
  // One KMP machine per needle, all advanced over the same byte. A line
  // matches when any of them completes, so the cursor's single `matched` flag
  // keeps its meaning however many terms were asked for.
  const scanBudget = root.limits.maxScanBytes
  const patterns = compileTerms(terms)
  const longest = patterns.reduce((widest, pattern) => Math.max(widest, pattern.bytes.length), 0)
  const candidates: Array<Candidate<{ path: string; line: number; text: string }>> = []
  let position = { ...start }
  let scanned = 0

  const record = (path: string, descriptor: number, end: number, resume: SearchPosition): void => {
    const text = evidence(descriptor, position.lineStart, end)
    if (text === null) return
    candidates.push({
      item: { path, line: position.line, text },
      position: resume,
      bytes: Buffer.from(`${path}\0${position.line}\0${text}\n`, 'utf8'),
    })
  }

  while (position.file < files.length && candidates.length < limit && scanned < scanBudget) {
    const file = files[position.file]!
    let open
    try {
      open = openFileForRead(root, file.path)
    } catch {
      if (failOnObservationChange) throw new ToolError('filesystem changed while reading')
      // The file was served by the walk and is gone now. The cursor this page
      // issues will fail on the next call, which is the report that matters.
      position = nextFile(position.file)
      continue
    }

    const { descriptor } = open
    const size = open.bytes
    try {
      if (open.identity !== file.identity) throw new ToolError('filesystem changed while reading')
      if (position.offset > size || position.lineStart > position.offset) {
        throw new ToolError('cursor position is not valid')
      }
      // A file is skipped whole only when both binary signals agree: its
      // opening bytes hold a NUL and they do not decode as UTF-8. Either test
      // alone drops real text. NUL is itself valid UTF-8, so the usual NUL
      // heuristic would have silently discarded 34 MB of genuine text on one
      // real checkout; and undecodability alone would discard a text file
      // holding a single malformed line, which `evidence` is supposed to skip
      // one line at a time. Together they still skip the compiled artifacts
      // and dumps that made searching a real root cost a hundred empty pages.
      // The sniff is charged to the scan budget, and on a file that is text it
      // reads the same bytes the scan would have read first.
      if (position.offset === 0 && isBinary(descriptor, size)) {
        scanned += Math.min(BINARY_SNIFF_BYTES, size)
        position = nextFile(position.file)
        continue
      }
      const states = restoreMatchStates(descriptor, position, patterns, longest, terms.caseInsensitive)
      const buffer = Buffer.allocUnsafe(Math.min(SEARCH_BUFFER_BYTES, Math.max(size - position.offset, 1)))

      while (position.offset < size && candidates.length < limit && scanned < scanBudget) {
        const wanted = Math.min(buffer.length, size - position.offset, scanBudget - scanned)
        const count = readSync(descriptor, buffer, 0, wanted, position.offset)
        if (count <= 0) throw new ToolError('read failed')

        for (let index = 0; index < count; index += 1) {
          const byte = buffer[index]!
          position.offset += 1
          scanned += 1

          if (byte === 0x0a) {
            if (position.matched) {
              record(file.path, descriptor, position.offset - 1, {
                ...position,
                lineStart: position.offset,
                line: position.line + 1,
                matched: false,
              })
            }
            position.lineStart = position.offset
            position.line += 1
            position.matched = false
            states.fill(0)
            if (candidates.length >= limit) break
            continue
          }

          const probe = terms.caseInsensitive ? foldByte(byte) : byte
          for (let term = 0; term < patterns.length; term += 1) {
            const { bytes: termBytes, failure } = patterns[term]!
            let state = kmpStep(termBytes, failure, states[term]!, probe)
            if (state === termBytes.length) {
              position.matched = true
              state = failure[state - 1] ?? 0
            }
            states[term] = state
          }
        }
      }

      if (position.offset >= size) {
        // A final line with no trailing newline still counts as a line.
        if (position.matched && position.offset > position.lineStart && candidates.length < limit) {
          record(file.path, descriptor, position.offset, nextFile(position.file))
        }
        position = nextFile(position.file)
      }
      assertOpenFileIdentity(open)
    } finally {
      closeSync(descriptor)
    }
  }

  return { candidates, next: position.file < files.length ? position : null }
}

function nextFile(file: number): SearchPosition {
  return { file: file + 1, offset: 0, lineStart: 0, line: 1, matched: false }
}

/** True when the opening bytes both hold a NUL and fail to decode as UTF-8. */
function isBinary(descriptor: number, size: number): boolean {
  const length = Math.min(BINARY_SNIFF_BYTES, size)
  if (length === 0) return false
  const bytes = Buffer.allocUnsafe(length)
  if (readSync(descriptor, bytes, 0, length, 0) !== length) throw new ToolError('read failed')
  // `validUtf8Prefix` allows a sniff that stops mid-scalar, so a cut-short
  // multi-byte character at the 8 KiB boundary is not mistaken for evidence.
  return bytes.includes(0) && validUtf8Prefix(bytes) <= 0
}

/**
 * Replays the current line's tail so a resumed scan cannot miss a straddling
 * match. The replay is as long as the widest needle, so every machine sees
 * enough history regardless of which one eventually matches.
 */
function restoreMatchStates(
  descriptor: number,
  position: SearchPosition,
  patterns: readonly CompiledTerm[],
  longest: number,
  caseInsensitive: boolean,
): number[] {
  const states = patterns.map(() => 0)
  const overlap = Math.min(longest - 1, position.offset - position.lineStart)
  if (overlap <= 0) return states
  const bytes = Buffer.allocUnsafe(overlap)
  if (readSync(descriptor, bytes, 0, overlap, position.offset - overlap) !== overlap) {
    throw new ToolError('read failed')
  }
  for (const byte of bytes) {
    const probe = caseInsensitive ? foldByte(byte) : byte
    for (let term = 0; term < patterns.length; term += 1) {
      const { bytes: termBytes, failure } = patterns[term]!
      let state = kmpStep(termBytes, failure, states[term]!, probe)
      if (state === termBytes.length) state = failure[state - 1] ?? 0
      states[term] = state
    }
  }
  return states
}

/** The matched line, or null when its bytes are not valid UTF-8. */
function evidence(descriptor: number, start: number, end: number): string | null {
  const length = Math.min(Math.max(end - start, 0), MAX_EVIDENCE_BYTES)
  if (length === 0) return ''
  const bytes = Buffer.allocUnsafe(length)
  if (readSync(descriptor, bytes, 0, length, start) !== length) throw new ToolError('read failed')

  const truncated = end - start > MAX_EVIDENCE_BYTES
  const safeLength = truncated ? validUtf8Prefix(bytes) : length
  if (safeLength <= 0 || (!truncated && safeLength !== length)) return null

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, safeLength)).replace(/\r$/, '')
  } catch {
    return null
  }
}

/**
 * The longest prefix of `bytes` that decodes as UTF-8, considering only the
 * last three bytes as a possible incomplete scalar. Zero means the bytes are
 * invalid rather than merely cut short.
 */
function validUtf8Prefix(bytes: Buffer): number {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let length = bytes.length; length >= Math.max(bytes.length - 3, 0); length -= 1) {
    try {
      decoder.decode(bytes.subarray(0, length))
      return length
    } catch {
      // At most three trailing bytes can belong to an incomplete UTF-8 scalar.
    }
  }
  return 0
}

/** Pages a fully materialized, sorted candidate list. */
function arrayPage<T>(
  cursors: CursorCodec,
  scope: string,
  state: string,
  candidates: readonly Candidate<T>[],
  offset: number,
  limit: number,
  resultBudget: ResultBudget,
) {
  if (offset > candidates.length) throw new ToolError('cursor position is not valid')
  const end = Math.min(offset + limit, candidates.length)
  return pageValue(
    cursors,
    scope,
    state,
    offset,
    candidates.slice(offset, end),
    end < candidates.length ? end : null,
    resultBudget,
  )
}

/**
 * Fits the largest candidate prefix under the decoded-result ceiling. Sizing
 * uses a fixed-length placeholder hash, then the chosen prefix is hashed once.
 */
function pageValue<T>(
  cursors: CursorCodec,
  scope: string,
  state: string,
  start: unknown,
  candidates: readonly Candidate<T>[],
  finalPosition: unknown,
  resultBudget: ResultBudget,
) {
  const valueFor = (count: number, contentHash: string) => {
    const next = count === candidates.length ? finalPosition : count === 0 ? start : candidates[count - 1]!.position
    return {
      items: candidates.slice(0, count).map((candidate) => candidate.item),
      next_cursor: next === null ? null : cursors.encode(scope, state, next),
      content_hash: contentHash,
    }
  }

  const fits = (count: number): boolean =>
    logicalResultBytes(valueFor(count, SIZING_HASH), resultBudget.identity) <= resultBudget.maxBytes

  if (fits(candidates.length)) {
    return valueFor(candidates.length, digest(candidates.map((candidate) => candidate.bytes)))
  }
  if (!fits(0)) throw new ToolError('result ceiling is too small')

  let low = 0
  let high = candidates.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }

  if (low === 0 && candidates.length > 0) {
    throw new ToolError('one result item exceeds the result ceiling')
  }
  return valueFor(low, digest(candidates.slice(0, low).map((candidate) => candidate.bytes)))
}

/** The digest of the bytes a call returned. A citation names these, not a tree. */
function digest(parts: readonly Buffer[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return `sha256:${hash.digest('hex')}`
}

function pagedOutput(itemProperties: Record<string, unknown>): JsonSchemaType {
  return {
    type: 'object',
    properties: {
      content_hash: { type: 'string' },
      items: {
        type: 'array',
        items: { type: 'object', properties: itemProperties, additionalProperties: false },
      },
    },
    // `next_cursor` is always present and is null at completion. The frozen
    // JSON Schema subset this server targets has no nullable union, so it is
    // documented in the description and admitted as the sole extra field.
    required: ['content_hash', 'items'],
    additionalProperties: true,
  } as JsonSchemaType
}

function structured(value: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value }
}

function logicalResultBytes(value: Record<string, unknown>, identity: ServerIdentity): number {
  return Buffer.byteLength(
    JSON.stringify({
      ...structured(value),
      resultType: 'complete',
      _meta: { 'io.modelcontextprotocol/serverInfo': identity },
    }),
    'utf8',
  )
}

function requirePath(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ToolError(`${field} must be a string`)
  const normalized = normalizeRelative(value)
  if (normalized === null) throw new ToolError(`${field} is not a relative path inside the root`)
  return normalized
}

/** One or more literal needles, and how their bytes are compared. */
interface Terms {
  readonly values: readonly string[]
  readonly caseInsensitive: boolean
}

interface CompiledTerm {
  readonly bytes: Buffer
  readonly failure: readonly number[]
}

/**
 * ASCII-only case folding.
 *
 * Deliberately not Unicode: the scanner is byte-oriented, and full case
 * folding is neither byte-local nor length-preserving, so it cannot be done
 * correctly one byte at a time. Folding A-Z is a rule that holds exactly, is
 * the same on every platform, and covers what identifiers are made of.
 */
function foldByte(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte
}

function foldString(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0x20))
}

function compileTerms(terms: Terms): CompiledTerm[] {
  return terms.values.map((term) => {
    const bytes = Buffer.from(terms.caseInsensitive ? foldString(term) : term, 'utf8')
    return { bytes, failure: kmpFailure(bytes) }
  })
}

/**
 * Reads the needles for a search: exactly one of `query` or `any_of`.
 *
 * `any_of` is a list rather than a `|` inside `query` on purpose. Splitting a
 * query on a bare pipe would silently change the meaning of every literal
 * search containing one -- `string | number` is ordinary source text -- and a
 * search that quietly matches more than it was asked to is the failure this
 * server spends errors to avoid.
 */
function requireTerms(args: Record<string, unknown>): Terms {
  if (args.query !== undefined && args.any_of !== undefined) {
    throw new ToolError('pass either query or any_of, not both')
  }
  const values = args.any_of === undefined ? [requireQuery(args.query)] : requireAnyOf(args.any_of)
  return { values, caseInsensitive: requireFlag(args.case_insensitive, 'case_insensitive') }
}

function requireAnyOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolError('any_of must be a non-empty array of strings')
  }
  if (value.length > MAX_TERMS) throw new ToolError(`any_of accepts at most ${MAX_TERMS} terms`)
  return value.map((term) => requireQuery(term))
}

function requireFlag(value: unknown, field: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new ToolError(`${field} must be a boolean`)
  return value
}

function requireLine(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ToolError('start_line must be a positive integer')
  }
  return value
}

/**
 * The byte offset where 1-based `line` begins, or the file size when the file
 * has fewer lines than that.
 *
 * There is no index to seek with, so this counts newlines from the start. It
 * is still far cheaper than the alternative, which is shipping every preceding
 * byte through a result budget to let the caller count them; and the scan is
 * charged against the same ceiling a search page obeys, so an absurd line
 * number on a huge file fails with something actionable rather than reading
 * without limit.
 */
function byteOfLine(descriptor: number, size: number, line: number, budget: number): number {
  if (line === 1) return 0
  let position = 0
  let remaining = line - 1
  const buffer = Buffer.allocUnsafe(SEARCH_BUFFER_BYTES)

  while (position < size) {
    if (position >= budget) throw new ToolError('start_line is further into the file than one page may scan')
    const wanted = Math.min(buffer.length, size - position, budget - position)
    const count = readSync(descriptor, buffer, 0, wanted, position)
    if (count <= 0) throw new ToolError('read failed')

    for (let index = 0; index < count; index += 1) {
      position += 1
      if (buffer[index] === 0x0a && (remaining -= 1) === 0) return position
    }
  }

  return size
}

function requireQuery(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new ToolError('query must be a non-empty string')
  if (Buffer.byteLength(value, 'utf8') > MAX_QUERY_BYTES || value.includes('\n') || value.includes('\r')) {
    throw new ToolError('query must be one line of at most 256 UTF-8 bytes')
  }
  return value
}

function boundedPage(limit: unknown, maximum = MAX_PAGE): number {
  if (limit === undefined) return maximum
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    throw new ToolError('limit must be a positive integer')
  }
  return Math.min(limit, maximum)
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSearchPosition(value: unknown, fileCount: number): value is SearchPosition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const position = value as Record<string, unknown>
  return (
    Object.keys(position).sort().join(',') === 'file,line,lineStart,matched,offset' &&
    isOffset(position.file) &&
    position.file < fileCount &&
    isOffset(position.offset) &&
    isOffset(position.lineStart) &&
    position.lineStart <= position.offset &&
    typeof position.line === 'number' &&
    Number.isSafeInteger(position.line) &&
    position.line >= 1 &&
    typeof position.matched === 'boolean'
  )
}

function kmpFailure(query: Buffer): number[] {
  const failure = Array<number>(query.length).fill(0)
  for (let index = 1, prefix = 0; index < query.length; index += 1) {
    while (prefix > 0 && query[index] !== query[prefix]) prefix = failure[prefix - 1]!
    if (query[index] === query[prefix]) prefix += 1
    failure[index] = prefix
  }
  return failure
}

function kmpStep(query: Buffer, failure: readonly number[], state: number, byte: number): number {
  while (state > 0 && byte !== query[state]) state = failure[state - 1]!
  if (byte === query[state]) state += 1
  return state
}
