# Alfred WhatsApp ingress (pilot)

This is a separate public Cloudflare Worker, **not** a route on the protected Alfred app and not an exposed port on the Dell. It receives Meta's Cloud API webhook, verifies Meta's HMAC over the original request bytes, and stores text only when both the destination phone-number ID and sender match configured allowlists. It never sends WhatsApp messages. The Dell can fetch pending messages using a scoped collector token and acknowledge them after safely recording them in Alfred.

This is deliberately a first layer, **not a complete WhatsApp integration**. Do not register a phone number until the Worker has its secrets, signed-message tests pass against the live URL, and the Dell collector is ready. Use a dedicated number, not Peacock's existing WhatsApp Business app number. Do not enable Meta message-history import.

Required Worker secrets (never commit values):

- `META_APP_SECRET`: the app secret for the dedicated Meta developer app whose WhatsApp webhook is subscribed.
- `META_VERIFY_TOKEN`: a random token generated for Meta's webhook challenge.
- `COLLECTOR_TOKEN`: a different random token, at least 32 characters, used only by the Dell.
- `ALLOWED_SENDER`: the owner's personal WhatsApp number in international format.
- `PHONE_NUMBER_ID`: Meta's identifier for the Alfred test number during testing, then the dedicated Alfred production number if one is registered. Never use Peacock's existing WhatsApp Business app number.

The Cloudflare D1 database `alfred-whatsapp-inbox` and its `whatsapp_inbox` table have been created. The Worker is deployed at `https://alfred-whatsapp-ingress.cpayneer.workers.dev/` and has the `INBOX_DB` binding. An unauthenticated `/inbox` request returns 401 and an incorrect webhook challenge returns 403. The Worker has no secrets configured yet, so it cannot accept messages. Before connecting the number, configure the secrets, verify a valid GET challenge, verify an invalid POST signature gets 401, and set up the Dell collector. Do not paste any secrets or verification codes into chat.

The canonical public privacy-information URL is `https://alfred-whatsapp-ingress.cpayneer.workers.dev/privacy`. It is a factual single-user notice only; the private Alfred application remains protected. The Vercel-hosted copy is not suitable for Meta's privacy URL because production deployment protection redirects unauthenticated visitors.

The Dell collector is in `collector.py`. It polls the private inbox over HTTPS, commits each text message to a Dell-local SQLite database, and **only then** acknowledges the staging copy for deletion. It sends no WhatsApp messages and cannot call a cloud LLM. The Dell currently runs the existing stack under Docker, but `chris` does not have Docker socket access. Use the supplied `alfred-whatsapp-collector.service` as a lean systemd **user** service instead; linger is already enabled, so the service survives logout. Put the same secret as the Worker's `COLLECTOR_TOKEN` in the Dell's `collector-token` file (mode 600) and keep the `collector-data` directory mode 700. The alternative `compose.collector.yml` with `collector.env.example` is available if Docker management is preferred later. The SQLite file is intentionally separate from Alfred Core's existing SQLite database until a review/triage API is added.

Meta's production setup screen warns that an unpublished app will not deliver real messages to the configured webhook, including messages from admins or testers. Configuring and verifying the callback is therefore insufficient for an end-to-end live test; publishing requirements must be checked before registering the dedicated number. The production screen says a payment method is for business-initiated sends, which this receive-only pilot does not make. Neither that screen nor the test number establishes that long-term use is free or permitted for a personal assistant.

The inbox is intentionally limited to text forwards for the pilot. Other senders' messages, media, statuses, and app echoes are not stored. Successful collector acknowledgement deletes the staging copy. Dell Core locally triages collected text and presents suggestions in Capture → Inbox. The operator must approve a filing; no forwarded message is actioned automatically. Notifications and external actions remain future work.
