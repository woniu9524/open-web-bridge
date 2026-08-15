# owb command reference

SKILL.md covers how to get work done; this file covers **what arguments each
command takes**. Look things up here before writing a complex call — it is
faster than guessing. `owb help <group>` is the same information, shorter.

**Contents**: [Argument rules](#argument-rules) · [Timeouts](#timeouts-three-layers) ·
[Quoting](#quoting-complex-args-and-eval) · [Meta](#meta) · [Core](#core) ·
[tab](#tab) · [net](#net) · [har](#har) ·
[hook / debug / script / verify](#hook--debug--script--verify) · [cookie](#cookie) ·
[state](#state) · [env](#env) · [file](#file) · [task / flow](#task--flow) ·
[human / daemon](#human--daemon) · [Environment variables](#environment-variables)

## Argument rules

- `--foo-bar <value>` maps to the tool argument `foo_bar`. Values are
  JSON-parsed when possible, so `--new-tab true` is the boolean `true`, not the
  string `"true"`.
- Identifier-ish arguments are **never** JSON-parsed, because they are strings
  that often look like numbers: `request_id` (CDP ids look like `110404.81`),
  `script_id`, `object_id`, `frame_id`, `text`, `url_pattern`, `selector`,
  `expression`, `name`, `path`, `keys`. Coercing those would silently break
  lookups and comparisons.
- `--tab <id>` maps to `tabId`. **Without it, commands act on the active tab** —
  which is the page the user is looking at, not necessarily yours.
- `--args '<json>'` is merged wholesale and has **highest priority**. Object-shaped
  arguments (`network`, `geolocation`, `files`, `assertions`) can only be passed
  this way.
- `--out <path>` only means anything for screenshots and PDFs (binary to disk).
- `--raw` prints the full result envelope, `--compact` prints single-line JSON,
  `--no-autostart` stops the CLI from starting a daemon.
- Click-family commands take **either** `selector` **or** `ref`, never both
  (`BAD_ARGS`). A positional starting with `@` is a ref; otherwise it is a CSS
  selector.

Output: success prints data JSON to stdout; failure prints one line
`error CODE: message` to stderr with a non-zero exit code (2 for usage errors).

These underscore-prefixed fields come from the CLI, not the page:

| Field | Meaning |
| --- | --- |
| `_clipped` + `_hint` | Result exceeded 60KB and was truncated; narrow the request per `_hint` |
| `_nodesOmitted` | `page` dropped the structured `nodes` duplicate (content is all in `lines`) |
| `_harOmitted` | HAR body was not printed to stdout — use `har save` instead |

## Timeouts (three layers)

| Layer | Argument | Default |
| --- | --- | --- |
| CLI waiting for the ctl result | `--timeout <seconds>` | 120 (ctl caps at 300) |
| Tool-internal waiting | `--timeout-ms <ms>` | open 30000 / wait 10000 (cap 110000) / wait-user 280000 |
| A single CDP call | — | 30s, hardcoded, **not adjustable** |

`--timeout` is **not** forwarded to the tool. To let a page wait longer, always
use `--timeout-ms`. If tool-internal waiting exceeds 110s you must *also* raise
`--timeout`, or you hit the 120s envelope first (`ctl call timeout`).

## Quoting complex `--args` and `eval`

This is the most common time-waster, and it is a **shell quoting problem, not a
tool problem** — but the symptoms look like the tool is broken:

```
用法错误：--args 不是合法 JSON：Bad escaped character in JSON at position 38
error EVAL_EXCEPTION: Uncaught: SyntaxError: missing ) after argument list
```

Two frequent triggers: **Windows paths** (`C:\Users\...` — `\U` is an illegal
JSON escape) and **JS expressions containing strings** (three layers of quotes
always collide).

Don't fight the escaping — put the content in a file and read it back:

```bash
cat > /tmp/expr.js << 'EOF'
(function(){ return JSON.stringify({ n: document.querySelectorAll("a").length }); })()
EOF
node -e 'console.log(JSON.stringify({expression:require("fs").readFileSync(process.argv[1],"utf8")}))' \
  /tmp/expr.js > /tmp/eval-args.json
owb eval --args "$(cat /tmp/eval-args.json)"
```

Simple arguments stay simple (`owb fill @e3 "keyword"` — but on PowerShell,
quote the ref; next section); the file pattern is only for when quotes collide.

### PowerShell (Windows): quote every `@ref`

In PowerShell a bare `@e3` is **splatting syntax** — "expand the variable
`$e3`" — and an undefined variable expands to *nothing*, so the ref silently
vanishes before owb ever runs. `owb fill @e3 "1800"` arrives as `fill "1800"`:
the value gets promoted to selector and the real value is missing, so the
error is a confusing `BAD_ARGS: fill: value is required`. This hits **every**
command that takes an `@ref` (`click`, `fill`, `scroll --ref`):

```powershell
owb fill '@e3' 'keyword'    # ✓ quoted ref — single or double quotes both work
owb click '@e5'             # ✓
```

The bash examples throughout these docs write refs bare because POSIX shells
don't expand `@`. If a value fights PowerShell quoting on top of that,
`owb call fill --args '{"ref":"e3","value":"..."}'` sidesteps the shell layer
entirely (PowerShell single-quoted strings are literal, so the JSON survives).

### Windows hosts that spawn without a shell

Agent runtimes that launch subprocesses directly (Python `CreateProcess`,
some sandboxes) can't execute npm's `owb.ps1` / `owb.cmd` shims — `owb` works
in your terminal but the agent reports "command not found". Invoke the entry
file with node instead:

```powershell
node "$(npm root -g)\open-web-bridge\owb-daemon\src\cli.js" page --mode text
```

`npm root -g` prints the global `node_modules` directory; resolve it once and
reuse the absolute path from any shell-less spawn API.

## Meta

| Command | Description |
| --- | --- |
| `owb` | Self-check: daemon reachability, mode (local/relay), extension connection, attached tabs |
| `owb setup` | Install walkthrough (extension path + skill install + self-check) |
| `owb skill install [--to <agents>] [--project] [--dir <path>]` | Install the skill for **every detected agent** (`~/.claude` / `~/.codex` / `~/.cursor` / `~/.opencode`). `--to claude,codex` picks agents, `--project` installs into the current project instead of the home directory, `--dir <path>` installs to `<path>/owb` |
| `owb skill path` | Print the bundled skill source directory |
| `owb update check` | Compare the installed version against the npm registry; prints the upgrade steps when a newer version exists. Run once at the end of a session, per SKILL.md "Staying current" — **silent chore: only an actual `⬆ update available` is worth mentioning to the user; up-to-date and registry-unreachable results are said to no one** |
| `owb help [group]` | All commands, or details for one group |
| `owb call <tool> --args '<json>'` | Call any underlying tool directly (escape hatch for anything the aliases miss) |
| `owb seq "<step>" "<step>" …` | Run several steps over **one** process and connection (drops the ~100–200ms per-command spawn overhead). Each step is a full owb command minus the `owb` prefix; `--file <path>` adds one step per line (`#` comments; a line starting with `{` is a JSON step `{"tool":…,"args":{…}}` — zero shell quoting); `--delay-ms <n>` pauses between steps; `--keep-going` continues past a failed step; top-level `--tab` / `--timeout` become each step's default. Output: one JSON line per step + a `{"seq":{steps,ok,failed}}` summary; exit 1 if any step failed. Recipe: `recipes.md` |

## Core

| Command | Arguments | Notes |
| --- | --- | --- |
| `open <url>` | `url`(required) `--new-tab` `--active`(default true) `--wait-until load\|domcontentloaded\|complete` `--timeout-ms`(30000) | A timeout is not an error — it returns `loadCompleted:false`. May also carry `httpErrorHint` / `attachHint` / `taskHint` / `backgroundTabHint` |
| `back` / `forward` | `--timeout-ms` | Underlying tool is `history` |
| `reload` | `--bypass-cache` `--timeout-ms` | Hard reload with `--bypass-cache true` |
| `page` | `--mode snapshot\|article\|text`(default snapshot) `--max-chars`(20000, min 100) `--max-nodes`(400, **max 2000**) `--since-last` | Returns `lines`/`content`/`text`, plus a `text` alias in every mode; sets `truncated`/`omittedNodes` when clipped |
| `shot` | `--format png\|jpeg`(png) `--quality`(jpeg only, 1-100, default 80) `--full-page` `--out <path>` | Always writes to disk; stdout returns only `{savedTo, bytes}` |
| `click <@ref\|selector>` | `--ref` / `--selector` (pick one). `--mouse true` sends **real mouse events** (`isTrusted:true`, visible cursor animation) and unlocks `--x --y` (coordinates), `--button left\|right\|middle`, `--click-count 1\|2` | Disabled elements raise a clear error rather than reporting false success |
| `fill <@ref\|selector> <value>` | `value`(required — omitting it errors rather than silently clearing the field) | Uses the native setter, so React controlled components work |
| `keys` | `--text <text>` **or** `--keys "<sequence>"` (exactly one; both is an error) | Key names below |
| `scroll` | `--args '{"to":"top\|bottom"}'`, `--dy`/`--dx` (relative), `--absolute true` with `--dy`, `--selector`/`--ref` (scroll to element), `--settle-ms`(400, cap 5000) | Returns `{x, y, maxY, atBottom}` |
| `eval <expression>` | `expression`(required) `--frame-pattern <regex>` `--await-promise` `--return-by-value` | Returns `{value, type}`; `value` is usually a JSON string, so **parse twice** |
| `wait` | Exactly one of `--selector` / `--text` / `--url-pattern` / `--network-idle`; plus `--state visible\|attached`(visible) `--timeout-ms`(10000) `--idle-ms`(500) `--stale-ms`(15000) | Long-lived connections (WebSocket/SSE) do not count against network idle |
| `frames` | `--include-extensions` | `contextId:null` means a cross-origin frame — `eval --frame-pattern` cannot reach it |
| `status` | — | Extension-side state: WS connection, attached tabs |
| `cdp` | `--args '{"method":"<CDP method>","params":{...}}'` | Escape hatch: send raw CDP |

**Key names for `keys`**: `Enter Tab Escape Backspace Delete Home End PageUp
PageDown ArrowLeft ArrowUp ArrowRight ArrowDown Space F1`–`F12`, single
characters (`a`, `5`), and modifier combos `Ctrl+a` `Shift+Tab` `Meta+c`
(valid modifiers: Ctrl, Alt, Shift, Meta). Separate multiple keys with **spaces**
to press them in order.

## tab

| Command | Arguments | Notes |
| --- | --- | --- |
| `tab list` | — | All tabs, including group membership |
| `tab find <regex>` | `url_pattern` | Find by URL — faster than listing and filtering yourself |
| `tab close` | `--tab <id>` `--force` | Only tabs in OWB-managed groups; closing a user's own tab raises `FORBIDDEN` |
| `tab close-group` | `--args '{"include_tasks":false}'` (default true), `{"include_handoff":true}` (default false) | One-shot cleanup |

## net

Capture and inspect network traffic. Full workflow in `debugging.md`.

| Command | Arguments |
| --- | --- |
| `net start` | `--clear` (clears the old buffer by default; `--clear false` keeps it) |
| `net stop` | — |
| `net list` | `--url-pattern` `--limit` `--sort-by duration\|size` `--newest` `--include-orphans` `--include-extensions` |
| `net detail` | `--request-id`(required) `--include-body` `--max-body` |
| `net initiator` | `--request-id`, or `--url-pattern`/`--url` |
| `net capture` | `--url-pattern`(required) `--trigger '<JS expression>'` `--timeout-ms` |

## har

Recording, replay generation, and regression comparison. Full workflow in
`debugging.md`.

| Command | Arguments |
| --- | --- |
| `har start` | `--include-bodies` `--max-body-bytes` `--max-total-body-bytes` `--url-pattern` `--exclude-pattern` `--resource-types` `--capture-console` `--capture-screenshots` `--capture-storage` |
| `har save` | `--args '{"filename":"name"}'` `--title` `--tab`. Writes `work/har/<name>.har`; **with an active task it always writes `tasks/<id>/recording.har` and `filename` is ignored** |
| `har discard` | `--title`. Stops **and throws the recording away** (no file). `har save` is the only command that stops and writes; there is no plain "stop" |
| `har status` | — |
| `har to-replay` | `--path <path under work/>` or `--args '{"har":{...}}'`; `--format python\|curl\|node` `--url-pattern` `--save` |
| `har diff` | `--baseline <path>` `--current <path>` `--save` |
| `har assert` | `--path` plus `--args '{"assertions":[...]}'`; assertion types in `debugging.md` |

## hook / debug / script / verify

These four groups are the reverse-engineering ladder. Usage and worked examples
live in **`debugging.md`**; below are just the names and the critical arguments.

⚠️ `oracle` is a **top-level** command (`owb oracle`), even though `owb help`
lists it under the debug group. Everything else in that group takes the `debug `
prefix.

| Command | Required / key arguments |
| --- | --- |
| `hook preset <name>` | `preset xhr\|fetch\|crypto` (or `--args '{"presets":[...]}'`); `--reload` |
| `hook fn` | `--function-path <global path>`; `--trace-args` `--trace-ret` `--trace-stack` `--hook-code` `--replacement` `--position` |
| `hook remove` | `--preset` / `--args '{"presets":[...]}'` |
| `hook status` | — |
| `hook logs` | `--source` `--since-seq` `--limit`(100, cap 500) `--tab`; **the result field is `events`, not `logs`** |
| `debug break-xhr` | `--url-substring` or `--url-pattern` |
| `debug break-fn` | `--function-path`; `--condition` `--url-pattern` `--line-number` `--column-number` |
| `debug break-remove` | `--url-substring` / `--url-pattern` / `--key` |
| `debug stack` | `--max-frames` `--prop-limit` `--include-global` `--auto-resume` |
| `debug step` | `--action into\|over\|out` (default over); errors clearly if nothing is paused |
| `debug resume` | — |
| `debug console` | `--enabled true\|false` |
| `oracle` | `--function-path` or `--object-id`; `--args '{"call_args":[...]}'` (**a misspelled argument name errors out rather than silently succeeding**); `--freeze` (default true) |
| `script list` | `--url-pattern` `--wait-ms` `--include-extensions` |
| `script source` | `--script-id`(required) `--max-chars` |
| `script search` | `--query`(required) `--url-pattern` `--limit` `--case-sensitive` `--is-regex` |
| `script patch` | `--url-pattern`(required) `--code` `--patch-type prepend\|proxy_probe` (default prepend); **takes effect on next load** |
| `script unpatch` | `--id` or `--url-pattern` |
| `script watch` | `--url-pattern` `--action` `--event` `--patch-type` `--code` |
| `script watch-remove` | `--id` or `--url-pattern` |
| `verify signer` | `--args '{"source":"(input)=>({sig:...})","samples":[...]}'`; passing only `calls` runs a dry run. **A bare function declaration evaluates to `undefined` — wrap it in parentheses** |
| `verify replay` | `--url`(required) `--method` `--impersonate chrome\|edge\|firefox\|safari` (or a versioned target) `--allow-redirects` `--max-body`; `--args` carries `headers`/`body`/`params`. **Needs the curl-impersonate binary** |
| `verify evidence` | `--path`(required) `--args '{"content":...}'`; missing `content` is a `BAD_ARGS` error, and the result reports `bytes` |

## cookie

| Command | Arguments |
| --- | --- |
| `cookie get` | `--args '{"urls":["https://x.com/"]}'` (defaults to the current tab's URL) |
| `cookie set` | `--name`(required) `--value`(required); optional `--url` `--domain` `--path` `--secure` `--http-only` `--same-site Strict\|Lax\|None` `--expires` (Unix seconds or a parseable date string) |
| `cookie delete` | `--name`(required) |

## state

Saved login sessions.

| Command | Arguments | Notes |
| --- | --- | --- |
| `state save <name>` | `name`(required) `--tab` | cookies + localStorage + IndexedDB into `work/states/<name>.json` |
| `state load <name>` | `name`(required) `--tab` | Restore |
| `state list` | — | What is stored |
| `state delete <name>` | `name`(required) | Drop stale ones |

The raw extension-side primitives behind save/load are reachable as
`owb call export_state` / `owb call import_state --args '{"state":{...}}'`
(current page's storage only) — the four commands above cover the normal
workflow.

⚠️ These files hold **plaintext credentials**. `work/` is gitignored, but be
careful before packaging or sharing the repo.

## env

Device, network, geolocation and UA emulation.

| Command | Arguments |
| --- | --- |
| `env set` | Flat: `--width` `--height` `--mobile` `--touch` `--device` `--timezone` `--locale` `--user-agent`. Object-shaped via `--args`: `network:{latency,download,upload}`, `geolocation:{latitude,longitude,accuracy}`, `permissions:[...]`, `viewport:{...}` |
| `env reset` | — ⚠️ **Always reset when done**, or the user's browser stays stuck in emulation |
| `env compare` | Before/after environment comparison |

## file

| Command | Arguments | Where the file lands |
| --- | --- | --- |
| `download` | `--url` or `--selector`; `--filename` `--timeout-ms` | The system download directory **on the machine running the browser**; the result has no `dir`/`originalPath` |
| `file fetch` | `--url`(required) `--timeout-ms` | Daemon-side fetch, copied into `work/downloads/`; returns `path`/`originalPath`/`dir` |
| `upload` | `--ref`/`--selector` plus `--args '{"files":[{"name":"a.txt","base64":"..."}]}'` (**does not take a file path**) | Builds a File inside the page, bypassing the filesystem |
| `pdf` | `--format A4\|Letter…` `--landscape` `--print-background` `--margin-top/-bottom/-left/-right` `--prefer-css-page-size` `--out <path>` | Always to disk; stdout returns the path |

Building the base64 payload for `upload`:

```bash
node -e 'const fs=require("fs"),p=process.argv[1];
console.log(JSON.stringify({ref:"@e12",files:[{name:require("path").basename(p),
base64:fs.readFileSync(p).toString("base64")}]}))' "C:\Users\me\a.txt" > /tmp/up.json
owb upload --args "$(cat /tmp/up.json)"
```

## task / flow

| Command | Arguments | Notes |
| --- | --- | --- |
| `task begin <title>` | `title` (positional) | Creates a `task: <title>` tab group plus a `work/tasks/<id>/` archive directory |
| `task end` | — | Stops recording, archives the HAR, clears task context. **Does not close tabs** |
| `task list` | — | Past tasks |
| `flow save <name>` | `name`(required) `--task-id` | Captures calls within the task's time window; without an active task it raises `NEED_TASK` |
| `flow run <name>` | `name`(required) `--keep-tab-ids` `--continue-on-error` | Recorded tabIds are dropped by default and each step resolves to the active tab |
| `flow list` | — | Saved flows |

## human / daemon

| Command | Arguments | Notes |
| --- | --- | --- |
| `handoff` | `--reason "<what the user should do>"` | Moves the tab into the orange "✋ OWB waiting for you" group |
| `wait-user` | `--condition url_change\|selector\|text` (**defaults to url_change**) `--selector` `--text` `--timeout-ms`(280000) `--clear` | For logins, **always pass an explicit condition** — a login that does not change the URL will otherwise wait out the full timeout |
| `daemon-status` | — | Mode (local/relay), relay URL, extension presence, current task |
| `daemon-stop` | — | Stops the daemon (it restarts on the next command). Part of the upgrade path; also loses `currentTask` context |
| `reload-ext` | — | Makes the extension reload itself, so you don't have to click through `chrome://extensions` |

## Environment variables

Daemon side, **read only at startup**:

| Variable | Effect |
| --- | --- |
| `OWB_PORT` | Daemon port (default 43917) |
| `OWB_WORK_DIR` | Location of `work/` (archives, HAR, saved sessions, downloads) |
| `OWB_RELAY_URL` | Relay address; with the next variable, enables relay mode — see `relay.md` |
| `OWB_RELAY_TOKEN` | Relay token; must match on both ends |
| `OWB_CURL_BINARY` | Path to curl-impersonate (used by `verify replay`) |

CLI side, read per command:

| Variable | Effect |
| --- | --- |
| `OWB_NO_EXT_RETRY` | Any value other than `0` **skips the `NO_EXTENSION` backoff** (~35s total). Useful in automated tests, or when you know the browser is closed and don't want every command to stall |

⚠️ Because the daemon reads its environment **only at startup**, changing these
means **stopping the running daemon first** and letting the next `owb` command
start a fresh one. Setting the variable alone does nothing.
