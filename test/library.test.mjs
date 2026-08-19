/**
 * Usage from Node without the binary.
 *
 * The package is also a library: a host that already runs Node can build the
 * same server in-process and hand it a transport of its own. These tests use
 * the SDK's in-memory transport pair, so the whole exchange stays in one
 * process and no stdio is involved.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { InMemoryTransport } from '@modelcontextprotocol/server'

import {
  compileGlob,
  ConfigError,
  createSelector,
  createServer,
  DEFAULT_LIMITS,
  IDENTITY,
  normalizeRelative,
  openRoot,
  ToolError,
} from '../dist/index.js'
import { makeRoot, PROTOCOL } from './helpers/harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

/** Connects an in-process server and returns a one-shot request function. */
async function connect(root) {
  const server = createServer(openRoot(root))
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  await clientSide.start()

  const waiters = new Map()
  clientSide.onmessage = (message) => {
    const waiter = waiters.get(message.id)
    if (waiter) {
      waiters.delete(message.id)
      waiter(message)
    }
  }

  let nextId = 0
  return {
    async call(name, args = {}) {
      nextId += 1
      const id = nextId
      const settled = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out awaiting ${name}`)), 20_000)
        waiters.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
      })
      await clientSide.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL,
            'io.modelcontextprotocol/clientInfo': { name: 'library-tests', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      })
      return settled
    },
    close: () => clientSide.close(),
  }
}

test('an embedded server reads and writes over a transport of the caller\u2019s choosing', async () => {
  const fixture = makeRoot({ 'lib/alpha.ex': 'alpha line one\n' })
  const client = await connect({ root: fixture.root, include: ['**'] })

  try {
    const written = await client.call('write_text_file', { path: 'notes.txt', content: 'embedded\n' })
    assert.equal(written.result.structuredContent.bytes, 9)

    const read = await client.call('read_text_file', { path: 'notes.txt' })
    assert.equal(read.result.structuredContent.items.map((chunk) => chunk.text).join(''), 'embedded\n')

    const listing = await client.call('list_directory')
    assert.deepEqual(
      listing.result.structuredContent.items.map((entry) => entry.name),
      ['lib', 'notes.txt'],
    )
  } finally {
    await client.close()
    fixture.cleanup()
  }
})

test('two servers over one root can be given different authority', async () => {
  const fixture = makeRoot({ 'inbox/note.txt': 'x\n' })
  // The same package, installed twice with different rules: one that can only
  // see `inbox/`, and one that can only write at the top level.
  const reader = await connect({ root: fixture.root, include: ['inbox/**'] })
  const writer = await connect({ root: fixture.root, include: ['*.txt'] })

  try {
    const denied = await writer.call('read_text_file', { path: 'inbox/note.txt' })
    assert.equal(denied.result.isError, true, 'the writer installation cannot reach inbox/')

    const refused = await reader.call('write_text_file', { path: 'report.txt', content: 'x' })
    assert.equal(refused.result.isError, true, 'the reader installation cannot write at the top level')

    const allowed = await writer.call('write_text_file', { path: 'report.txt', content: 'done\n' })
    assert.equal(allowed.result.structuredContent.path, 'report.txt')
  } finally {
    await reader.close()
    await writer.close()
    fixture.cleanup()
  }
})

test('openRoot rejects an unusable configuration before serving anything', async () => {
  const fixture = makeRoot({ 'a.txt': 'x\n' })

  try {
    assert.throws(() => openRoot({ root: fixture.root, include: [] }), ConfigError)
    assert.throws(() => openRoot({ root: join(fixture.root, 'missing'), include: ['**'] }), ConfigError)
    assert.throws(() => openRoot({ root: join(fixture.root, 'a.txt'), include: ['**'] }), ConfigError)
    assert.throws(() => openRoot({ root: fixture.root, include: ['**'], limits: { maxFiles: 0 } }), ConfigError)

    const root = openRoot({ root: fixture.root, include: ['**'] })
    assert.equal(root.limits.maxWriteBytes, DEFAULT_LIMITS.maxWriteBytes)
    assert.equal(root.selector.selects('a.txt'), true)
  } finally {
    fixture.cleanup()
  }
})

test('the reported identity matches the published package', () => {
  assert.equal(IDENTITY.name, 'ptc-fs-mcp')
  assert.equal(IDENTITY.version, manifest.version)
  assert.equal(manifest.name, 'ptc-fs-mcp')
})

test('ToolError and ConfigError are exported so a caller can branch on them', () => {
  assert.ok(new ToolError('x') instanceof Error)
  assert.ok(new ConfigError('x') instanceof Error)
  assert.notEqual(ToolError, ConfigError)
})

test('normalizeRelative accepts relative paths and rejects everything else', () => {
  assert.equal(normalizeRelative(''), '')
  assert.equal(normalizeRelative('lib/a.ts'), 'lib/a.ts')
  assert.equal(normalizeRelative('lib//a.ts'), 'lib/a.ts')
  assert.equal(normalizeRelative('lib/'), 'lib')

  for (const value of ['/abs', '..', 'a/../b', './a', 'a\\b', 'C:/a', 'a\u0000b', 'x'.repeat(2_000)]) {
    assert.equal(normalizeRelative(value), null, value)
  }
})

test('globs match within a segment, across segments, and at zero depth', () => {
  assert.equal(compileGlob('lib/**').test('lib/a.ts'), true)
  assert.equal(compileGlob('lib/**').test('lib/deep/a.ts'), true)
  assert.equal(compileGlob('lib/**').test('libx/a.ts'), false)
  assert.equal(compileGlob('*.ts').test('a.ts'), true)
  assert.equal(compileGlob('*.ts').test('lib/a.ts'), false)
  assert.equal(compileGlob('a?c.ts').test('abc.ts'), true)
  assert.equal(compileGlob('a.ts').test('axts'), false, 'a dot is literal, not a wildcard')
})

test('a selector requires an include and lets an exclude only narrow', () => {
  const selector = createSelector(['lib/**'], ['lib/secret/**'])

  assert.equal(selector.selects('lib/a.ts'), true)
  assert.equal(selector.selects('lib/secret/a.ts'), false)
  assert.equal(selector.selects('docs/a.md'), false)
  assert.equal(createSelector([], ['x']).selects('anything'), false, 'the default is no files')
})
