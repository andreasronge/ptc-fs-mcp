/**
 * Using the server from Node, in-process.
 *
 * The published binary speaks MCP over stdio and is the usual way in. This
 * script shows the other way: build the same server as a library and hand it
 * a transport you control. Here that is the SDK's in-memory transport, so the
 * whole exchange happens in one process with no subprocess and no pipes.
 *
 *   node examples/embed.mjs
 *
 * Run `npm run build` first, or install the package and import it by name.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InMemoryTransport } from '@modelcontextprotocol/server'

import { createServer, openRoot } from '../dist/index.js'

const PROTOCOL = '2026-07-28'

const workspace = mkdtempSync(join(tmpdir(), 'ptc-fs-mcp-example-'))

// `include` is mandatory and the default is no files, so a root you forget to
// configure exposes nothing rather than everything.
const root = openRoot({ root: workspace, include: ['**'], exclude: ['*.secret'] })
const server = createServer(root)

const [client, transport] = InMemoryTransport.createLinkedPair()
await server.connect(transport)
await client.start()

const pending = new Map()
client.onmessage = (message) => {
  const settle = pending.get(message.id)
  if (settle) {
    pending.delete(message.id)
    settle(message)
  }
}

let nextId = 0

/** One `tools/call`, returning the tool's structured result. */
async function call(name, args = {}) {
  nextId += 1
  const id = nextId
  const response = new Promise((resolve) => pending.set(id, resolve))

  await client.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL,
        'io.modelcontextprotocol/clientInfo': { name: 'embed-example', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  })

  const message = await response
  if (message.error) throw new Error(message.error.message)
  if (message.result.isError) throw new Error(message.result.content[0].text)
  return message.result.structuredContent
}

/** Follows `next_cursor` to the end of a paginated traversal. */
async function collect(name, args = {}) {
  const items = []
  let cursor

  do {
    const page = await call(name, { ...args, ...(cursor ? { cursor } : {}) })
    items.push(...page.items)
    cursor = page.next_cursor ?? undefined
  } while (cursor)

  return items
}

try {
  const written = await call('write_text_file', {
    path: 'report.md',
    content: '# Findings\n\nThe needle is in this line.\n',
  })
  console.log('wrote  ', written.path, `(${written.bytes} bytes)`, written.content_hash)

  // Reads are live, so the file just written is already visible.
  console.log(
    'listing',
    (await collect('list_directory')).map((entry) => entry.name),
  )
  console.log('search ', await collect('search_text', { query: 'needle' }))

  const page = await call('read_text_file', { path: 'report.md' })
  console.log('read   ', JSON.stringify(page.items.map((chunk) => chunk.text).join('')))
  // The hash covers the bytes this call returned, so a citation names them.
  console.log('cite   ', page.content_hash)

  // The exclude rule wins over the include, and a write that could not be read
  // back is refused rather than silently landing somewhere unreadable.
  await call('write_text_file', { path: 'api.secret', content: 'nope' }).catch((error) =>
    console.log('refused', error.message),
  )
} finally {
  await client.close()
  rmSync(workspace, { recursive: true, force: true })
}
