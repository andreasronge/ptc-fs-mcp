import assert from 'node:assert/strict'
import test from 'node:test'

import { call, callFailing, collect, withFixture, withRoot } from './helpers/harness.mjs'

test('search_text reports the path and line number of a match', async () => {
  await withFixture(async (server) => {
    const matches = await collect(server, 'search_text', { query: 'needle' })
    assert.deepEqual(matches, [{ path: 'lib/beta.ex', line: 1, text: 'beta needle here' }])
  })
})

test('search_text scopes to a path prefix', async () => {
  await withRoot({ 'a/hit.txt': 'needle\n', 'b/hit.txt': 'needle\n' }, async (server) => {
    assert.deepEqual(
      (await collect(server, 'search_text', { query: 'needle', path: 'a' })).map((match) => match.path),
      ['a/hit.txt'],
    )
    assert.equal((await collect(server, 'search_text', { query: 'needle' })).length, 2)
  })
})

test('search_text traverses far beyond one page', async () => {
  const text = Array.from({ length: 620 }, (_, index) => `needle ${index}\n`).join('')

  await withRoot({ 'many.txt': text }, async (server) => {
    const matches = await collect(server, 'search_text', { query: 'needle', limit: 37 })
    assert.equal(matches.length, 620)
    assert.deepEqual(
      matches.map((match) => match.line),
      Array.from({ length: 620 }, (_, index) => index + 1),
    )
  })
})

test('search_text makes cursor progress through a huge sparse line', async () => {
  const text = `${'a'.repeat(600_000)}needle\n`

  await withRoot({ 'sparse.txt': text }, async (server) => {
    const first = await call(server, 'search_text', { query: 'needle', limit: 1 })
    assert.deepEqual(first.items, [], 'the scan budget stops before the match')
    assert.ok(first.next_cursor, 'a budget stop must still return a progress cursor')

    const matches = await collect(server, 'search_text', { query: 'needle', limit: 1 })
    assert.equal(matches.length, 1)
    assert.equal(matches[0].line, 1)
  })
})

test('a match straddling the scan buffer boundary is still found', async () => {
  // The query begins at byte 8_190, three bytes before the 8_192-byte buffer ends.
  const text = `${'a'.repeat(8_190)}needle\n`

  await withRoot({ 'straddle.txt': text }, async (server) => {
    const matches = await collect(server, 'search_text', { query: 'needle' })
    assert.equal(matches.length, 1, 'the scanner must replay the line tail across a buffer refill')
  })
})

test('a final line with no trailing newline is reported', async () => {
  await withRoot({ 'tail.txt': 'first\nneedle at the end' }, async (server) => {
    assert.deepEqual(await collect(server, 'search_text', { query: 'needle' }), [
      { path: 'tail.txt', line: 2, text: 'needle at the end' },
    ])
  })
})

test('a line that is not valid UTF-8 is skipped, and its neighbours are not', async () => {
  const bytes = Buffer.concat([
    Buffer.from('needle clean\n', 'utf8'),
    Buffer.from('needle '),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('\nneedle also clean\n', 'utf8'),
  ])

  await withRoot({ 'mixed.txt': bytes }, async (server) => {
    assert.deepEqual(
      (await collect(server, 'search_text', { query: 'needle' })).map((match) => match.line),
      [1, 3],
      'a line either reports whole or not at all',
    )
  })
})

test('search_text carries a CRLF-trimmed line and a bounded evidence length', async () => {
  await withRoot({ 'crlf.txt': 'needle here\r\n', 'long.txt': `needle ${'x'.repeat(4_000)}\n` }, async (server) => {
    const matches = await collect(server, 'search_text', { query: 'needle' })
    const crlf = matches.find((match) => match.path === 'crlf.txt')
    const long = matches.find((match) => match.path === 'long.txt')

    assert.equal(crlf.text, 'needle here', 'the carriage return is not evidence')
    assert.ok(long.text.length <= 1_024, 'evidence is capped rather than unbounded')
    assert.ok(long.text.startsWith('needle '))
  })
})

test('search_files matches a literal substring of the path', async () => {
  await withRoot({ 'lib/one.ts': 'x', 'lib/two.js': 'y', 'docs/one.md': 'z' }, async (server) => {
    assert.deepEqual(
      (await collect(server, 'search_files', { query: 'one' })).map((item) => item.path),
      ['docs/one.md', 'lib/one.ts'],
    )
    assert.deepEqual(await collect(server, 'search_files', { query: 'nothing' }), [])
  })
})

test('a query is required, single-line, and bounded', async () => {
  await withFixture(async (server) => {
    for (const query of ['', 'a\nb', 'a\rb', 'x'.repeat(300), 7, null]) {
      await callFailing(server, 'search_text', { query })
      await callFailing(server, 'search_files', { query })
    }
  })
})

test('search results are stable and reproducible across identical calls', async () => {
  await withFixture(async (server) => {
    const first = await call(server, 'search_text', { query: 'line' })
    const second = await call(server, 'search_text', { query: 'line' })
    assert.deepEqual(first, second, 'an unchanged tree must give byte-identical results and hashes')
  })
})
