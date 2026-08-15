# open-web-bridge

**English** · [简体中文](README.zh-CN.md)

Let any AI agent drive **your real browser** — your logged-in sessions, your
fingerprint, the page you are looking at right now.

That is the whole point: an agent that opens its own clean browser can only reach
what is public. An agent driving *your* browser can read the article behind your
subscription, check the dashboard you are already signed into, and finish the flow
that needs your identity.

Two deployment shapes:

- **Local mode** (default) — three layers: AI agent → local daemon (Node.js on
  `127.0.0.1:43917`) → MV3 Chrome extension → the page, over CDP. Agents connect
  through the **`owb` CLI**, so anything that can run a shell (Claude Code, Kimi
  Code, Codex, …) works with zero configuration. A bundled skill teaches the
  typical workflows.
- **Relay mode** (optional) — the daemon and the extension both dial out to a
  public relay (Cloudflare Workers + Durable Objects, paired by token), so a
  **remote** agent can drive your browser without exposing any port on your
  machine. Off by default; enabling it does not change local mode.

## What it can do

- **Semantic snapshots** — `read_page` assigns stable `@eN` refs to interactive
  elements so `click`/`fill`/`screenshot` can reference them directly;
  `since_last` returns only what changed (the difference between a session that
  survives and one that drowns in tokens); `article` mode extracts body text as
  clean markdown
- **Waiting primitives** — `wait_for` on a selector, text, URL or network idle,
  instead of polling with `evaluate`
- **Real mouse events plus a visible cursor** — `mouse_click` dispatches genuine
  CDP Input events (`isTrusted`), with an in-page bezier cursor animation so a
  user sitting beside you can see what is happening
- **Human handoff** — `handoff` / `wait_user` give the tab back to you for a
  captcha or a QR login, and the agent resumes automatically once you are done
- **The awkward interactions** — `download`/`upload` (uploads go through an
  in-page DataTransfer, so no filesystem access is needed), `print_pdf`,
  `list_frames` + `evaluate frame_pattern` for iframe-targeted evaluation
- **Environment emulation** — `emulate`/`emulate_reset` covers viewport, network
  throttling, geolocation, timezone, locale, permissions and UA in one call
- **Network capture** — full requests and responses including headers and bodies,
  plus `get_initiator` for the call stack that produced a request
- **Session recording (HAR)** — `record_start/stop` writes standard HAR 1.2
  (timing, WebSocket, actively collected bodies, url/resource_type filters,
  multi-tab merge), with console archives, storage change streams and a
  navigation screenshot timeline; `daemon_task_end` files the HAR automatically
- **HAR processing** — `daemon_har_to_replay` (→ python/curl/node replay scripts,
  with dynamic signature headers marked as placeholders),
  `daemon_har_diff` (drift between two recordings), `daemon_har_assert`
- **Tasks and workflows** — `daemon_task_begin/end` for archiving and tab
  grouping; `daemon_workflow_save/run` turns a working flow into deterministic
  replay
- **Per-site session store** — `daemon_state_save/load <name>` saves and restores
  a login (cookies + localStorage + IndexedDB)
- **Debugging and analysis** (on demand) — hook presets (xhr/fetch/crypto),
  breakpoints and call-frame inspection, script patching, offline function
  verification, TLS fingerprint replay

## Install

Requirements: **Node.js ≥ 18** and a Chromium-based browser (Chrome or Edge).

### Let an AI install it for you

Paste this to your agent (Claude Code / Kimi Code / Codex / …) and it will walk
you through:

> Install open-web-bridge for me. Do these in order and tell me the result of each:
>
> 1. Run `npm i -g open-web-bridge`
> 2. Run `owb setup`, read me the "install the browser extension" step, and wait
>    until I confirm I've done it
> 3. Run `owb` and confirm both the daemon and the extension show ✓. If the
>    extension is not connected, tell me to click the extension icon in my
>    browser toolbar and check its status
> 4. Run `owb skill install`, then tell me to start a new session
>
> After that you can drive my browser with the `owb` command; `owb help` lists
> everything.

### Manual install

```bash
npm i -g open-web-bridge     # CLI + extension files + skill, in one command
owb setup                     # walkthrough: extension path, skill install, self-check
```

`owb setup` tells you how to install the extension. **That is the one step you
have to do yourself** — the extension has to go into the browser you actually use,
because that is where your sessions are, which is the entire point of this
project. No command line can do it for you.

Then run `owb` once as a self-check; two ✓ means you are ready. Finally
`owb skill install` installs the skill for **every agent it detects** — Claude
Code (`~/.claude/skills/`), Codex CLI (`~/.codex/skills/`), Cursor
(`~/.cursor/skills/`), OpenCode (`~/.opencode/skills/`). Use
`--to claude,codex` to pick agents yourself, `--project` to install into the
current project only, or `--dir <path>` for anywhere else.

Later, `owb update check` compares your install against npm and prints the
upgrade steps when a newer version exists — the skill also teaches agents to
run it at the end of a session, so you hear about updates without asking.

The skill uses progressive disclosure, and `skill install` copies the whole
directory:

```
owb/SKILL.md                     the trunk — enters context on every trigger
owb/references/commands.md       arguments for all 80 commands
owb/references/recipes.md        longer per-task procedures
owb/references/debugging.md      capture / HAR / hooks / breakpoints / reverse engineering
owb/references/field-notes.md    real-world oddities, indexed by symptom
owb/references/relay.md          relay mode setup
```

Only `SKILL.md` is always loaded; the agent reads the rest when it needs them.
Other agents can simply concatenate these markdown files into their rules or
system prompt — there is no proprietary format.

### Try it

Tell your agent something like "open Hacker News and summarize the top three
stories for me". Or drive it yourself:

```bash
owb open https://example.com
owb page                 # semantic snapshot: interactive elements numbered @eN
owb click @e1            # act by number
owb help                 # all commands
```

> Running from source (development): `git clone`, then `npm install` in the repo
> root, and use `node owb-daemon/src/cli.js <command>` instead of `owb` — or
> `npm link` and use `owb` as normal.

## Repository layout

```
open-web-bridge/          ← npm package root (package.json lives here)
├── owb-daemon/src/       owb CLI (the agent-facing surface) + local daemon
├── owb-daemon/tests/     tests (not shipped in the npm package)
├── owb-extension/        MV3 Chrome extension
├── owb-relay/            optional: Cloudflare Workers relay (deployed separately, not in the npm package)
└── owb-skills/owb/       the skill an AI agent installs (SKILL.md + references/)
```

`npm i -g open-web-bridge` installs the CLI, the extension files and the skill
together — the extension path printed by `owb setup` points at the copy inside the
package. Runtime artifacts (task archives, saved sessions, HAR files) go to
`work/`, which is gitignored.

## Relay mode (remote control, optional)

Lets a **remote** agent drive your browser over the public internet without
exposing any port on your machine. Off by default.

Topology: the extension (your machine) and the daemon (the agent's machine) both
dial out to a public relay and pair by token; once paired the relay forwards
transparently in both directions. The relay runs on Cloudflare Workers + Durable
Objects (sleeps when idle, friendly to the free tier, TLS included).

**1. Deploy the relay (about 2 minutes, once):**

```bash
cd owb-relay
npm install
npx wrangler login          # one browser authorization
npx wrangler deploy         # prints https://owb-relay2.<subdomain>.workers.dev
```

See `owb-relay/README.md` for details.

**2. Configure the extension:** click the extension icon in your browser toolbar →
switch to the **Relay** tab → enter the relay URL (e.g.
`wss://owb-relay2.xxx.workers.dev`) → click **Generate** → **Save and reconnect**.
The popup shows pairing progress live (browser → relay → daemon lighting up in
turn).

**3. Configure the daemon:** set the matching environment variables on the agent's
machine, then start the daemon:

```bash
export OWB_RELAY_URL="wss://owb-relay2.xxx.workers.dev"
export OWB_RELAY_TOKEN="<the same token as the extension>"
owb-daemon                    # the log will say relay mode
```

Once paired, `owb daemon-status` reports `mode: relay` and a remote agent drives
the browser exactly as it would locally. The CLI surface is unchanged (it still
connects to the local `/ctl`).

⚠️ The daemon reads these variables **only at startup**. If a local-mode daemon is
already running, stop it first — setting the variables alone does nothing.

## Optional: TLS fingerprint replay

`daemon_replay` needs the curl-impersonate binary (only used when verifying
protocol scripts). Download the archive for your platform from
[lexiforest/curl-impersonate releases](https://github.com/lexiforest/curl-impersonate/releases)
and extract it into the repo's `bin/` directory, or point `OWB_CURL_BINARY` at it.

## Security model (please read before using)

**Local mode (default):**

- The daemon listens only on `127.0.0.1` and validates the Host/Origin of the WS
  handshake (protecting against DNS rebinding)
- **Local trust model, no pairing token**: any process on the same machine can
  connect to the daemon. This is a deliberate simplification — the connection cost
  is zero — but **do not run the daemon on a shared or multi-user machine**, where
  a hostile local process could drive the browser
- A token was previously used as a same-machine defense (`?token=` was on by
  default in v0.7.0–v0.8.0) and has since been removed: it cannot stop a hostile
  process running as the same user (which can read the filesystem anyway), so the
  benefit did not justify the configuration cost
- For the same reason, the plaintext sessions under `work/states/` are only safe
  if you trust the processes on your machine. It is gitignored — check before
  sharing the repo
- The extension requests `debugger` + `<all_urls>`. These are the permissions CDP
  control requires, and they amount to handing browser control to the local daemon

See **[PRIVACY.md](PRIVACY.md)** for what the extension can access, where that
data goes, and a per-permission justification. Short version: nothing is sent to
the developer, and there is no server we operate.

**Relay mode (optional):**

- **The token is the only secret on the wire**, and it must travel over `wss`
  (Cloudflare's edge TLS). Reaching a relay room proves possession of the token
  (rooms are addressed by `sha256(token)`, so a leaked hash cannot be reversed
  into a working URL)
- **The relay is a trusted broker.** There is **no end-to-end encryption** — the
  relay can see all plaintext traffic, including login cookies and storage. Deploy
  it on a Cloudflare account you control, or accept that risk. E2EE (per-frame
  encryption with a token-derived key) is a planned hardening step
- Generate the token in the extension, copy it into the daemon's environment by
  hand, and **never commit it**
- Enabling relay mode does not change the local trust model of `/ctl` — the CLI
  still connects to the daemon on your own machine

## Tests

```bash
npm test          # smoke + CLI + slug + doc-example lint + doc-example run + HAR export
```

Individual suites:

```bash
node owb-daemon/tests/smoke_test.js          # protocol / daemon / orchestration (spawns its own daemon)
node owb-daemon/tests/cli_test.js            # the owb CLI surface: command mapping, forwarding, error model
node owb-daemon/tests/slug_test.js           # filename slugs, including non-ASCII names
node owb-daemon/tests/docs_examples_test.js  # every `owb ...` example in the skill resolves to a real command
node owb-daemon/tests/docs_run_test.js       # side-effect-free skill examples actually execute
node owb-daemon/tests/harexport_test.js      # HAR → replay / diff / assert
node owb-daemon/tests/relay_test.js          # relay mode integration (mock relay + real daemon)
node owb-daemon/tests/verify_replay_test.js  # offline verification + replay
node owb-daemon/tests/e2e_browser_test.js    # end to end on a real browser (headless Chromium + the real extension)
node owb-daemon/tests/read_page_test.js      # page-expression unit tests (several sibling files cover the rest)

cd owb-relay && node test/relay_test.mjs     # relay Durable Object unit tests
```

The last two doc-example suites exist because of a specific failure: the commands
the tests exercised and the commands the documentation taught had drifted apart,
so documented examples could break while every test stayed green.

## License

MIT
