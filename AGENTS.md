# Repository guidance

## Project overview

`ptc-fs-mcp` is a small TypeScript filesystem MCP server and library. It exposes
files only beneath one configured root and communicates over stdio. The package
is demo software, but its confinement, cursor integrity, byte budgets, and
protocol behavior are deliberate security and compatibility boundaries.

## Setup and commands

- Use a supported Node.js release from `package.json` (`>=20.19.0`) and install
  the locked dependency tree with `npm ci`.
- Run `npm run build` to compile `src/` into the ignored `dist/` directory.
- Run `npm test` for the full integration suite. Tests exercise the built CLI
  over real stdio and create their own temporary filesystem roots.
- Run `npm run verify` before proposing a change. It checks formatting and
  types, rebuilds, and runs the full test suite.
- Use `npm run format` when repository files need Prettier formatting.

## Repository conventions

- Keep production code in `src/` and tests in `test/*.test.mjs`. Add or update
  tests for observable behavior changes and bug fixes.
- Do not commit `dist/`, `node_modules/`, coverage output, tarballs, or other
  generated artifacts.
- Preserve ESM imports and the strict TypeScript settings in `tsconfig.json`.
- Keep stdout reserved for MCP protocol messages. Send diagnostics to stderr,
  and keep user-facing errors short without stack traces or host paths.
- Keep the server deterministic and self-contained: it must not spawn child
  processes, access the network, or depend on environment variables.
- Treat path confinement, symlink handling, include/exclude rules, cursor
  validation, result-size limits, and UTF-8 handling as security-sensitive.
  Do not weaken them without explicit maintainer direction.
- This server intentionally supports only the MCP protocol profile documented
  in `README.md`. Do not add negotiation or compatibility fallbacks unless the
  task explicitly calls for them.

## Change boundaries

- Do not publish packages, create version tags, or change the package version
  as part of an ordinary code change.
- Avoid changing release credentials, publishing behavior, or the public tool
  contract without explicit maintainer direction.
- Keep changes scoped to the task and preserve unrelated work in the tree.
