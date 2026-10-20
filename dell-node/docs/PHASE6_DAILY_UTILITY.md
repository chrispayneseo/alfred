# Phase 6 — Daily Utility Layer

Phase 6 turns the accepted Phase 5 agent stack into a practical daily interface without changing the execution or permission boundary.

## Status model

| Phase | Capability | Mode |
| --- | --- | --- |
| 6A | Reviewed capture | `reviewed_capture_v1` |
| 6B | Owner-editable triage | `reviewed_capture_v1` |
| 6C | Guarded Core dispatch | `phase5_guarded_dispatch_v1` |
| 6D | Daily command centre | `daily_command_centre_v1` |
| 6E | Hardening and acceptance | `phase6_daily_utility_acceptance_v1` |

## 6A — Reviewed capture

The existing WhatsApp forward-only privacy model remains authoritative. Forwarded message bodies are untrusted input data and never become Core instructions.

The local on-device classifier may suggest `note`, `task`, `reminder` or `clarify`, but the Phase 6 daily surface exposes only reviewed/suggested title-level data and metadata. Raw forwarded bodies and details are intentionally excluded from `/v1/core/daily/today`.

Manual local capture remains available for local notes, tasks and reminders.

## 6B — Owner-editable triage

Before a forwarded task/reminder can enter Core, the owner can edit its type, title, due date and detail. `POST /v1/core/daily/intake/{message_id}/review` persists that reviewed interpretation.

Once an exact Core approval has been created, those reviewed fields are locked for that intake item. This prevents a proposal from being silently changed after approval scope has been calculated.

A reminder must have a validated `YYYY-MM-DD` due date before it can be proposed.

## 6C — Guarded Core dispatch

`POST /v1/core/daily/intake/{message_id}/propose` delegates directly to the existing WhatsApp Core bridge. The bridge converts only the reviewed `task` or dated `reminder` fields into a deterministic Core command.

Raw forwarded text is never passed to `orchestrate()`.

The resulting mutation remains behind the existing Phase 5 exact-scope approval path. Phase 6 does not add a new executor, planner, permission engine, retry mechanism or policy decision.

`POST /v1/core/daily/intake/{message_id}/resolve` can resolve only the approval already linked to that exact intake item. A verified completed approval marks the intake item filed. Rejected or failed work is not marked complete.

## 6D — Daily command centre

`GET /v1/core/daily/today` combines four existing local sources into one owner-facing view:

- pending reviewed capture;
- open local tasks/reminders;
- Phase 5 active goals and waiting approvals;
- Phase 5 completed/attention metadata for the current day.

The web Today screen renders this as **Alfred command centre**. It shows concise counts and a bounded `Needs you` queue, with Capture as the review surface for forwarded messages.

The command-centre GET route is read-only and does not execute tools or resolve approvals.

## 6E — Acceptance

`GET /v1/core/phase6/status` verifies that:

- the Phase 5I baseline is still accepted;
- forwarded text remains data, not instructions;
- owner review is required before dispatch;
- Core dispatch retains exact-scope approval;
- no parallel executor or policy path exists;
- no automatic external mutation was added;
- browser submission is not enabled by Phase 6;
- email sending is not enabled by Phase 6;
- daily content remains minimised;
- the control plane does not depend on cloud models.

The adversarial suite additionally checks that injection-like raw forwards are absent from the daily payload and Core command, reviewed scope cannot change after proposal creation, arbitrary approvals cannot be resolved through an intake ID, and a completed linked approval is the only path that files Core-dispatched intake.

## Endpoints

Read-only:

- `GET /v1/core/daily/status`
- `GET /v1/core/daily/today`
- `GET /v1/core/phase6/status`

Owner actions:

- `POST /v1/core/daily/intake/{message_id}/review`
- `POST /v1/core/daily/intake/{message_id}/propose`
- `POST /v1/core/daily/intake/{message_id}/resolve`

All routes are mounted on the existing authenticated Core router.

## Deliberate boundaries

Phase 6 does **not** add or enable:

- email send/reply/forward;
- password, OTP or 2FA entry;
- payment card/CVV entry;
- CAPTCHA solving;
- browser downloads/uploads;
- persistent browser profiles;
- automatic purchase/booking submission;
- a second executor or approval system;
- automatic execution of arbitrary forwarded text.

The existing live browser submission kill switch remains a separate Phase 5 configuration boundary and should stay disabled unless a future explicitly scoped phase changes that decision.

## Live acceptance

After deploying the Phase 6 files and rebuilding Core/web, run:

```bash
sudo bash /opt/alfred-node/scripts/phase6-daily-utility-smoke.sh
```

A successful run prints five Phase 6 PASS lines, verifies the acceptance contract, and runs the Phase 6 adversarial tests against temporary stores without resolving a live approval or performing an external mutation.
