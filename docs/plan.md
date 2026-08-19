# Plan: extract one live read/write filesystem MCP server

Status: **server built and published-ready**; the `ptc_runner` migration below
is not started. Written 2026-08-19.

The open question was decided on 2026-08-19: **option 3, accept unit-only
coverage**. The server is live-only with no `--freeze` mode and no snapshot
module, and `ptc_runner` drops the two `snapshot_identity` end-to-end
assertions rather than keeping a mode that this plan set out to remove. See
"Open question" below for what that costs.

## Why

`ptc_runner` ships two sample MCP servers today:

- `examples/mcp/filesystem` — 640 + 295 lines of TypeScript, five read-only
  tools, served from an immutable snapshot captured at startup. Ships a
  committed `dist/server.js`, a 26 KB `NOTICE`, and a CI job that verifies the
  bundle reproduces from `src/`.
- `examples/mcp/writer` — 130 lines of Elixir, one `write_text_file` tool, no
  build step.

Two servers in two languages, and no server that can read back what it wrote.
That split is not a teaching point; it is an artifact of how the two samples
were added. One server, in one language, that reads and writes live bytes is
both smaller to maintain and closer to what someone copying the sample wants.

Extracting it out of `ptc_runner` also removes Node.js from that repo's CI
critical path, the committed bundle from its hex payload, and the sample's
release cadence from its review gates.

### Public, not private

The repository must be public. The sample's entire job is "ready to copy," and
`ptc_runner`'s docs link directly to its source tree. A private repo would 404
for every reader, require a deploy key for `ptc_runner` CI, and lock external
contributors and forks out of the MCP end-to-end tests.

## Design decisions

### One server, read and write

Tools:

| Tool              | Effect | Returns                                                |
| ----------------- | ------ | ------------------------------------------------------ |
| `list_directory`  | read   | Sorted, paginated entries under a relative prefix      |
| `search_files`    | read   | Sorted, paginated paths containing a literal substring |
| `search_text`     | read   | Paginated literal matches with path and line evidence  |
| `read_text_file`  | read   | Paginated exact UTF-8 byte chunks                      |
| `write_text_file` | write  | Replaces one regular file, reports path and bytes      |

Splitting authority stays possible without splitting servers: an MCP host
chooses which upstream tools become capabilities, so one installation can map
only `read_text_file` and a second installation of the same binary — pointed at
a different root — can map only `write_text_file`. That is how
`examples/named-mission-reader-writer` should be rebuilt; its security property
(a generated reader program cannot resolve the write tool) is unchanged.

### Latest MCP profile only

`2026-07-28`, matching what PtcRunner implements. No `initialize` fallback, no
downgrade negotiation, no compatibility branches. This is already true of the
current TypeScript sample — the SDK negotiates and the sample source carries no
version branches — so it costs nothing to state as a rule and keeps it true.

### Live bytes, not a frozen snapshot

The current reader captures the root at startup, streams it to private
temporary disk, and never reads the source tree again. That buys repeatable
tests, a hashable whole-tree identity, and bounded memory. It also makes
read-after-write impossible, which is disqualifying for a server that writes.

The new server reads live. Consequences to handle explicitly:

- **Cursors must fail, not tear.** A cursor carries the state it was issued
  against; if the underlying file or directory changed, the next page is
  rejected with a short actionable error rather than silently returning a torn
  result. A silent torn read is the worst available outcome.
- **Per-read content hash replaces the whole-tree hash.** Each read result
  carries the digest of the bytes that call returned, so a citation binds to
  what was actually read. This is a better citation model regardless of
  freezing: a citation should name the bytes, not a tree that happened to exist
  at process start.
- **No `snapshot_identity` installation.** In PtcRunner, `snapshot_identity` is
  called once during provider assembly and published as
  `content_snapshot_hash`. That is a whole-corpus, assembly-time identity and it
  is only meaningful for a frozen server. The live server does not offer one;
  hosts simply omit the field. See the open question below.

### Confinement (carried over unchanged)

- Relative paths only. Absolute paths, `.`/`..` segments, NUL bytes, and Windows
  separators are rejected rather than resolved.
- Symbolic links are skipped, never followed.
- Non-regular files and non-UTF-8 files are not served.
- `--include` is mandatory and repeatable; the default is no files. `--exclude`
  may only narrow.
- Writes accept a single-segment lowercase basename, cap content, and refuse a
  destination observed as anything other than a regular file — including a
  symlink.
- No subprocess, no network, no Roots/Sampling/Logging/Tasks capability.
- stdout carries protocol messages only; diagnostics go to stderr.
- Errors are short actionable text: no stacktraces, no host paths.

### Packaging

Publish to npm so host documents can pin a version:

```json
"transport": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@andreasronge/ptc-fs-mcp@<version>", "--root", "workspace", "--include", "**"]
}
```

Port the existing `test/server.test.mjs` (540 lines) as the starting suite and
extend it for the write path and for cursor invalidation under mutation.

## Migration in `ptc_runner`

Every touch point, so nothing is discovered late:

| Path                                                            | Change                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `test/ptc_runner/kernel/filesystem_mcp_e2e_test.exs`            | Point at the pinned npm package; drop or relocate the `content_snapshot_hash` assertions (see open question) |
| `test/ptc_runner/kernel/named_missions_authority_e2e_test.exs`  | Point at the pinned package                                                                                  |
| `examples/named-mission-reader-writer/ptc-host.json`            | Two installations of the one server, different roots, narrowed tool maps                                     |
| `examples/named-mission-reader-writer/README.md`                | Rewrite the "two servers" framing as "two installations"                                                     |
| `examples/mcp/filesystem/`                                      | Delete                                                                                                       |
| `examples/mcp/writer/`                                          | Delete                                                                                                       |
| `mix.exs` (`files:` list)                                       | Drop both example directories from the hex payload                                                           |
| `scripts/verify_core_package.sh`                                | Drop the `dist/server.js` and `NOTICE` assertions                                                            |
| `.github/workflows/test.yml`                                    | Drop the Node setup, npm build, and bundle-reproducibility job                                               |
| `scripts/ci/classify-changes.sh`                                | Drop the `examples/mcp/filesystem/*` branch                                                                  |
| `test/scripts/classify_changes_test.exs`                        | Update to match                                                                                              |
| `docs/reference/mcp.md`                                         | Replace both sample links with the new repo; keep the write-effect contract text                             |
| `docs/guides/connecting-tools-with-mcp.md`                      | Same                                                                                                         |
| `examples/kernel-tutorial/README.md`                            | Same                                                                                                         |
| `site/reference/mcp/`, `site/guides/connecting-tools-with-mcp/` | Generated — regenerate with `mix ptc.gen_docs`                                                               |

The end-to-end tests keep their point. The moduledoc claim — "acceptance proof
that a new filesystem capability can arrive without changing the runtime" —
holds just as well against a pinned npm package as against a vendored bundle,
and the e2e suite is already network- and key-bound, so `npx` introduces no new
class of dependency.

Do not delete anything in `ptc_runner` until the new package is published and
the e2e tests pass against it.

## Open question: what happens to `snapshot_identity` coverage

Dropping the freeze deletes two live assertions:

- `filesystem_mcp_e2e_test.exs:79` — the published `content_snapshot_hash`
  equals the hash the server reported.
- `filesystem_mcp_e2e_test.exs:101-124` — a `snapshot_identity` naming a missing
  field closes provider assembly with `:mcp_invalid_snapshot_identity`.

The runtime feature keeps unit coverage in `mcp_source_test.exs` and
`host_config_test.exs` either way. Three options for the end-to-end proof:

1. **Add an opt-in `--freeze` mode** to the new server, used only by that one
   PtcRunner test. Keeps both proofs honest against a real foreign-language
   server; costs one mode and the snapshot code that comes with it. Note this
   partially reintroduces what this plan set out to remove — as a flag, not a
   default.
2. **Move those two assertions to a tiny stub MCP server** in PtcRunner's test
   support. Cheaper, and still a real external process, but the stub is written
   by the same repo it is proving.
3. **Accept unit-only coverage** and delete the two assertions.

Recommendation: (1), because `snapshot_identity` is a shipped runtime feature
and a freeze is a legitimate _mode_ for a deterministic fixture even though it
is a bad default for a general file tool. Decide before writing the server —
it changes whether the snapshot module gets ported at all.

## Order of work

1. Decide the open question above.
2. Scaffold the repo: package manifest, TypeScript config, MCP SDK dependency,
   test runner, CI.
3. Port the read tools onto live bytes, with per-read hashes and
   fail-on-change cursors.
4. Add `write_text_file`.
5. Port and extend the test suite; add the read-after-write and
   cursor-invalidation cases the old sample could not have.
6. Publish to npm.
7. Land the `ptc_runner` migration as one PR, deletions included.
