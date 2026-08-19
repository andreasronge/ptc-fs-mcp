import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { call, callFailing, collect, FIXTURE, withFixture, withRoot } from './helpers/harness.mjs'

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`

test('a read reconstructs the file exactly across pages', async () => {
  await withFixture(async (server) => {
    const chunks = await collect(server, 'read_text_file', { path: 'lib/alpha.ex', limit: 1 })
    assert.equal(chunks.map((chunk) => chunk.text).join(''), FIXTURE['lib/alpha.ex'])
    assert.equal(chunks[0].byte_offset, 0)
  })
})

test('content_hash is the digest of the bytes that call returned', async () => {
  await withFixture(async (server) => {
    const page = await call(server, 'read_text_file', { path: 'lib/alpha.ex' })
    const returned = Buffer.from(page.items.map((chunk) => chunk.text).join(''), 'utf8')

    assert.equal(page.content_hash, sha256(returned))
    assert.equal(page.next_cursor, null, 'the whole small file fits in one page')
    assert.equal(page.content_hash, sha256(Buffer.from(FIXTURE['lib/alpha.ex'], 'utf8')))
  })
})

test('two reads of unchanged bytes cite the same hash; an edit changes it', async () => {
  await withRoot({ 'note.txt': 'first\n' }, async (server) => {
    const before = await call(server, 'read_text_file', { path: 'note.txt' })
    const again = await call(server, 'read_text_file', { path: 'note.txt' })
    assert.equal(before.content_hash, again.content_hash)

    await call(server, 'write_text_file', { path: 'note.txt', content: 'second\n' })
    const after = await call(server, 'read_text_file', { path: 'note.txt' })
    assert.notEqual(after.content_hash, before.content_hash, 'a citation must not survive an edit')
    assert.equal(after.content_hash, sha256(Buffer.from('second\n', 'utf8')))
  })
})

test('multi-byte UTF-8 is preserved and never split across a chunk boundary', async () => {
  await withFixture(async (server) => {
    const chunks = await collect(server, 'read_text_file', { path: 'lib/utf8.ex' })
    assert.equal(chunks.map((chunk) => chunk.text).join(''), 'café unicode\n')
  })
})

test('a multi-megabyte file reconstructs exactly across many pages', async () => {
  const text = `${'x'.repeat(1_100_000)}é${'y'.repeat(100_000)}\n`

  await withRoot({ 'huge.txt': text }, async (server) => {
    const chunks = await collect(server, 'read_text_file', { path: 'huge.txt', limit: 2 })
    assert.ok(chunks.length > 2, 'a large file must paginate')
    assert.equal(chunks.map((chunk) => chunk.text).join(''), text)
  })
})

test('a scalar straddling the chunk boundary is emitted whole', async () => {
  // The é lands on byte 2047, so a naive 2048-byte chunk would cut it in half.
  const text = `${'a'.repeat(2_047)}é${'b'.repeat(10)}`

  await withRoot({ 'straddle.txt': text }, async (server) => {
    const chunks = await collect(server, 'read_text_file', { path: 'straddle.txt' })
    assert.equal(chunks.map((chunk) => chunk.text).join(''), text)
    assert.ok(
      chunks.every((chunk) => !chunk.text.includes('�')),
      'no replacement character may appear',
    )
  })
})

test('escape-heavy pages stay under the decoded result ceiling', async () => {
  // Every byte here is six bytes of JSON escape, so a page that fit as raw
  // bytes would blow the ceiling once encoded.
  const text = `${'\u0001'.repeat(40_000)}\n`

  await withRoot({ 'controls.txt': text }, async (server) => {
    let cursor
    let joined = ''
    do {
      const response = await server.request('tools/call', {
        name: 'read_text_file',
        arguments: { path: 'controls.txt', limit: 8, ...(cursor === undefined ? {} : { cursor }) },
      })
      assert.equal(response.error, undefined)
      assert.ok(Buffer.byteLength(JSON.stringify(response.result), 'utf8') < 64_000, 'a page must fit the ceiling')
      joined += response.result.structuredContent.items.map((chunk) => chunk.text).join('')
      cursor = response.result.structuredContent.next_cursor ?? undefined
    } while (cursor !== undefined)

    assert.equal(joined, text, 'fitting defers items, it never drops them')
  })
})

test('limit is bounded and validated', async () => {
  await withFixture(async (server) => {
    for (const limit of [0, -1, 1.5, 'many', null]) {
      await callFailing(server, 'read_text_file', { path: 'lib/alpha.ex', limit })
    }
    const page = await call(server, 'list_directory', { limit: 1_000_000 })
    assert.ok(page.items.length <= 200, 'an oversized limit is clamped, not honoured')
  })
})

test('an empty file reads as a single empty page', async () => {
  await withRoot({ 'empty.txt': '' }, async (server) => {
    const page = await call(server, 'read_text_file', { path: 'empty.txt' })
    assert.deepEqual(page.items, [])
    assert.equal(page.next_cursor, null)
    assert.equal(page.content_hash, sha256(Buffer.alloc(0)))
  })
})

test('reading a directory or a missing path fails with actionable text', async () => {
  await withFixture(async (server) => {
    assert.match(
      await callFailing(server, 'read_text_file', { path: 'lib/missing.ex' }),
      /not a readable regular file/,
    )
    // The input schema rejects an empty path before the handler is reached.
    assert.match(await callFailing(server, 'read_text_file', { path: '' }), /path/)
    // `lib` itself does not match `lib/**`, so selection refuses it before any syscall.
    assert.match(await callFailing(server, 'read_text_file', { path: 'lib' }), /not served by this root/)
  })

  await withFixture(
    async (server) => {
      assert.match(await callFailing(server, 'read_text_file', { path: 'lib' }), /not a readable regular file/)
    },
    ['--include', '**'],
  )
})

test('list_directory reports names, kinds, and relative paths', async () => {
  await withRoot({ 'lib/deep/inner.txt': 'x\n', 'lib/top.txt': 'y\n', 'readme.md': 'z\n' }, async (server) => {
    assert.deepEqual(await collect(server, 'list_directory'), [
      { name: 'lib', kind: 'directory', path: 'lib' },
      { name: 'readme.md', kind: 'file', path: 'readme.md' },
    ])
    assert.deepEqual(await collect(server, 'list_directory', { path: 'lib' }), [
      { name: 'deep', kind: 'directory', path: 'lib/deep' },
      { name: 'top.txt', kind: 'file', path: 'lib/top.txt' },
    ])
  })
})

test('listings are sorted and paginate through an opaque cursor', async () => {
  await withFixture(async (server) => {
    const first = await call(server, 'search_files', { query: '.ex', limit: 1 })
    assert.equal(first.items.length, 1)
    assert.ok(first.next_cursor, 'a partial page must carry a cursor')

    const second = await call(server, 'search_files', { query: '.ex', limit: 1, cursor: first.next_cursor })
    assert.equal(second.items.length, 1)
    assert.notDeepEqual(first.items, second.items)

    const ordered = [first.items[0].path, second.items[0].path]
    assert.deepEqual([...ordered].sort(), ordered, 'pages must follow sorted order')
  })
})
