-- C.1: additive contact projection and message reads; preserve all old sources.
ALTER TABLE contacts ADD COLUMN last_incoming_at TEXT;
ALTER TABLE contacts ADD COLUMN last_incoming_summary TEXT;
CREATE INDEX contacts_latest_incoming ON contacts (COALESCE(last_incoming_at, created_at) DESC, contact_id DESC);
ALTER TABLE owner_inbox ADD COLUMN latest_incoming_sequence INTEGER NOT NULL DEFAULT 1;
ALTER TABLE owner_inbox ADD COLUMN acknowledged_sequence INTEGER NOT NULL DEFAULT 0;
UPDATE owner_inbox SET acknowledged_sequence = acknowledged_through;

CREATE TABLE owner_replies_c1 (
  reply_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES owner_inbox(conversation_id),
  sequence INTEGER NOT NULL CHECK (sequence >= 2),
  body TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_event_id TEXT,
  CHECK ((status = 'draft' AND body IS NOT NULL AND length(body) BETWEEN 1 AND 8000 AND published_event_id IS NULL)
      OR (status = 'published' AND body IS NULL AND published_event_id IS NOT NULL)),
  UNIQUE (conversation_id, sequence)
);
INSERT INTO owner_replies_c1 (reply_id, conversation_id, sequence, body, status, created_at, updated_at)
SELECT reply_id, conversation_id, sequence, body, status, created_at, updated_at FROM owner_replies;
DROP TABLE owner_replies;
ALTER TABLE owner_replies_c1 RENAME TO owner_replies;

CREATE TABLE owner_operations_c1 (
  operation_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('write_reply', 'update_inbox', 'manage_dialogue_access')),
  conversation_id TEXT NOT NULL REFERENCES owner_inbox(conversation_id),
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (actor, submission_id)
);
INSERT INTO owner_operations_c1 SELECT * FROM owner_operations;
DROP TABLE owner_operations;
ALTER TABLE owner_operations_c1 RENAME TO owner_operations;
CREATE INDEX owner_operations_conversation ON owner_operations (conversation_id, created_at, operation_id);

CREATE TABLE dialogues (
  dialogue_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL UNIQUE REFERENCES contacts(contact_id),
  conversation_id TEXT NOT NULL UNIQUE REFERENCES owner_inbox(conversation_id),
  status TEXT NOT NULL DEFAULT 'awaiting_alexander' CHECK (status IN ('awaiting_alexander', 'awaiting_visitor')),
  created_at TEXT NOT NULL,
  last_incoming_at TEXT NOT NULL,
  latest_incoming_id TEXT NOT NULL,
  self_reported_test INTEGER NOT NULL CHECK (self_reported_test IN (0,1))
);
CREATE TABLE dialogue_events (
  message_id TEXT PRIMARY KEY,
  dialogue_id TEXT NOT NULL REFERENCES dialogues(dialogue_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  author TEXT NOT NULL CHECK (author IN ('visitor', 'alexander')),
  body TEXT,
  source_contact_id TEXT REFERENCES contacts(contact_id),
  in_reply_to_message_id TEXT,
  created_at TEXT NOT NULL,
  CHECK ((body IS NOT NULL AND source_contact_id IS NULL) OR (body IS NULL AND source_contact_id IS NOT NULL)),
  UNIQUE (dialogue_id, sequence)
);
CREATE INDEX dialogue_events_direction ON dialogue_events (dialogue_id, author, sequence);
CREATE TABLE dialogue_access (
  access_id TEXT PRIMARY KEY,
  dialogue_id TEXT NOT NULL REFERENCES dialogues(dialogue_id),
  token_hash TEXT NOT NULL UNIQUE,
  cursor_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX dialogue_active_access ON dialogue_access (dialogue_id) WHERE revoked_at IS NULL;
CREATE TABLE dialogue_operations (
  operation_id TEXT PRIMARY KEY,
  dialogue_id TEXT NOT NULL REFERENCES dialogues(dialogue_id),
  access_id TEXT NOT NULL REFERENCES dialogue_access(access_id),
  submission_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (access_id, submission_id)
);
CREATE TABLE message_read_receipts (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reader_side TEXT NOT NULL CHECK (reader_side IN ('owner', 'visitor')),
  read_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id, reader_side)
);

CREATE TABLE owner_notification_outbox_c1 (
  notification_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('contact', 'admin_test', 'observed_goal', 'dialogue_message')),
  source_id TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT 'owner' CHECK (destination = 'owner'),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  telegram_message_id INTEGER,
  sent_at TEXT,
  last_error_code TEXT,
  UNIQUE (source_type, source_id, destination)
);
INSERT INTO owner_notification_outbox_c1 SELECT * FROM owner_notification_outbox;
DROP TABLE owner_notification_outbox;
ALTER TABLE owner_notification_outbox_c1 RENAME TO owner_notification_outbox;
CREATE INDEX owner_notifications_due ON owner_notification_outbox (status, next_attempt_at, created_at, notification_id);
