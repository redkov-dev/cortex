-- Private owner delivery state. Apply explicitly; public requests never depend on it.
CREATE TABLE IF NOT EXISTS owner_notification_state (
  destination TEXT PRIMARY KEY CHECK (destination = 'owner'),
  notify_from TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_send_at INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_outcome TEXT,
  last_error_code TEXT
);

CREATE TABLE IF NOT EXISTS owner_notification_outbox (
  notification_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('contact', 'admin_test')),
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

CREATE INDEX IF NOT EXISTS contacts_owner_notifications
  ON contacts (self_reported_test, created_at, contact_id);
CREATE INDEX IF NOT EXISTS owner_notifications_due
  ON owner_notification_outbox (status, next_attempt_at, created_at, notification_id);
