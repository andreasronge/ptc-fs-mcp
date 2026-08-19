# ptc-fs-mcp

A small filesystem [MCP](https://modelcontextprotocol.io) server: read and
write files under one confined root, over stdio.

**Demo software.** It exists so that agentic runtimes have a real, deterministic
external tool to point at in tutorials, examples, and integration tests. It is
deliberately small enough to read in one sitting and copy into your own project.
Do not deploy it as a production file service.

It was built for the [PtcRunner](https://github.com/andreasronge/ptc_runner)
agentic framework, where a filesystem capability arrives entirely through host
configuration rather than runtime code. Nothing in the server is specific to
PtcRunner — it speaks plain MCP over stdio, so any MCP client can install it.

```console
npx -y ptc-fs-mcp --root ./workspace --include '**'
```

## Tools

| Tool              | Effect | Returns                                                |
| ----------------- | ------ | ------------------------------------------------------ |
| `list_directory`  | read   | Sorted, paginated entries under a relative prefix      |
| `search_files`    | read   | Sorted, paginated paths containing a literal substring |
| `search_text`     | read   | Paginated literal matches with path and line evidence  |
| `read_text_file`  | read   | Paginated exact UTF-8 byte chunks                      |
| `write_text_file` | write  | Replaces one regular file, reports path and bytes      |

The four read tools accept optional `cursor` and `limit` and return exactly
`items`, `next_cursor`, and `content_hash`. Start without a cursor and follow
`next_cursor` until it is null. For `read_text_file`, concatenating item `text`
reconstructs the file exactly.

## Live bytes

Reads reflect the filesystem at call time, so a write is visible to the next
read. That is the point of the server, and it has two consequences worth
stating rather than discovering.

**Cursors fail rather than tear.** A cursor carries a digest of the state its
traversal depends on. If that state changed, the next page is rejected with
`the filesystem changed since this cursor was issued; start the traversal
again`. A silently torn page — half from before the change, half from after —
is the one outcome worth spending an error on.

Only the state a result actually depends on is bound, so a cursor is not
invalidated by an unrelated change:

| Tool             | Fails when                                      | Survives                                       |
| ---------------- | ----------------------------------------------- | ---------------------------------------------- |
| `list_directory` | The listed entries change                       | A file appears deeper in a listed subdirectory |
| `search_files`   | The matching path set changes                   | A matched file's contents are edited           |
| `search_text`    | Any in-scope file's contents or identity change | A change outside the searched prefix           |
| `read_text_file` | That one file changes                           | Any other file changes                         |

Cursors are signed with a per-process key, bound to the tool and its arguments,
and must be presented exactly as issued. A cursor from another traversal,
another process, or an edited string is rejected.

**Every result carries `content_hash`,** the SHA-256 digest of the bytes that
call returned. A citation then names the bytes actually read rather than a tree
that happened to exist at some other moment. `write_text_file` reports the same
digest over the bytes it wrote, so a write and the read that follows it can be
checked against each other.

There is no whole-tree hash and no `snapshot_identity` to install. A digest can
only cover a bounded capture, and this server does not take one.

## Running

```console
ptc-fs-mcp --root ./workspace --include 'lib/**' --include 'docs/**' --exclude '**/secrets/**'
```

| Option                  | Meaning                                                  |
| ----------------------- | -------------------------------------------------------- |
| `--root <dir>`          | Directory to confine to. Required.                       |
| `--include <glob>`      | Serve matching paths. Required, repeatable.              |
| `--exclude <glob>`      | Never serve matching paths. Repeatable; may only narrow. |
| `--max-file-bytes <n>`  | Do not serve files larger than this.                     |
| `--max-write-bytes <n>` | Largest `write_text_file` payload. Default 65536.        |

`--include` is mandatory and the default is **no files**, so a server started
without it exposes nothing. Excluded paths are skipped before any `stat` or
`open`, so they are never inventoried. Globs match `*` within a segment and
`**` across segments; `lib/**` selects both `lib/a.ts` and `lib/deep/a.ts`.

**Writes land in the root, so the include rules must reach it.**
`write_text_file` names one basename, never a directory, so every write goes
directly into the root. An include set that only reaches into subdirectories —
`--include 'lib/**'` — serves those files for reading but can accept no write
at all, and each attempt is refused with `no --include pattern of this root
matches a file in the root itself`. That is a legitimate configuration for a
read-only installation, so the server starts anyway and says so on stderr:

```
ptc-fs-mcp: no --include pattern matches a file in the root itself, so
write_text_file will refuse every call.
```

Where the write tool is mapped, use `--include '**'` or add a root-level
pattern such as `--include '*.md'` alongside the directory ones.

Install it from a host document by pinning a version:

```json
"transport": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "ptc-fs-mcp@0.1.0", "--root", "workspace", "--include", "**"],
  "inherit_environment": true
}
```

### Spawning without an inherited environment

That form needs `PATH` twice over: `npx` is found on it, and the installed
binary begins with `#!/usr/bin/env node`, which resolves the interpreter on it
as well. A host that spawns with a scrubbed environment — PtcRunner's
`inherit_environment: false`, which its own end-to-end tests use — cannot start
the server at all, and the failure arrives as an acquisition error such as
`provider_unavailable` rather than as anything naming `PATH`. Version managers
make this sharper, not softer: an nvm interpreter lives at a path like
`~/.nvm/versions/node/v20.19.0/bin/node` and exists nowhere else.

The two configurations are mutually exclusive. To spawn hermetically, install
the package ahead of time and name the interpreter and the script absolutely,
bypassing both `npx` and the shebang:

```console
npm install ptc-fs-mcp@0.1.0
node -p process.execPath
node -p "require.resolve('ptc-fs-mcp/package.json').replace(/package\.json$/, 'dist/cli.js')"
```

```json
"transport": {
  "type": "stdio",
  "command": "/absolute/path/to/bin/node",
  "args": [
    "/absolute/path/to/node_modules/ptc-fs-mcp/dist/cli.js",
    "--root",
    "/absolute/path/to/workspace",
    "--include",
    "**"
  ],
  "inherit_environment": false,
  "env": {}
}
```

The server itself needs nothing from the environment: it spawns no process,
opens no network connection, and reads no variable of its own. `--root` is
resolved against the working directory, so make it absolute as well unless the
host sets a `cwd` you control. `hermetic_workspace` in
[`examples/ptc-host.json`](examples/ptc-host.json) is this form.

### Splitting authority without splitting servers

An MCP host chooses which upstream tools become capabilities, so one
installation of this package can map only `read_text_file` while a second
installation — pointed at a different root — maps only `write_text_file`. A
generated reader program then cannot resolve the write tool at all. See
[`examples/ptc-host.json`](examples/ptc-host.json).

## Usage from Node

The package is also a library. `openRoot` validates the configuration and pins
the root; `createServer` builds the same `McpServer` the binary serves, and you
give it whatever transport you like.

```js
import { createServer, openRoot } from 'ptc-fs-mcp'

const root = openRoot({ root: './workspace', include: ['**'], exclude: ['*.secret'] })
const server = createServer(root)

await server.connect(myTransport)
```

[`examples/embed.mjs`](examples/embed.mjs) is a runnable version that writes a
file, reads it back, and searches it — all in one process over the SDK's
in-memory transport:

```console
npm run build && node examples/embed.mjs
```

`openRoot` throws `ConfigError` on an unusable configuration, and tools raise
`ToolError`; both are exported, along with `normalizeRelative`, `compileGlob`,
`createSelector`, and `DEFAULT_LIMITS`, so a host can reuse the path contract
without reimplementing it. TypeScript declarations ship with the package.

## Protocol

`2026-07-28` only. There is no `initialize` fallback, no downgrade negotiation,
and no compatibility branch: a 2025-era opening is refused with the
unsupported-protocol-version error naming the profile this server implements.
Only the `tools` capability is advertised — no Roots, Sampling, Logging, or
Tasks.

## Confinement

- Relative paths only. Absolute paths, `.`/`..` segments, NUL bytes, and Windows
  separators are rejected rather than resolved.
- Symbolic links are skipped, never followed, so a link inside the root cannot
  reach bytes outside it. The final `open` uses `O_NOFOLLOW`, so a link swapped
  in after the check still fails.
- A directory appears in a listing only because it holds something served, so
  an unserved directory's name never leaks.
- `write_text_file` accepts one lowercase basename — no directories, no
  traversal — caps the payload, and confirms the destination is a regular file
  through the descriptor it will write rather than through a separate `stat` a
  symlink could outrace. A destination outside `--include` is refused, because
  a write you could not read back is a trap rather than a feature. Because a
  write lands in the root, include rules that reach only into subdirectories
  refuse every write; see [Running](#running).
- Path listings are content-blind; content tools refuse what they cannot decode.
  `read_text_file` fails on a file that is not valid UTF-8, and `search_text`
  skips a line whose bytes do not decode, so a line is either reported whole or
  not at all.
- Results are fitted against the full decoded MCP result, and text search also
  has a scan-byte budget. An empty search page can therefore carry a progress
  cursor when a sparse file needs more scanning.
- Errors are short actionable text — no stacktraces, no host paths.
- Nothing is spawned, no network is used, and stdout carries protocol messages
  only; diagnostics go to stderr.

### What it does not defend

The root must be trusted and quiescent enough that a _privileged_ actor is not
racing you. Portable Node path APIs cannot descriptor-confine every ancestor
directory, so an actor able to swap a parent directory mid-call is out of
scope. The server rejects observed symlinks and uses a no-follow final open;
it does not claim to defend an actively hostile source root.

Cursor staleness is detected from size, mtime, ctime, and inode number. On a
filesystem with coarse timestamp granularity, an in-place rewrite of exactly
the same length within the same timestamp tick would not be detected. Every
mainstream filesystem this runs on records nanosecond times, and ctime is not
settable from userspace.

## Development

```console
npm install
npm run build        # tsc to dist/, with declarations and source maps
npm test             # builds, then runs the suite against the built binary
npm run verify       # format check, typecheck, and tests
```

The suite drives the built `dist/cli.js` as a real child process over real
stdio, so what ships is what is tested. Roots are generated per test rather
than committed, because this server writes as well as reads.

## License

MIT. See [LICENSE](LICENSE).
