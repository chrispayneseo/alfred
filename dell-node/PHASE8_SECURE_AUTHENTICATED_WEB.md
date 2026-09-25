# Phase 8 — Secure Authenticated Web Actions

Phase 8 extends Alfred's accepted controlled-browser path so the owner can establish a logged-in website session without giving Alfred a password, passcode, OTP/2FA value, card/CVV value or CAPTCHA response.

## Architecture

- Human login bootstrap creates a Playwright storage-state file on the Dell.
- Each profile has an opaque id and an explicit public-origin allowlist.
- The browser worker mounts the profile directory read-only.
- Core can open an authenticated session using only `profile_id` + public URL.
- Subsequent navigation and inspection reuse the Phase 5F browser session.
- Consequential submission remains `browser.submit` and therefore still requires exact-scope owner approval, Phase 5E verification, idempotency and reconciliation on ambiguity.

## Human bootstrap

`dell-node/scripts/phase8-browser-profile-bootstrap.py` launches a visible Chromium session. The owner performs login and any 2FA/CAPTCHA directly in that browser. The script writes:

- `<profile>.state.json` — Playwright browser storage state, mode `0600`
- `<profile>.meta.json` — label, creation time and allowed public origins, mode `0600`

Neither file is exposed through Core APIs. Core status returns only profile ids, labels and allowed origins.

## New Core action

`browser.authenticated.session.open`

Policy: read-only / automatic. It can establish an already-authenticated browsing session but cannot submit a form or create an external side effect.

## New endpoints

- `GET /v1/core/authenticated-web/status`
- `POST /v1/core/authenticated-web/open`
- `GET /v1/core/phase8/status`

Browser worker:

- `GET /v1/profiles`
- `POST /v1/session/open-authenticated`

## Preserved boundaries

Phase 8 does **not** enable:

- Alfred entering passwords, PINs, passcodes, OTP/2FA values or recovery codes
- CAPTCHA solving
- payment-card or CVV entry
- browser downloads or file uploads
- unrestricted authenticated navigation outside a profile's origin allowlist
- email sending
- automatic purchase/booking submission
- a second Core executor

`ALFRED_BROWSER_SUBMIT_ENABLED=false` remains the expected live configuration.

## Sequential deployment

Deploy Phase 7 and complete its live acceptance first. Then checkout the Phase 8 release SHA and run:

```bash
sudo bash dell-node/scripts/deploy-phase8.sh
```

The installer reruns Phase 7 live acceptance before it changes the runtime, backs up Phase 7, installs/rebuilds Core and browser-worker, runs Phase 8 acceptance and writes `/opt/alfred-node/.phase8-live-accepted` only after all checks pass.

## Optional authenticated profile setup

After Phase 8 is live, install Playwright in a local Python environment if needed and run the bootstrap script from the Dell desktop session. The visible browser is the only place secrets are entered.

The profile feature is optional: Phase 8 acceptance validates the architecture and boundaries without requiring a real website account.
