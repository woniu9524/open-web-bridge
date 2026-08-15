# Relay mode: letting a remote agent drive the user's browser

**Read this when**: the user asks whether this works "on a server" or "from
another machine", asks about remote-controlling their browser or configuring a
relay, or `owb daemon-status` reports `mode: relay`.

## How the two modes differ

**Local mode (the default, nothing to configure)** — daemon and browser on the
same machine:

```
you (agent) → owb CLI → daemon(127.0.0.1:43917) → extension → browser
```

**Relay mode** — the browser is on the user's machine while the agent and daemon
are elsewhere (a server, another computer, the cloud). Both ends **dial out** to a
public relay and pair up using the same token:

```
browser/extension (user's machine) ──wss──►┐              ┌──wss── daemon + owb CLI (your side)
                                           │  relay broker │
                                           └───────────────┘
                                    (Cloudflare Workers + Durable Objects)
```

The key property: **both ends dial out, so the user's machine needs no open port
and no public IP.**

## First, work out which mode you are in

```bash
owb daemon-status
```

The result has `mode: "local"` or `"relay"` (relay also carries `relay_url`).
On the user's side, the extension popup shows it too: clicking the OWB toolbar
icon shows a topology diagram with **two nodes in local mode** (browser—daemon)
and **a third "relay" node in the middle in relay mode**.

## Setup: walking the user through it

This mixes **actions on the user's machine** with **environment variables on your
side**, so you cannot do all of it yourself. Follow this order and **wait for the
user to confirm each step before moving on**.

### Step 0: confirm it is actually needed

Ask first: which machine is the browser on, and which machine is the agent on?
**If they are the same machine, relay mode is unnecessary** — local mode is faster
and safer. Skip this entire document.

### Step 1: is there a relay address yet?

- **Already deployed**: get the `wss://…` address and go to step 2.
- **Not yet**: the user needs to deploy one on their own Cloudflare account (the
  free tier is enough). ⚠️ **The relay source is not part of the npm package** —
  it ships only in the git repository, so `cd owb-relay` fails on a normal
  `npm i -g` install. Point the user at
  <https://github.com/woniu9524/open-web-bridge/tree/master/owb-relay> (its
  README is the full guide); from a clone, the core is three commands:

  ```bash
  cd owb-relay && npm install
  npx wrangler login       # one browser authorization
  npx wrangler deploy      # prints https://owb-relay2.<subdomain>.workers.dev
  ```

  ⚠️ **It must be deployed on the user's own Cloudflare account** — see "Security
  boundaries" below for why. Change the printed address to `wss://` and that is
  the relay URL.

### Step 2: generate a token

The token is **the only key to remote-controlling this browser**; 32 random bytes
is plenty. Two ways to produce one:

- The "Relay" tab in the extension popup has a **Generate** button (preferred —
  the user clicks it and you never see the value)
- Command line:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

⚠️ **You do not need to know the token's value.** Have the user generate it and
fill in both ends themselves. **Do not echo it in conversation, do not write it
into repository files, do not let it reach logs.** When you genuinely need to
refer to it, the masked form shown in the popup (`abc123…wxyz`) is enough to
confirm both ends match.

### Step 3: configure the extension side (the user does this)

Tell the user to click through in this order:

1. Click the OWB extension icon in the browser toolbar
2. Switch to the **Relay** tab
3. **Relay URL**: the `wss://…` address from step 1 (it must start with `wss://`,
   or saving fails)
4. **Relay TOKEN**: the token from step 2 (or click **Generate**, then **Copy**)
5. Click **Save**

Saving writes to extension storage and reconnects immediately — no browser
restart. The status will sit at **"Pairing…"** with a note about waiting for the
daemon to join with the same token. **That is expected**: the other end is not up
yet.

### Step 4: configure the daemon side (your side)

The daemon enables relay mode through two environment variables, and **both must
be present**:

```bash
export OWB_RELAY_URL="wss://owb-relay2.<subdomain>.workers.dev"
export OWB_RELAY_TOKEN="<exactly the same token as the extension side>"
```

⚠️ **The daemon reads its environment only at startup.** If a local-mode daemon is
already running, setting the variables does nothing — **stop it first**, then let
the next `owb` command start a fresh one (the CLI spawns the daemon with the
current process environment).

⚠️ Don't put the token in a repository file. Use a shell environment variable or
the user's own secret management.

### Step 5: verify

```bash
owb daemon-status     # expect mode: "relay" plus relay_url
owb                   # expect two ✓: daemon (relay mode) + extension connected
owb open https://example.com --new-tab true    # a real command
```

On the user's side the popup should move from "Pairing…" to **"Connected"**, with
all three nodes in the topology lit.

## What changes in relay mode

Once paired, **every command is used exactly the same way** (routing is unchanged
internally). But a few things matter:

### ⚠️ Files land on different machines

This is the easiest thing to get wrong. In local mode "the file I downloaded" and
"the file I can read" are the same file. In relay mode they are **not**:

| Command | Where the file actually is | Can you read it? |
| --- | --- | --- |
| `owb download` | The system download directory **on the user's machine** (the Chrome downloads API can only write there) | ❌ no |
| `owb file fetch` | `work/downloads/` **on the daemon machine** (the daemon does the HTTP fetch itself) | ✅ yes |
| `owb shot --out` / `owb pdf --out` | **Your side** (the CLI writes the bytes locally) | ✅ yes |
| `har save` / `state save` / task archives | `work/` **on the daemon machine** | ✅ yes |
| `owb upload` | Touches no filesystem (base64 through an in-page DataTransfer) | ✅ works normally in relay mode |

⚠️ **`file fetch` is the daemon fetching a URL itself, without the user's browser
session** — for anything behind a login it will fetch a login page instead. Those
files either need the user to download them, or a different approach on the daemon
side after `owb state save`.

### Latency and timeouts

Every command adds a public-internet round trip:

- **The 30-second hard CDP timeout is much easier to hit** (see SKILL.md's timeout
  table). Prefer `--wait-until domcontentloaded` on slow sites, and shrink
  `--max-nodes` rather than raising it for snapshots.
- Large results (full-page screenshots, full snapshots, HAR) transfer more slowly
  — **`--since-last` incremental snapshots matter more here**, and HAR should
  always go to disk via `har save` rather than to stdout.
- The reconnect backoff cap rises from 15 to **60 seconds** (each reconnect is a
  billable relay request), so recovery after a dropout is **slower than local**.
  Seeing `NO_EXTENSION` for a while is normal.

### The user is next to the browser — and cannot see you

In local mode the user at least knows the agent runs on the same machine. In relay
mode you are driving their browser **from somewhere else**, and all they see is
tabs moving on their own. So:

- **`--new-tab true` plus `--active false` matter more** — don't take over their
  screen
- **Say what you are about to do** before anything that changes state; this needs
  more warning than local mode, not less
- Clean up with `owb tab close-group` — don't leave tabs behind on someone else's
  machine

## Security boundaries (tell the user before configuring)

- **The token is the only secret on the wire.** Whoever holds it can fully control
  this browser, including every logged-in session. Don't leak it, don't commit it,
  don't echo it in conversation.
- **The relay is a trusted broker; there is currently no end-to-end encryption.**
  The relay service can see all plaintext traffic, **including cookies and
  storage**. That is why it **must be deployed on the user's own Cloudflare
  account** — never use a public relay someone else runs.
- Transport itself is `wss://` (Cloudflare edge TLS). The token appears in the URL
  path — encrypted in transit, but it will show up in the user's own Cloudflare
  request logs.
- A reconnect from the same role replaces the previous connection; either end
  disconnecting drops the other.
- **Turn it off when done**: in the extension popup, switch back to the Local tab
  and save (this clears the relay fields); on the daemon side, unset the two
  environment variables and restart.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Popup stuck at **"Pairing…"** | Only one end is up. **This is a normal state** — wait for the other end. If both ends are configured and it persists, check the tokens match exactly (compare the masked head and tail) |
| Popup shows **"Not connected"**, asking you to check URL and token | The relay URL is wrong or was never deployed; verify with `curl https://<relay>/health` |
| `owb daemon-status` still shows `mode: "local"` | Either both variables are not set, or **an old daemon is still alive**. Stop it and rerun (the daemon reads its environment only at startup) |
| Persistent `NO_EXTENSION`, backoff doesn't help | The extension on the user's machine has not reached the relay. Have them check the popup status; relay reconnect backoff caps at 60s, slower than local |
| `Exceeded allowed volume of requests in Durable Objects free tier` | Cloudflare's free tier (1M DO requests/month) is exhausted; it resets on the 1st, or upgrade to Workers Paid ($5/month) |
| `error code: 1042` or a 404 that never reaches the worker | The workers.dev route is not enabled — confirm `workers_dev = true` in `wrangler.toml` and redeploy |
| A bare `1101` with no other information | The exception is outside the catch layer (broken deploy or platform fault). Run `npx wrangler tail` for the stack; redeploy under a different worker name |

Deeper documentation on deploying, testing and the quotas of the relay service
itself is in the repository (not the npm package):
<https://github.com/woniu9524/open-web-bridge/tree/master/owb-relay>.
