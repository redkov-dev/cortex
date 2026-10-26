CREATE TABLE IF NOT EXISTS owner_workspace_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
INSERT INTO owner_workspace_state (singleton) VALUES (1)
ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS owner_inbox (
  conversation_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('contact', 'observation')),
  source_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_sequence INTEGER NOT NULL DEFAULT 1 CHECK (last_sequence >= 1),
  acknowledged_through INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_through BETWEEN 0 AND 1),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  UNIQUE (source_type, source_id)
);

CREATE TABLE IF NOT EXISTS owner_replies (
  reply_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES owner_inbox(conversation_id),
  sequence INTEGER NOT NULL CHECK (sequence >= 2),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence)
);

CREATE TABLE IF NOT EXISTS owner_operations (
  operation_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('write_reply', 'update_inbox')),
  conversation_id TEXT NOT NULL REFERENCES owner_inbox(conversation_id),
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (actor, submission_id)
);
CREATE INDEX IF NOT EXISTS owner_operations_conversation
  ON owner_operations (conversation_id, created_at, operation_id);
