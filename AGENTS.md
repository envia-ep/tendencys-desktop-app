# AI agent instructions — Tendencys Desktop

Multi-service Tauri 2 desktop shell (React 19 + Vite). See `README.md` for
architecture, SSO, and environment details.

## AI tooling parity

Any AI config change must be mirrored: a `.cursor/rules/*.mdc` rule has an
equivalent block here in `AGENTS.md`, and vice versa. Keep the two in sync when
adding, editing, or removing agent guidance.

## Releasing the desktop app

Releases are automated by `.github/workflows/release-desktop.yml`. Pushing a `v*`
tag builds every platform (macOS arm + Intel, Windows, Linux), code-signs +
notarizes, and publishes a GitHub Release on `envia-ep/tendencys-desktop-app`
containing the installers, `latest.json`, and `.sig` signatures. Installed apps
auto-update silently from that release on next launch.

### Release procedure (follow exactly)

1. Be on `master`, clean tree, up to date: `git checkout master && git pull`.
2. Bump the version in all three files at once (never edit them by hand):
   ```bash
   npm run release:version X.Y.Z    # e.g. 0.1.1 — semver, no leading "v"
   ```
   This writes `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml`.
3. Commit: `git commit -am "chore: release vX.Y.Z"`.
4. Tag and push together — the tag is what triggers CI:
   ```bash
   git tag vX.Y.Z
   git push --follow-tags
   ```
5. Watch the run: `gh run watch` (or the repo Actions tab). ~15-25 min.
6. Verify the Releases page has the installers + `latest.json` + `.sig`, and that
   the release is published (not draft — the workflow flips it automatically).

### Hard rules

- **The git tag MUST be `vX.Y.Z` and MUST equal the version in the three files**
  (minus the `v`). Always use `npm run release:version` so they stay in sync.
- **Never regenerate the Tauri updater signing key.** The public key in
  `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) must never change — if it
  does, every already-installed app can no longer verify updates. The private key
  lives only in the `TAURI_SIGNING_PRIVATE_KEY` GitHub secret and at
  `~/.tauri/tendencys-desktop.key`; never commit it.
- **Never move, delete, re-tag, or force-push an existing `vX.Y.Z` tag.** If a
  build fails, fix the cause and cut the **next** version (a new tag). Tags are
  immutable release records.
- **Never change the updater endpoint** in `tauri.conf.json`
  (`https://github.com/envia-ep/tendencys-desktop-app/releases/latest/download/latest.json`)
  or publish releases to a different repo — the download page and installed apps
  both depend on this repo's public releases.
- Only `v*` tags trigger a release. Pushing to `master` does not.
- Bump versions monotonically (semver). Never reuse a version number.

### If a release build fails

- Read the failing job's logs in the Actions tab. macOS failures are almost always
 notarization (`APPLE_ID` / `APPLE_PASSWORD` app-specific password / `APPLE_TEAM_ID`).
- Windows signing uses **Azure Trusted Signing** (`trusted-signing-cli` +
 `bundle.windows.signCommand`); failures are usually the `AZURE_*` secrets
 (tenant/client id/secret, or endpoint/account/profile). It only runs when
 `AZURE_SIGNING_ENDPOINT` is set — otherwise the Windows build ships unsigned
 rather than failing the release.
- Fix the secret or code, commit, then cut a **new** version tag. Do not retry by
 re-pushing the same tag.

### Related pieces (do not break)

- Browser download page: `docs/index.html`, served via GitHub Pages
  (`master` / `/docs`). It reads the public GitHub Releases API — no backend.
- Silent auto-update logic: `src/lib/updater.ts` + `src/hooks/useAppUpdater.ts`.
- Required GitHub Actions secrets are documented in `README.md` (Releasing section).
