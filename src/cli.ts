#!/usr/bin/env node
/**
 * The stdio binary. An MCP host spawns this and speaks the latest profile to
 * it; there is no legacy handshake and no downgrade path.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { ConfigError } from './errors.js'
import { createServer, IDENTITY } from './index.js'
import { openRoot, type Limits, type RootOptions } from './root.js'

const USAGE = `ptc-fs-mcp ${IDENTITY.version} -- filesystem MCP server over stdio

Usage:
  ptc-fs-mcp --root <dir> --include <glob> [--include <glob>...] [options]

Options:
  --root <dir>            Directory to confine to. Required.
  --include <glob>        Serve paths matching this glob. Required, repeatable.
                          The default is no files.
  --exclude <glob>        Never serve paths matching this glob. Repeatable.
                          May only narrow what --include selected.
  --max-file-bytes <n>    Do not serve files larger than this.
  --max-write-bytes <n>   Largest write_text_file payload. Default 65536.
  --help                  Print this message.
  --version               Print the version.

Paths are relative to the root; symbolic links are skipped, never followed.
Protocol messages go to stdout, diagnostics to stderr.`

export function parseArguments(argv: readonly string[]): RootOptions {
  const include: string[] = []
  const exclude: string[] = []
  const limits: { -readonly [K in keyof Limits]?: Limits[K] } = {}
  let root: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!
    const value = argv[index + 1]

    if (flag === '--help' || flag === '--version') continue
    if (value === undefined) throw new ConfigError(`missing value for ${flag}`)

    if (flag === '--root') root = value
    else if (flag === '--include') include.push(value)
    else if (flag === '--exclude') exclude.push(value)
    else if (flag === '--max-file-bytes') limits.maxFileBytes = positiveInteger(value, flag)
    else if (flag === '--max-write-bytes') limits.maxWriteBytes = positiveInteger(value, flag)
    else throw new ConfigError(`unknown option ${flag}`)
    index += 1
  }

  if (root === undefined) throw new ConfigError('--root is required')
  return { root, include, exclude, limits }
}

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new ConfigError(`${flag} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new ConfigError(`${flag} is too large`)
  return parsed
}

export function main(argv: readonly string[]): void {
  if (argv.includes('--help')) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${IDENTITY.version}\n`)
    return
  }

  const root = openRoot(parseArguments(argv))
  const transport = serveStdio(() => createServer(root), {
    // The plan's rule, enforced rather than merely documented: this server
    // implements one profile, so a 2025-era opening is refused outright.
    legacy: 'reject',
    onerror: () => process.stderr.write('ptc-fs-mcp transport error\n'),
  })

  const shutdown = (): void => {
    void Promise.resolve()
      .then(() => transport.close())
      .finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'startup failed'}\n`)
  process.exit(64)
}
