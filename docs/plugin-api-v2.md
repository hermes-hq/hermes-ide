# Plugin API v2

Plugin API v2 lets a plugin react to any agent, put items in the attention inbox, read feature tracks and add checks to code review. It ships behind the `pluginApiV2` feature flag (on for the beta channel) until it is proven.

## Opting in

Declare the version in `hermes-plugin.json`:

```json
{
  "id": "acme.license-gate",
  "apiVersion": 2,
  "permissions": ["sessions.read", "inbox.raise", "features.read", "review.checks"]
}
```

A plugin without `apiVersion` (or with `1`) gets the original API, unchanged. While v2 is on, Hermes marks such a plugin as using the old API in Settings > Plugins and logs one deprecation warning when it starts. **v1 plugins stop loading in Hermes 2.2.** A plugin that asks for a version this Hermes does not offer (v2 with the flag off, or an unknown number) is not started, and Settings > Plugins says why.

Everything v1 offers is still there in v2. The one deprecated call is `agents.watchTranscript`: it only understands Claude transcripts. It keeps working in v2 and warns once; use `agents.onEvent` instead.

## What v2 adds

| Namespace | Call | Permission |
|---|---|---|
| `agents` | `getStatus(sessionId)`, `onEvent(listener)`, `onStatusChange(listener)` | `sessions.read` |
| `inbox` | `raise({ kind, sessionId?, detail })`, `resolve(id)`, `list()` | `inbox.raise` |
| `features` | `list(sessionId)`, `get(sessionId, slug)` | `features.read` |
| `review` | `registerCheck({ id, title, description?, run })` | `review.checks` |

### Agents: one event stream for every agent

`onEvent` receives `{ sessionId, event }` for every session, whatever the agent. The events are the same ones Hermes itself uses (`status`, `turn_start`, `turn_end`, `turn_failed`, `turn_interrupted`, `attention`, `identity`, `exit`), and a status is always one of the same thirteen kinds with a confidence (`exact`, `signal`, `guessed`). Newer versions of Hermes may add event types: ignore the ones you do not know.

Listeners run after Hermes has recorded the event, never inside it; a listener that throws is logged and affects nothing else. Payloads are frozen copies.

### Inbox

`raise` returns the item. Hermes sets its source to `plugin:<your id>`; you cannot set it. Raising the same kind, session and detail again returns the open item. A plugin can hold at most 20 open items, can only resolve and list its own, and its items are removed when it is turned off or uninstalled.

### Feature tracks (read-only)

`list(sessionId)` reads `.hermes/features/<slug>/feature.md` in the repository the session works in and returns each track's front matter (`slug`, `track`, `phase`, `gate`, `doneWhen`) and body, or why it could not be read (with the line number). Hermes never follows symbolic links there and skips files over 64 KB. There is no way to write.

### Review checks

`registerCheck` adds a check that the Review Desk runs over a diff. `run(input)` gets the unified diff and the same diff parsed into files and added lines (with their line numbers), and answers `{ outcome: "pass" | "warn" | "fail", summary, findings: [{ file, line, message }] }`. A check that throws, answers something else or takes longer than 10 seconds shows as an error, never stops the other checks, and cannot change what they see.

## Sample

[`docs/examples/plugins/license-gate`](examples/plugins/license-gate) is a complete v2 plugin in plain JavaScript: a License scan that fails on copyleft licenses in added lines and raises a gate in the inbox, naming the feature track the session works on. Copy the folder into your plugins folder to try it.

The TypeScript types are in `@hermes-hq/plugin-sdk` (`HermesPluginAPIv2`, `definePluginV2`).
