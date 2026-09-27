# Real-app scenarios

These scripts drive the **real** Hermes desktop app, hands-free, on macOS,
Windows and Linux. They are the acceptance criteria of shipped features:
`e2e/acceptance.yml` maps every criterion to the scenario that proves it, and
`node e2e/acceptance-check.mjs` fails when a shipped feature has no green
scenario on every OS.

## How it works

- `src-tauri/src/e2e_bridge.rs` — a test-only automation bridge inside the
  app, behind the cargo feature `e2e`. It refuses to compile in a release
  build, only starts when the process has `HERMES_E2E=1`, listens on
  `127.0.0.1` on a random port, and needs a random token on every request.
  It evaluates JavaScript in the app's webview and takes window screenshots
  from inside the app (no focus, no screen-recording permission, works on a
  virtual display). Screenshots are taken after the page has painted, and a
  capture that is one flat colour (nothing painted, screen locked) is refused
  by both the app and the harness, so a picture in the evidence always shows
  the state the scenario asserted.
- `src/e2e/hooks.ts` — read-only hooks for the terminal's text, compiled in
  only when the frontend is built with `VITE_HERMES_E2E=1`.
- `harness.mjs` — the client: launch the test app with a throwaway home
  folder, click, type real key events, read the terminal, screenshot, quit.
- `scenarios/*.mjs` — one script per user journey. Each writes a log,
  screenshots and a `result.json` to its evidence folder and ends with
  `RESULT: PASS` or `RESULT: FAIL`.
- `run.mjs` — runs scenarios in fresh processes, N times each, and records
  every run in `results.json` for the acceptance gate.

The test app has its own identifier (`com.hermes-ide.terminal.e2e`), so it
never touches an installed Hermes or its data.

## Running locally

```sh
node e2e/app/build.mjs                          # build the test app (once per change)
node e2e/app/scenarios/terminal-echo.mjs        # one scenario
node e2e/app/run.mjs --repeat 20 terminal-echo.mjs
node e2e/app/run.mjs                            # every scenario, once
node e2e/app/run.mjs --fresh                    # ...forgetting earlier runs' results
node e2e/acceptance-check.mjs                   # the ledger is well-formed
node e2e/acceptance-check.mjs --results <dir>   # ...and green everywhere
```

Set `HERMES_E2E_OUT` to choose where the app and the evidence go (default:
`$TMPDIR/hermes-e2e`). Evidence never belongs in the repository.

`node e2e/app/cli.mjs` talks to a running test app step by step; see the
header of that file.

## Adding a scenario

1. Create `scenarios/<feature-id>-<name>.mjs` (copy `terminal-echo.mjs`).
   Drive the app through the real UI; assert on what a person would see.
   End with `finishScenario(...)`.
2. Add the file to the feature's criteria in `e2e/acceptance.yml`. Append
   `@linux`, `@darwin` or `@win32` only when the scenario genuinely cannot run
   elsewhere.
3. Run it locally, then let the `E2E` workflow prove it on all three runners.

## CI

`.github/workflows/e2e.yml` builds the test app and runs the scenarios on
`ubuntu-24.04` (under `xvfb`), `windows-2022` and `macos-15`, uploads each
runner's evidence, and then runs the acceptance gate over the results of all
three. Pull requests run `terminal-echo` 5 times; `main`, the merge queue and
manual runs 20 times.
