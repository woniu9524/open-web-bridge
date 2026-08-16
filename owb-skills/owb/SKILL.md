---
name: owb
description: Open Web Bridge (OWB) — drive the user's own real browser with the `owb` command. Read pages behind their existing logins, gather and cross-check information, fill forms, walk multi-step flows, debug their site, audit responsive/accessibility behavior, and capture or reverse-engineer network traffic. Use this whenever the user mentions Open Web Bridge or OWB by name, or a task involves "go look at this page", "pull these pages together", "do this for me on that site", "my site's frontend is broken", "how is this request signed", or anything at all that needs a logged-in session or a real browser environment rather than a plain HTTP fetch.
---

# owb (Open Web Bridge) — driving the user's real browser

`owb`, the Open Web Bridge CLI, operates **the browser the user is using right
now**: their logged-in accounts, their settings, their open tabs. That is why you
can reach content that exists only behind a login, and complete actions that
require an identity.

For the same reason, **every step lands on a real person's account** and **they may
be using this browser beside you**. Read freely; ask before changing anything;
open pages in new tabs so you don't take over what they are looking at.

## How to use this document

**In a hurry?** Read "Before you start" → "The shape of a task" → "The core loop".
This file is the trunk; **five reference files live in `references/`, read on demand:**

| File | When to read it |
| --- | --- |
| `references/commands.md` | Arguments, defaults, limits and return fields — **check before writing a complex call instead of guessing argument names** |
| `references/recipes.md` | Longer recipes for a specific job: extraction, clicking quirks, drag/canvas, downloads, site debugging, responsive audits, logins, flows |
| `references/debugging.md` | Debugging and reverse-engineering: capture, HAR processing, hooks, breakpoints, script patching, offline signature verification |
| `references/field-notes.md` | Long-tail oddities seen in the field (the "Reality check" table below is the symptom index — come here once a symptom matches) |
| `references/relay.md` | The user asks about remote-controlling their browser, or `daemon-status` reports relay mode |

**For anything not documented here**: this file cannot cover all 80 commands.
`owb help` lists all 16 groups, `owb help <group>` expands one, and
`owb call <tool> --args '<json>'` calls any underlying tool directly.
**Don't guess command names — look them up.**

## Before you start

```bash
owb          # self-check
```

- `✓ daemon` + `✓ extension connected` → go
- `✗ extension not connected` → **stop and tell the user** to click the extension
  icon in their toolbar and check its status. Hammering the tools will only
  produce `NO_EXTENSION` forever.
- Command not found → `npm i -g open-web-bridge`, then `owb setup`
- `[owb] daemon not running, starting it…` on stderr during the first command is
  **not an error** — the CLI is starting the daemon. Wait for it to connect;
  don't report it as a fault.

The self-check reports one of two modes: **local** (default; daemon and browser on
one machine) and **relay** (browser on the user's machine, agent elsewhere, paired
through a public relay). Local mode needs no configuration. Everything about relay
mode — setup, capability differences, troubleshooting — is in `references/relay.md`.

## The shape of a task

**Read this section first.** Individual commands are documented below, but if you
don't know where a piece of work begins and ends, you will pile dozens of
unrelated tabs into one place and have to close them one by one — measured: 25
tabs in a single session.

For multi-step work (**anything beyond opening one page for a single look**), the
four steps are:

```bash
owb task begin "competitor pricing research"  # ① open a task: creates a task group
owb open <url> --new-tab true                 # ② work: new tabs join that group
owb page / click / fill / wait                #    …normal operations
owb task end                                  # ③ close out: stop recording, archive, report tabs
owb tab close-group                           # ④ clean up: close every tab from this task
```

Each step earns its place:

| Step | What happens without it |
| --- | --- |
| `task begin` | Tabs pour into the shared scratch group, mixed with other tasks and with the user's own tabs |
| `--new-tab true` | **You navigate away from whatever the user is currently reading** — this is a real person's browser, not yours |
| `task end` | Recording keeps running and nothing is archived; `flow save` also fails with `NEED_TASK` |
| `tab close-group` | Tabs accumulate without limit, and it gets progressively harder to tell whose is whose |

⚠️ **`task end` does not close tabs.** It archives, clears task context and
**reports** which tabIds were produced, but the pages stay open (sometimes you do
want to keep the results visible). To actually clean up you must also run
`tab close-group`. The word "end" does not mean what you would assume.

`tab close-group` closes the "OWB scratch" group plus every "task:" group;
**handoff groups are kept by default** (that is the user's live workspace). To
include them, pass `--args '{"include_handoff":true}'`. To close only the scratch
group and keep task groups, pass `--args '{"include_tasks":false}'`.

A one-off look needs no task — `owb open <url> --new-tab true` is enough, and the
tab lands in the "OWB scratch" group. The `taskHint` in the result tells you how
many tabs are sitting there; **a rising number is the signal to `task begin`**.

⚠️ **Losing task context has two consequences.** Chrome reclaims idle MV3 service
workers, and `owb reload-ext` or a daemon restart does the same; afterwards
`currentTask` is gone. (1) **The group survives but new tabs stop joining it** and
scatter into the scratch group — the symptom is tabs wandering off mid-task; just
run `task begin` again (same title reuses the group). (2) **`task end` reports
`NO_TASK` and the task is never archived** — though `tab close-group` still works,
since it matches by group name. If you need the archive, confirm
`owb daemon-status` still shows `current_task` before closing out.

🚨 **Running several OWB missions at once (multiple agents/processes driving the
same browser concurrently) is a different failure mode from the one above, and
it's not idle recycling — it's contention.** The daemon tracks "the current task"
as one shared value, not one per caller. Whichever `task begin` runs *last* holds
it; every earlier task's plain `task end` then either raises `NO_TASK` (if the
pointer's since gone null) or — worse — **returns `ok:true` while archiving
someone else's task, with no error to catch it**. New tabs opened in between two
`task begin` calls get grouped under whichever task happened to be "current" at
that exact moment, not the one that opened them — so tabs from different parallel
missions end up scattered across each other's groups. Measured: 5 concurrent tasks,
5/5 hit this. **What's fixed, and what still isn't:**
- `task begin` returns `task_id` — hold onto it, and pass it back as
  `task end --task-id <id>` instead of a bare `task end`. That reliably archives
  *your* task's metadata even if the pointer has moved on (the result carries
  `ended_stale: true` when it wasn't the live one) — but it does **not** retroactively
  fix which group your tabs already landed in.
- `task end`'s cleanup no longer reaches outside your task: it re-confirms ownership
  with the extension **by task id** before touching anything, and stops only the
  recorders on **your** task's tabs rather than every recorder in the browser. Tab
  ownership is tracked per task as you navigate, so it covers tabs you reused as
  well as ones you opened with `--new-tab`. If a recorder is running on a tab that
  genuinely isn't yours, `task end` leaves it alone and names it in
  `recorders_not_archived` — it is never silently dropped, but you do have to
  `har save` it yourself.
- **Still unfixed — skip `tab close-group` when other missions might be running.**
  It closes by group *name*, and group membership is exactly what's unreliable
  under concurrency — it can just as easily close another mission's live tabs as
  your own. Track the tabIds you actually opened yourself and `owb tab close --tab
  <id>` each one individually (or batch them with `owb seq`) instead.
- ⚠️ `task end`'s result has `group.cleared: true` — that means the **task context**
  was cleared, not that any tab was closed (`tabs_closed: false` says so explicitly).
  Closing tabs is always a separate step.

## Your tabs and the user's tabs

`owb` runs inside **the browser the user is using right now**, so there are always
two populations of tabs. Confusing them means closing the user's work at best, and
**reading the wrong page without noticing** at worst.

| Group | Color | Whose | Created when |
| --- | --- | --- | --- |
| `task: <title>` | cyan | yours | `--new-tab` after `task begin` |
| `OWB scratch` | blue | yours | `--new-tab` with no active task (staging area) |
| `✋ OWB waiting for you` | orange | **handed to the user** | after `owb handoff` (captcha, login) |
| ungrouped | — | **the user's own** | they opened it; never touch these |

**Guardrail**: `owb tab close` only permits the first three. Closing an ungrouped
tab raises `FORBIDDEN`. That is protection, not a fault — when you hit it, first
ask yourself "did I grab the wrong tabId?" rather than reaching for `--force true`.

⚠️ **Never assume a tab is still the one you left there.** The user may have
navigated it elsewhere, and other automation may reuse it. Measured: after a gap,
an old tabId used with `eval` to read a chess position returned a completely
unrelated search results page — **every command "succeeded" and every piece of
data was wrong**, which is far harder to catch than an error. Before reusing a
tabId across turns, confirm with `owb tab list` (or `owb tab find --url-pattern
"<regex>"`), or just open a fresh one.

## The core loop: look → point → act

`owb page` turns the page into a numbered list, one `@eN` per interactive element,
so you act by number instead of guessing CSS selectors.

```bash
owb open https://example.com --new-tab true   # ← don't skip this, see below
owb page                      # @e1 @e2 … each with role, text, href
owb fill @e3 "keyword"
owb keys --keys Enter         # submit with a real Enter key
owb wait --text "results"     # wait for readiness, never sleep
owb click @e5
```

⚠️ **`--new-tab true` is not optional.** Skipping it navigates the user's current
tab away from what they were reading. Only skip it when you specifically intend to
operate on the current page.

💡 **`--active false` opens the new tab in the background**, so you don't steal
their screen focus. Especially worth it when opening several pages to read.

🚨 **But a background tab is not the active tab, so every later command needs an
explicit `--tab`.** Without `--tab`, `page`/`eval`/`wait`/`click` act on the
**active** tab — which is not the one you just opened; it is **the page the user is
looking at**. Skipping `--tab` does not produce an error, it produces a **silent
read of the user's private page treated as your task data** (measured: `open`
returned tabId A, and the very next `page` read the user's internal admin system).

```bash
owb open <url> --new-tab true --active false   # → note the tabId in the result
owb page --tab <that tabId>                    # ← carry it on every command
```

The `open` result includes `backgroundTabHint` naming the tabId to use. With an
active task, forgetting `--tab` raises `AMBIGUOUS_TAB` — but **without an active
task there is no such protection**, which is one more reason to `task begin` for
multi-step work.

### Keyboard: `owb keys`

`fill` only sets a value; it **produces no key events**. Submitting a search,
dismissing a dialog, or using a shortcut all require `keys`:

```bash
owb keys --keys Enter                 # submit
owb keys --keys Escape                # close a dialog / exit fullscreen
owb keys --keys "ArrowDown ArrowDown Enter"   # space-separated, pressed in order
owb keys --keys "Ctrl+a"              # modifiers (Ctrl|Alt|Shift|Meta)
owb keys --text "typed text"          # insertText — produces no per-key events
```

⚠️ **`--text` and `--keys` are mutually exclusive**; passing both raises
`BAD_ARGS`. To type and then press Enter, call it twice. Named keys and the full
list are in `references/commands.md`.

### Reading a snapshot

One line carries more than you might expect:

```
@e17 link "Technology" href=https://example.com/lists/65.html
@e2  textbox "Search models, datasets, users..."
@e48 textbox "< 1B 6B 12B" type=range
@e86 textbox "Filter by name" type=search
      checkbox "Subscribe to newsletter" checked
      link "Next page" href=... disabled
```

- **Links always carry `href`** — even when the name is empty, the URL tells you
  where it goes. This is an underrated fallback.
- Inputs carry `type=` (range/search/date/email…), and `required`, `checked`,
  `disabled` are all marked; `<select>` lists its `values=[...]`.
- `iframes` lists the page's iframes and `shadowRoots` reports how much content
  comes from Web Components (snapshots descend into open shadow roots). To act
  inside an iframe: `owb frames` for the list, then
  `owb eval --frame-pattern <regex>`; `contextId:null` frames are cross-origin
  and cannot be evaluated.

### ⚠️ Refs expire

After a navigation or re-render, old numbers stop working and report `REF_STALE`.
**Run `owb page` again for fresh numbers** — don't retry with the old ones.

### ⚠️ Notice when a snapshot was truncated

Roughly a quarter of sites hit the cap on the first screen (default 20000 chars /
400 nodes); the result then carries `truncated: true` and `omittedNodes`.
**Either raise the cap or narrow the scope:**

```bash
owb page --max-nodes 1200 --max-chars 60000    # full detail (max-nodes caps at 2000)
owb page --mode article                         # article body only
```

Dense text-heavy sites hit the cap especially easily.

## Saving tokens: incremental snapshots

After acting, **do not re-read the whole page**. Use `--since-last` to get only
what changed:

```bash
owb fill @e86 "qwen3"
owb wait --network-idle true
owb page --since-last true
# → added=54 changed=6 removed=62 unchanged=340
```

Only 54 new entries enter your context instead of 400 elements. Whether a long
session survives comes down to this one habit.

## Three ways to read — pick the right one

| Mode | Use for | Main field |
| --- | --- | --- |
| `owb page` (default snapshot) | **Acting** on a page: finding buttons, filling forms, clicking links | `lines` |
| `owb page --mode article` | Reading the body of an **article page** as clean markdown | `content` |
| `owb page --mode text` | List pages, irregular structures, when you want all the text | `text` |

💡 **All three modes also expose `text`** as an alias for that mode's main field,
so scripts can read `text` without switching field names per mode.

⚠️ **List pages and forum front pages return 0 characters in article mode** —
they have no "article body"; that is correct, not a failure. The `reason` field on
an empty result explains why.

💡 **Body reads as 0 characters while `hiddenContentNote` says the DOM holds
thousands → switch to `--mode text`**, which falls back to `textContent`
automatically and marks the result `textSource: "textContent-fallback"`
(measured: article 3 chars → text 25161). ⚠️ That fallback is **DOM order, not
visual order**, and includes navigation chrome — fine for reading, not for
judging layout. Why it happens: `references/field-notes.md`, symptom C.

💡 **Body nearly empty and the DOM really is empty too** (title renders,
content doesn't — typical of client-side-rendered pages): the result carries a
`_hint` that says which case you are in — still loading (→ `wait
--network-idle`), a bot-check interstitial (→ `handoff`), an SPA shell whose
data never arrived (→ check `net list`), or content behind interaction /
inside an iframe. Follow the hint instead of re-reading in a loop.

## Waiting and timeouts

```bash
owb wait --selector ".result-item"      # wait for an element
owb wait --text "128 results"           # wait for text
owb wait --url-pattern "search"         # wait for navigation
owb wait --network-idle true            # wait for requests to settle (best for SPAs)
```

Exactly one of the four; **passing two raises `BAD_ARGS`**. Never sleep.

⚠️ **On SPAs, `open` returning `loadCompleted:true` does not mean the content has
rendered.** Measured: one news site returned complete in 2.3 seconds with only 6
elements in the snapshot. When a snapshot looks suspiciously small, run
`owb wait --network-idle true` and read again.

### ⚠️ Three layers of timeout — the most common source of wasted effort

| Layer | Argument | Default | Cap |
| --- | --- | --- | --- |
| CLI waiting for the ctl result | `--timeout <seconds>` | 120 | 300 |
| Tool-internal waiting | `--timeout-ms <ms>` | `open` 30000 / `wait` **10000** / `wait-user` 280000 | `wait` 110000 |
| A single CDP call | none | **30 seconds** | **hardcoded, no argument changes it** |

- ⚠️ **`--timeout` is not forwarded to the tool**; it only relaxes the CLI's wait
  for a result. To let `owb open` wait more than 30 seconds on a slow site, write
  `--timeout-ms 60000`. Writing `--timeout 60` **does nothing**.
- ⚠️ **`owb wait` waits only 10 seconds by default**, not indefinitely. For slow
  sites pass `--timeout-ms 60000` explicitly.
- ⚠️ When tool-internal waiting exceeds 110 seconds you must **also** raise
  `--timeout`, or you hit the 120-second envelope first (`ctl call timeout`).
  `wait-user` is the one exception — the CLI relaxes it automatically.
- ⚠️ The 30 seconds that `owb shot` and `owb eval` can hit is the CDP hard limit;
  **no argument helps**. That is a different problem — see the Reality check table.

## Common tasks

Longer recipes — structured extraction, live-data provenance, `click` vs
`click --mouse`, dragging and canvas, rich text editors (ProseMirror-style),
speeding up slow sites, downloads and uploads, debugging a site,
responsive/accessibility audits, saving logins, recording flows, high-frequency
step sequences (`owb seq`) — live in **`references/recipes.md`**. The few below
are either used constantly or easy to get wrong.

### Reading content that requires a login

The user's session is already in the browser, so just open it:

```bash
owb open <article URL> --new-tab true
owb page --mode article
```

For multiple pages: `owb page` to find the "next page" number → `owb click @eN` →
`owb wait` → read again.

### Reading comment threads and forum discussions

Comments and replies **are not article body** — `--mode article` doesn't recognize
them and returns 0 characters, while the default snapshot only draws structure
(who posted how long ago, upvote/reply links) and never shows what was said.
**Skip snapshot and article for threads; go straight to text:**

```bash
owb open https://news.ycombinator.com/item?id=<id> --new-tab true
owb page --mode text        # measured: the whole thread is here; snapshot/article are empty
```

The same applies to Reddit posts, forum replies, and Q&A answer lists.

### Cross-site synthesis and verification

The genuinely valuable pattern: pull a repository link from a paper page → open
GitHub to read stars and recent commits → conclude whether the code actually
exists and whether the project is alive. **That conclusion requires more than one
site**; no single-site scrape produces it. Pair it with `task begin` to keep the
whole chain in one group.

### Hitting a captcha, QR login, or a password prompt

Don't try to get around it, and don't fill in credentials. Hand it back:

```bash
owb handoff --reason "Please complete the QR login on this page, then tell me"
owb wait-user --condition text --text "Sign out"    # ← wait for a post-login marker
```

⚠️ **A bare `owb wait-user` waits for a URL change** (`condition: url_change` by
default) with a 280-second timeout. QR logins and SPA logins **often don't change
the URL** — a bare call will silently wait almost five minutes and then time out.
**For logins, always pass an explicit condition**: `--condition text --text "<text
that only appears after login>"` or `--condition selector --selector "<avatar or
username selector>"`.

Then **tell the user plainly what you need them to do**. When they are done,
confirm with `owb page` before continuing.

### Debugging the user's own site

⚠️ **`net start` must come before navigation**, or you get orphan records with no
URL. 🚨 **But don't write it as bare `owb net start` then `owb open <url>`** —
without `--tab`, capture binds to the **user's active tab** and the `open` then
navigates their page away. Get your own blank tab first:

```bash
owb open about:blank --new-tab true --active false   # ① your own tab, note the tabId
owb net start --tab <id>                             # ② bind capture to it
owb open http://localhost:3000 --tab <id>            # ③ then navigate
```

⚠️ **`har save` is the only command that stops AND keeps the recording.**
`har discard` also stops but **throws the data away** — it exists for
abandoning a recording, never as a step before `save` (that reports
`NOT_RECORDING` and the data is permanently lost).

**The full ladder — HAR to replay scripts, HAR diffing, assertions, hooks,
breakpoints, script search and patching, offline signature verification, TLS
replay — is in `references/debugging.md`.** Go there for "how is this parameter
computed" questions. The rest of the recipe is in `references/recipes.md`.

## Arguments and output

- `--foo-bar <value>` → tool argument `foo_bar`; JSON-parsed when possible
  (`--new-tab true` is a boolean)
- `--tab <id>` selects a tab; without it, the **active** tab is used
- `--out <file>` is the on-disk path for screenshots and PDFs
- `--args '<json>'` passes anything the flat aliases don't cover (highest priority)
- Escape hatches: `--raw` for the full result envelope, `--compact` for
  single-line JSON, `--no-autostart` to skip starting the daemon,
  `owb call <tool> --args '<json>'` for any tool, `owb cdp` for raw CDP
- `owb seq "<step>" "<step>" …` runs several steps over **one** process and
  connection — reach for it when a stretch of mechanical steps (game moves,
  multi-field forms) would otherwise pay ~100–200ms of spawn overhead each.
  Recipe in `references/recipes.md`, flags in `references/commands.md`
- ⚠️ **PowerShell**: a bare `@e3` is splatting syntax and **silently
  vanishes** before owb runs (symptom: a confusing `BAD_ARGS`) — always quote
  refs there: `owb fill '@e3' 'x'`. And Windows hosts that spawn processes
  without a shell can't execute the `owb.ps1`/`owb.cmd` shims — invoke
  `node "<npm root -g>\open-web-bridge\owb-daemon\src\cli.js"` instead.
  Both are detailed in `references/commands.md` under "PowerShell"

Success prints data JSON to stdout; failure prints one line
`error CODE: message` to stderr with a non-zero exit code (2 for usage errors).

⚠️ **Screenshots and PDFs always go to disk**; stdout returns only
`{savedTo, bytes}` rather than flooding your context with base64. For a full-page
capture add `--full-page true`.

**Full argument tables, return fields and the underscore-prefixed CLI metadata
fields are in `references/commands.md`.**

## Reality check: symptom → judgment

These are not malfunctions; they are what a real browser does. **The table indexes
by symptom, with details in `references/field-notes.md`** — go read the details
once a symptom matches, rather than pulling all of it into context up front.

| Symptom | Judgment in one line |
| --- | --- |
| Floating buttons unrelated to the page (translate / bookmark / quick settings) | Injected by **another extension** the user installed; `extensionUiHidden` only filters some. **Don't click them** |
| Animation frozen / video stuck at `readyState:0` / game unresponsive | **The whole Chrome window lacks OS focus** (not the tab being inactive). Run the focus diagnostic below |
| `owb shot` hangs the full 30 seconds | First add `owb eval "1+1"` to fork: also times out = the tab is genuinely dead (close and reopen); instant = the window lacks focus (reopening won't help) |
| Empty snapshot with `renderNote` | The tab isn't rendering; already auto-foregrounded and retried. `renderNote` says whether it is a content problem or window focus |
| 403 / empty snapshot / `httpErrorHint` | Anti-scraping refusal. **Change approach**; don't keep analyzing an empty snapshot |
| Everything reports `FORBIDDEN` and the page looks different | The tab was **replaced wholesale** by an extension like OneTab. Confirm with `tab list`, reopen in a new tab |
| `FORBIDDEN` mentioning `cannot be scripted`, a `chrome-extension://` URL, or an interstitial | Chrome **structurally forbids** debugging these (Web Store, `chrome://`, `devtools://`, other extensions' pages, security interstitials). **Not a fault, retrying won't help** — find another route, or have the user handle it in the browser |
| A PDF URL yields no body text in any mode | Chrome's PDF viewer lives in a separate sandboxed view — **architecturally out of reach**. Find an HTML version, or screenshot it |
| Garbage words like `derosnopS` in search results | Anti-scraping decoy text (invisible to humans). **Skip it as noise** |
| Navigating to `docs.google.com/**/create` | ⚠️ **Merely visiting creates a real file in the user's account**, and a brand-new empty file cannot be trashed. Don't navigate to these URLs |
| stderr shows `extension unreachable … retrying in N s` | The MV3 worker was recycled. **Normal** — the command retries itself (about 35 seconds total) to success |
| Still `NO_EXTENSION` after the backoff finishes | This is not idle recycling; **the script itself crashed** and the heartbeat cannot wake it. **Stop waiting** and tell the user |
| Navigation is just slow | Measured across 219 sites: p50 4.7s / p90 15s / p99 30s. Beyond 30s it is usually the site — widen with `--timeout-ms` or use `domcontentloaded` |

Window focus diagnostic (**check both signals; one alone will misdiagnose**):

```bash
owb eval 'document.visibilityState + " hasFocus=" + document.hasFocus()'
```

- Frozen rAF/animation/video → follow `visibilityState` (measured: `hasFocus()`
  true while `visibilityState` was still hidden, and rAF never fired)
- `shot` hanging the full 30s → follow `hasFocus()` (measured: the page was
  `visible` while `hasFocus()` was false and the compositor produced no frames)

If either looks wrong, ask the user to **bring the whole browser window to the
foreground**, rather than retrying or concluding the tool is broken. This is
Chrome's power-saving design; there is no CDP-level workaround
(`Emulation.setFocusEmulationEnabled` was tried and does not help — don't go down
that road).

## When something errors

| Error | Meaning | What to do |
| --- | --- | --- |
| `NO_EXTENSION` | Extension not connected | The CLI already retried with backoff for ~35s; **if it still fails, stop waiting** (the script crashed and the heartbeat can't wake it) and ask the user to check the extension |
| `REF_STALE` | Numbers expired | Run `owb page` again |
| `AMBIGUOUS_TAB` | Several tabs match, **or** you gave no `--tab` and the active tab is the user's own page | `owb tab list` for ids, then pass `--tab`. The latter usually means you used `--active false` without `--tab` — use the tabId `open` returned |
| `BAD_ARGS` | Wrong or duplicated arguments | The message lists the valid values; if unsure of an argument name, check `references/commands.md` |
| `PAUSED` | The page is stopped at a breakpoint | `owb debug resume` |
| `FRAME_NOT_FOUND` | iframe not found | `owb frames` for the list; `contextId:null` frames are cross-origin and can't be evaluated |
| `TIMEOUT` | Busy main thread (most common) / breakpoint / modal | Try `owb wait --network-idle true` and retry; to wait longer use **`--timeout-ms`** (not `--timeout`). **When even `shot` times out, first add `owb eval "1+1"` to fork the diagnosis** |
| `ctl call timeout` | You hit the CLI envelope | You raised tool-internal waiting past 110s — also pass `--timeout <seconds>` |
| `NEED_TASK` | No active task | `owb task begin "<title>"` and retry |
| `NOT_RECORDING` | The recorder was destroyed | You called `har discard` first; discard throws the recording away, and the data is gone — record again, then finish with `har save` alone |
| `FORBIDDEN` + interstitial | Chrome security page | No workaround; the user must deal with the certificate warning |
| `FORBIDDEN` + not in an OWB-managed group | You are closing **a user's own tab** | This is the guardrail, not a fault. Check the tabId with `owb tab list`; only consider `--force true` if it really should be closed |

## Command map

16 groups, 80 commands — **names only, so you know what exists**. Arguments are in
`references/commands.md`, or run `owb help <group>`.

| Group | Commands |
| --- | --- |
| **core** | open back forward reload page shot click (`--mouse` for real mouse events) fill keys scroll eval wait frames status cdp |
| **tab** | tab list / find / close / close-group |
| **net** | net start / stop / list / detail / initiator / capture |
| **har** | har start / save / discard / status / to-replay / diff / assert |
| **hook** | hook preset / fn / remove / status / logs |
| **debug** | debug break-xhr / break-fn / break-remove / stack / step / resume / console; **`oracle` is top-level** (`owb oracle`, not `owb debug oracle`) |
| **script** | script list / source / search / patch / unpatch / watch / watch-remove |
| **verify** | verify signer / replay / evidence |
| **cookie** | cookie get / set / delete |
| **state** | state save / load / list / delete (raw primitives: `owb call export_state` / `import_state`) |
| **env** | env set / reset / compare |
| **file** | download, upload, pdf are **top-level**; only `file fetch` takes the `file ` prefix |
| **task** | task begin / end / list |
| **flow** | flow save / run / list |
| **human** | handoff, wait-user |
| **daemon** | daemon-status, daemon-stop, reload-ext |

The net/har/hook/debug/script/verify groups are the debugging ladder — see `references/debugging.md`.

## Staying current

Versions iterate quickly, and a stale install is a real source of avoidable
failures (this document itself is an installed copy that only updates on
reinstall). **After the session's main task is finished** — once per session,
not after every command — run:

```bash
owb update check
```

**This is a background chore, silent by default.** Don't announce that you are
about to check, and don't narrate the result — the **only** outcome worth a
sentence to the user is an actual update. Three outcomes:

- `✓ up to date` → **say nothing at all** (no "already on the latest version",
  no mention that a check happened).
- `? could not reach the npm registry` → **say nothing**; never retry or
  troubleshoot this on your own.
- `⬆ update available` → the output lists the exact upgrade steps
  (`npm i -g open-web-bridge@latest`, then `owb skill install` to refresh this
  skill, then `owb daemon-stop` so the new daemon starts on the next command;
  a store-installed extension updates itself, a Load-unpacked one needs
  `owb reload-ext`). Tell the user a new version exists and **offer to run the
  upgrade** — run the steps only after they agree, then run `owb` to confirm
  both ✓s before reporting success.

## Boundaries

These actions land on a real person's account, and many cannot be undone.

**Ask the user first**: sending messages, posting, commenting, sending email,
submitting forms, placing orders or paying, deleting content, changing account
settings, authorizing third parties.

**Never do**: enter passwords, verification codes or payment details (hand off
instead), bypass human-verification challenges, open private pages unrelated to
the task (direct messages, mail, billing).

Reverse-engineering and traffic analysis are for **the user's own sites, or sites
the user has explicitly asked you to investigate**. Circumventing anti-abuse
controls or breaking into someone else's system is out of scope.

Reading and browsing: just do it. **For anything that changes state, say what you
intend to do and wait for a yes.**
