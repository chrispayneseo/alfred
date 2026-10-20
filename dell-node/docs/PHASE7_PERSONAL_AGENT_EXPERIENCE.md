# Phase 7 — Personal Agent Experience

Phase 7 turns the accepted Phase 5/6 backend into a coherent daily assistant on the two surfaces Chris actually uses: the Alfred web app on phone and Mac.

## 7A — Unified Alfred interface

The existing Today surface remains the landing page and now links directly to **Ask Alfred**, **Alfred Inbox**, **Search Alfred**, and reviewed Capture. Phone navigation promotes these agent surfaces to first-class tabs; Mac navigation exposes the same routes in the persistent sidebar.

## 7B — Conversational command interface

`POST /v1/core/experience/command` is a thin facade over the existing authoritative `orchestrate()` boundary. It creates no alternate routing, model, permission, or execution path. Natural-language requests can therefore continue to use deterministic local reads, connected integrations, cloud approval, mutation planning and exact-scope approvals exactly as Core already defines them.

## 7C — Notifications and attention

`GET /v1/core/experience/notifications` exposes an event-driven in-app feed derived from items that need attention and verified completions. Phase 7 deliberately does **not** introduce an automatic daily briefing or unsolicited cloud reasoning.

## 7D — Connected personal context

Connected Gmail and Calendar data continue to be accessed only through the existing Core read planners and integration registry. Phase 7 does not create a shadow index of connected account data. A connected-source question belongs in **Ask Alfred** so Core can choose the permitted integration at request time.

## 7E — Alfred Inbox

`GET /v1/core/experience/inbox` normalises existing durable state into three owner-facing queues:

- **Needs you** — reviewed capture, exact-scope approvals, execution attention.
- **Working** — active durable goals/current steps.
- **Done** — verified completed executions.

The payload is content-minimised: no raw forwarded body, tool arguments, tool results, approval scope hash, or connected-source payload is exposed.

## 7F — Better capture

Phase 7 reuses the Phase 6 reviewed capture model. Forwarded WhatsApp text remains untrusted data. Capture is not automatically converted into an external mutation.

## 7G — Personal search

`GET /v1/core/experience/search?q=...` searches Alfred's local unified memory/task/reminder context on the Dell. It returns bounded snippets and provenance. No cloud model is used by this endpoint. Connected account searches remain request-time Core reads through Ask Alfred.

## 7H — Hardening and acceptance

`GET /v1/core/phase7/status` validates 11 contracts, including:

- Phase 6 remains accepted.
- Phone and Mac use the same authoritative Core.
- No second executor or policy path exists.
- Capture and exact-scope approvals are reused.
- Personal search is local-first.
- Notifications are event-driven rather than a daily briefing.
- Browser submission and email sending remain disabled by Phase 7.
- No automatic external mutation is introduced.

The live smoke script also confirms that reading Phase 7 status/inbox/search surfaces does not resolve approvals or create executions.

## Routes

- `GET /v1/core/experience/status`
- `GET /v1/core/experience/inbox`
- `GET /v1/core/experience/search?q=<query>&limit=<n>`
- `GET /v1/core/experience/notifications`
- `POST /v1/core/experience/command`
- `GET /v1/core/phase7/status`

All routes are mounted on the same owner-authenticated Core router already used by Phases 5 and 6.

## Boundaries deliberately unchanged

Phase 7 does not enable:

- email send/reply/forward;
- password, passcode, OTP or 2FA entry;
- payment-card or CVV handling;
- CAPTCHA solving;
- browser downloads/uploads;
- persistent browser profiles;
- automatic purchase or booking submission;
- a second executor or approval system;
- automatic execution of arbitrary forwarded content.

`ALFRED_BROWSER_SUBMIT_ENABLED=false` remains the required live configuration.
