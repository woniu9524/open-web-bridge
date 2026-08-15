# Debugging and reverse-engineering with owb

SKILL.md covers using the browser to **get work done**; this file covers using it
to **find out what is going on**: why an endpoint is slow, why a request 403s,
what computes this signature parameter, whether a release broke an old API.

**Contents**: [① Look at requests](#-look-at-requests) · [② HAR](#-har-archive-replay-compare) ·
[③ Hooks](#-hooks-see-how-a-function-is-called) · [④ Breakpoints](#-breakpoints-freeze-the-moment-the-request-goes-out) ·
[⑤ Read and verify code](#-read-code-verify-algorithms) · [Worked example](#putting-it-together) ·
[Shared pitfalls](#pitfalls-across-this-whole-line)

Five rungs. **Work top-down and stop as soon as a rung answers your question.**

| Rung | Commands | Answers |
| --- | --- | --- |
| ① Look at requests | `net start/list/detail/initiator` | What was sent, how slow, how big, who triggered it |
| ② Keep evidence | `har start/save` + `to-replay/diff/assert` | Archive it, turn it into a browser-free replay script, compare against a baseline |
| ③ Hook | `hook preset/fn` + `hook logs` | How often a function is called, with what arguments and return values |
| ④ Breakpoint | `debug break-xhr/break-fn/frames` | What is in the closure **at the moment** the request goes out |
| ⑤ Read/patch code | `script search/source/patch`, `oracle`, `verify signer` | What the algorithm is, and whether it can be reproduced outside the page |

⚠️ **Scope**: use this line on the user's own sites, or sites the user has
explicitly asked you to investigate. Circumventing anti-abuse controls or
breaking into someone else's system is out of bounds.

## ① Look at requests

⚠️ **`net start` must come before navigation**, or you get orphan records with no
URL (the result's `orphanRecordsHidden` tells you how many were dropped).

🚨 **Do not write this as `owb net start` followed by `owb open <url>`.** Without
`--tab`, `net start` binds to the **active tab** — the page the user is currently
looking at — and an `open` without `--new-tab` then **navigates their page away**.
This has really happened: capture bound to the user's admin dashboard.
**Get your own blank tab first, then start capturing on it:**

```bash
owb open about:blank --new-tab true --active false     # ① your own tab
# → note the returned tabId; every command below carries --tab
owb net start --tab <id>                       # ② capture bound to your tab
owb open https://target.example --tab <id>     # ③ now navigate — no first-paint request is missed
owb net list --tab <id> --sort-by duration --limit 10  # slowest ten
owb net list --tab <id> --sort-by size --limit 10      # heaviest ten
owb net list --tab <id> --url-pattern "api/"           # endpoints only
owb net detail --tab <id> --request-id <id> --include-body true   # full headers + body
owb net initiator --tab <id> --request-id <id>         # who sent it: full call stack
```

`net initiator` is the bridge from "where did this request come from" to "which
code sent it" — take the script URL and line number off the top of the stack and
go straight to rung ⑤ `script source`.

To catch a request that **only fires on interaction**, don't race it yourself —
use the macro:

```bash
owb net capture --url-pattern "api/search" --args '{"trigger":"document.querySelector(\"#go\").click()"}'
```

It arms the listener first, then runs `trigger`, then returns the matching
request. `trigger` takes a plain JS expression string.

## ② HAR: archive, replay, compare

```bash
owb har start --args '{"include_bodies":true,"url_pattern":"api/"}'
owb open <target page> --new-tab true
owb har save --args '{"filename":"investigation"}'
```

⚠️ **`har save` is the only command that stops AND keeps the recording** —
`har discard` also stops but throws the data away (its job: abandoning a
recording). Discard first and `save` reports `NOT_RECORDING`; **the data is
gone for good**.
⚠️ With an active task it always writes `tasks/<task id>/recording.har` and
ignores `filename`.

`har save` reports `entries` (what is actually in the file) plus `entriesDropped`
when some recorded requests had no complete response and could not be serialized.

Three things to do with a recording — this is where HAR earns its keep:

```bash
# Turn it into a script that runs without a browser (dynamic signature headers
# become placeholders).
# ⚠️ One page load is easily dozens of requests (analytics, fonts, map tiles);
# unfiltered output is unusable. --url-pattern keeps only what you want, and the
# result reports matched/total so you can see what was selected.
owb har to-replay --path har/investigation.har --format python --save true \
  --url-pattern "api/search"

# Compare two recordings for drift: missing requests, changed status codes,
# changed response shapes.
owb har diff --baseline har/before-release.har --current har/after-release.har --save true

# Assertions: turn "this endpoint must return 200 and contain this field" into a
# repeatable check.
owb har assert --path har/investigation.har --args '{"assertions":[
  {"type":"request_exists","url_pattern":"api/user"},
  {"type":"response_status","url_pattern":"api/user","value":200},
  {"type":"response_contains","url_pattern":"api/user","value":"nickname"},
  {"type":"min_requests","value":5}
]}'
```

Assertion types: `request_exists` / `request_absent` / `response_status` /
`response_contains` / `min_requests`. ⚠️ A `har` argument passed as a JSON
**string** is parsed back into an object; invalid JSON raises `BAD_HAR` rather
than silently "passing" every assertion.

## ③ Hooks: see how a function is called

Three ready-made presets cover most "how is this parameter assembled" cases:

| Preset | What it hooks |
| --- | --- |
| `xhr` | `XMLHttpRequest` open/send/setRequestHeader |
| `fetch` | `fetch()` arguments and responses |
| `crypto` | Encoding primitives like `btoa`/`atob`/`JSON.stringify` |

```bash
owb hook preset crypto            # ⚠️ reloads the page by default (see below)
owb click @e5                     # trigger the target action
owb hook logs --source hook:crypto --limit 50
```

⚠️ **`hook preset` defaults `reload` to true and will reload the page.** Hooks are
injected via `addScriptToEvaluateOnNewDocument`, which only applies to documents
created *after* registration — without a reload they simply don't take effect.
The cost is losing half-filled forms and unsaved page state. To preserve the
page, pass `--reload false`, but then **the hook does not apply to the current
page** and you must wait for the next navigation (the result's `_hint` says so
explicitly — don't ignore it).

**Hooking an arbitrary function** (a page global such as `app.sign`):

```bash
owb hook fn --function-path "app.sign" --trace-args true --trace-ret true --trace-stack true
owb click @e5
owb hook logs --source hook:fn
```

`--position before|after|replace`; `replace` with `--replacement '<function
expression>'` swaps the implementation entirely. `--hook-code` takes a custom
callback `(args, result, stack) => {...}`. `--non-overridable true` stops a page
SDK from overwriting your hook later. If the target function doesn't exist yet at
injection time, the template polls for it (up to 15 seconds).

⚠️ **`hook fn` only intercepts calls that go through the hooked path.** It
replaces the `app.sign` **property**, while page code often holds a closure-local
reference (`var s = sign(...)` rather than `app.sign(...)`) — those calls
**bypass the hook entirely**. The symptom: the hook is clearly installed
(`window.__owbFnHooked` has the key, the function body reads
`function sign() { [native code] }`), clicking the button fires a real request,
yet `hook logs` shows only one `installed` event and no calls. **The hook is not
broken** — it cannot see those calls by definition. Measured: calling
`owb eval 'app.sign({...})'` produces a `return` event immediately; clicking the
button produces none.

To catch internal calls, drop to rung ④ `debug break-fn` (breaks on the function
object, so every caller stops) or rung ⑤ `script patch` to edit the source.

⚠️ **The result field is `events`, not `logs`.** `--since-seq` pulls incrementally
(`--since` also works). With hooks on several tabs, filter with `--tab` or the
events are interleaved (`filtered_other_tabs` reports how many were filtered out).
⚠️ On busy sites the `crypto` preset can hit `JSON.stringify` thousands of times
per second — narrow with `--source` and `--limit` rather than pulling everything.

## ④ Breakpoints: freeze the moment the request goes out

Hooks see arguments and return values; they cannot see **intermediate variables
inside the closure**. For those, break.

```bash
owb debug break-xhr --url-substring "/api/sign"    # XHR breakpoint
# or: owb debug break-fn --function-path "app.sign"
owb click @e5                                      # trigger it
owb debug stack --max-frames 3 --prop-limit 40     # read frames and scopes at the frozen moment
owb debug resume                                   # let it go
```

- `debug stack` **does not auto-resume** (pass `--auto-resume true` for that),
  because auto-resuming would interrupt consecutive inspections of the same
  breakpoint. Remember to `debug resume` afterwards, or the page stays frozen and
  every later command reports `PAUSED`.
- Calling `frames` when nothing is paused reports `NOT_PAUSED`, and the message
  tells you whether the breakpoint is armed and whether that code path has been
  reached — **that is not a transient failure, so don't spin on retries**. Go
  trigger the code path.
- `debug step --action into|over|out` steps; `debug break-remove` clears.
- For page errors themselves, stream the console with
  `owb debug console --enabled true`.

⚠️ A breakpoint **freezes the whole page**. If the user is watching that tab,
they see it hang. Always `resume` + `break-remove` when you finish.

## ⑤ Read code, verify algorithms

**Find the code:**

```bash
owb script list --url-pattern "app"              # which scripts the page loaded
owb script search --query "sign" --limit 20      # search all script sources (--is-regex true for regex)
owb script source --script-id <id> --max-chars 20000
```

`script search` is the main entry point for reverse-engineering — far faster than
clicking through files in devtools. Combined with the script URL and line number
from rung ① `net initiator`, it takes you straight to the lines that send the
request.

**Patch the code** (applies on next load):

```bash
owb script patch --url-pattern "app\\.js" --code '<JS to insert>' --patch-type prepend
owb script watch --url-pattern "app\\.js"        # notify when this script loads
owb script unpatch --url-pattern "app\\.js"      # undo when done
```

⚠️ `script patch` changes how this site behaves **in the user's real browser**.
It only lasts for the session, but `unpatch` when you are done — don't leave it.

**Deterministic sampling (`oracle`)** — don't guess the implementation, call the
page's own function as a black box:

```bash
owb oracle --function-path "app.sign" --args '{"call_args":["hello",123]}'
```

`--freeze` defaults to true, freezing time and randomness during the call so the
same input yields the same output. You can also pass `--object-id` (a closure
function reference obtained from `debug stack`) to call private functions.
⚠️ **A misspelled argument name errors out** rather than silently calling with no
arguments and returning a plausible-looking `null`.

**Offline verification** — check your reconstructed algorithm against real samples:

```bash
owb verify signer --args '{
  "source": "(input) => ({ sig: myHash(input.a + input.b) })",
  "samples": [{"input":{"a":"1","b":"2"},"expected":{"sig":"abc123"}}]
}'
```

⚠️ **`source` must evaluate to a function** — a bare `function f(){}` declaration
evaluates to `undefined`, so wrap it in parentheses. Passing `calls` without
`expected` runs a dry run (it hands back the computed values instead of inventing
a pass rate). If every sample fails you get an explicit `VERIFY_FAILED`, with
`results[].first_divergence` pointing at the byte offset where they diverge.

**TLS fingerprint replay** — confirm the request can be reproduced outside the
browser:

```bash
owb verify replay --url "https://x.example/api/sign" --method POST \
  --impersonate chrome --args '{"headers":{...},"body":"..."}'
```

Requires the `curl-impersonate` binary (in `<repo>/bin/`, on PATH, or pointed to
by `OWB_CURL_BINARY`; if missing you get a download link). `--impersonate` accepts
`chrome|edge|firefox|safari` or a versioned target.

**Archiving evidence**: `owb verify evidence --path <path under work/> --args
'{"content":...}'` writes conclusions into the archive directory alongside the
HAR and task records. Missing `content` is a `BAD_ARGS` error rather than a
silently empty file, and the result reports `bytes`.

## Putting it together

A typical "where does this parameter come from" run:

```bash
owb task begin "investigate sign parameter"
owb open about:blank --new-tab true --active false   # your own tab first
owb net start --tab <id>
owb open https://target.example --tab <id>
owb click @e5 --tab <id>                             # trigger the request
owb net list --tab <id> --url-pattern "api/" --limit 5     # ① find it
owb net initiator --tab <id> --request-id <id>             # ① who sent it → script + line
owb script search --query "sign=" --tab <id>               # ⑤ candidate implementations
owb hook fn --tab <id> --function-path "app.sign" --trace-args true --trace-ret true
owb click @e5 --tab <id>                             # ③ trigger again, watch real I/O
owb hook logs --tab <id> --source hook:fn
owb oracle --tab <id> --function-path "app.sign" --args '{"call_args":["<observed input>"]}'
owb verify signer --args '{"source":"<your reconstruction>","samples":[...]}'   # ⑤ offline check
owb har save --args '{"filename":"sign-investigation"}'
owb task end
owb tab close-group
```

Any rung may end the investigation early — if `net detail` already shows the
backend changed its response, there is no reason to go deeper.

## Pitfalls across this whole line

- **Hooks and breakpoints act on the user's real browser.** Pages get reloaded and
  frozen, and the user can see it. Say so before you start, and clean up
  afterwards with `hook remove` / `break-remove` / `script unpatch`.
- **`--url-pattern` is a regex, not a glob.** The dot in `app.js` must be escaped
  as `app\\.js` (plus another layer for the shell).
- **After editing extension code, use `owb reload-ext`** instead of clicking
  through `chrome://extensions`. But if you introduce a syntax error the extension
  will not start at all (`NO_EXTENSION`, and the heartbeat cannot wake it) — at
  that point your only recourse is the browser UI. Run
  `node --check owb-extension/background.js` before reloading; it costs nothing
  and catches almost all of these.
