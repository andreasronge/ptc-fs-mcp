/**
 * ptc-fs-mcp -- a small filesystem MCP server over one confined root.
 *
 * The package is usable two ways. As a binary it speaks MCP over stdio and is
 * installed from a host document. As a library it hands you the same
 * `McpServer` so you can connect it to a transport of your own:
 *
 * ```ts
 * import { createServer, openRoot } from 'ptc-fs-mcp'
 *
 * const server = createServer(openRoot({ root: './workspace', include: ['**'] }))
 * await server.connect(myTransport)
 * ```
 */

import { createRequire } from 'node:module'
import type { McpServer } from '@modelcontextprotocol/server'

import { createServer as build, type ServerIdentity } from './tools.js'
import type { Root } from './root.js'

const manifest = createRequire(import.meta.url)('../package.json') as { name: string; version: string }

/** This package's name and version, as the server reports them to a client. */
export const IDENTITY: ServerIdentity = { name: 'ptc-fs-mcp', version: manifest.version }

/**
 * Builds the MCP server for a live root.
 *
 * The server is not connected to anything; give it a transport, or use
 * {@link serveStdio} from the SDK as the binary does.
 */
export function createServer(root: Root, identity: ServerIdentity = IDENTITY): McpServer {
  return build(root, identity)
}

export { openRoot, DEFAULT_LIMITS } from './root.js'
export type { Root, RootOptions, Limits, FileFact } from './root.js'
export { ConfigError, ToolError } from './errors.js'
export { normalizeRelative, compileGlob, createSelector } from './paths.js'
export type { Selector } from './paths.js'
export type { ServerIdentity } from './tools.js'
