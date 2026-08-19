/**
 * Cursors under a filesystem that can change mid-traversal.
 *
 * A frozen server can hand out a cursor and know the data behind it will
 * still be there. This one cannot, so the contract is that a cursor either
 * resumes against the same data or fails loudly. These tests pin that
 * boundary: what must fail, and equally, what must not.
 */

import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { call, callFailing, respell, startServer, withFixture, withRoot } from './helpers/harness.mjs'

const CHANGED = /the filesystem changed since this cursor was issued/

test('a read cursor is refused after the file it names is edited', async () => {
  const text = `${'a'.repeat(20_000)}\n`

  await withRoot({ 'big.txt': text }, async (server, root) => {
    const first = await call(server, 'read_text_file', { path: 'big.txt', limit: 1 })
    assert.ok(first.next_cursor, 'the file must need more than one page')

    writeFileSync(join(root, 'big.txt'), `${'b'.repeat(20_000)}\n`)

    const message = await callFailing(server, 'read_text_file', { path: 'big.txt', cursor: first.next_cursor })
    assert.match(message, CHANGED, 'a torn read must be refused, never silently returned')
  })
})

test('a read cursor survives an edit to an unrelated file', async () => {
  const text = `${'a'.repeat(20_000)}\n`

  await withRoot({ 'big.txt': text, 'other.txt': 'x\n' }, async (server, root) => {
    const first = await call(server, 'read_text_file', { path: 'big.txt', limit: 1 })
    writeFileSync(join(root, 'other.txt'), 'changed\n')

    const second = await call(server, 'read_text_file', { path: 'big.txt', cursor: first.next_cursor })
    assert.ok(second.items.length > 0, 'only the state a result depends on may invalidate its cursor')
  })
})

test('a search_files cursor is refused after a served path appears or disappears', async () => {
  const files = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`file-${index}.txt`, 'x\n']))

  await withRoot(files, async (server, root) => {
    const first = await call(server, 'search_files', { query: '.txt', limit: 2 })
    writeFileSync(join(root, 'file-9.txt'), 'x\n')
    assert.match(await callFailing(server, 'search_files', { query: '.txt', cursor: first.next_cursor }), CHANGED)

    const again = await call(server, 'search_files', { query: '.txt', limit: 2 })
    rmSync(join(root, 'file-9.txt'))
    assert.match(await callFailing(server, 'search_files', { query: '.txt', cursor: again.next_cursor }), CHANGED)
  })
})

test('a search_files cursor survives an edit that leaves every path in place', async () => {
  const files = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`file-${index}.txt`, 'x\n']))

  await withRoot(files, async (server, root) => {
    const first = await call(server, 'search_files', { query: '.txt', limit: 2 })
    writeFileSync(join(root, 'file-0.txt'), 'wholly different content\n')

    const second = await call(server, 'search_files', { query: '.txt', cursor: first.next_cursor })
    assert.ok(second.items.length > 0, 'a path listing cannot tear on a content edit')
  })
})

test('a search_text cursor is refused after any in-scope content changes', async () => {
  const text = Array.from({ length: 400 }, (_, index) => `needle ${index}\n`).join('')

  await withRoot({ 'many.txt': text, 'quiet.txt': 'nothing\n' }, async (server, root) => {
    const first = await call(server, 'search_text', { query: 'needle', limit: 5 })
    assert.ok(first.next_cursor)

    writeFileSync(join(root, 'quiet.txt'), 'still nothing, but different\n')

    const message = await callFailing(server, 'search_text', { query: 'needle', cursor: first.next_cursor })
    assert.match(message, CHANGED, 'a text scan indexes into the file set, so the whole scope is bound')
  })
})

test('a list_directory cursor is refused when the listing itself changes', async () => {
  const files = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`entry-${index}.txt`, 'x\n']))

  await withRoot(files, async (server, root) => {
    const first = await call(server, 'list_directory', { limit: 2 })
    writeFileSync(join(root, 'entry-9.txt'), 'x\n')

    assert.match(await callFailing(server, 'list_directory', { cursor: first.next_cursor }), CHANGED)
  })
})

test('a list_directory cursor survives a change below the level being listed', async () => {
  const files = { 'sub/a.txt': 'x\n', 'one.txt': 'x\n', 'two.txt': 'x\n', 'three.txt': 'x\n' }

  await withRoot(files, async (server, root) => {
    const first = await call(server, 'list_directory', { limit: 2 })
    writeFileSync(join(root, 'sub', 'b.txt'), 'x\n')

    const second = await call(server, 'list_directory', { cursor: first.next_cursor })
    assert.ok(second.items.length > 0, 'sub/ is still one directory entry, so the listing did not tear')
  })
})

test('a cursor cannot be replayed into another tool or another query', async () => {
  await withFixture(async (server) => {
    const cursor = (await call(server, 'search_files', { query: '.ex', limit: 1 })).next_cursor

    for (const [name, args] of [
      ['search_files', { query: 'alpha', cursor }],
      ['read_text_file', { path: 'lib/alpha.ex', cursor }],
      ['list_directory', { cursor }],
      ['search_text', { query: '.ex', cursor }],
    ]) {
      const message = await callFailing(server, name, args)
      assert.match(message, /different traversal|not valid/, name)
    }
  })
})

test('an edited cursor is rejected', async () => {
  await withFixture(async (server) => {
    const cursor = (await call(server, 'search_files', { query: '.ex', limit: 1 })).next_cursor

    for (const tampered of [
      `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`,
      cursor.slice(1),
      cursor.replace('.', '..'),
      cursor.split('.')[0],
      'not-a-cursor',
      '',
      'x'.repeat(5_000),
    ]) {
      assert.match(await callFailing(server, 'search_files', { query: '.ex', cursor: tampered }), /not valid/)
    }
  })
})

// The final base64url character of a 32-byte signature carries only four
// significant bits, so fifteen of its sixteen legal values have a sibling that
// decodes to the same bytes. A verifier comparing decoded signatures would
// therefore accept cursor strings it never issued.
test('a re-spelled signature that decodes to the same bytes is rejected', async () => {
  await withFixture(async (server) => {
    const cursor = (await call(server, 'search_files', { query: '.ex', limit: 1 })).next_cursor
    const [payload, signature] = cursor.split('.')

    const message = await callFailing(server, 'search_files', {
      query: '.ex',
      cursor: `${payload}.${respell(signature)}`,
    })
    assert.match(message, /not valid/, 'only the issued spelling of a cursor may resume')
  })
})

test('a cursor from another process is rejected', async () => {
  await withFixture(async (first) => {
    const cursor = (await call(first, 'search_files', { query: '.ex', limit: 1 })).next_cursor

    await withFixture(async (second) => {
      assert.match(await callFailing(second, 'search_files', { query: '.ex', cursor }), /not valid/)
    })
  })
})

test('a cursor is not a position a client can forge', async () => {
  await withFixture(async (server) => {
    const forged = Buffer.from(JSON.stringify({ v: 1, s: 'x', t: 'y', p: 0 }), 'utf8').toString('base64url')

    assert.match(await callFailing(server, 'search_files', { query: '.ex', cursor: `${forged}.aaaa` }), /not valid/)
  })
})

test('a completed traversal returns a null cursor rather than an empty page forever', async () => {
  await withFixture(async (server) => {
    const page = await call(server, 'search_files', { query: '.ex' })
    assert.equal(page.next_cursor, null)
  })
})

test('cursors do not survive a server restart', async () => {
  await withRoot({ 'a.txt': 'x\n', 'b.txt': 'x\n', 'c.txt': 'x\n' }, async (server, root) => {
    const cursor = (await call(server, 'search_files', { query: '.txt', limit: 1 })).next_cursor

    const restarted = startServer(['--root', root, '--include', '**'])
    try {
      assert.match(await callFailing(restarted, 'search_files', { query: '.txt', cursor }), /not valid/)
    } finally {
      await restarted.close()
    }
  })
})
