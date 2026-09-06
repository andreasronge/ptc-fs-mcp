import assert from 'node:assert/strict'
import test from 'node:test'

import { call, callFailing, collect, startServer, withRoot } from './helpers/harness.mjs'

const TREE = {
  'app.ts': 'const needle = 1\n',
  'src/deep.ts': 'needle again\n',
  '.env': 'TOKEN=needle-secret\n',
  '.env.local': 'TOKEN=needle-secret\n',
  'server.pem': 'needle-key\n',
  'node_modules/pkg/index.js': 'needle in a dependency\n',
  '_build/dev/app.beam': 'needle in elixir build output\n',
  'deps/jason/mix.exs': 'needle in an elixir dependency\n',
  '__pycache__/mod.pyc': 'needle in python cache\n',
  '.git/config': 'needle in git\n',
}

/** Names that are tool output in one ecosystem and ordinary words in a file share. */
const AMBIGUOUS = {
  'target/Q3 pipeline.csv': 'needle,sales target\n',
  'coverage/policy.csv': 'needle,insurance coverage\n',
  'build/site plan.txt': 'needle in a construction plan\n',
  'dist/regions.csv': 'needle,distribution list\n',
  'Deck.key': 'needle in a keynote file\n',
}

test('a bare "." names the root, the way every client first asks for it', async () => {
  await withRoot(TREE, async (server) => {
    const dotted = await call(server, 'list_directory', { path: '.' })
    const empty = await call(server, 'list_directory', { path: '' })
    assert.deepEqual(dotted.items, empty.items)
    assert.equal(dotted.content_hash, empty.content_hash)

    assert.deepEqual(
      (await collect(server, 'search_text', { query: 'needle', path: '.' })).map((match) => match.path),
      ['app.ts', 'src/deep.ts'],
    )
  })
})

test('"." is the only dot path accepted; a dot segment is still rejected', async () => {
  await withRoot(TREE, async (server) => {
    for (const path of ['./src', 'src/.', './', '..', 'src/../src', '.hidden/..']) {
      const message = await callFailing(server, 'list_directory', { path })
      assert.match(message, /not a relative path inside the root/)
    }
  })
})

test('dependency and tooling directories are excluded by default', async () => {
  await withRoot(TREE, async (server) => {
    const matches = await collect(server, 'search_text', { query: 'needle' })
    assert.deepEqual(
      matches.map((match) => match.path),
      ['app.ts', 'src/deep.ts'],
      'node_modules, _build, deps, __pycache__, and .git are all skipped',
    )

    const listed = (await call(server, 'list_directory', { path: '' })).items.map((entry) => entry.name)
    assert.deepEqual(listed, ['app.ts', 'src'])
  })
})

test('an Elixir checkout hides _build and deps without any configuration', async () => {
  await withRoot(
    {
      'lib/app.ex': 'defmodule App do\nend\n',
      '_build/dev/app.beam': 'defmodule\n',
      'deps/jason/lib/jason.ex': 'defmodule\n',
    },
    async (server) => {
      assert.deepEqual(
        (await collect(server, 'search_text', { query: 'defmodule' })).map((match) => match.path),
        ['lib/app.ex'],
      )
    },
  )
})

test('names that are output in one toolchain and data in a file share are served', async () => {
  // The cost of hiding a directory is silent, so the default list holds only
  // names nobody chooses for their own data. `target`, `coverage`, `build`,
  // and `dist` are ordinary business words, and `.key` is Apple Keynote.
  await withRoot(AMBIGUOUS, async (server) => {
    assert.deepEqual((await collect(server, 'search_text', { query: 'needle' })).map((match) => match.path).sort(), [
      'Deck.key',
      'build/site plan.txt',
      'coverage/policy.csv',
      'dist/regions.csv',
      'target/Q3 pipeline.csv',
    ])
  })
})

test('credential filenames are excluded by default', async () => {
  await withRoot(TREE, async (server) => {
    for (const path of ['.env', '.env.local', 'server.pem']) {
      const message = await callFailing(server, 'read_text_file', { path })
      assert.match(message, /--exclude pattern|not served by this root|no --include pattern/)
    }
    const paths = await collect(server, 'search_files', { query: 'env' })
    assert.deepEqual(paths, [], 'an excluded path is never inventoried, so it cannot leak through search either')
  })
})

test('--no-default-exclude restores every built-in exclusion at once', async () => {
  await withRoot(
    TREE,
    async (server) => {
      const matches = await collect(server, 'search_text', { query: 'needle' })
      assert.deepEqual(matches.map((match) => match.path).sort(), [
        '.env',
        '.env.local',
        '.git/config',
        '__pycache__/mod.pyc',
        '_build/dev/app.beam',
        'app.ts',
        'deps/jason/mix.exs',
        'node_modules/pkg/index.js',
        'server.pem',
        'src/deep.ts',
      ])
    },
    ['--include', '**', '--no-default-exclude'],
  )
})

test('an explicit --exclude still narrows on top of the defaults', async () => {
  await withRoot(
    TREE,
    async (server) => {
      const matches = await collect(server, 'search_text', { query: 'needle' })
      assert.deepEqual(
        matches.map((match) => match.path),
        ['app.ts'],
      )
    },
    ['--include', '**', '--exclude', 'src/**'],
  )
})

test('a write to a default-excluded destination is refused', async () => {
  await withRoot(TREE, async (server) => {
    // A leading dot is not a legal basename here, so `.env` never reaches the
    // selector. `server.pem` is a legal basename that the defaults still cover.
    const message = await callFailing(server, 'write_text_file', { path: 'server.pem', content: 'x\n' })
    assert.match(message, /--exclude/)
  })
})

test('a literal --include a built-in exclude defeats is named at startup', async () => {
  const server = startServer(['--root', process.cwd(), '--include', '.env'])
  try {
    await call(server, 'list_directory', {})
    assert.match(server.stderr(), /--include \.env matches a built-in exclude/)
    assert.match(server.stderr(), /--no-default-exclude/)
  } finally {
    await server.close()
  }
})

test('no such diagnostic is printed for an ordinary include', async () => {
  const server = startServer(['--root', process.cwd(), '--include', '**'])
  try {
    await call(server, 'list_directory', {})
    assert.doesNotMatch(server.stderr(), /built-in exclude/)
  } finally {
    await server.close()
  }
})

test('listing one level does not pay for the whole tree', async () => {
  // The old listing derived entries from a full recursive inventory, so a root
  // with more files than --max-files could not be listed at all -- which is
  // every real checkout. A listing needs one served file per child, not all of
  // them, so this must succeed well below the file ceiling.
  const files = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`deep/nested/f${index}.txt`, 'x\n']))
  files['top.txt'] = 'x\n'

  await withRoot(
    files,
    async (server) => {
      const listed = await call(server, 'list_directory', { path: '.' })
      assert.deepEqual(
        listed.items.map((entry) => `${entry.kind}:${entry.name}`),
        ['directory:deep', 'file:top.txt'],
      )
      assert.match(await callFailing(server, 'search_files', { query: 'f1' }), /file limit exceeded/)
    },
    ['--include', '**', '--max-files', '10'],
  )
})

test('a directory appears only because it holds something served', async () => {
  await withRoot(
    { 'shown/keep.txt': 'x\n', 'hidden/skip.md': 'x\n', 'empty/.keep': '' },
    async (server) => {
      const listed = await call(server, 'list_directory', { path: '' })
      assert.deepEqual(
        listed.items.map((entry) => entry.name),
        ['shown'],
        'an unserved directory’s name must not leak through the listing',
      )
    },
    ['--include', '**/*.txt'],
  )
})

test('--max-scan-bytes trades a longer page for fewer round trips', async () => {
  const text = `${'a'.repeat(600_000)}needle\n`

  await withRoot(
    { 'sparse.txt': text },
    async (server) => {
      const wide = await call(server, 'search_text', { query: 'needle' })
      assert.equal(wide.items.length, 1, 'one page must reach a match 600KB in')
      assert.equal(wide.next_cursor, null)
    },
    ['--include', '**', '--max-scan-bytes', '1000000'],
  )
})

test('the walk ceilings are configurable and still refuse what they must', async () => {
  await withRoot(
    { 'a/b/c/d.txt': 'x\n' },
    async (server) => {
      assert.match(await callFailing(server, 'search_files', { query: 'd' }), /directory depth limit exceeded/)
    },
    ['--include', '**', '--max-depth', '1'],
  )
})

test('the built-in excludes match without regard to case', async () => {
  // On a case-insensitive filesystem `NODE_MODULES/pkg.js` and
  // `node_modules/pkg.js` name the same bytes, so a case-sensitive default
  // would be one alias away from being bypassed.
  await withRoot(
    { 'NODE_MODULES/pkg.js': 'leaked\n', '.ENV': 'TOKEN=leaked\n', 'app.js': 'kept\n' },
    async (server) => {
      assert.deepEqual(await collect(server, 'search_files', { any_of: ['pkg', 'ENV'] }), [])
      assert.match(await callFailing(server, 'read_text_file', { path: 'NODE_MODULES/pkg.js' }), /--exclude pattern/)
      assert.deepEqual(
        (await collect(server, 'search_text', { query: 'kept' })).map((match) => match.path),
        ['app.js'],
      )
    },
  )
})

test('an operator --exclude stays case-sensitive', async () => {
  // The built-in list is caseless because it names tool output nobody chose.
  // An explicit pattern means the exact spelling the operator wrote.
  await withRoot(
    { 'Build/x.txt': 'kept\n' },
    async (server) => {
      assert.deepEqual(
        (await collect(server, 'search_text', { query: 'kept' })).map((match) => match.path),
        ['Build/x.txt'],
      )
    },
    ['--include', '**', '--exclude', 'build/**'],
  )
})

test('the depth ceiling is measured from the root, not from the listed directory', async () => {
  await withRoot(
    { 'a/b/c/d.txt': 'x\n' },
    async (server) => {
      assert.match(await callFailing(server, 'list_directory', { path: 'a/b' }), /directory depth limit exceeded/)
      assert.match(await callFailing(server, 'search_files', { query: 'd' }), /directory depth limit exceeded/)
    },
    ['--include', '**', '--max-depth', '1'],
  )
})

test('a listing is still bounded by the file ceiling', async () => {
  // The ceiling no longer covers the whole tree, which was the point, but one
  // listing must not materialize an unbounded directory.
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index}.txt`, 'x\n']))

  await withRoot(
    files,
    async (server) => {
      assert.match(await callFailing(server, 'list_directory', { path: '.' }), /file limit exceeded/)
    },
    ['--include', '**', '--max-files', '5'],
  )
})

test('--max-depth 0 is accepted, and means the root may hold no directories', async () => {
  // A ceiling refuses the call rather than truncating the walk -- that is how
  // every other ceiling here behaves -- so zero serves a flat root and fails
  // one with a subdirectory. The point of the test is that the CLI accepts it
  // at all: `positiveInteger` used to reject the value `openRoot` allows.
  await withRoot(
    { 'top.txt': 'x\n' },
    async (server) => {
      assert.deepEqual(
        (await collect(server, 'search_files', { query: '.txt' })).map((entry) => entry.path),
        ['top.txt'],
      )
    },
    ['--include', '**', '--max-depth', '0'],
  )

  await withRoot(
    { 'top.txt': 'x\n', 'sub/deep.txt': 'x\n' },
    async (server) => {
      assert.match(await callFailing(server, 'search_files', { query: '.txt' }), /directory depth limit exceeded/)
    },
    ['--include', '**', '--max-depth', '0'],
  )
})

test('the file ceiling bounds listed directories, not only listed files', async () => {
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`d${index}/x.txt`, 'x\n']))

  await withRoot(
    files,
    async (server) => {
      assert.match(await callFailing(server, 'list_directory', { path: '.' }), /file limit exceeded/)
    },
    ['--include', '**', '--max-files', '3'],
  )
})
