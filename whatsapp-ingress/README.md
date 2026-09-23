# Alfred WhatsApp ingress (pilot)

This is a separate public Cloudflare Worker, **not** a route on the protected Alfred app and not an exposed port on the Dell. It receives Meta's Cloud API webhook, verifies Meta's HMAC over the original request bytes, and stores text only when both the destination phone-number ID and sender match configured allowlists. It never sends WhatsApp messages. The Dell can fetch pending messages using a scoped collector token and acknowledge them after safely recording them in Alfred.

This is deliberately a first layer, **not a complete WhatsApp integration**. Do not register a phone number until the Worker has its secrets, signed-message tests pass against the live URL, and the Dell collector is ready. Use a dedicated number, not Peacock's existing WhatsApp Business app number. Do not enable Meta message-history import.

Required Worker secrets (never commit values):

- `META_APP_SECRET`: the app secret for the dedicated Meta developer app whose WhatsApp webhook is subscribed.
- `META_VERIFY_TOKEN`: a random token generated for Meta's webhook challenge.
- `COLLECTOR_TOKEN`: a different random token, at least 32 characters, used only by the Dell.
- `ALLOWED_SENDER`: the owner's personal WhatsApp number in international format.
- `PHONE_NUMBER_ID`: Meta's identifier for the Peacock Business number, **not** the phone number itself.

The Cloudflare D1 database `alfred-whatsapp-inbox` and its `whatsapp_inbox` table have been created. The Worker is deployed at `https://alfred-whatsapp-ingress.cpayneer.workers.dev/` and has the `INBOX_DB` binding. An unauthenticated `/inbox` request returns 401 and an incorrect webhook challenge returns 403. The Worker has no secrets configured yet, so it cannot accept messages. Before connecting the number, configure the secrets, verify a valid GET challenge, verify an invalid POST signature gets 401, and set up the Dell collector. Do not paste any secrets or verification codes into chat.

The inbox is intentionally limited to text forwards for the pilot. Customer messages, media, statuses, and app echoes are not stored. Successful collector acknowledgement deletes the staging copy; the Dell must persist its own copy **before** acknowledging. Follow-up work must add that Dell collector, local triage, and Alfred task/memory/reminder review before this feature is considered complete.
