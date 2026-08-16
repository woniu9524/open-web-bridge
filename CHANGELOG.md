# Changelog

Notable changes per release. Dates are release dates; the repository history
has the full detail.

## 1.2.1 — 2026-08-16

Follow-up to 1.2.0: an independent review reproduced three real defects in that
release's `task_end` work, and writing the regression test for them surfaced a
fourth, older one. **If you are on 1.2.0, upgrade.**

### Fixed

- **`task_end` used the task *title* to prove ownership, and titles are not
  unique** — running `task begin` with the same title deliberately reuses the
  group, so two concurrently-running same-named tasks each passed the other's
  ownership check. The guard permitted exactly what it was written to prevent:
  one task would clear the other's context, stop its recorder, and file its HAR
  under its own directory, reporting a clean success. Ownership is now proven
  with the task id, which `task_begin` hands to the extension.
- **`task_id` itself was not unique.** It is a second-resolution timestamp plus
  a title slug, so two same-titled `task_begin` calls in the same second
  produced the *same* id — colliding metadata files, and two tasks sharing one
  identity. Ids now get a `-2`, `-3`, … suffix on collision.
- **A task begun with no title could never be ended.** `task_begin` stored a
  timestamp fallback while `task_end` compared against the empty title, so the
  task was always misjudged as someone else's: archived as `ended_stale`, its
  extension context never cleared, its recorder never stopped.
- **Task tab ownership no longer depends on tab groups.** Groups are only
  created for `--new-tab` navigations, so any task that reused an existing tab
  looked like it owned no tabs at all, and 1.2.0 silently skipped stopping and
  archiving its recording. Each task now tracks the tabs it navigates. A
  recorder genuinely outside the task is reported in `recorders_not_archived`
  rather than passed over in silence.
- **`net detail` on a WebSocket could dump ~400 KB into the caller's context.**
  The CLI's output clipper only shrinks top-level strings, so an array of frame
  objects slipped past it, and `--max-body` did not apply. It now returns the
  last 50 frames by default (`--max-frames <n>` to raise), and reports
  `framesReturned` / `framesKept` / `framesSeen` separately.
- `frameCount` meant "total seen" in `net list` but "currently kept" in
  `net detail`; both now report `framesSeen`, so the numbers agree.
- Four WebSocket event handlers wrote to the capture buffer without checking
  that the connection was known, minting typeless records that never finish —
  one of which could stop `wait --network-idle` from ever settling again on
  that tab. All four now ignore frames for connections they never saw open.
- `owb cookie set --http-only` and `--same-site` reached validation, but the
  unknown-flag error message never mentioned the universal flags (`--tab`,
  `--timeout`, …), implying they were rejected too.

## 1.2.0 — 2026-08-16

### Breaking

- **A flag a command doesn't take is now a usage error** (exit 2) instead of
  being silently dropped. `owb page --url <url>` used to exit 0 having done
  nothing — it re-snapshotted whatever the tab was already showing, and the
  stale result was indistinguishable from a successful navigation. The error
  names the offending flag and lists the valid ones. `owb call <tool>` is
  exempt (its argument surface can't be enumerated) and the contents of
  `--args` are never checked, so both escape hatches still pass anything.

### Added

- **`net` sees WebSocket traffic.** Connections show up in `net list` with
  `isWebSocket: true`, `status: 101` and a live `frameCount`; `net detail`
  returns the frames (`dir`/`opcode`/`len`/`data`) instead of a response body.
  Only the HAR path could see WebSockets before, so `net` alone would report a
  push-driven page as having no traffic. Two caps keep a chatty socket bounded:
  the most recent 200 frames per connection (`framesSeen` is the true total,
  `framesDropped`/`framesNote` appear once frames are lost) and 2000 chars per
  payload — record with `har start`/`har save` for a complete session.

### Fixed

- `task_end` no longer reaches outside its own task when cleaning up. It
  confirms with the extension that the task is still the live one before
  clearing anything, and stops only the recorders on **its own** tabs rather
  than every recorder in the browser — previously, ending one task could stop
  and absorb a concurrently-running task's recording into its own HAR, and
  clear that task's tab group. The trade-off: a recording on a tab that never
  joined the task's group is no longer auto-archived by `task_end` (the data is
  still there — `har save` it yourself).
- `cookie set --http-only` and `--same-site` were documented but dead: the CLI
  turns them into `http_only`/`same_site` and the implementation read only the
  camelCase spelling, so both were silently discarded. Both spellings now work.
- `task_end`'s result reports `tabs_closed: false` alongside `group.cleared`,
  which only ever meant "the task pointer was cleared" — never that any tab was
  closed.

## 1.1.1 — 2026-08-16

### Fixed

- `task_end` takes an explicit `--task-id` (mirroring `flow save`) instead of
  always trusting the daemon's single shared "current task" pointer. With
  several agents driving one browser, whichever `task_begin` ran last owned
  that pointer, so an earlier task's plain `task_end` either raised `NO_TASK`
  or — worse — returned `ok` while archiving *someone else's* task. Ending a
  task that is no longer current now archives it as `ended_stale` without
  touching the live recorder, tab group, or pointer, and the pointer is
  re-checked immediately before it is cleared so a `task_begin` landing during
  `task_end`'s own awaits can't have its task closed out from under it.
- `frames` no longer accumulates execution contexts from pages the tab has
  already navigated away from. The registry is cleared on
  `Runtime.executionContextsCleared` rather than `Page.frameNavigated`: the
  latter is a different CDP domain with no ordering guarantee against the new
  page's `executionContextCreated`, so the stale entries survived and could
  shadow the real context — `eval --frame-pattern` could silently resolve
  against a context that no longer existed instead of erroring.
- `cdp` explains itself when its params arrive empty. It is the one command
  that does not fold flat `--foo-bar` flags into CDP params, and reaching for
  them produced Chrome's opaque `BINDINGS: mandatory field missing at
  position N` under an `INTERNAL` code that invited retries; it is now
  `BAD_ARGS` naming the nested `--args '{"method":…,"params":{…}}'` form.

## 1.1.0 — 2026-08-16

### Breaking

- **Command table trimmed to 80 commands in 16 groups.** Removed and renamed
  names now fail with a usage error that names the replacement, rather than
  being kept as silent aliases:
  | Old | New |
  | --- | --- |
  | `owb click-mouse <target>` | `owb click <target> --mouse true` |
  | `owb har stop` | `owb har discard` (and `har save` is the only stop-and-keep) |
  | `owb debug frames` | `owb debug stack` (top-level `owb frames` still lists iframes) |
  | `owb state export` / `state import` | `owb call export_state` / `import_state` |
- **The raw event log is off by default.** Set `OWB_EVENTS_LOG=1` to restore it.
  Nothing read the file back — `events` backfill and `hook_logs` both serve from
  the in-memory ring buffer — and it grew without bound (18 GiB measured).
- **Audit results are truncated and redacted.** `work/sessions/*.jsonl` keeps
  tool-call arguments verbatim (workflow replay depends on them) but caps result
  payloads at 2 KB and strips credential fields. Anything parsing those files
  for result bodies needs to adjust.

### Added

- `owb seq "<step>" "<step>" …` — run several commands over one process and one
  connection, removing the ~100–200 ms per-command spawn cost that dominates
  long mechanical sequences. `--file`, `--delay-ms`, `--keep-going`; JSONL out.
- Log rotation and retention for everything under `work/`: per-day files, a
  per-file size cap (`OWB_LOG_MAX_FILE_MB`, default 64) and a retention window
  (`OWB_LOG_KEEP_DAYS`, default 14; `0` disables).
- `npm run test:browser` / `test:replay` / `test:relay` for the suites that need
  a real browser, the curl-impersonate binary, or just the relay.

### Fixed

- `eval --await-promise` and `--return-by-value` never took effect — the CLI
  snake-cases flags while the tool read only camelCase, so awaiting a Promise
  silently returned `{}`.
- An expression serializing to `{}` now explains itself (un-awaited Promise,
  Map/Set, class instance, DOM node) instead of looking like an empty success.
- `read_page` triages a near-empty body: still loading, bot-check interstitial,
  empty SPA shell, or interaction/iframe-gated content.
- Five silent-success paths: `harAssert` without `url_pattern` (matched every
  request), `verify_signer` on a sample without `expected` (`pass_rate` 1.0),
  `replay` with a bad `max_body` (empty body reported as success),
  `emulate_reset`'s retry (reported success while overrides remained), and
  `task_begin`'s ASCII slug (Chinese titles collapsed, colliding task ids).
- A `while(true)` in `signer_code` no longer hangs the daemon: the vm timeout
  now covers the call, not just evaluating the source.
- The deadman that detaches debuggers when the daemon disappears now survives
  service-worker recycling, and enumerates real attached targets.
- `daemon.*` calls respect the caller's timeout; `workflow_run` stops at its
  deadline instead of driving the browser after the caller gave up.
- `workflow_save` streams the audit log within the task's date window instead of
  synchronously reading every session file (130 MB measured) into memory.
- Relay: tokens are validated before a Durable Object is created (an unbounded
  room-creation quota drain), frames are forwarded to the peer role rather than
  broadcast, re-pairing no longer deadlocks the daemon, and `daemon.status`
  reports real pairing state instead of inferring it from environment variables.
- The extension popup accepted `ws://` for the relay while its own message said
  `wss://` — the token and cookies would have crossed the internet in the clear.
- Files under `work/` are created `0600` and directories `0700`.
- `hooks/fetch.js` captures the native `JSON.stringify` like its three siblings,
  so the crypto preset no longer records a fabricated call per fetch report.

### Changed

- `npm test` runs every headless suite (20, up from 6) plus a `node --check`
  gate over the extension sources, and no longer stops at the first failure.
- `npm version` syncs the extension manifest, and `prepublishOnly` runs the
  tests. `package.json`, `manifest.json` and `package-lock.json` had drifted to
  three different versions.
- Update checks are silent unless an update exists.

## 1.0.2 — 2026-08-15

- Multi-agent `owb skill install` (Claude Code / Codex / Cursor / OpenCode),
  `owb update check`, `owb daemon-stop`.

## 1.0.1 — 2026-08-14

- First public release: CLI, daemon, extension, relay, and the bundled skill.
