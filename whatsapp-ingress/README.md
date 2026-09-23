# Alfred WhatsApp ingress (pilot)

This is a separate public Cloudflare Worker, **not** a route on the protected Alfred app and not an exposed port on the Dell. It receives Meta's direct-delivery webhook, verifies Meta's HMAC over the original request bytes, and stores text only when both the destination phone-number ID and sender match configured allowlists. It never sends WhatsApp messages. The Dell can fetch pending messages using a scoped collector token and acknowledge them after safely recording them in Alfred.

This is deliberately a first layer, **not a complete WhatsApp integration**. Nothing should be connected in Cosend until the Worker is deployed, signed-message tests pass against the live URL, and the Dell collector is ready. Do not enable history import or Cosend AI/automation. Use Cosend's *direct delivery* mode, not default/forwarding mode, if the stated no-content-storage property is required.

Required Worker secrets (never commit values):

- `META_APP_SECRET`: the signing secret shown on the Cosend connection settings page for direct delivery.
- `META_VERIFY_TOKEN`: a random token generated for Meta's webhook challenge.
- `COLLECTOR_TOKEN`: a different random token, at least 32 characters, used only by the Dell.
- `ALLOWED_SENDER`: the owner's personal WhatsApp number in international format.
- `PHONE_NUMBER_ID`: Meta's identifier for the Peacock Business number, **not** the phone number itself.

Create a Cloudflare D1 database named `alfred-whatsapp-inbox`, replace the placeholder ID in `wrangler.toml`, apply `migrations/0001_inbox.sql`, and deploy this folder as a separate Worker. Before connecting the number, verify `/webhook` GET challenge with the chosen token, verify an invalid POST signature gets 401, and verify `/inbox` cannot be read without the collector token. Do not paste any secrets or verification codes into chat.

The inbox is intentionally limited to text forwards for the pilot. Customer messages, media, statuses, and app echoes are not stored. Successful collector acknowledgement deletes the staging copy; the Dell must persist its own copy **before** acknowledging. Follow-up work must add that Dell collector, local triage, and Alfred task/memory/reminder review before this feature is considered complete.
