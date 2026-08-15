# Chrome Web Store submission copy

Everything below is ready to paste into the developer dashboard. Field names match
the form. Keep this file in sync when the listing changes.

---

## Single purpose

Chrome requires one clear sentence. This is the field reviewers weigh most, because
`debugger` + `<all_urls>` only survives review if the purpose plainly requires them.

> Open Web Bridge connects the user's browser to a local program they run
> themselves, so that AI coding agents can read and operate pages inside the
> user's own logged-in session through the Chrome DevTools Protocol.

## Short description (132 char limit — already in manifest.json)

> Let AI agents drive your real browser — page snapshots, network capture, hooks and human handoff, driven from your terminal.

## Detailed description

> Open Web Bridge lets an AI coding agent drive the browser you already use —
> with your logins, your session, your open tabs.
>
> That distinction is the whole point. An agent that launches its own clean
> browser can only reach what is public. An agent driving your browser can read
> the article behind your subscription, check the dashboard you are already
> signed into, and finish a flow that needs your identity.
>
> HOW IT WORKS
>
> This extension is a bridge, not a service. It connects to a small daemon you
> install and run on your own machine (npm i -g open-web-bridge). Your agent talks
> to that daemon through a command-line tool; the daemon talks to this extension;
> the extension drives the page through the Chrome DevTools Protocol.
>
> There is no account, no cloud service, and no server operated by us. By default
> the extension only ever connects to 127.0.0.1.
>
> WHAT IT GIVES AN AGENT
>
> • Semantic page snapshots — interactive elements get stable numbered references,
>   so the agent clicks "@e5" instead of guessing CSS selectors
> • Incremental snapshots — after an action, only what changed is returned
> • Real input — clicks are dispatched as genuine mouse events, with a visible
>   on-page cursor so you can watch what is happening
> • Human handoff — when the agent hits a captcha or a QR login it hands the tab
>   back to you, waits, and resumes when you are done
> • Network capture and HAR recording — inspect requests, export a recording, turn
>   it into a replay script
> • Device emulation — viewport, network throttling, geolocation, timezone, locale
> • Tab hygiene — tabs the agent opens go into labelled, colour-coded groups, and
>   it refuses to close tabs you opened yourself
>
> ABOUT THE PERMISSIONS
>
> This extension asks for broad access, and you should understand why before
> installing. Driving a browser through the DevTools Protocol requires the
> "debugger" permission, and the set of sites is whatever you ask the agent about,
> which cannot be known in advance. Installing it amounts to granting the local
> daemon control of your browser. Chrome shows a banner while it is attached.
>
> Nothing is collected and nothing is sent to the developer. Full detail, including
> a per-permission justification, is in the privacy policy.
>
> Open source (MIT): https://github.com/woniu9524/open-web-bridge

## Category

Developer Tools

## Permission justifications

One field per permission on the form.

**debugger**
> This is the core mechanism of the extension. Reading page structure, capturing
> network traffic, dispatching real input events and setting breakpoints are all
> done through the Chrome DevTools Protocol, which this permission provides. The
> extension cannot perform its function without it.

**tabs**
> Used to open, navigate, enumerate and close tabs, to resolve which tab a command
> targets, and to read tab URLs so a command is routed to the correct page.

**tabGroups**
> A safety feature. Tabs the extension creates are placed in labelled groups
> ("task: …", "OWB scratch", "OWB waiting for you"). This is what allows the
> extension to refuse to close a tab the user opened themselves, and lets the user
> clean up all agent-created tabs in one action.

**storage**
> Stores the user's own connection settings (the daemon address, and the optional
> relay URL and token) and the registry of active debug hooks so state survives the
> service worker being recycled. No page content is stored.

**alarms**
> A heartbeat that reconnects the MV3 service worker after Chrome recycles it.
> Without it the connection to the local daemon silently dies when the worker goes
> idle.

**downloads**
> Implements the download command, which triggers and tracks a browser download the
> user asked for.

**Host permission `<all_urls>`**
> The user decides which sites the agent works on, and that set cannot be known in
> advance — it is whatever page the user asks about. A fixed host list would mean
> the extension simply fails on any site not enumerated at build time, which would
> defeat its purpose.

**Remote code**
> No remote code is used. All logic ships in the package. The extension executes
> JavaScript expressions that the user's own local daemon sends it — this is the
> user driving their own browser, not code fetched from a remote server.

## Data usage disclosures

Tick these on the form and they must match PRIVACY.md.

| Question | Answer |
| --- | --- |
| Does it collect personally identifiable information? | No |
| Health information? | No |
| Financial and payment information? | No |
| Authentication information? | **Yes** — the extension can read cookies and storage for pages the user operates on, and can save a session locally at the user's request. It is never transmitted to the developer. |
| Personal communications? | No |
| Location? | No |
| Web history? | No |
| User activity? | No |
| Website content? | **Yes** — page content is read on the user's instruction and sent to the local daemon the user runs. |

Certifications (all three must be checked):
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL

> https://github.com/woniu9524/open-web-bridge/blob/master/PRIVACY.md

## Support / homepage URL

> https://github.com/woniu9524/open-web-bridge

## Screenshots

1280×800 (keep them out of the repo; export to a local scratch folder):

- `owb-store-1280x800.png` — the whole window: task tab group, popup, a real page
- `owb-store-2-popup.png` — popup close-up: connection state, Local/Relay, daemon address

## Review notes (the "notes for reviewer" field)

> This extension is the browser half of an open-source developer tool. It does
> nothing on its own: it connects to a daemon the user installs from npm
> (open-web-bridge) and runs on their own machine, and only acts on commands that
> daemon sends.
>
> The debugger permission is unavoidable — the entire function is driving the page
> through the DevTools Protocol. Chrome's own "started debugging this browser"
> banner is left visible while attached, so the user always knows.
>
> There is no backend, no analytics and no data collection. The default connection
> target is 127.0.0.1. An optional relay mode exists for driving a browser from
> another machine; the relay is deployed by the user on their own Cloudflare
> account, and the documentation states plainly that it is a trusted broker with no
> end-to-end encryption.
>
> Full source: https://github.com/woniu9524/open-web-bridge
