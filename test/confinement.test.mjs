import assert from 'node:assert/strict'
import test from 'node:test'

import { call, callFailing, collect, FIXTURE, withFixture, withRoot } from './helpers/harness.mjs'

test('--include selects only matching files', async () => {
  await withFixture(async (server) => {
    const paths = (await collect(server, 'search_files', { query: '.ex' })).map((item) => item.path)
    assert.ok(paths.includes('lib/alpha.ex'))
    assert.ok(paths.includes('lib/beta.ex'))
  })
})

test('a path outside the include rules is never inventoried, searched, or read', async () => {
  await withFixture(async (server) => {
    assert.deepEqual(await collect(server, 'search_files', { query: 'creds' }), [])
    assert.deepEqual(await collect(server, 'search_text', { query: 'must-not-appear' }), [])
    await callFailing(server, 'read_text_file', { path: 'secrets/creds.env' })
  })
})

test('an unserved directory does not appear in a listing', async () => {
  await withFixture(async (server) => {
    const names = (await collect(server, 'list_directory')).map((entry) => entry.name)
    assert.deepEqual(names, ['lib'], 'secrets/ holds nothing served, so its name must not leak')
  })
})

test('--exclude narrows an include', async () => {
  await withFixture(
    async (server) => {
      assert.deepEqual(await collect(server, 'search_files', { query: 'beta' }), [])
      assert.ok((await collect(server, 'search_files', { query: 'alpha' })).length === 1)
    },
    ['--include', 'lib/**', '--exclude', 'lib/beta.ex'],
  )
})

test('--exclude cannot widen an include', async () => {
  await withFixture(
    async (server) => {
      assert.deepEqual(await collect(server, 'search_files', { query: 'creds' }), [])
    },
    ['--include', 'lib/**', '--exclude', 'nothing-matches'],
  )
})

test('traversal, absolute paths, backslashes, and NUL are rejected', async () => {
  await withFixture(async (server) => {
    for (const path of [
      '../package.json',
      '/etc/hostname',
      'lib/../../escape',
      'lib\u0000.ex',
      'lib\\alpha.ex',
      'C:\\lib\\alpha.ex',
      './lib/alpha.ex',
    ]) {
      const message = await callFailing(server, 'read_text_file', { path })
      assert.match(message, /relative path|not a readable regular file|not served/, path)
    }
  })
})

test('symbolic links are skipped, never followed', async () => {
  await withFixture(async (server) => {
    assert.deepEqual(await collect(server, 'search_files', { query: 'escape' }), [], 'a link must not be inventoried')
    assert.deepEqual(await collect(server, 'search_text', { query: 'outside the root' }), [])

    const message = await callFailing(server, 'read_text_file', { path: 'lib/escape.ex' })
    assert.equal(message.includes('outside the root'), false, 'the link target must not be read')
  })
})

test('a symlinked directory is not descended into', async () => {
  await withRoot({ 'kept/a.txt': 'kept\n', linked: { symlink: '../outside-dir' } }, async (server) => {
    const names = (await collect(server, 'list_directory')).map((entry) => entry.name)
    assert.deepEqual(names, ['kept'])
  })
})

test('a file that is not valid UTF-8 is listed but refused as text', async () => {
  await withFixture(async (server) => {
    const paths = (await collect(server, 'search_files', { query: 'binary' })).map((item) => item.path)
    assert.deepEqual(paths, ['lib/binary.ex'], 'a path listing is content-blind')

    const message = await callFailing(server, 'read_text_file', { path: 'lib/binary.ex' })
    assert.match(message, /not valid UTF-8/)
  })
})

test('--max-file-bytes removes a file from every tool', async () => {
  await withRoot(
    { 'small.txt': 'ok\n', 'large.txt': 'x'.repeat(100) },
    async (server) => {
      assert.deepEqual(
        (await collect(server, 'search_files', { query: '.txt' })).map((item) => item.path),
        ['small.txt'],
      )
      await callFailing(server, 'read_text_file', { path: 'large.txt' })
    },
    ['--include', '**', '--max-file-bytes', '10'],
  )
})

test('the host root never appears in a result', async () => {
  await withFixture(async (server, root) => {
    for (const [name, args] of [
      ['list_directory', {}],
      ['search_files', { query: '.ex' }],
      ['search_text', { query: 'alpha' }],
      ['read_text_file', { path: 'lib/alpha.ex' }],
    ]) {
      const serialized = JSON.stringify(await call(server, name, args))
      assert.equal(serialized.includes(root), false, `${name} must not disclose the host root`)
      assert.equal(serialized.includes('/Users'), false, `${name} must not disclose an absolute path`)
    }
  })
})

test('errors are bounded text without stacktraces or host paths', async () => {
  await withFixture(async (server, root) => {
    for (const [name, args] of [
      ['read_text_file', { path: 'lib/missing.ex' }],
      ['read_text_file', { path: '../escape' }],
      ['search_text', { query: 'x'.repeat(300) }],
      ['search_files', { query: '' }],
      ['list_directory', { limit: 0 }],
      ['write_text_file', { path: 'Bad Name', content: '' }],
    ]) {
      const message = await callFailing(server, name, args)
      assert.equal(message.includes('    at '), false, `${name}: no stacktrace may reach the client`)
      assert.equal(message.includes(root), false, `${name}: no host path may reach the client`)
      assert.ok(message.length < 1_000, `${name}: errors stay short`)
    }
  })
})

test('an unknown tool and unknown argument are refused', async () => {
  await withFixture(async (server) => {
    await callFailing(server, 'delete_everything', {})
    await callFailing(server, 'read_text_file', { path: 'lib/alpha.ex', follow_symlinks: true })
  })
})

test('the fixture is unchanged by a full read-only session', async () => {
  await withFixture(async (server) => {
    await collect(server, 'list_directory')
    await collect(server, 'search_text', { query: 'e' })
    const alpha = await collect(server, 'read_text_file', { path: 'lib/alpha.ex' })
    assert.equal(alpha.map((chunk) => chunk.text).join(''), FIXTURE['lib/alpha.ex'])
  })
})
