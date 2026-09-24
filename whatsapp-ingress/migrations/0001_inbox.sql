CREATE TABLE IF NOT EXISTS whatsapp_inbox (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
