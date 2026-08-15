# Privacy Policy — Open Web Bridge

Last updated: 2026-08-15 · Applies to the Open Web Bridge browser extension and
the `open-web-bridge` npm package.

## The short version

**Open Web Bridge collects nothing and sends nothing to its developer.** There is
no analytics, no telemetry, no crash reporting, and no remote server operated by
us. The extension talks to a daemon **you** run, on **your** machine, at
`ws://127.0.0.1:43917/ws`.

The extension is a bridge, not a service. It has no backend.

## What the extension can access

To do its job the extension can read and control pages through the Chrome
DevTools Protocol. In practice that means it can see and act on, **at the moment
you or your agent asks it to**:

- page content (DOM, text, screenshots)
- network requests and responses, including headers and bodies
- cookies, `localStorage`, `sessionStorage` and IndexedDB for pages you operate on
- the list of your open tabs and their URLs

This is a broad capability, and you should treat installing it as **granting the
local daemon control of your browser**. That is the trade this tool makes: an
agent driving your real browser can reach what you are logged into, which is the
entire point, and it is also why the capability is this wide.

## Where that data goes

**By default: only to `127.0.0.1`.** The extension's configured WebSocket target
is `ws://127.0.0.1:43917/ws` and the relay address is empty. Nothing leaves your
machine.

**If you enable relay mode** (off by default; you must enter a URL and token
yourself), traffic is forwarded through a relay **you deploy on your own
Cloudflare account**. Two things to understand before enabling it:

- There is **no end-to-end encryption**. The relay is a trusted broker and can see
  all plaintext traffic passing through it, **including cookies and storage**.
  This is why the documentation insists you deploy your own relay rather than
  using one operated by anyone else.
- The pairing token is the only secret protecting that channel. Anyone holding it
  can drive your browser.

## What is stored, and where

**In extension storage (`chrome.storage.local`)** — configuration and internal
bookkeeping only:

- `wsUrl`, `relayUrl`, `relayToken` — your connection settings
- a hook registry (which debug hooks are active on which tab), so state survives
  the service worker being recycled

No page content and no browsing history are stored by the extension.

**On disk, by the daemon** — under the `work/` directory on whichever machine runs
the daemon:

- task archives, HAR recordings, screenshots and downloads you asked for
- **saved login sessions** (`state save`) — cookies, `localStorage` and IndexedDB,
  written **in plaintext** under `work/states/`

⚠️ `work/` is gitignored, but it is not encrypted. Anything you save with
`state save` is a plaintext credential file. Treat it accordingly, and check
before sharing or packaging the repository.

## Third parties

None. The extension contacts no third-party service. The only network destination
it ever uses is the daemon endpoint you configure — `127.0.0.1` by default, or
your own relay if you opt in.

Publishing to npm and the Chrome Web Store means those platforms have their own
data practices for downloads and installs; those are governed by their policies,
not this one.

## Permissions, and why each is needed

The Chrome Web Store requires a justification per permission. These are the real
reasons, and each is used in the code:

| Permission | Why it is required |
| --- | --- |
| `debugger` | **The core mechanism.** Everything — reading pages, capturing network traffic, dispatching real input events, setting breakpoints — goes through the Chrome DevTools Protocol, which this permission provides. The extension cannot function without it. |
| `tabs` | Open, navigate, enumerate and close tabs; resolve which tab a command targets; read tab URLs so a command can be routed to the right page. |
| `tabGroups` | **A safety feature.** Tabs the extension creates are placed in labelled groups ("task: …", "OWB scratch", "waiting for you"). This is what lets the extension refuse to close a tab you opened yourself, and lets you clean up its tabs in one action. |
| `storage` | Persist your connection settings (relay URL and token) and the active-hook registry across service-worker restarts. No page content is stored. |
| `alarms` | A heartbeat that reconnects the MV3 service worker after Chrome recycles it. Without it the connection silently dies when the worker goes idle. |
| `downloads` | Implements the `download` command, which triggers and tracks a browser download you asked for. |
| `<all_urls>` | You decide which sites the agent works on, and that set cannot be known in advance — it is whatever page you ask about. A narrower host list would mean the tool simply fails on any site not enumerated at build time. |

## Data we do not collect

To be explicit: no personal information, no browsing history, no page content, no
credentials, no usage statistics, and no device identifiers are transmitted to the
developer or to any third party. There is no server to transmit them to.

## Your controls

- Remove the extension to revoke all of it at once.
- Relay mode: switch the popup back to the Local tab and save (this clears the
  relay fields), and unset `OWB_RELAY_URL` / `OWB_RELAY_TOKEN` on the daemon side.
- Saved sessions: `owb state list` shows what exists, `owb state delete <name>`
  removes one, or delete `work/states/` outright.
- Everything the daemon writes lives under `work/` and can be deleted at any time.

## Source

The extension is open source (MIT). If any statement here is contradicted by the
code, the code is the truth and the discrepancy is a bug — please open an issue.

https://github.com/woniu9524/open-web-bridge

## Contact

Report privacy concerns as a GitHub issue:
https://github.com/woniu9524/open-web-bridge/issues
