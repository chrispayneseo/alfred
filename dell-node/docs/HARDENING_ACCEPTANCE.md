# Phase 5I — Hardening & Acceptance

Phase 5I is the final acceptance boundary for Alfred Phase 5. It does not add a
new executor, planner, permission system, retry path or model. It verifies that
the already-accepted Phase 5A–5H layers remain simultaneously active and fail
closed under adversarial conditions.

## Runtime acceptance contract

`GET /v1/core/hardening/status` is mounted on the existing owner-authenticated
Core route collection. It is read-only and metadata-only. It evaluates local
policy/configuration invariants and reports:

- the accepted mode for Phases 5A through 5H;
- exact-scope approval still authoritative for consequential actions;
- verified scalar hand-offs still authoritative for multi-tool workflows;
- Phase 5E idempotency, replay protection and reconciliation still active;
- controlled browser public-network and sensitive-field boundaries still active;
- static reusable recipes cannot introduce browser submit or email send;
- Agent Observability remains read-only and metadata-only;
- high-risk unimplemented actions remain absent from the tool registry;
- the accepted executor wrapper ordering remains intact;
- no Phase 5 policy/recovery decision depends on a cloud model.

The endpoint does not expose tool arguments, results, connected-source content,
recipe parameters, approval scope hashes, credentials or secret values.

## Adversarial Core tests

`test_phase5_hardening_acceptance.py` exercises the cross-phase invariants that
matter most for safe autonomy:

1. an approval cannot be reused after its exact arguments are altered;
2. an already-completed mutation cannot be duplicated by a repeated request;
3. an ambiguous mutation is never blindly retried;
4. restart recovery classifies interrupted reads and mutations without invoking
   either during reconciliation;
5. recipe inputs cannot invent `browser.submit`, `email.send` or shell actions;
6. recipe parameter content cannot leak through Today/Agent Activity or the
   final acceptance endpoint;
7. the browser submission kill switch denies before approval, execution or a
   Phase 5E receipt is created.

The tests use temporary local SQLite stores. They do not operate on the live
Alfred durable state.

## Browser-worker adversarial tests

The worker policy suite additionally verifies:

- loopback, wildcard, RFC1918, link-local metadata and local IPv6 targets are
  blocked;
- URLs containing embedded credentials are rejected;
- a hostname resolving to a mixture of public and private addresses is blocked;
- safe mode cannot issue mutating HTTP methods;
- cross-origin mutation requests remain blocked during submission;
- credential/payment/file selectors remain outside the capability;
- changed prepared values or URL change the state fingerprint;
- stale prepared-state approval is rejected before dispatch;
- changed target origin is rejected before dispatch;
- a repeated worker idempotency key returns the cached submission result without
  a second dispatch.

## Live acceptance

Run:

```bash
sudo bash /opt/alfred-node/scripts/phase5-hardening-acceptance-smoke.sh
```

The smoke checks the live Phase 5A–5H contract without mutating live state, then
runs the Core and browser adversarial suites against temporary fixtures.

Phase 5 is accepted only when:

- the runtime contract reports `accepted: true` with no failed checks;
- the Core adversarial acceptance suite passes;
- the browser adversarial acceptance suite passes;
- the existing full Core, frontend and browser CI regression suites remain green;
- the live smoke completes without a live website submission or external
  mutation.

## Deliberate boundaries after Phase 5

The following remain deliberately outside the accepted capability rather than
being treated as unfinished bugs:

- sending email (Gmail remains draft-only);
- password/passcode/OTP/2FA entry;
- payment-card/CVV entry;
- CAPTCHA solving;
- browser downloads or uploads;
- persistent/logged browser profiles;
- automatic booking, purchase or other high-impact browser submission without
  exact-scope owner approval.

Future work that needs authenticated browser sessions or payment secrets should
introduce a separate secure human/secret hand-off design instead of weakening
these Phase 5 boundaries.
