"""Poll the signed WhatsApp ingress and durably stage messages on the Dell.

This is deliberately receive-only. No forwarded text is sent to a cloud model,
turned into a task, or committed to Alfred memory without a later review step.
"""

import argparse
import json
import logging
import os
import sqlite3
import time
import urllib.error
import urllib.request
from contextlib import closing
from pathlib import Path
from typing import Optional


LOG = logging.getLogger("alfred_whatsapp_collector")
MAX_RESPONSE_BYTES = 256_000


def request_json(url: str, token: str, *, body: Optional[dict] = None) -> dict:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "AlfredWhatsAppCollector/1.0",
            **({"Content-Type": "application/json"} if payload is not None else {}),
        },
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("Ingress response was too large")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError("Ingress returned an invalid response")
        return result


def open_database(path: str) -> sqlite3.Connection:
    database_path = Path(path)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(database_path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
    db.execute(
        """CREATE TABLE IF NOT EXISTS whatsapp_inbox (
            id TEXT PRIMARY KEY,
            body TEXT NOT NULL,
            sent_at TEXT NOT NULL,
            received_at TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'new',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )"""
    )
    db.commit()
    return db


def collect_once(db: sqlite3.Connection, base_url: str, token: str) -> int:
    base_url = base_url.rstrip("/")
    if not base_url.startswith("https://"):
        raise ValueError("Ingress URL must use HTTPS")
    result = request_json(f"{base_url}/inbox", token)
    messages = result.get("messages")
    if not isinstance(messages, list):
        raise ValueError("Ingress response has no messages list")

    count = 0
    for message in messages:
        if not isinstance(message, dict):
            raise ValueError("Ingress returned an invalid message")
        message_id = message.get("id")
        body = message.get("body")
        if not isinstance(message_id, str) or not message_id.startswith("wamid."):
            raise ValueError("Ingress returned an invalid message ID")
        if not isinstance(body, str) or not body or len(body) > 10_000:
            raise ValueError("Ingress returned an invalid message body")

        with db:
            db.execute(
                """INSERT OR IGNORE INTO whatsapp_inbox
                   (id, body, sent_at, received_at) VALUES (?, ?, ?, ?)""",
                (message_id, body, str(message.get("sent_at") or ""), str(message.get("received_at") or "")),
            )
        # Only remove the staging copy after the local SQLite transaction commits.
        ack = request_json(f"{base_url}/inbox/ack", token, body={"id": message_id})
        if ack.get("ok") is not True:
            raise ValueError("Ingress did not acknowledge the stored message")
        count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description="Alfred WhatsApp receive-only collector")
    parser.add_argument("--once", action="store_true", help="Poll once and exit")
    parser.add_argument("--list", action="store_true", help="Show staged messages without their text")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    path = os.environ.get("ALFRED_WHATSAPP_DB", "/data/whatsapp-inbox.sqlite3")
    with closing(open_database(path)) as db:
        if args.list:
            for row in db.execute("SELECT id, state, created_at FROM whatsapp_inbox ORDER BY created_at DESC LIMIT 20"):
                print("\t".join(row))
            return

        url = os.environ.get("ALFRED_INGRESS_URL", "https://alfred-whatsapp-ingress.cpayneer.workers.dev")
        token_file = os.environ.get("ALFRED_COLLECTOR_TOKEN_FILE", "")
        token = Path(token_file).read_text(encoding="utf-8").strip() if token_file else os.environ.get("ALFRED_COLLECTOR_TOKEN", "")
        if len(token) < 32:
            raise SystemExit("ALFRED_COLLECTOR_TOKEN must be configured with at least 32 characters")
        interval = max(10, int(os.environ.get("ALFRED_POLL_SECONDS", "30")))
        while True:
            try:
                count = collect_once(db, url, token)
                if count:
                    LOG.info("Stored and acknowledged %d message(s)", count)
            except (urllib.error.URLError, TimeoutError, ValueError, sqlite3.Error) as error:
                # Never log request headers, response bodies or forwarded message text.
                LOG.warning("Collector poll failed (%s)", type(error).__name__)
                if args.once:
                    raise SystemExit(1) from None
            if args.once:
                return
            time.sleep(interval)


if __name__ == "__main__":
    main()
