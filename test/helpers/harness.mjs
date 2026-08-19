/**
 * Test harness: real child processes over real stdio, the way a host runs it.
 *
 * Roots are generated per test rather than committed, because this server
 * writes as well as reads. A committed tree would either be dirtied by the
 * write tests or force them into a second, less realistic path.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The built binary, not the TypeScript source: what ships is what is tested. */
export const BINARY = join(here, '..', '..', 'dist', 'cli.js')

/** The only profile this server implements. */
export const PROTOCOL = '2026-07-28'

/**
 * The standard tree. `binary.ex` is not valid UTF-8, `escape.ex` is a symlink
 * that leaves the root, and `secrets/` exists to be excluded.
 */
export const FIXTURE = {
  'lib/alpha.ex': 'alpha line one\nalpha line two\n',
  'lib/beta.ex': 'beta needle here\n',
  'lib/utf8.ex': 'café unicode\n',
  'lib/binary.ex': Buffer.from([0xff, 0xfe, 0x20, 0x62, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x0a]),
  'lib/escape.ex': { symlink: '../../outside.txt' },
  'secrets/creds.env': 'TOKEN=must-not-appear\n',
}

/**
 * Materializes `files` into a fresh temporary root.
 *
 * A sibling `outside.txt` lives one level above the root so a fixture symlink
 * has something real to point at beyond the confinement boundary.
 */
export function makeRoot(files) {
  const enclosure = mkdtempSync(join(tmpdir(), 'ptc-fs-mcp-test-'))
  const root = join(enclosure, 'root')
  mkdirSync(root)
  writeFileSync(join(enclosure, 'outside.txt'), 'outside the root\n')

  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    if (contents !== null && typeof contents === 'object' && 'symlink' in contents) {
      symlinkSync(contents.symlink, absolute)
    } else {
      writeFileSync(absolute, contents)
    }
  }

  return { enclosure, root, cleanup: () => rmSync(enclosure, { recursive: true, force: true }) }
}

/** Spawns the server and returns a minimal JSON-RPC client over its stdio. */
export function startServer(args) {
  const child = spawn(process.execPath, [BINARY, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  const waiters = new Map()
  let stdout = ''
  let stderr = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    for (let newline = stdout.indexOf('\n'); newline !== -1; newline = stdout.indexOf('\n')) {
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      if (line.trim() === '') continue

      const message = JSON.parse(line)
      const waiter = waiters.get(message.id)
      if (waiter) {
        waiters.delete(message.id)
        waiter(message)
      }
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  let nextId = 0

  return {
    child,
    stderr: () => stderr,

    /** Sends a request carrying the modern protocol claim in `_meta`. */
    request(method, params = {}, protocol = PROTOCOL) {
      nextId += 1
      const id = nextId
      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': protocol,
            'io.modelcontextprotocol/clientInfo': { name: 'ptc-fs-mcp-tests', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out awaiting ${method}`)), 20_000)
        waiters.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      })
    },

    /** Sends a raw message with no `_meta` claim, as a 2025-era client would. */
    raw(message) {
      const id = message.id
      child.stdin.write(`${JSON.stringify(message)}\n`)
      if (id === undefined) return Promise.resolve(undefined)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out awaiting raw response')), 20_000)
        waiters.set(id, (response) => {
          clearTimeout(timer)
          resolve(response)
        })
      })
    },

    async close() {
      child.stdin.end()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

/** Runs `body` against a server on a generated root, then tears both down. */
export async function withRoot(files, body, extraArgs = ['--include', '**']) {
  const fixture = makeRoot(files)
  const server = startServer(['--root', fixture.root, ...extraArgs])
  try {
    await body(server, fixture.root, fixture)
  } finally {
    await server.close()
    fixture.cleanup()
  }
}

/** The standard tree with only `lib/**` served -- the common read-only setup. */
export async function withFixture(body, extraArgs = ['--include', 'lib/**']) {
  return withRoot(FIXTURE, body, extraArgs)
}

/** Unwraps a successful tool result, failing loudly on a protocol error. */
export function structured(response) {
  assert.equal(response.error, undefined, JSON.stringify(response.error))
  assert.notEqual(response.result?.isError, true, JSON.stringify(response.result))
  return response.result.structuredContent
}

export async function call(server, name, args = {}) {
  return structured(await server.request('tools/call', { name, arguments: args }))
}

/** Calls a tool expecting failure, and returns the message the client sees. */
export async function callFailing(server, name, args = {}) {
  const response = await server.request('tools/call', { name, arguments: args })
  assert.ok(response.error || response.result?.isError, `${name} must have failed: ${JSON.stringify(response)}`)
  return JSON.stringify(response.error ?? response.result)
}

/** Follows `next_cursor` to completion, asserting the envelope on every page. */
export async function collect(server, name, args = {}) {
  const items = []
  let cursor
  let pages = 0

  do {
    const result = await call(server, name, { ...args, ...(cursor === undefined ? {} : { cursor }) })
    assert.deepEqual(Object.keys(result).sort(), ['content_hash', 'items', 'next_cursor'])
    assert.match(result.content_hash, /^sha256:[0-9a-f]{64}$/)
    items.push(...result.items)
    cursor = result.next_cursor ?? undefined
    pages += 1
    assert.ok(pages < 10_000, 'cursor traversal must make progress')
  } while (cursor !== undefined)

  return items
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** A different string for the same signature bytes: the encoding is not canonical. */
export function respell(signature) {
  const bytes = Buffer.from(signature, 'base64url')
  const sibling = [...BASE64URL]
    .map((character) => `${signature.slice(0, -1)}${character}`)
    .find((candidate) => candidate !== signature && Buffer.from(candidate, 'base64url').equals(bytes))

  assert.ok(sibling, 'the signature must have an alternate spelling for this test to mean anything')
  return sibling
}
