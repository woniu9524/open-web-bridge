# Task recipes

SKILL.md covers the core loop and the things you must not get wrong. This file
holds the longer recipes for specific jobs — read the one you need.

**Contents**: [Structured extraction](#structured-extraction-with-eval) ·
[click vs click-mouse](#click-reports-success-but-nothing-seems-to-happen) ·
[Drag and canvas](#dragging-and-canvas-drawing) · [Slow sites](#speeding-up-slow-sites) ·
[Downloading and uploading](#downloading-files--the-two-commands-differ) ·
[Debugging a site](#debugging-the-users-own-site) ·
[Responsive / a11y audits](#responsive-and-accessibility-audits) ·
[Saving a login](#saving-a-login-session) · [Flows](#turning-a-flow-into-one-repeatable-command)

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

## `click` reports success but nothing seems to happen

`click` uses `element.click()` (script-triggered, `isTrusted:false`);
`click-mouse` sends real CDP mouse events (`isTrusted:true`). Most sites treat
them the same, but **some custom components read `event.isTrusted` and only accept
real events**. The symptom is "the DOM attribute really did change, but the app's
own state did not react". Measured on NYT Connections tiles: after `click()` the
underlying checkbox really was `checked:true`, yet the tile didn't highlight and
Submit stayed locked; `click-mouse` on the same ref worked. Reddit's share and
external-link cards behave the same way.

How to tell: `click` reported `clicked:true` but the expected visual change is
missing (**confirm with a screenshot, don't trust the return value alone**) —
retry with `click-mouse`. Prefer `click` for ordinary forms and buttons; it is
faster.

⚠️ **`checked` and `aria-*` are not evidence of "successfully selected"** — they
can be changed normally by `click()` while the app's own state is something else
entirely. Look at the visuals or at a functional side effect (did the button
unlock?), not just the DOM attribute.

## Dragging and canvas drawing

`click` and `click-mouse` both press and release at one point and cannot simulate
a drag. **Try two `click-mouse` calls first** (click origin, click destination) —
measured, that is enough for chess.com's board. Only if the site truly does not
support click-to-select do you need the three-step `Input.dispatchMouseEvent`
sequence through `owb cdp` (mousePressed → mouseMoved → mouseReleased), which
works for drawing in Excalidraw and panning Google Maps.

⚠️ The middle `mouseMoved` **must carry `buttons:1`**, or the cursor moves and the
element doesn't. Canvas content is not DOM, so `owb page` cannot see it — confirm
with `owb shot`. **The full template and the map-specific pitfalls are in
`field-notes.md`.**

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

⚠️ **Never `har stop` and then `har save`.** `har save` **already includes stop**;
stopping first destroys the recorder, so `har save` reports `NOT_RECORDING` and
**the data is permanently lost**.
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

## Scrolled but nothing new appeared?

`owb scroll --args '{"to":"bottom"}'` returns `{y, maxY, atBottom}` — check those
first to confirm you really reached the bottom. If you did and `--since-last`
still shows `added=0`, there are three possibilities: **the page genuinely has no
more content** (a fixed grid, not a feed), **there is a "load more" button** (go
back to `owb page` and find it), or **it is virtualized** (the DOM node count stays
constant, and `changed` will be > 0). Use the return values to tell them apart
before concluding the tool failed.
