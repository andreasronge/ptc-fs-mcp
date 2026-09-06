#!/usr/bin/env node
/**
 * The stdio binary. An MCP host spawns this and speaks the latest profile to
 * it; there is no legacy handshake and no downgrade path.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { ConfigError } from './errors.js'
import { createServer, IDENTITY } from './index.js'
import { compileGlob, DEFAULT_EXCLUDE } from './paths.js'
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
  --no-default-exclude    Do not apply the built-in excludes. Those cover
                          dependency and tool directories such as
                          node_modules, _build, deps, and .git, plus
                          credential filenames such as .env and *.pem. They
                          are matched without regard to case, only ever
                          narrow, and this flag drops all of them at once.
  --max-files <n>         Most files one traversal may select. Default 50000.
  --max-directories <n>   Most directories one traversal may enter.
                          Default 50000.
  --max-depth <n>         Deepest directory nesting to walk. Default 64.
  --max-entries <n>       Most directory entries one traversal may read.
                          Default 1000000.
  --max-file-bytes <n>    Do not serve files larger than this.
  --max-read-bytes <n>    Source bytes considered per read page. Default 16384.
  --max-scan-bytes <n>    Source bytes scanned per search_text page. Default
                          4194304. Every page re-walks the root to bind its
                          cursor, so this trades a longer call for far fewer
                          of them; the result ceiling still bounds a page.
  --max-result-bytes <n>  Complete decoded tool result ceiling. Default 48000.
                          Valid range 48000-1048576. Must not exceed the
                          consumer's effective limit; consumers below 48000
                          bytes are unsupported.
  --max-write-bytes <n>   Largest write_text_file payload. Default 65536.
  --cursor-key-env <name> Read a base64url HMAC key from this environment
                          variable and enable deterministic cursors. The key
                          must decode to at least 32 bytes.
  --max-cursor-hash-bytes <n>
                          File bytes hashed per call in deterministic mode.
                          Default 16777216.
  --help                  Print this message.
  --version               Print the version.

Paths are relative to the root; symbolic links are skipped, never followed.
A write names one basename and lands in the root itself, so write_text_file
needs an --include glob with no directory prefix, such as '**'.
Protocol messages go to stdout, diagnostics to stderr.

The shebang resolves node through PATH. A host that spawns this without
inheriting the environment must run an absolute node against an absolute
dist/cli.js rather than this name or npx.`

interface ParsedArguments extends RootOptions {
  readonly cursorKeyEnv?: string
  readonly maxCursorHashBytes?: number
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const include: string[] = []
  const exclude: string[] = []
  const limits: { -readonly [K in keyof Limits]?: Limits[K] } = {}
  let root: string | undefined
  let defaultExclude: boolean | undefined
  let cursorKeyEnv: string | undefined
  let maxCursorHashBytes: number | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!
    const value = argv[index + 1]

    if (flag === '--help' || flag === '--version') continue
    // Valueless, so it must be settled before the arity check below consumes
    // whatever followed it as an operand.
    if (flag === '--no-default-exclude') {
      defaultExclude = false
      continue
    }
    if (value === undefined) throw new ConfigError(`missing value for ${flag}`)

    if (flag === '--root') root = value
    else if (flag === '--include') include.push(value)
    else if (flag === '--exclude') exclude.push(value)
    else if (flag === '--max-files') limits.maxFiles = positiveInteger(value, flag)
    else if (flag === '--max-directories') limits.maxDirectories = positiveInteger(value, flag)
    // Zero is a meaningful ceiling -- serve the root's own files and nothing
    // below -- so this one flag accepts it where the others do not.
    else if (flag === '--max-depth') limits.maxDepth = nonNegativeInteger(value, flag)
    else if (flag === '--max-entries') limits.maxEntries = positiveInteger(value, flag)
    else if (flag === '--max-file-bytes') limits.maxFileBytes = positiveInteger(value, flag)
    else if (flag === '--max-read-bytes') limits.maxReadBytes = positiveInteger(value, flag)
    else if (flag === '--max-scan-bytes') limits.maxScanBytes = positiveInteger(value, flag)
    else if (flag === '--max-result-bytes') limits.maxResultBytes = positiveInteger(value, flag)
    else if (flag === '--max-write-bytes') limits.maxWriteBytes = positiveInteger(value, flag)
    else if (flag === '--cursor-key-env') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
        throw new ConfigError('--cursor-key-env must name an environment variable')
      cursorKeyEnv = value
    } else if (flag === '--max-cursor-hash-bytes') maxCursorHashBytes = positiveInteger(value, flag)
    else throw new ConfigError(`unknown option ${flag}`)
    index += 1
  }

  if (root === undefined) throw new ConfigError('--root is required')
  return {
    root,
    include,
    exclude,
    limits,
    ...(defaultExclude === undefined ? {} : { defaultExclude }),
    ...(cursorKeyEnv === undefined ? {} : { cursorKeyEnv }),
    ...(maxCursorHashBytes === undefined ? {} : { maxCursorHashBytes }),
  }
}

function cursorKeyFromEnvironment(name: string | undefined): Buffer | undefined {
  if (name === undefined) return undefined
  const encoded = process.env[name]
  if (encoded === undefined || encoded === '' || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new ConfigError('cursor key environment variable is missing, empty, or malformed')
  }
  const key = Buffer.from(encoded, 'base64url')
  if (key.toString('base64url') !== encoded || key.byteLength < 32) {
    throw new ConfigError('cursor key environment variable is malformed or contains fewer than 32 bytes')
  }
  return key
}

/** Literal include patterns -- no wildcards -- that a built-in exclude covers. */
function literalIncludesDefeatedByDefaults(include: readonly string[]): string[] {
  const defaults = DEFAULT_EXCLUDE.map((pattern) => compileGlob(pattern, 'i'))
  return include.filter((pattern) => !/[*?]/.test(pattern) && defaults.some((excluded) => excluded.test(pattern)))
}

function nonNegativeInteger(value: string, flag: string): number {
  if (value === '0') return 0
  return positiveInteger(value, flag)
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

  const parsed = parseArguments(argv)
  const root = openRoot(parsed)
  const cursorKey = cursorKeyFromEnvironment(parsed.cursorKeyEnv)
  if (!root.selector.servesRootLevel) {
    // Not fatal: a read-only installation with `--include 'lib/**'` is a
    // legitimate and common setup, and this process cannot know which tools
    // the host maps. But if it does map the write tool, every call will be
    // refused, so the cause is stated once here instead of only in errors.
    process.stderr.write(
      'ptc-fs-mcp: no --include pattern matches a file in the root itself, so write_text_file will refuse every ' +
        "call. Reads are unaffected. Add an --include glob with no directory prefix, such as '**', if this " +
        'installation maps the write tool.\n',
    )
  }
  // Excludes win over includes, so a default can silently defeat an include the
  // operator wrote on purpose -- `--include '.env'` is the sharp case. Only
  // literal patterns are checked: for those the conflict is a fact, while for a
  // wildcard it would be a guess, and the same reasoning that keeps
  // servesRootLevel from attempting regex intersection applies here.
  const defeated = parsed.defaultExclude === false ? [] : literalIncludesDefeatedByDefaults(parsed.include)
  if (defeated.length > 0) {
    process.stderr.write(
      `ptc-fs-mcp: --include ${defeated.join(', ')} matches a built-in exclude, so nothing it names is served. ` +
        'Pass --no-default-exclude to drop the built-in list.\n',
    )
  }

  const transport = serveStdio(
    () =>
      createServer(root, IDENTITY, {
        ...(cursorKey === undefined ? {} : { cursorKey }),
        ...(parsed.maxCursorHashBytes === undefined ? {} : { maxCursorHashBytes: parsed.maxCursorHashBytes }),
      }),
    {
      // The plan's rule, enforced rather than merely documented: this server
      // implements one profile, so a 2025-era opening is refused outright.
      legacy: 'reject',
      onerror: () => process.stderr.write('ptc-fs-mcp transport error\n'),
    },
  )

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
