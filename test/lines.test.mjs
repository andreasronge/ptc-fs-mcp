import assert from 'node:assert/strict'
import test from 'node:test'

import { call, callFailing, collect, withRoot } from './helpers/harness.mjs'

const CSV = `Region,Quarter,Revenue\n${Array.from({ length: 5_000 }, (_, index) => `R${index},Q3,${index * 10}`).join('\n')}\n`

test('start_line begins the read at a 1-based line', async () => {
  await withRoot({ 'a.txt': 'one\ntwo\nthree\nfour\n' }, async (server) => {
    const text = (await collect(server, 'read_text_file', { path: 'a.txt', start_line: 3 }))
      .map((chunk) => chunk.text)
      .join('')
    assert.equal(text, 'three\nfour\n')
  })
})

test('start_line 1 is the whole file, and matches omitting it', async () => {
  await withRoot({ 'a.txt': 'one\ntwo\n' }, async (server) => {
    const whole = await call(server, 'read_text_file', { path: 'a.txt' })
    const first = await call(server, 'read_text_file', { path: 'a.txt', start_line: 1 })
    assert.equal(first.items[0].text, whole.items[0].text)
    assert.equal(first.items[0].byte_offset, 0)
  })
})

test('byte_offset stays absolute, so a line read is citable', async () => {
  await withRoot({ 'a.txt': 'one\ntwo\nthree\n' }, async (server) => {
    const page = await call(server, 'read_text_file', { path: 'a.txt', start_line: 2 })
    assert.equal(page.items[0].byte_offset, 4)
    assert.equal(page.items[0].text, 'two\nthree\n')
  })
})

test('a start_line past the end of the file reads nothing', async () => {
  await withRoot({ 'a.txt': 'one\ntwo\n' }, async (server) => {
    const page = await call(server, 'read_text_file', { path: 'a.txt', start_line: 99 })
    assert.deepEqual(page.items, [])
    assert.equal(page.next_cursor, null)
  })
})

test('a mid-file CSV slice costs one page, not the rows before it', async () => {
  await withRoot({ 'data.csv': CSV }, async (server) => {
    const page = await call(server, 'read_text_file', { path: 'data.csv', start_line: 4_000, limit: 1 })
    assert.match(page.items[0].text, /^R3998,Q3,39980\n/, 'the page starts exactly at the requested row')

    // The header is one separate read, which is what a CSV consumer needs.
    const header = await call(server, 'read_text_file', { path: 'data.csv', limit: 1 })
    assert.match(header.items[0].text, /^Region,Quarter,Revenue\n/)
  })
})

test('a cursor is bound to the start_line it was issued for', async () => {
  await withRoot({ 'data.csv': CSV }, async (server) => {
    const first = await call(server, 'read_text_file', { path: 'data.csv', start_line: 10, limit: 1 })
    assert.ok(first.next_cursor)

    assert.match(
      await callFailing(server, 'read_text_file', { path: 'data.csv', start_line: 11, cursor: first.next_cursor }),
      /cursor/,
    )
    const resumed = await call(server, 'read_text_file', {
      path: 'data.csv',
      start_line: 10,
      cursor: first.next_cursor,
    })
    assert.ok(resumed.items.length > 0)
  })
})

test('start_line must be a positive integer', async () => {
  await withRoot({ 'a.txt': 'one\n' }, async (server) => {
    for (const start_line of [0, -1, 1.5]) {
      assert.match(await callFailing(server, 'read_text_file', { path: 'a.txt', start_line }), /start_line/)
    }
  })
})

test('a line beyond the scan ceiling fails with something actionable', async () => {
  await withRoot(
    { 'data.csv': CSV },
    async (server) => {
      assert.match(
        await callFailing(server, 'read_text_file', { path: 'data.csv', start_line: 4_000 }),
        /start_line is further into the file than one page may scan/,
      )
    },
    ['--include', '**', '--max-scan-bytes', '8192'],
  )
})

test('the start_line scan cannot read past its budget in a single buffer', async () => {
  // The newline sits at byte 10000, inside the second 8 KiB read but beyond
  // the 8192 ceiling. Reading a whole buffer regardless would have accepted
  // it and quietly scanned past the limit the ceiling exists to impose.
  const text = `${'a'.repeat(10_000)}\nsecond line\n`

  await withRoot(
    { 'wide.txt': text },
    async (server) => {
      assert.match(
        await callFailing(server, 'read_text_file', { path: 'wide.txt', start_line: 2 }),
        /start_line is further into the file than one page may scan/,
      )
    },
    ['--include', '**', '--max-scan-bytes', '8192'],
  )
})
