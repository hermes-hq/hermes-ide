# Releasing

A release is a version bump merged to `main`. The workflow does the rest.

## Ship a version

1. Write `RELEASE_NOTES.md` for the new version. Its first line must name it
   (`# Hermes IDE 1.4.1`). The release fails without it: there is no
   auto-generated fallback.
2. `npm run bump -- 1.4.1`. This edits the version in `package.json`,
   `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
   `src-tauri/Cargo.lock` and nothing else. It creates no commit and no tag.
3. Open a PR with the bump and the notes; merge it.

On the merge, `.github/workflows/release.yml`:

1. checks that the merged commit passed CI's `gate` check (the real-app
   scenarios on every OS plus the acceptance ledger; see
   `e2e/release-gate.mjs`) and runs the frontend and Rust test suites;
2. builds, signs and notarizes every installer from the merged commit;
3. creates a **draft** release, uploads the assets and both manifests
   (`latest.json` for the updater, `downloads.json` for the website) and
   lints them: every updater bundle must carry a signature that verifies
   against the app's public key, every installer must be listed;
4. installs each installer on a clean runner of its platform (macOS arm64
   and Intel, Ubuntu x64 and arm64, Windows x64 and arm64) and runs
   `hermes-ide --self-test=<report.json>`, which must exit 0;
5. creates the tag `v1.4.1` on the merged commit and publishes the release
   as a **prerelease**. Beta clients pick it up (see channels). Stable
   clients do not: `releases/latest` only ever points at a non-prerelease.

Tags are never moved. A re-run that finds `v1.4.1` pointing elsewhere fails.
A candidate that fails a gate is fixed by shipping the next version.

## When a train fails

Nothing was published and no tag exists, but the draft release `v1.4.1` is
still there, and it belongs to the commit that made it. The workflow refuses
to build for that version from any other commit (a later push to main sees
the draft in its first job and stops, without building anything), so main
cannot release again until you do one of:

- delete the draft (`gh release delete v1.4.1 --yes`) and re-run the failed
  workflow run, or push the fix and let the train build `v1.4.1` again from
  the new commit;
- or bump to the next version (`npm run bump -- 1.4.2`, new notes) and leave
  the draft to be deleted whenever.

Re-running the failed run itself (same commit) reuses its draft; that is the
only case a draft is ever reused.

## Channels

- **Stable** reads `https://github.com/hermes-hq/hermes-ide/releases/latest/download/latest.json`
  (the updater endpoint in `tauri.conf.json`).
- **Beta** reads `https://raw.githubusercontent.com/hermes-hq/hermes-ide/channels/beta.json`,
  a copy of the newest prerelease's `latest.json` that the workflow commits to
  the `channels` branch. Beta is always at or ahead of stable.

Users choose in Settings → General → Update channel. The choice is the
`update_channel` setting; the check runs in the backend so the setting applies
to the scheduled checks as well as "Check for Updates".

Two environment variables exist for test rigs, and production builds honour
them too (there is no test-only build of the updater):
`HERMES_UPDATE_ENDPOINT=<https url>` reads that manifest instead of the
channel's, `HERMES_DISABLE_UPDATE_CHECK=1` never checks (the installed-artifact
smoke sets it so CI launches do not count as installs). An override endpoint
cannot install anything the app's public key did not sign: the updater still
requires https and a valid signature, so pointing a production build at a
foreign manifest fails the check rather than installing it.

## Promotion to stable

`.github/workflows/promote.yml` runs hourly. The newest prerelease that has
soaked for 24 hours becomes the latest release. Then a canary reads the public
stable manifest and downloads every asset it points at; if that fails the
previous release is made latest again and the candidate goes back to
prerelease.

- Hold: open an issue with the label `release-hold`. Name the tag in the
  title to hold that version; name none to hold everything.
- Promote now: run the workflow by hand with the tag (the hold still applies).
- Halt after promotion: mark the previous release as latest
  (`gh release edit v1.4.0 --latest`) and the bad one as prerelease. The
  updater never downgrades, so ship the fix as the next version.

## Self-test

`hermes-ide --self-test=<report.json>` starts the real app, opens the
database, checks the bundled bridge runtime, waits for the UI to render, runs
an echo through a real shell in a PTY, writes the report and exits 0 or 1. It
is what the release smoke runs and what to ask a user for when an install
misbehaves.

## Dry run

Run the Release workflow by hand with a throwaway tag such as
`v0.0.0-dryrun-3` (any ref). It builds, drafts, lints and smokes exactly like
a release, then deletes the draft. Nothing is published and no tag is created.

## Manifests

`scripts/ci/release-manifests.mjs build <dir>` writes both manifests from the
files in a release folder; `lint <dir>` checks them (also run in the workflow).
Linux updates use the `.deb` itself, signed at build time, under the
`linux-*-deb` keys. Windows ships the NSIS installer only: the updater installs
with NSIS, so an MSI install would end up with two copies after its first
update.
