import assert from 'node:assert/strict'
import test from 'node:test'

import { call, callFailing, collect, startServer, withFixture, withRoot } from './helpers/harness.mjs'

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

  // The scan budget is pinned rather than inherited, so this keeps testing the
  // empty-progress-page path regardless of what the default is tuned to.
  const scoped = ['--include', '**', '--max-scan-bytes', '262144']
  await withRoot(
    { 'sparse.txt': text },
    async (server) => {
      const first = await call(server, 'search_text', { query: 'needle', limit: 1 })
      assert.deepEqual(first.items, [], 'the scan budget stops before the match')
      assert.ok(first.next_cursor, 'a budget stop must still return a progress cursor')

      const matches = await collect(server, 'search_text', { query: 'needle', limit: 1 })
      assert.equal(matches.length, 1)
      assert.equal(matches[0].line, 1)
    },
    scoped,
  )
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

test('any_of matches a line containing any one of the terms', async () => {
  await withRoot(
    { 'a.txt': 'has TODO here\n', 'b.txt': 'has FIXME here\n', 'c.txt': 'has neither\n' },
    async (server) => {
      const matches = await collect(server, 'search_text', { any_of: ['TODO', 'FIXME'] })
      assert.deepEqual(
        matches.map((match) => match.path),
        ['a.txt', 'b.txt'],
      )
    },
  )
})

test('a line matching two terms at once is reported once', async () => {
  await withRoot({ 'both.txt': 'TODO and FIXME on one line\n' }, async (server) => {
    const matches = await collect(server, 'search_text', { any_of: ['TODO', 'FIXME'] })
    assert.equal(matches.length, 1)
  })
})

test('search_files accepts any_of over the path', async () => {
  await withRoot({ 'src/a.ts': 'x\n', 'test/b.mjs': 'x\n', 'docs/c.md': 'x\n' }, async (server) => {
    assert.deepEqual(await collect(server, 'search_files', { any_of: ['.ts', '.mjs'] }), [
      { path: 'src/a.ts' },
      { path: 'test/b.mjs' },
    ])
  })
})

test('case_insensitive folds ASCII letters in both tools', async () => {
  await withRoot({ 'Mixed.TXT': 'A Needle Here\n' }, async (server) => {
    assert.equal((await collect(server, 'search_text', { query: 'needle' })).length, 0)
    assert.equal((await collect(server, 'search_text', { query: 'NEEDLE', case_insensitive: true })).length, 1)
    assert.deepEqual(await collect(server, 'search_files', { query: 'mixed.txt', case_insensitive: true }), [
      { path: 'Mixed.TXT' },
    ])
  })
})

test('case folding is ASCII only, so non-ASCII case is left alone', async () => {
  await withRoot({ 'u.txt': 'CAFÉ\n' }, async (server) => {
    assert.equal((await collect(server, 'search_text', { query: 'café', case_insensitive: true })).length, 0)
    assert.equal((await collect(server, 'search_text', { query: 'CAFÉ', case_insensitive: true })).length, 1)
  })
})

test('a multi-term match straddling the scan buffer boundary is still found', async () => {
  const text = `${'a'.repeat(8_190)}needle\n`

  await withRoot({ 'straddle.txt': text }, async (server) => {
    assert.equal((await collect(server, 'search_text', { any_of: ['zz', 'needle'] })).length, 1)
    assert.equal(
      (await collect(server, 'search_text', { any_of: ['zz', 'NEEDLE'], case_insensitive: true })).length,
      1,
      'the replayed line tail must be folded the same way the scan is',
    )
  })
})

test('query and any_of are mutually exclusive, and one is required', async () => {
  await withFixture(async (server) => {
    // These two cannot be said in JSON Schema, so the tool says them itself.
    assert.match(
      await callFailing(server, 'search_text', { query: 'a', any_of: ['b'] }),
      /pass either query or any_of, not both/,
    )
    assert.match(await callFailing(server, 'search_text', {}), /query must be a non-empty string/)
  })
})

test('the published schema bounds any_of and case_insensitive before the tool runs', async () => {
  await withFixture(async (server) => {
    // Declared rather than merely enforced, so a client reading inputSchema
    // sees the same limits the server applies. Each refusal names its field.
    for (const args of [
      { any_of: [] },
      { any_of: Array.from({ length: 17 }, (_, index) => `t${index}`) },
      { any_of: ['ok', 7] },
    ]) {
      assert.match(await callFailing(server, 'search_text', args), /any_of/)
    }
    assert.match(
      await callFailing(server, 'search_text', { query: 'a', case_insensitive: 'yes' }),
      /case_insensitive/,
    )
  })
})

test('a cursor is bound to the terms and the folding it was issued for', async () => {
  await withRoot({ 'a.txt': 'one\ntwo\nthree\n' }, async (server) => {
    const first = await call(server, 'search_text', { any_of: ['one', 'two'], limit: 1 })
    assert.ok(first.next_cursor)

    for (const args of [
      { any_of: ['one', 'three'] },
      { any_of: ['one'] },
      { query: 'one' },
      { any_of: ['one', 'two'], case_insensitive: true },
    ]) {
      const message = await callFailing(server, 'search_text', { ...args, cursor: first.next_cursor })
      assert.match(message, /cursor/)
    }
  })
})

test('search_text skips a binary file whole rather than scanning it', async () => {
  // Both signals: a NUL, and bytes that do not decode as UTF-8.
  const binary = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x00]), Buffer.alloc(200_000, 0xc0)])

  await withRoot({ 'blob.bin': binary, 'notes.txt': 'needle in text\n' }, async (server) => {
    assert.deepEqual(
      (await collect(server, 'search_text', { query: 'needle' })).map((match) => match.path),
      ['notes.txt'],
    )
  })
})

test('a file is skipped only when both binary signals agree', async () => {
  // NUL is valid UTF-8, so a NUL alone must not discard a text file...
  const withNul = `first line\nsecond\0line has a nul\nneedle here\n`
  // ...and one malformed line must not discard the rest either, which is the
  // behaviour `evidence` already promises line by line.
  const withBadByte = Buffer.concat([Buffer.from('needle up top\n'), Buffer.from([0xff, 0xfe, 0x0a])])

  await withRoot({ 'a.txt': withNul, 'b.txt': withBadByte }, async (server) => {
    assert.deepEqual((await collect(server, 'search_text', { query: 'needle' })).map((match) => match.path).sort(), [
      'a.txt',
      'b.txt',
    ])
  })
})

test('a binary file is still listed and still refuses to be read as text', async () => {
  const binary = Buffer.from([0x00, 0xff, 0xfe, 0x41])

  await withRoot({ 'blob.bin': binary }, async (server) => {
    assert.deepEqual(
      (await call(server, 'list_directory', { path: '.' })).items.map((entry) => entry.name),
      ['blob.bin'],
      'listings stay content-blind; only the scanner sniffs',
    )
    assert.match(await callFailing(server, 'read_text_file', { path: 'blob.bin' }), /not valid UTF-8/)
  })
})

test('the binary sniff obeys the scan budget rather than reading past it', async () => {
  const binary = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x00]), Buffer.alloc(50_000, 0xc0)])

  await withRoot(
    { 'blob.bin': binary, 'notes.txt': 'needle in text\n' },
    async (server) => {
      const matches = await collect(server, 'search_text', { query: 'needle' })
      assert.deepEqual(
        matches.map((match) => match.path),
        ['notes.txt'],
        'a clamped sniff must still classify, and the traversal must still finish',
      )
    },
    ['--include', '**', '--max-scan-bytes', '8192'],
  )
})

test('binary evidence must be co-located on one line, not spread over the file', async () => {
  // A NUL on one line and a malformed byte on another is a text file with two
  // odd lines, not a binary. Skipping it whole would discard `needle` for
  // exactly the reason `evidence` exists to drop a single line instead.
  const mixed = Buffer.concat([Buffer.from('needle here\n'), Buffer.from([0x00, 0x0a, 0xff, 0x0a])])

  await withRoot({ 'mixed.txt': mixed }, async (server) => {
    assert.deepEqual(
      (await collect(server, 'search_text', { query: 'needle' })).map((match) => match.line),
      [1],
      'the good line survives lines that are individually odd',
    )
  })
})

test('a line that both holds a NUL and fails to decode marks the file binary', async () => {
  const binary = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x0a]), Buffer.alloc(50_000, 0xc0)])

  await withRoot({ 'blob.bin': binary, 'notes.txt': 'needle in text\n' }, async (server) => {
    assert.deepEqual(
      (await collect(server, 'search_text', { query: 'needle' })).map((match) => match.path),
      ['notes.txt'],
    )
  })
})

test('a binary file with no newline in its opening bytes is still classified', async () => {
  // The earlier fixtures all held a newline early, so a `return false` on the
  // no-newline case passed them while disabling the test on real binaries,
  // which frequently hold no 0x0a at all in their first 8 KiB.
  const binary = Buffer.concat([Buffer.alloc(20_000, 0xc0), Buffer.from([0x00]), Buffer.from('needle\n')])

  await withRoot({ 'blob.bin': binary, 'notes.txt': 'needle in text\n' }, async (server) => {
    assert.deepEqual(
      (await collect(server, 'search_text', { query: 'needle' })).map((match) => match.path),
      ['notes.txt'],
    )
  })
})

test('classification does not depend on how the pages happened to fall', async () => {
  // The sniff used to shrink to whatever budget remained, so a file reached
  // late in a page could be scanned unclassified and never re-examined.
  const filler = `${'padding line that is quite long indeed\n'.repeat(200)}`
  const binary = Buffer.concat([Buffer.alloc(20_000, 0xc0), Buffer.from([0x00])])
  const tree = { 'a-filler.txt': filler, 'b-blob.bin': binary, 'c-notes.txt': 'needle in text\n' }

  for (const extra of [[], ['--max-scan-bytes', '8192'], ['--max-scan-bytes', '9000']]) {
    await withRoot(
      tree,
      async (server) => {
        for (const limit of [1, 5, undefined]) {
          const args = { query: 'needle', ...(limit === undefined ? {} : { limit }) }
          assert.deepEqual(
            (await collect(server, 'search_text', args)).map((match) => match.path),
            ['c-notes.txt'],
            `budget ${extra[1] ?? 'default'} limit ${limit}`,
          )
        }
      },
      ['--include', '**', ...extra],
    )
  }
})

test('a short binary file with no trailing newline is classified', async () => {
  // At end of file the last segment is a whole line, so it answers the same
  // rule as one; treating it as possibly-truncated let `text\0\xff` through.
  const binary = Buffer.from([0x74, 0x65, 0x78, 0x74, 0x00, 0xff])

  await withRoot({ 'tiny.bin': binary, 'notes.txt': 'needle in text\n' }, async (server) => {
    assert.deepEqual(
      (await collect(server, 'search_text', { query: 'text' })).map((match) => match.path),
      ['notes.txt'],
    )
  })
})

test('--max-scan-bytes may not be set below one binary sniff', async () => {
  // A budget smaller than one sniff could not hold it, and the sniff is a
  // fixed size so that classification does not depend on the page. Refusing
  // the configuration is what keeps both of those true at once.
  const server = startServer(['--root', process.cwd(), '--include', '**', '--max-scan-bytes', '4096'])
  const code = await new Promise((resolve) => server.child.once('exit', resolve))
  assert.equal(code, 64)
  assert.match(server.stderr(), /limits are not valid/)
})
