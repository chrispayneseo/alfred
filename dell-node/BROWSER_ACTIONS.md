# Phase 5F — Controlled Browser / Web Actions

Phase 5F adds a separate Playwright browser worker to the Dell. Alfred Core stays
authoritative for tool registration, permissions, exact-scope approval, goal
execution and Phase 5E recovery. The worker never receives the Alfred database,
Gmail/Calendar credentials, local-files mount or cloud-model keys.

## Safety boundary

The worker is intentionally conservative:

- only public `http://` and `https://` destinations are allowed;
- loopback, private, link-local and reserved IP destinations are rejected after DNS resolution;
- WebSockets and EventSource connections are blocked;
- browser sessions are memory-only, headless and expire after 30 minutes by default;
- downloads, uploads and persistent browser profiles are unavailable;
- page content is labelled `untrusted_web_content=true`;
- ordinary navigation runs in read-only network mode;
- form preparation runs in an offline mode that blocks all network requests while values are filled;
- password, passcode, OTP, payment-card, security-code and file-upload fields are rejected;
- every `browser.submit` is a high-impact Core action and requires exact-scope owner approval;
- the approval is bound to the current browser-state fingerprint, target origin, selector and action kind;
- the worker accepts an idempotency key for submission, while Phase 5E remains the durable replay/ambiguity authority;
- an uncertain submission outcome is not blindly retried; it enters Phase 5E reconciliation.

This first controlled-browser version deliberately does **not** automate credentials,
payment-card entry or CAPTCHA/2FA challenges. Those need a separate secret-handoff
and human-in-the-loop design rather than putting secrets into durable goal arguments.

## Core tools

| Tool | Policy | Purpose |
| --- | --- | --- |
| `browser.session.open` | automatic read | Open a fresh isolated session at a public URL |
| `browser.navigate` | automatic read | Navigate the current session to another public URL |
| `browser.page.inspect` | automatic read | Return bounded text, links, forms and control metadata |
| `browser.form.prepare` | automatic reversible | Fill approved non-sensitive fields with network blocked |
| `browser.submit` | **owner approval required** | Click one exact prepared submission control |
| `browser.session.close` | automatic reversible | Destroy the ephemeral browser session |

`browser.submit` is also behind the global `ALFRED_BROWSER_SUBMIT_ENABLED` kill switch.
Turning that flag on does not remove the per-action approval requirement.

## Enable on the Dell

Create a long random worker token in `/opt/alfred-node/.env`, then set:

```bash
ALFRED_BROWSER_ENABLED=true
ALFRED_BROWSER_SUBMIT_ENABLED=false
ALFRED_BROWSER_WORKER_URL=http://browser-worker:8090
ALFRED_BROWSER_WORKER_TOKEN=<random 64+ character token>
```

Start the worker profile and rebuild Core:

```bash
cd /opt/alfred-node
sudo docker compose --profile browser up -d --build browser-worker core
```

Keep `ALFRED_BROWSER_SUBMIT_ENABLED=false` while validating navigation and form
preparation. Enable it only when you want approved browser submissions to be
possible.

## Workflow shape

Phase 5C bindings can carry verified scalar values such as `session_id` and
`state_fingerprint` between steps. A typical future goal can therefore be:

1. `browser.session.open`
2. `browser.page.inspect`
3. `browser.form.prepare`
4. `browser.submit` → stops for exact-scope approval
5. `browser.page.inspect` → verify the resulting page
6. `browser.session.close`

The worker itself never creates new plan steps and never decides whether approval
is required.
