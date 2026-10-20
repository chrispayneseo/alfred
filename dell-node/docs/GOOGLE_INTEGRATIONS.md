# Alfred Google Calendar + Gmail setup

Alfred keeps Google Calendar and Gmail credentials separate so each integration can be granted independently. Calendar and Gmail are read-only by default. Calendar writes and Gmail draft creation remain behind separate write-capable credentials and explicit feature gates.

## Google Cloud setup

Use a dedicated Google Cloud project for Alfred.

1. Enable **Google Calendar API** and **Gmail API**.
2. Configure the OAuth consent screen for the Google account that Alfred will use.
3. If the project uses an External audience while testing, add the account as a test user.
4. Create a **Desktop app** OAuth client for Calendar and download its JSON.
5. Create a second **Desktop app** OAuth client for Gmail and download its JSON.

Keeping the two desktop clients separate helps preserve the read-scope boundary between Calendar and Gmail.

### Publishing status

Google refresh tokens issued while an External OAuth app is in **Testing** normally expire after 7 days. For a persistent Alfred installation, move the OAuth app to **In production** after testing. Google may still show an unverified-app warning for a private/unverified project; do not add other users unless the project has been reviewed appropriately.

## Authorize on the Dell

Never paste OAuth client secrets or refresh tokens into chat or commit them to GitHub.

Copy the two downloaded client JSON files to a private local directory on the Dell, for example:

```bash
sudo mkdir -p /opt/alfred-node/private/google
sudo chmod 700 /opt/alfred-node/private/google
```

Then run the bootstrap helper separately for each integration:

```bash
sudo python3 /opt/alfred-node/scripts/google-oauth-bootstrap.py \
  calendar /opt/alfred-node/private/google/calendar-client.json

sudo python3 /opt/alfred-node/scripts/google-oauth-bootstrap.py \
  gmail /opt/alfred-node/private/google/gmail-client.json
```

The helper:

- listens only on `127.0.0.1` for the OAuth callback;
- requests offline access so Core can refresh short-lived access tokens;
- requests `calendar.readonly` for Calendar;
- requests `gmail.readonly` for Gmail;
- validates the granted scope;
- writes client ID, client secret and refresh token directly into `/opt/alfred-node/.env`;
- never prints secrets or tokens.

If the browser does not open automatically, copy the printed Google authorization URL into a browser running on the same Dell while the helper is waiting.

After each successful authorization, recreate Core so the environment is reloaded:

```bash
cd /opt/alfred-node
sudo docker compose up -d --force-recreate core
```

## Live verification

After both integrations report ready, run:

```bash
sudo bash /opt/alfred-node/scripts/google-live-smoke.sh
```

The live smoke test checks:

- Calendar natural-language reads;
- Gmail natural-language reads;
- deterministic Calendar + Gmail multi-read chaining;
- that the route stays inside registered integration tools;
- that no connected content is printed by the test script;
- that no mutation is performed.

Expected high-level output:

```text
PASS: Calendar and Gmail read capabilities are ready
PASS: Calendar natural-language read
PASS: Gmail natural-language read
PASS: Deterministic Calendar + Gmail multi-read
```

## Write capabilities remain off

The bootstrap helper deliberately sets:

```text
GOOGLE_CALENDAR_WRITE_ENABLED=false
```

and does not configure Gmail write credentials. Calendar create/update/delete and Gmail draft creation therefore remain unavailable until their separate write paths are explicitly configured and tested.
