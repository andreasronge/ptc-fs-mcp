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

| Tool              | Effect | Returns                                                 |
| ----------------- | ------ | ------------------------------------------------------- |
| `list_directory`  | read   | Sorted, paginated entries under a relative prefix       |
| `search_files`    | read   | Sorted, paginated paths containing a literal substring  |
| `search_text`     | read   | Paginated literal matches with path and line evidence   |
| `read_text_file`  | read   | Paginated exact UTF-8 byte chunks, from a line if asked |
| `write_text_file` | write  | Replaces one regular file, reports path and bytes       |

The four read tools accept optional `cursor` and `limit` and return exactly
`items`, `next_cursor`, and `content_hash`. Start without a cursor and follow
`next_cursor` until it is null. For `read_text_file`, concatenating item `text`
reconstructs the file exactly -- or, when `start_line` was given, exactly the
part of it from that line on.

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

| Tool             | Fails when                                                               | Survives                                                                         |
| ---------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `list_directory` | The listed entries change                                                | A file appears deeper in a listed subdirectory                                   |
| `search_files`   | The matching path set changes                                            | A matched file's contents are edited                                             |
| `search_text`    | Any in-scope content changes; by default, physical identity also changes | A change outside the prefix; deterministically, a checksum-identical replacement |
| `read_text_file` | That file's content changes; by default, physical identity also changes  | Other files change; deterministically, a checksum-identical replacement          |

Cursors are opaque, signed, bound to the tool and its arguments, and must be
presented exactly as issued. There are two modes:

| Mode                     | Configuration             | Lifetime and state identity                                                                        |
| ------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------- |
| Process-affine (default) | No cursor option          | A random signing key and physical file identity make cursors valid only in one process.            |
| Deterministic (opt-in)   | `--cursor-key-env <name>` | A stable signing key and content digests let unchanged bytes resume across processes and machines. |

Deterministic mode keeps `list_directory` and `search_files` path-only. It binds
`read_text_file` to the selected file's size and SHA-256 digest, and
`search_text` to the ordered paths, sizes, and digests in scope. Replacing a
file with identical bytes therefore preserves a cursor; changing one served
byte rejects it. Digests are cached by physical file identity within a process,
up to the configured file-count limit. Files are hashed and read through opened
descriptors with identity checks so a concurrent change fails rather than
returning a torn page.

The stable key is an integrity secret when clients are untrusted. A public key
is useful for tests and trusted playback, but lets anyone holding it forge a
cursor. Keep the named environment variable out of the MCP client's visible
capability surface when cursor unforgeability matters.

```json
{
  "args": ["--root", "workspace", "--include", "**", "--cursor-key-env", "PTC_FS_MCP_CURSOR_KEY"],
  "inherit_environment": false,
  "env": { "PTC_FS_MCP_CURSOR_KEY": "<base64url credential>" }
}
```

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

| Option                        | Meaning                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `--root <dir>`                | Directory to confine to. Required.                                           |
| `--include <glob>`            | Serve matching paths. Required, repeatable.                                  |
| `--exclude <glob>`            | Never serve matching paths. Repeatable; may only narrow.                     |
| `--no-default-exclude`        | Drop the built-in excludes described below.                                  |
| `--max-files <n>`             | Most files one traversal may select. Default 50000.                          |
| `--max-directories <n>`       | Most directories one traversal may enter. Default 50000.                     |
| `--max-depth <n>`             | Deepest directory nesting to walk. Default 64.                               |
| `--max-entries <n>`           | Most directory entries one traversal may read. Default 1000000.              |
| `--max-scan-bytes <n>`        | Source bytes scanned per `search_text` page. Default 4194304, minimum 16384. |
| `--max-file-bytes <n>`        | Do not serve files larger than this.                                         |
| `--max-read-bytes <n>`        | Source bytes considered per read page. Default 16384.                        |
| `--max-result-bytes <n>`      | Complete decoded tool result ceiling. Default 48000.                         |
| `--max-write-bytes <n>`       | Largest `write_text_file` payload. Default 65536.                            |
| `--cursor-key-env <name>`     | Read a stable base64url cursor key from this environment variable.           |
| `--max-cursor-hash-bytes <n>` | File bytes hashed per deterministic call. Default 16777216.                  |

The cursor key must be canonical unpadded base64url encoding of at least 32
bytes (256 bits). If the named variable is missing, empty, malformed, or too
short, startup fails without printing its value. `--max-cursor-hash-bytes`
bounds the total uncached content hashing required by one tool call; exceeding
it fails with an actionable error instead of scanning an unbounded root.

Read pages obey both byte budgets. `--max-read-bytes` bounds bytes from the
source file, while `--max-result-bytes` bounds the complete decoded MCP tool
result, including both `content` and `structuredContent`. Text therefore costs
more result bytes than source bytes, especially when JSON escaping is needed.
The result ceiling remains authoritative and may shorten a page below the read
budget. Both options accept at most 1048576 bytes; `--max-read-bytes` accepts a
minimum of 4 and `--max-result-bytes` a minimum of 48000. The result minimum
keeps one worst-case escaped 2048-byte internal text chunk representable.
Set `--max-result-bytes` no higher than the consumer's effective decoded-result
limit; consumers below 48000 bytes are unsupported. When the limit is unknown,
keep the default.

Library hosts opt in explicitly with a `createServer` option:

```js
const key = Buffer.from(process.env.PTC_FS_MCP_CURSOR_KEY, 'base64url')
const server = createServer(root, {
  cursorKey: key,
  maxCursorHashBytes: 16_777_216,
})
```

`cursorKey` must contain at least 32 bytes. Library hosts are responsible for
decoding and protecting it; the server never reads an environment variable.

For a consumer with a 1000000-byte decoded-result limit, a representative
large-page configuration is:

```console
ptc-fs-mcp --root ./workspace --include '**' --max-read-bytes 500000 --max-result-bytes 1000000
```

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
  "args": ["-y", "ptc-fs-mcp@0.3.0", "--root", "workspace", "--include", "**"],
  "inherit_environment": true
}
```

### What is excluded before you ask

`--include` decides what a root can serve; a built-in exclude list then removes
what a caller almost never means to read. It covers dependency and tool output
-- `node_modules`, `_build`, `deps`, `__pycache__`, `bower_components`, `.git`,
`.hg`, `.svn`, `.venv`, `.tox`, `.next`, `.nuxt`, `.gradle`, `.terraform`,
`.turbo`, `.cargo`, `.bundle`, `.elixir_ls`, `.mypy_cache`, `.pytest_cache`,
`.parcel-cache`, `.ruff_cache` -- and filenames that are credentials more often
than content: `.env`, `.env.*`, `*.pem`, `*.p12`, `*.pfx`, and the usual SSH
private keys.

Every name on that list is one nobody picks for their own data, and that rule
is doing real work. `build`, `dist`, `target`, `coverage`, and `cover` are all
build output in some toolchain and all ordinary words in a business file share,
so none of them is excluded. Neither is `*.key`, which is the Apple Keynote
extension as well as a private-key one. Excluding a directory hides it
silently, and silently hiding real data is a worse failure than listing a
directory of build output. Where a root is known to be a checkout, name those
directories with `--exclude`.

Every entry is an ordinary exclude glob, so the list can only narrow what
`--include` selected, and an excluded directory is skipped without descending
into it. The built-in patterns are matched without regard to case, because on
a case-insensitive filesystem `NODE_MODULES/pkg.js` names the very same bytes
as the excluded spelling and a case-sensitive pattern would be one alias away
from being bypassed. An explicit `--exclude` stays case-sensitive: there a
caller means the exact pattern they wrote. That is a cost question as much as a tidiness one: a scan budget spent
walking `deps` is a page of empty results while the match a caller wanted waits
behind it.

`--no-default-exclude` drops the whole list at once. There is no per-pattern
re-inclusion, because ordering-sensitive negation is the part of ignore files
that reliably surprises the person writing them. Nothing here reads
`.gitignore`: what a root serves is decided by the configuration that started
the server, not by a file inside the tree it is serving.

Because excludes win over includes, a default can defeat an include written on
purpose. When a literal `--include` -- one with no wildcards -- is covered by a
built-in exclude, startup says so on stderr and names the flag that turns the
list off.

### Searching for more than one thing

`search_files` and `search_text` take either a `query` or an `any_of` list of
up to 16 substrings, and match a path or a line that contains any one of them.
A line matching several terms is still reported once.

`case_insensitive` folds ASCII letters on both sides of the comparison. The
fold is deliberately ASCII-only: the scanner is byte-oriented, and full Unicode
case folding is neither byte-local nor length-preserving, so `CAFÉ` matches
`CAFÉ` and not `café`.

Terms are literal. `any_of` is a list rather than a `|` inside `query` for that
reason -- splitting on a bare pipe would quietly change the meaning of every
search for text that contains one, and `string | number` is ordinary source.
A cursor is bound to the exact terms and folding it was issued for.

`search_text` skips a file whole when one line in its opening bytes both
contains a NUL and fails to decode as UTF-8. Each part of that is load-bearing.
Either signal alone discards real text -- NUL is itself valid UTF-8, and a text
file holding one malformed line is meant to lose that line rather than the
file -- and the two must fall on the same line, or a text file with a NUL in
one place and a bad byte in another would be condemned by the combination.
What is left identifies the compiled artifacts and dumps whose every line would
be dropped anyway: on one real checkout, 146 MB of the 374 MB served. Listings stay content-blind,
and `read_text_file` still refuses the same file with `file is not valid
UTF-8`.

That decision is still made from the opening 8 KiB, so it can be wrong in one
direction worth naming: a file whose first lines look binary but which holds
real text further in is skipped whole, and its matches are not reported. Every tool
that classifies files this way shares the limitation; the trade is against
spending a page budget proving a compiled artifact holds nothing, which on one
real checkout was half the bytes served. Where a root holds such files and
their text matters, extract it before serving the root.

### Serving a large root

Every page re-walks the root to bind its cursor, because reads reflect the
filesystem at call time and nothing is cached between calls. On a large tree
that walk, not the scan, is what a search costs, so the number of round trips
matters more than the work inside one.

Two dials follow from that. `--max-scan-bytes` sets how much source text one
`search_text` page may scan; raising it trades a longer call for far fewer of
them, and the result ceiling still bounds what comes back. The walk ceilings --
`--max-files`, `--max-directories`, `--max-depth`, `--max-entries` -- bound the
traversal itself and fail the call with an actionable error rather than
scanning without limit.

Scoping `--include` is worth more than either. A 13,000-file checkout served
with `--include '**'` is 374 MB, half of it compiled artifacts; the same root
served as `--include 'lib/**' --include 'test/**'` answers the same search in
four pages.

`list_directory` does not pay for the whole tree. A directory is listed exactly
when it holds at least one served file at any depth, and each probe stops at
the first one it finds, so listing one level costs a probe per child rather
than an inventory of everything beneath it.

### Reading part of a large file

`read_text_file` pages from the start of a file by default. `start_line` begins
at a 1-based line instead, which is what makes a large CSV or log navigable: a
slice at row 4,000 costs one page rather than the 3,999 rows before it crossing
the result budget first. `byte_offset` stays absolute, so a line-addressed read
is still citable against the whole file, and a cursor is bound to the
`start_line` it was issued for.

Only the bytes actually returned have to decode. Seeking to a line counts
newlines and reads nothing out, so a file whose earlier lines are not valid
UTF-8 can still be read from a later one -- which is the useful answer for a
CSV whose header was written in some other encoding. Reading that same file
from the beginning still fails, because then those bytes would be served.

There is no line index to seek with, so locating a line counts newlines from
the start. That happens only on the page with no cursor to resume from -- every
later page reads its offset out of the cursor -- and it is charged against
`--max-scan-bytes`, so an absurd line number fails with an actionable error
rather than reading without limit.

Nothing above understands CSV. Deliberately: quoting, embedded newlines,
delimiters, and headers are shaping decisions that belong wherever the rows are
consumed, and a second parser here would only disagree with that one in corner
cases. This server narrows bytes; the consumer gives them meaning. Reading the
header is one call and the rows another, which is all a parser needs.

### Text that is not UTF-8

This is a UTF-8 text server, and two consequences are worth stating rather than
discovering.

`read_text_file` refuses a file that is not valid UTF-8, which includes a CSV
exported as cp1252 or latin-1 -- still a common shape for spreadsheet output.
`search_text` skips a line it cannot decode, so a search over a mixed-encoding
tree reports matches only from the files that decode, and says nothing about
the ones that did not. That silence is the sharp edge: transcode at the source
if a root holds legacy encodings. Serving them here would mean `content_hash`
naming bytes that were never on disk, which is the one thing a citation may not
do.

A UTF-8 byte-order mark is content, not metadata, here. `read_text_file`
returns the bytes exactly as they are, so a BOM arrives as a leading `\uFEFF`
and a naive parse carries it into the first column name. Stripping it is one
expression in the consumer:

```clojure
(if (starts-with? raw "\uFEFF") (subs raw 1) raw)
```

The server does not, because concatenated pages must reconstruct the file
exactly and `content_hash` names the bytes actually served.

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
npm install ptc-fs-mcp@0.3.0
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

By default the server needs nothing from the environment: it spawns no process
and opens no network connection. Deterministic cursor mode reads only the
variable explicitly named by `--cursor-key-env`; provide it through the host's
`transport.env` credential binding even when inherited environment is disabled.
`--root` is resolved against the working directory, so make it absolute unless
the host sets a `cwd` you control. `hermetic_workspace` in
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
pnpm run build && node examples/embed.mjs
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
  separators are rejected rather than resolved. The one exception is a bare `.`,
  which names the root exactly as the empty string does; `./lib` and `lib/.`
  still carry a dot segment and are still rejected.
- Symbolic links are skipped, never followed, so a link inside the root cannot
  reach bytes outside it. The final `open` uses `O_NOFOLLOW`, so a link swapped
  in after the check still fails. `O_NOFOLLOW` covers only the name it opens,
  so every ancestor of a path is checked before that open too: naming
  `link/secret.txt`, or listing `link` as a prefix, is refused rather than
  followed.
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

In default mode, cursor staleness is detected from size, mtime, ctime, and inode
number. Deterministic mode uses size and content digests for cursor state; the
physical metadata only decides whether its bounded digest cache may be reused.
On a filesystem with coarse timestamp granularity, an in-place rewrite of
exactly the same length within the same timestamp tick could evade both the
default state check and deterministic cache invalidation. Every mainstream
filesystem this runs on records nanosecond times, and ctime is not settable
from userspace.

## Development

```console
npm install --global corepack@latest # Node 25+ only; earlier releases bundle it
corepack enable                    # once per machine
pnpm install --frozen-lockfile
pnpm run build                     # tsc to dist/, with declarations and source maps
pnpm test                          # builds, then runs the suite against the built binary
pnpm run verify                    # format check, typecheck, and tests
```

The `packageManager` field in `package.json` pins pnpm and its integrity hash.
Corepack verifies that hash, and automation reads the same field for the version.

The suite drives the built `dist/cli.js` as a real child process over real
stdio, so what ships is what is tested. Roots are generated per test rather
than committed, because this server writes as well as reads.

## License

MIT. See [LICENSE](LICENSE).
