# Field notes: what a real browser actually does

These are **not malfunctions**. They are conditions hit repeatedly across 217
sites and seven sweeps (1521 site-visits). SKILL.md's "Reality check" table is
the symptom index — **come here once a symptom matches**.

Every entry gives the root cause and whether a workaround exists. **Where it says
"no workaround", that direction has been tested — don't retry it.**

**Contents**: [Window not OS-focused](#1-the-chrome-window-is-not-the-os-foreground-window) ·
[Drag and canvas](#2-drag-and-canvas-the-three-step-template) ·
[Other extensions](#3-other-extensions-are-in-your-page) ·
[Pages you cannot read](#4-pages-you-cannot-read) ·
[Google Docs /create](#5--google-docs-create-urls-navigation-is-a-side-effect) ·
[Extension dropouts](#6-extension-dropouts-self-healing-but-only-one-kind) ·
[Timeouts](#7-timeouts-suspect-the-main-thread-first)

## 1. The Chrome window is not the OS foreground window

**The most common cause of "the tool is broken" misdiagnoses.** All three
symptoms below share this root cause.

⚠️ This is **not** about a tab being inactive — it is about the **whole Chrome
window** lacking operating-system focus (covered by another window, user switched
apps). `Page.bringToFront` only switches tabs within a window; it cannot help.

The cause is Chrome throttling hidden windows: `requestAnimationFrame` stops
firing, media buffering pauses, the compositor stops producing frames.
**There is no CDP-level workaround.** `Emulation.setFocusEmulationEnabled` has
been tried — it can fake `document.visibilityState` into `"visible"`, but it does
not change the real rendering throttle (measured: the 2048 board still never
renders). **Don't go down that road again.**

### Diagnosis: check both signals

```bash
owb eval 'document.visibilityState + " hasFocus=" + document.hasFocus()'
```

⚠️ **Checking only one will misdiagnose you.** The two signals decouple in
opposite directions and each governs different symptoms:

| Symptom | Follow this signal | Counter-example seen in the field |
| --- | --- | --- |
| Animation / video / game frozen | `visibilityState` | `hasFocus()` was `true` (the window did have focus) while `visibilityState` was still `hidden`, and rAF never fired |
| `shot` hangs for the full 30s | `hasFocus()` | On Flightradar24, `visibilityState` was `visible` (the page was plainly on screen) while `hasFocus()` was `false`, and the compositor still produced no frames |

**Whenever something that should move doesn't** — stalled animation, video not
playing, a click with no visual change, even `shot` timing out — run that command
first. If either signal looks wrong, **ask the user to bring the whole browser
window to the foreground** instead of retrying.

### Symptom A: animation / video / game frozen

Observed: YouTube `<video>` stuck at `readyState:0`; on play2048.co the board
never produces a single tile and arrow keys do nothing. **The latter is the proof
of causation** — when the same window regained foreground on its own (window focus
changes naturally in real use), reopening the same page produced tiles and
responded to keys immediately.

### Symptom B: `shot` hangs 30s → first add `owb eval "1+1"` to fork the diagnosis

Screenshots go through compositor frame capture and need no JS, so whether `eval`
answers is the deciding split:

- **`eval` also times out** → the renderer really is wedged, not merely "busy".
  Observed on Google Sheets: `open` to a different URL had no effect, `eval` and
  `shot` both timed out, and it stayed that way for minutes; `debug resume` did
  not help either (it reports `NOT_PAUSED`).
  **Fix: `tab close` and reopen in a new tab** — the new tab responds normally.
- **`eval` returns instantly and only `shot` hangs** → the tab is fine; the window
  has no focus. `Page.captureScreenshot` is waiting for a composited frame, and
  without one it burns the full 30-second hard timeout. **This has nothing to do
  with WebGL** — an ordinary IMDB page hangs the same way.
  ⚠️ **Here `tab close` is wasted effort** — a new tab has no OS focus either.

### Symptom C: empty snapshot with `renderNote`, or body text reading as 0 chars

When a tab isn't rendering, its elements have no layout boxes and the snapshot
comes back empty. The tool **automatically foregrounds and retries**, and
`renderNote` explains whether the cause was content or window focus.

There is a second flavor for article text: scroll-reveal animations never trigger
in an unfocused window, so `innerText` reads empty (measured on the claude.com
blog: `article` mode returned 3 characters while the DOM held ~28,000).
**`--mode text` automatically falls back to `textContent`** to recover the body
and reports `textSource: "textContent-fallback"`. That fallback text is in DOM
order rather than visual order and includes navigation chrome — fine for reading
the content, not for judging layout.

## 2. Drag and canvas: the three-step template

`click` (plain and `--mouse true` alike) presses and releases at one point, so
neither form can simulate a drag.

⚠️ **Try two `click --mouse true` calls first** (click the origin, then the destination)
— much simpler than the three-step sequence. Measured: chess.com's board works
this way, and the move is recorded correctly. Only escalate once you have
confirmed the site does **not** support click-to-select (no highlight after
selecting, nothing happens on click).

When you genuinely need a drag, send three events through the `owb cdp` escape
hatch. Measured: drawing a rectangle in Excalidraw works first try.

```bash
owb cdp --args '{"method":"Input.dispatchMouseEvent","params":
  {"type":"mousePressed","x":300,"y":250,"button":"left","buttons":1,"clickCount":1}}'
owb cdp --args '{"method":"Input.dispatchMouseEvent","params":
  {"type":"mouseMoved","x":500,"y":400,"button":"left","buttons":1}}'
owb cdp --args '{"method":"Input.dispatchMouseEvent","params":
  {"type":"mouseReleased","x":500,"y":400,"button":"left","buttons":0,"clickCount":1}}'
```

- ⚠️ The middle `mouseMoved` **must carry `buttons:1`** (left button still held).
  Without it the page sees a move with no button pressed, and many drag
  implementations use exactly that field to decide whether a drag is in progress —
  the visible result is "the cursor moved but the element didn't".
- Canvas content is not DOM, so `owb page` sees nothing at all. Confirm with
  `owb shot`.
- **Maps** (Google Maps and other WebGL tile maps) can be panned the same way.
  Give several intermediate `mouseMoved` points so the path is continuous and the
  implementation recognizes it as a real drag. ⚠️ But if the release point lands on
  a labeled point of interest, the map also treats it as a click and opens an info
  card — **end on empty space** (water, blank area) when you only want to pan.

## 3. Other extensions are in your page

- **Injected floating buttons**: snapshots strip elements mounted by known
  frameworks (Plasmo/CRXJS) and record them in `extensionUiHidden`, but **the
  filter is not exhaustive** — injection styles vary, and many only appear on
  hover or text selection. Recognize them yourself: buttons like `Translate
  image`, `Quick settings`, `Add to favorites` that have **nothing to do with the
  page's subject** are almost always another extension's overlay. **Don't click
  them.** The test is simple: does it relate to what you are doing?
- **A tab taken over entirely**: tools like OneTab replace the tab with their own
  page, after which every operation reports `FORBIDDEN` (repeatedly observed on
  Taobao and Eastmoney). **Don't retry** — run `owb tab list` to confirm, then
  reopen the target in a new tab.

## 4. Pages you cannot read

| Case | What you see | What to do |
| --- | --- | --- |
| **Anti-scraping refusal** | 403 or a shell page; `open` returns `httpErrorHint` (ThePaper, CNKI, some e-commerce) | **Change approach** — don't keep analyzing an empty snapshot |
| **Chrome security interstitial** | Certificate/privacy error pages forbid debugger attachment; `open` returns `attachHint`, `page` raises `FORBIDDEN` | **No workaround** — have the user handle it in the browser |
| **Structurally undebuggable URLs** | The whole `chrome.google.com/webstore/*` domain (**including the developer console** at `/devconsole`, not just the storefront), `chromewebstore.google.com`, `chrome://`, `devtools://`, other extensions' pages. `open` succeeds and everything after is `FORBIDDEN: The extensions gallery cannot be scripted` | **No workaround** — a new tab, a retry and `--force` all fail. Do the work by hand, or find another source |
| **PDF URLs** | All three read modes return nothing | See below |

**PDFs**: Chrome's built-in viewer renders in a **separate sandboxed view** that
neither the DOM nor the accessibility tree can see (`Accessibility.getFullAXTree`
was tried too). **This is not a selector problem — it is architecturally out of
reach.** Workaround: look for an HTML version (arXiv abstract pages usually offer
an "HTML (experimental)" link, and `--mode article` reads that fine). For PDFs
with no HTML version, `owb shot` a screenshot or hand it to the user.

**Decoy text**: eBay search pages have produced `derosnopS` in `text` mode —
"Sponsored" reversed, a honeypot aimed at scrapers (`color: transparent` plus
`aria-hidden="true"`, invisible to human eyes). Treat obviously non-word strings
like this as noise and move on.

## 5. ⚠️ Google Docs `/create` URLs: navigation *is* the side effect

**Merely navigating there creates a real file in the user's account.**
`docs.google.com/document/create`, `.../spreadsheets/create`, `.../forms/create`
are not "open a creation page and wait for confirmation" — visiting the URL
itself persists a blank document.

Hit twice in the field (Sheets, Forms), and in both cases the new blank file's
**"Move to trash" option was disabled**: Google behaves this way for brand-new
documents that were never edited, so clicking manually doesn't help either — the
document needs at least one content change before it can be trashed.

**If the task isn't genuinely to create a document, don't navigate to these URLs.**
If one was created by accident, don't keep poking the disabled delete button —
tell the user plainly that there is an extra empty file in their account.

## 6. Extension dropouts: self-healing, but only one kind

Chrome recycles the MV3 service worker, and the extension reconnects on its own.
You will see this on stderr:

```
[owb] extension unreachable (NO_EXTENSION), retrying in 1.5s…
```

Backoff is 1.5s → 4s → 10s → 20s, about 35 seconds total. **This is normal; the
command retries itself until it succeeds.** (Relay mode raises the reconnect
backoff cap to 60 seconds — see `relay.md`. If you know the browser is closed and
don't want to wait, set `OWB_NO_EXT_RETRY=1` to skip the backoff.)

⚠️ **Self-healing only covers "alive but idle and recycled" — it does nothing for
"the script itself crashed".** The `chrome.alarms` heartbeat cannot wake a worker
that fails at top-level parse (for example, you just broke `background.js` and
then `reload-ext` loaded that broken copy). Each heartbeat re-executes the same
broken file from disk and fails identically, so **waiting longer changes nothing**.
**One full backoff cycle still ending in `NO_EXTENSION` is the signal to stop and
tell the user.**

## 7. Timeouts: suspect the main thread first

The most common cause of `TIMEOUT` is **the page's main thread being saturated by
heavy JS** (especially while still loading), not a breakpoint. Run
`owb wait --network-idle true` and retry.
(Exception: a `shot` timeout is a different path — see section 1, symptom B.)

Navigation genuinely is slow sometimes. Across 219 sites: **p50 4.7s, p90 15s,
p99 30s**. Beyond 30 seconds it is usually the site, not the tool — widen with
`--timeout-ms` (⚠️ not `--timeout`, see SKILL.md's timeout table) or switch to
`--wait-until domcontentloaded`.
