# Task recipes

SKILL.md covers the core loop and the things you must not get wrong. This file
holds the longer recipes for specific jobs — read the one you need.

**Contents**: [Structured extraction](#structured-extraction-with-eval) ·
[Live data provenance](#live-data-record-provenance-and-keep-multiple-match-keys) ·
[click vs click --mouse](#click-reports-success-but-nothing-seems-to-happen) ·
[Drag and canvas](#dragging-and-canvas-drawing) ·
[Rich text editors](#rich-text-editors-when-fill-isnt-enough) ·
[Slow sites](#speeding-up-slow-sites) ·
[Downloading and uploading](#downloading-files--the-two-commands-differ) ·
[Debugging a site](#debugging-the-users-own-site) ·
[Responsive / a11y audits](#responsive-and-accessibility-audits) ·
[Saving a login](#saving-a-login-session) · [Flows](#turning-a-flow-into-one-repeatable-command) ·
[High-frequency sequences](#high-frequency-sequences-owb-seq)

## Structured extraction with eval

When a page has regular structure, one `owb eval` beats repeated `page` calls:

```bash
owb eval 'JSON.stringify([...document.querySelectorAll(".item")].slice(0,20).map(e=>({
  title: e.querySelector("h3")?.textContent.trim(),
  url: e.querySelector("a")?.href
})))'
```

⚠️ The result is `{"value":"<JSON string>","type":"string"}` — **parse twice**.

⚠️ **Don't write selectors as a list of alternatives** (like
`"mat-list-item, [class*=event]"`) — an outer container and an inner element each
match, so the same record appears twice. Measured while scraping an earthquake
list. Use one **specific enough** selector, and sanity-check the count first.

⚠️ Complex `--args` and `eval` expressions fight with shell quoting (Windows
paths, nested strings). Don't escalate the escaping — write the expression to a
file and read it back; the pattern is in `commands.md`.

## Live data: record provenance and keep multiple match keys

Two habits that repeatedly decide whether live-data missions (dashboards,
trackers, markets — anything with an "updated" stamp) survive later scrutiny:

**Every extracted number carries three fields of provenance.** A value copied
without them cannot be re-verified, compared across sites, or trusted an hour
later:

- `source` — the URL (and page area) it came from
- `observedAt` — your own clock at the moment you read it
- `updated` — the page's **own** freshness stamp when it shows one ("updated 3
  min ago", a corner timestamp). A page can keep rendering stale data long
  after it stopped refreshing; without this field you cannot tell.

**Cross-site entities need every key you can get.** The same flight / vessel /
product appears under different primary keys on different platforms, and a
single key that fails to match on the second site strands the whole
comparison. Measured with flights: keep the flight number **and** the aircraft
registration **and** the airport IATA/ICAO codes — for any single one of them,
some pair of sites disagreed. Record all candidate keys at extraction time
(they cost nothing then) instead of re-scraping after a failed join.

## `click` reports success but nothing seems to happen

A plain `click` uses `element.click()` (script-triggered, `isTrusted:false`);
`click --mouse true` sends real CDP mouse events (`isTrusted:true`, with a
visible cursor animation). Most sites treat them the same, but **some custom
components read `event.isTrusted` and only accept real events**. The symptom is
"the DOM attribute really did change, but the app's own state did not react".
Measured on NYT Connections tiles: after `click()` the underlying checkbox
really was `checked:true`, yet the tile didn't highlight and Submit stayed
locked; `click --mouse true` on the same ref worked. Reddit's share and
external-link cards behave the same way.

How to tell: `click` reported `clicked:true` but the expected visual change is
missing (**confirm with a screenshot, don't trust the return value alone**) —
retry with `--mouse true`. Prefer the plain form for ordinary forms and
buttons; it is faster.

⚠️ **`checked` and `aria-*` are not evidence of "successfully selected"** — they
can be changed normally by `click()` while the app's own state is something else
entirely. Look at the visuals or at a functional side effect (did the button
unlock?), not just the DOM attribute.

## Dragging and canvas drawing

Both click forms press and release at one point and cannot simulate a drag.
**Try two `click --mouse true` calls first** (click origin, click destination) —
measured, that is enough for chess.com's board. Only if the site truly does not
support click-to-select do you need the three-step `Input.dispatchMouseEvent`
sequence through `owb cdp` (mousePressed → mouseMoved → mouseReleased), which
works for drawing in Excalidraw and panning Google Maps.

⚠️ The middle `mouseMoved` **must carry `buttons:1`**, or the cursor moves and the
element doesn't. Canvas content is not DOM, so `owb page` cannot see it — confirm
with `owb shot`. **The full template and the map-specific pitfalls are in
`field-notes.md`.**

## Rich text editors: when `fill` isn't enough

`fill` handles plain `contenteditable` regions (the snapshot gives them refs,
and fill sets the text plus an InputEvent). But framework editors that **own
their DOM** — ProseMirror, Slate, Lexical, Quill (docs apps, Notion-style
pages, the Password Game) — reconcile against internal state and revert or
desync on a raw text write. Symptom: `fill` reports ok but the editor shows
nothing, or the text vanishes on the next keystroke.

Go through the real input pipeline instead:

```bash
owb click @e4                        # 1. focus the editor
owb keys --text "the text to type"   # 2. insertText — editors treat it as typing
owb keys --keys "Ctrl+a"             # 3. selection / shortcuts are real key events
owb keys --keys "Ctrl+b"             #    e.g. bold the current selection
owb keys --keys Backspace            #    or delete it
```

- `keys --text` goes through `beforeinput`/`input`, which every major editor
  implements — the reliable path for **content**.
- Bold/italic, selection changes and deletions are **commands, not content** —
  send the editor's own shortcuts with `keys --keys`.
- Verify against the editor's rendered state, not the value you wrote:
  `owb eval 'document.querySelector(".ProseMirror").textContent'` (or the
  page's own API when it exposes one).
- Still stuck (canvas-based editors, IME-driven widgets)? `handoff` and let
  the user type that one field.

## Speeding up slow sites

`open` waits for the page to fully load (all images and scripts) by default. When
you only need to read the content, `--wait-until domcontentloaded` is markedly
faster with no measured loss:

| Site | Default | domcontentloaded |
| --- | --- | --- |
| OSChina | 7.7s | **2.4s** |
| CSDN | 9.6s | **5.0s** |
| Sina News | 18.7s | **12.1s** |

When you still need to interact afterwards (clicking, waiting for JS bindings),
keep the default or pair it with `owb wait`.

## Downloading files — the two commands differ

⚠️ `owb download` and `owb file fetch` sound like synonyms but behave differently,
and **only the second copies the file into the sandboxed `work/downloads/`**:

- `owb download` — the browser performs its own download (clicking a download
  button or link), so the file necessarily lands in the real system download
  directory **on the machine running the browser** (Chrome's download API can only
  write there). The result has **no** `dir`/`originalPath` fields.
- `owb file fetch` — the daemon fetches a URL itself, then copies it into
  `work/downloads/`, returning `path` (the sandboxed copy), `originalPath` and
  `dir`. **Use this when you need a path you can reliably reference.**

⚠️ In relay mode these land on **different machines**, which makes the distinction
much more consequential — see `relay.md`.

⚠️ `owb upload` **does not take a file path**; it wants `files: [{name, base64}]`
(it builds a File inside the page, so it works in relay mode too). The snippet to
build that payload is in `commands.md`.

## Debugging the user's own site

⚠️ **Order matters**: `net start` must come **before** navigation, or you get
orphan records with no URL (`orphanRecordsHidden` reports how many were lost).

🚨 **But don't write it as bare `owb net start` followed by `owb open <url>`** —
without `--tab`, capture binds to the **user's active tab**, and the `open` then
navigates their page away. Get your own blank tab first:

```bash
owb open about:blank --new-tab true --active false   # ① your own tab, note the tabId
owb net start --tab <id>                             # ② bind capture to it
owb open http://localhost:3000 --tab <id>            # ③ then navigate
owb net list --tab <id> --sort-by duration --limit 10  # slowest ten (--sort-by size for heaviest)
owb net detail --tab <id> --request-id <id>          # full headers + body for one request
owb debug console --tab <id> --enabled true          # page errors
owb har start --tab <id> && owb open <page> --tab <id> && owb har save --args '{"filename":"investigation"}'
```

⚠️ **`har save` is the only command that stops AND keeps the recording.**
`har discard` also stops, but **throws the data away** (that is its job — use it
only to abandon a recording). Calling `har discard` first and `har save` after
reports `NOT_RECORDING` and **the data is permanently lost**.
⚠️ With an active task, `har save` always writes `tasks/<task id>/recording.har`
and **ignores `filename`** — don't assume the argument failed.

Capture is only the entry point. **Turning a HAR into a replay script, diffing two
HARs, assertion checks, hooking crypto functions, freezing at a breakpoint,
searching and patching script sources, offline signature verification and TLS
replay — that whole line is in `debugging.md`.**

## Responsive and accessibility audits

```bash
owb env set --width 390 --height 844 --mobile true --touch true
owb shot --out mobile.png
owb eval '<check horizontal overflow, tiny fonts, small tap targets>'
owb env compare                             # to check what emulation changed
owb env reset                               # ⚠️ required
```

⚠️ Set `--width 390` but `innerWidth` still reports 1200? **The tool is not
broken** — that site has no responsive viewport meta, so the browser gave it a
default layout viewport. That is itself the audit finding.

⚠️ `env set` stays in effect until `env reset`. Leaving it on leaves the user's
browser stuck in emulation. A second `env reset` returning `reset: []` confirms
nothing is left over.

Viewport arguments are flat; `network`, `geolocation` and `permissions` are
objects and go through `--args`:

```bash
owb env set --args '{"network":{"latency":300,"download":400000,"upload":400000}}'
```

Screenshots taken under emulation match the emulated viewport exactly, so they are
usable as audit evidence.

## Saving a login session

```bash
owb state save mysite      # cookies + localStorage + IndexedDB
owb state list             # what is stored
owb state load mysite      # restore after switching machines or profiles
owb state delete mysite    # drop it when stale
```

⚠️ These files contain **plaintext credentials** under `work/states/`
(gitignored). Be careful before packaging or sharing the repo.

## Turning a flow into one repeatable command

`flow save` captures the calls made **within a time window**, so it has to run
inside a task context (without an active task it reports `NEED_TASK`):

```bash
owb task begin "weekly report"
owb open <page> --new-tab true && owb click @eN && ...
owb flow save weekly-report
owb task end && owb tab close-group
owb flow list                  # what exists
owb flow run weekly-report     # replay it later with one command
```

⚠️ Two things about replay:

- **Don't do unrelated work while recording.** Every call in the window is
  recorded, including that other tab you opened along the way.
- **Replay needs a quiet browser.** Recorded tabIds are meaningless across
  sessions and get stripped, so each step resolves to "the current active tab"; if
  the user is switching tabs or another flow is running, you get `AMBIGUOUS_TAB`.
  Pass `--keep-tab-ids true` to preserve the original ids, or
  `--continue-on-error true` to keep going after a failed step.

## High-frequency sequences: `owb seq`

Every `owb` invocation pays a process spawn plus a WS handshake (~100–200ms on
Windows) before the tool even runs. Over a long stretch of **mechanical
steps** — game moves, dismiss-dialog-then-read, filling many fields — that
overhead dominates the wall clock. `owb seq` runs the whole stretch over
**one** process and one connection:

```bash
owb seq "click @e2" "keys --keys ArrowDown" "keys --keys ArrowDown" "page --since-last true"
owb seq --file steps.txt --delay-ms 120     # one step per line, # for comments
owb seq "fill @e3 hello" "keys --keys Enter" --tab 123   # top-level --tab = every step's default
```

- Each step is a complete owb command **minus the `owb` prefix**. Quote each
  step, and use the other quote style inside it (`"fill '@e3' 'two words'"`).
- Output is **one JSON line per step** plus a `{"seq":{steps,ok,failed}}`
  summary. A failed step stops the run (`--keep-going` to push past it); the
  exit code is 1 if anything failed.
- `--delay-ms <n>` pauses between steps — games and animated UIs often need
  100–200ms to settle before accepting the next input.
- In `--file`, a line starting with `{` is a JSON step
  `{"tool":"fill","args":{"ref":"e3","value":"…"}}` — zero shell quoting, the
  right form for values full of quotes (write the file, then run it).
- **Batch only the mechanical stretches.** Anything you must *think between*
  (read state → decide next move) still needs separate invocations — `seq`
  removes the per-step overhead, not the decision loop. For pure in-page
  mechanics a single `owb eval` loop is faster still, but its events are
  `isTrusted:false`; `seq` steps go through the real input pipeline.

`flow save/run` is the neighbouring tool: it **records** calls you already
made and replays them deterministically later. `seq` is for a sequence you are
composing right now, without recording anything.

## Scrolled but nothing new appeared?

`owb scroll --args '{"to":"bottom"}'` returns `{y, maxY, atBottom}` — check those
first to confirm you really reached the bottom. If you did and `--since-last`
still shows `added=0`, there are three possibilities: **the page genuinely has no
more content** (a fixed grid, not a feed), **there is a "load more" button** (go
back to `owb page` and find it), or **it is virtualized** (the DOM node count stays
constant, and `changed` will be > 0). Use the return values to tell them apart
before concluding the tool failed.
