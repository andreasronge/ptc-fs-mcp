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
import { fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server'

import { ToolError } from './errors.js'
import { decodeCursor, encodeCursor, scopeOf, stateOf } from './cursor.js'
import { normalizeRelative } from './paths.js'
import { inventory, openFileForRead, writeTextFile, type FileFact, type Root } from './root.js'

const MAX_PAGE = 200
const MAX_READ_CHUNKS = 8
const READ_CHUNK_BYTES = 2_048
const SEARCH_BUFFER_BYTES = 8_192
const SEARCH_SCAN_BYTES = 262_144
const MAX_QUERY_BYTES = 256
const MAX_EVIDENCE_BYTES = 1_024
const MAX_LOGICAL_RESULT_BYTES = 48_000

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

export interface ServerIdentity {
  readonly name: string
  readonly version: string
}

/**
 * Builds the MCP server for one live root. Exported so a host can embed the
 * server in its own process instead of spawning the stdio binary.
 */
export function createServer(root: Root, identity: ServerIdentity): McpServer {
  const server = new McpServer(
    { name: identity.name, version: identity.version },
    {
      instructions:
        'Read and write files under one confined root. Paths are relative to that root. Reads reflect the ' +
        'filesystem at call time, so a write is visible to the next read. Follow next_cursor until it is null; a ' +
        'cursor is rejected if the data it was issued against changed.',
    },
  )

  const meta = { 'io.modelcontextprotocol/cacheScope': 'private' as const }
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

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
      const items = directoryEntries(root, prefix)
      const scope = scopeOf('list_directory', { path: prefix })
      const state = stateOf(items.map((entry) => `${entry.kind}\0${entry.path}`))
      const offset = decodeCursor(scope, state, args.cursor, isOffset, 0)
      const candidates = items.map((item, index) => ({
        item,
        position: index + 1,
        bytes: Buffer.from(`${item.kind}\0${item.path}\n`, 'utf8'),
      }))
      return structured(arrayPage(scope, state, candidates, offset, boundedPage(args.limit)))
    },
  )

  server.registerTool(
    'search_files',
    {
      title: 'Search files',
      description: 'Sorted paths containing a literal substring. Follow next_cursor until null.',
      annotations: readOnly,
      _meta: meta,
      outputSchema: fromJsonSchema<Record<string, unknown>>(pagedOutput({ path: { type: 'string' } })),
      inputSchema: fromJsonSchema<Record<string, unknown>>({
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1 },
        },
        required: ['query'],
        additionalProperties: false,
      }),
    },
    async (args: Record<string, unknown>) => {
      const query = requireQuery(args.query)
      const paths = inventory(root)
        .map((file) => file.path)
        .filter((path) => path.includes(query))
      const scope = scopeOf('search_files', { query })
      const state = stateOf(paths)
      const offset = decodeCursor(scope, state, args.cursor, isOffset, 0)
      const candidates = paths.map((path, index) => ({
        item: { path },
        position: index + 1,
        bytes: Buffer.from(`${path}\n`, 'utf8'),
      }))
      return structured(arrayPage(scope, state, candidates, offset, boundedPage(args.limit)))
    },
  )

  server.registerTool(
    'search_text',
    {
      title: 'Search text',
      description: 'Streaming literal line search. Empty progress pages may carry next_cursor; follow it until null.',
      annotations: readOnly,
      _meta: meta,
      outputSchema: fromJsonSchema<Record<string, unknown>>(
        pagedOutput({ path: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } }),
      ),
      inputSchema: fromJsonSchema<Record<string, unknown>>({
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          path: { type: 'string' },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1 },
        },
        required: ['query'],
        additionalProperties: false,
      }),
    },
    async (args: Record<string, unknown>) => {
      const query = requireQuery(args.query)
      const prefix = args.path === undefined ? '' : requirePath(args.path, 'path')
      const files = inventory(root, prefix)
      const scope = scopeOf('search_text', { path: prefix, query })
      // Content is what a text search tears on, so the scan binds each file's
      // inode observation as well as the set of paths.
      const state = stateOf(files.map((file) => `${file.path}\0${file.identity}`))
      const first: SearchPosition = { file: 0, offset: 0, lineStart: 0, line: 1, matched: false }
      const start = decodeCursor(
        scope,
        state,
        args.cursor,
        (value): value is SearchPosition => isSearchPosition(value, files.length),
        first,
      )
      const scan = scanText(root, files, query, start, boundedPage(args.limit))
      return structured(pageValue(scope, state, start, scan.candidates, scan.next))
    },
  )

  server.registerTool(
    'read_text_file',
    {
      title: 'Read text file',
      description: 'Bounded exact UTF-8 chunks of live bytes. Concatenate item text and follow next_cursor.',
      annotations: readOnly,
      _meta: meta,
      outputSchema: fromJsonSchema<Record<string, unknown>>(
        pagedOutput({ byte_offset: { type: 'integer' }, text: { type: 'string' } }),
      ),
      inputSchema: fromJsonSchema<Record<string, unknown>>({
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1 },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_READ_CHUNKS },
        },
        required: ['path'],
        additionalProperties: false,
      }),
    },
    async (args: Record<string, unknown>) => {
      const path = requirePath(args.path, 'path')
      if (path === '') throw new ToolError('path must name a file')
      const file = openFileForRead(root, path)
      try {
        const scope = scopeOf('read_text_file', { path })
        const state = stateOf([file.identity])
        const offset = decodeCursor(scope, state, args.cursor, isOffset, 0)
        const limit = boundedPage(args.limit, MAX_READ_CHUNKS)
        return structured(readPage(file.descriptor, file.bytes, scope, state, offset, limit))
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

/**
 * Derives one directory level from the selected files beneath it.
 *
 * Deriving rather than reading the directory keeps `--include` the whole
 * access model: a directory appears only because it holds something served,
 * so an unserved directory's name never leaks through a listing.
 */
function directoryEntries(root: Root, prefix: string): Array<{ name: string; kind: string; path: string }> {
  const scope = prefix === '' ? '' : `${prefix}/`
  const entries = new Map<string, 'file' | 'directory'>()

  for (const file of inventory(root, prefix)) {
    const remainder = file.path.slice(scope.length)
    if (remainder === '') continue
    const separator = remainder.indexOf('/')
    if (separator === -1) entries.set(remainder, 'file')
    else entries.set(remainder.slice(0, separator), 'directory')
  }

  return [...entries.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, kind]) => ({ name, kind, path: scope + name }))
}

function readPage(descriptor: number, size: number, scope: string, state: string, offset: number, limit: number) {
  if (offset > size) throw new ToolError('cursor position is not valid')
  const candidates: Array<Candidate<{ byte_offset: number; text: string }>> = []
  let position = offset

  while (position < size && candidates.length < limit) {
    const requested = Math.min(READ_CHUNK_BYTES, size - position)
    const buffer = Buffer.allocUnsafe(requested)
    const count = readSync(descriptor, buffer, 0, requested, position)
    if (count <= 0) throw new ToolError('read failed')

    const bytes = buffer.subarray(0, count)
    const atEnd = position + count === size
    const safeLength = validUtf8Prefix(bytes)
    if (safeLength <= 0 || (atEnd && safeLength !== count)) throw new ToolError('file is not valid UTF-8')

    const chunk = bytes.subarray(0, safeLength)
    candidates.push({
      item: { byte_offset: position, text: chunk.toString('utf8') },
      position: position + safeLength,
      bytes: chunk,
    })
    position += safeLength
  }

  return pageValue(scope, state, offset, candidates, position < size ? position : null)
}

/**
 * Scans files for a literal byte sequence, one page at a time.
 *
 * The scan is byte-oriented so a huge file costs bounded memory, but evidence
 * is text: a match is reported only when its line decodes as UTF-8, which
 * makes a line either fully reported or fully skipped regardless of where the
 * traversal resumed.
 */
function scanText(root: Root, files: readonly FileFact[], query: string, start: SearchPosition, limit: number) {
  const queryBytes = Buffer.from(query, 'utf8')
  const failure = kmpFailure(queryBytes)
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

  while (position.file < files.length && candidates.length < limit && scanned < SEARCH_SCAN_BYTES) {
    const file = files[position.file]!
    let open
    try {
      open = openFileForRead(root, file.path)
    } catch {
      // The file was served by the walk and is gone now. The cursor this page
      // issues will fail on the next call, which is the report that matters.
      position = nextFile(position.file)
      continue
    }

    const { descriptor } = open
    const size = open.bytes
    try {
      if (position.offset > size || position.lineStart > position.offset) {
        throw new ToolError('cursor position is not valid')
      }
      let matchState = restoreMatchState(descriptor, position, queryBytes, failure)
      const buffer = Buffer.allocUnsafe(Math.min(SEARCH_BUFFER_BYTES, Math.max(size - position.offset, 1)))

      while (position.offset < size && candidates.length < limit && scanned < SEARCH_SCAN_BYTES) {
        const wanted = Math.min(buffer.length, size - position.offset, SEARCH_SCAN_BYTES - scanned)
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
            matchState = 0
            if (candidates.length >= limit) break
            continue
          }

          matchState = kmpStep(queryBytes, failure, matchState, byte)
          if (matchState === queryBytes.length) {
            position.matched = true
            matchState = failure[matchState - 1] ?? 0
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
    } finally {
      closeSync(descriptor)
    }
  }

  return { candidates, next: position.file < files.length ? position : null }
}

function nextFile(file: number): SearchPosition {
  return { file: file + 1, offset: 0, lineStart: 0, line: 1, matched: false }
}

/** Replays the current line's tail so a resumed scan cannot miss a straddling match. */
function restoreMatchState(
  descriptor: number,
  position: SearchPosition,
  query: Buffer,
  failure: readonly number[],
): number {
  const overlap = Math.min(query.length - 1, position.offset - position.lineStart)
  if (overlap <= 0) return 0
  const bytes = Buffer.allocUnsafe(overlap)
  if (readSync(descriptor, bytes, 0, overlap, position.offset - overlap) !== overlap) {
    throw new ToolError('read failed')
  }
  let state = 0
  for (const byte of bytes) {
    state = kmpStep(query, failure, state, byte)
    if (state === query.length) state = failure[state - 1] ?? 0
  }
  return state
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
  scope: string,
  state: string,
  candidates: readonly Candidate<T>[],
  offset: number,
  limit: number,
) {
  if (offset > candidates.length) throw new ToolError('cursor position is not valid')
  const end = Math.min(offset + limit, candidates.length)
  return pageValue(scope, state, offset, candidates.slice(offset, end), end < candidates.length ? end : null)
}

/**
 * Fits a page under the result ceiling, dropping items from the end and
 * reissuing the cursor so nothing is lost -- only deferred.
 */
function pageValue<T>(
  scope: string,
  state: string,
  start: unknown,
  candidates: readonly Candidate<T>[],
  finalPosition: unknown,
) {
  const kept = [...candidates]

  while (true) {
    const next =
      kept.length === candidates.length ? finalPosition : kept.length === 0 ? start : kept[kept.length - 1]!.position
    const value = {
      items: kept.map((candidate) => candidate.item),
      next_cursor: next === null ? null : encodeCursor(scope, state, next),
      content_hash: digest(kept.map((candidate) => candidate.bytes)),
    }

    if (logicalResultBytes(value) <= MAX_LOGICAL_RESULT_BYTES) {
      if (kept.length === 0 && candidates.length > 0) {
        throw new ToolError('one result item exceeds the result ceiling')
      }
      return value
    }
    if (kept.length === 0) throw new ToolError('one result item exceeds the result ceiling')
    kept.pop()
  }
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

function logicalResultBytes(value: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(structured(value)), 'utf8')
}

function requirePath(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ToolError(`${field} must be a string`)
  const normalized = normalizeRelative(value)
  if (normalized === null) throw new ToolError(`${field} is not a relative path inside the root`)
  return normalized
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
