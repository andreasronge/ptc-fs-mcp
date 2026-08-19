import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { BINARY, call, FIXTURE, makeRoot, PROTOCOL, startServer, withFixture } from './helpers/harness.mjs'

test('advertises exactly the five tools, with write marked as a write', async () => {
  await withFixture(async (server) => {
    const response = await server.request('tools/list')
    const tools = response.result.tools
    const names = tools.map((tool) => tool.name).sort()

    assert.deepEqual(names, ['list_directory', 'read_text_file', 'search_files', 'search_text', 'write_text_file'])

    for (const tool of tools) {
      const expected = tool.name === 'write_text_file' ? false : true
      assert.equal(tool.annotations.readOnlyHint, expected, `${tool.name} readOnlyHint`)
      assert.equal(tool.annotations.openWorldHint, false, `${tool.name} must not be open-world`)
    }
  })
})

test('advertises one protocol profile and no optional capability', async () => {
  await withFixture(async (server) => {
    const response = await server.request('server/discover')
    const result = response.result

    assert.deepEqual(result.supportedVersions, [PROTOCOL], 'exactly the latest profile, with no downgrade path')
    assert.deepEqual(Object.keys(result.capabilities), ['tools'], 'no roots, sampling, logging, or tasks')
    assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'ptc-fs-mcp')
  })
})

test('a legacy initialize opening is refused rather than served', async () => {
  await withFixture(async (server) => {
    const response = await server.raw({
      jsonrpc: '2.0',
      id: 900,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'legacy', version: '0' },
      },
    })

    assert.ok(response.error, 'the legacy handshake must not be answered with a result')
    assert.match(JSON.stringify(response.error), new RegExp(PROTOCOL))
  })
})

test('the connection stays usable after a legacy opening is refused', async () => {
  await withFixture(async (server) => {
    await server.raw({ jsonrpc: '2.0', id: 901, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    const listing = await call(server, 'list_directory')
    assert.ok(listing.items.length > 0, 'a modern opening must still be accepted')
  })
})

test('stdout carries protocol messages only', async () => {
  await withFixture(async (server) => {
    const response = await server.request('tools/list')
    assert.equal(response.jsonrpc, '2.0')
    assert.equal(server.stderr().includes('{"jsonrpc"'), false, 'protocol must not leak onto stderr')
  })
})

test('a cancellation notification leaves the server usable', async () => {
  await withFixture(async (server) => {
    await server.raw({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } })
    const after = await call(server, 'list_directory')
    assert.ok(after.items.length > 0)
  })
})

test('closing stdin terminates the server cleanly', async () => {
  const fixture = makeRoot(FIXTURE)
  try {
    const server = startServer(['--root', fixture.root, '--include', 'lib/**'])
    await call(server, 'list_directory')
    server.child.stdin.end()

    const code = await new Promise((resolve) => server.child.once('exit', resolve))
    assert.equal(code, 0, 'end of input must be an ordinary shutdown')
  } finally {
    fixture.cleanup()
  }
})

test('SIGTERM terminates the server cleanly', async () => {
  const fixture = makeRoot(FIXTURE)
  const server = startServer(['--root', fixture.root, '--include', 'lib/**'])
  try {
    await call(server, 'list_directory')
    const exited = new Promise((resolve) => server.child.once('exit', (code, signal) => resolve({ code, signal })))
    server.child.kill('SIGTERM')
    assert.deepEqual(await exited, { code: 0, signal: null })
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL')
    fixture.cleanup()
  }
})

test('--include is mandatory, so the default is no files', async () => {
  const fixture = makeRoot(FIXTURE)
  try {
    const server = startServer(['--root', fixture.root])
    const code = await new Promise((resolve) => server.child.once('exit', resolve))

    assert.equal(code, 64, 'a server with no include rules must refuse to start')
    assert.match(server.stderr(), /--include/)
  } finally {
    fixture.cleanup()
  }
})

test('an include set that cannot reach the root warns rather than refusing to start', async () => {
  const fixture = makeRoot(FIXTURE)
  const narrow = startServer(['--root', fixture.root, '--include', 'lib/**'])
  const whole = startServer(['--root', fixture.root, '--include', '**'])
  try {
    // Both serve reads; only the first can never accept a write.
    await call(narrow, 'list_directory')
    await call(whole, 'list_directory')

    assert.match(narrow.stderr(), /write_text_file will refuse every call/)
    assert.equal(narrow.stderr().includes('{"jsonrpc"'), false, 'the warning goes to stderr, the protocol to stdout')
    assert.equal(whole.stderr(), '', 'a root-level include has nothing to warn about')
  } finally {
    await narrow.close()
    await whole.close()
    fixture.cleanup()
  }
})

test('startup failures are usage errors carrying no stacktrace', async () => {
  for (const [args, pattern] of [
    [['--include', '**'], /--root is required/],
    [['--root', '/nonexistent-ptc-fs-mcp', '--include', '**'], /root does not exist/],
    [['--root', '.', '--include', '**', '--max-write-bytes', 'x'], /positive integer/],
    [['--root', '.', '--include', '**', '--nope', 'x'], /unknown option/],
  ]) {
    const server = startServer(args)
    const code = await new Promise((resolve) => server.child.once('exit', resolve))

    assert.equal(code, 64, args.join(' '))
    assert.match(server.stderr(), pattern)
    assert.equal(server.stderr().includes('    at '), false, 'no stacktrace may reach the operator')
  }
})

test('--help and --version print and exit successfully', async () => {
  for (const [flag, pattern] of [
    ['--help', /Usage:\s+ptc-fs-mcp/],
    ['--version', /^\d+\.\d+\.\d+/],
  ]) {
    const child = spawn(process.execPath, [BINARY, flag], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
    })

    const code = await new Promise((resolve) => child.once('close', resolve))
    assert.equal(code, 0, flag)
    assert.match(output, pattern)
  }
})
