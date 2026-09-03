# Releasing

Releases are published to npm by GitHub Actions. Do not publish from a local
checkout.

1. Update the version in `package.json` and `package-lock.json`, plus every
   version-pinned example. Review the changes since the previous `v*` tag and
   prepare brief release notes.
2. Run `npm ci` and `npm run verify`. Commit the release preparation, merge it
   into `main`, and confirm CI passes.
3. Run the **Release** workflow manually on `main`. Manual runs are rehearsals:
   they verify npm authentication and provenance, then perform a dry-run
   publish.
4. From the exact release commit on `main`, create and push an annotated tag
   whose name matches the manifest version:

   ```console
   version=$(node -p 'require("./package.json").version')
   git tag -a "v$version" -m "ptc-fs-mcp $version"
   git push origin "v$version"
   ```

5. Wait for the tag-triggered **Release** workflow to succeed, verify the
   version on npm, and create the matching GitHub release with the prepared
   notes.

Never move or reuse a published tag. If a published package needs correction,
prepare a new version.
