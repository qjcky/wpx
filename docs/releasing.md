# Releasing

Releases are built by GitHub Actions (`.github/workflows/release.yml`) for Windows (NSIS installer) and Linux (`.deb`,
`.AppImage`), signed for the auto-updater, and published as a draft release with `latest.json`. Updater artifacts are
enabled only for releases (`src-tauri/tauri.release.conf.json`), so local `npm run tauri build` works without the key.

## One-time setup

1. **Repository address** — `qjcky/wpx`. It is written in `src-tauri/tauri.conf.json` (`plugins.updater.endpoints`),
   `src-tauri/Cargo.toml` (`repository`), the READMEs, `SECURITY.md` and `CONTRIBUTING.md`. Installed copies look for
   updates there, so the repository must be public for auto-update to work.
2. **Updater signing key.** Updates are accepted only if signed with the key whose public part is
   `plugins.updater.pubkey` in `tauri.conf.json`. To create a new pair:
   ```bash
   npx tauri signer generate -w ~/.tauri/wpx-updater.key
   ```
   Put the public key into `tauri.conf.json`. Keep the private key **out of the repository** and back it up — without
   it, installed copies cannot be updated.
3. **GitHub secrets** (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of the private key file
     (`gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/wpx-updater.key`);
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password (not needed if the key has none).

## Each release

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`; add a section to
   `CHANGELOG.md`.
2. Commit, tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The workflow builds both platforms and creates a **draft** release with the installers, `latest.json`,
   `SHA256SUMS-*.txt` and the source of the bundled mihomo (GPL-3.0 requires offering it). Check the files, write
   notes, publish.
   Installed copies see the update within a day (or on *Check for updates*).

## Updating mihomo

1. Pick a release on <https://github.com/MetaCubeX/mihomo/releases>.
2. In `scripts/fetch-mihomo.mjs` set `VERSION` and the SHA-256 of each archive (shown next to the files on GitHub).
3. `npm run fetch-mihomo -- --force`, then test: `npm run lab`, install the engine on a test machine, check the tunnel.
4. After users update wpx, the Engine page offers **Update engine** (admin prompt, rollback on failure).
