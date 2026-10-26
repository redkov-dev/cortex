CREATE TABLE IF NOT EXISTS owner_notification_outbox_next (
  notification_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('contact', 'admin_test', 'observed_goal')),
  source_id TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT 'owner' CHECK (destination = 'owner'),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  telegram_message_id INTEGER,
  sent_at TEXT,
  last_error_code TEXT,
  UNIQUE (source_type, source_id, destination)
);

INSERT OR REPLACE INTO owner_notification_outbox_next
SELECT * FROM owner_notification_outbox;

DROP TABLE owner_notification_outbox;
ALTER TABLE owner_notification_outbox_next RENAME TO owner_notification_outbox;

CREATE INDEX IF NOT EXISTS owner_notifications_due
  ON owner_notification_outbox (status, next_attempt_at, created_at, notification_id);
