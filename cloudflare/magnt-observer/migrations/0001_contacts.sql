CREATE TABLE IF NOT EXISTS contacts (
  contact_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT NOT NULL,
  intent TEXT,
  what_you_need_from_human TEXT,
  agent_identity TEXT,
  operator TEXT,
  reply_to TEXT,
  found_via TEXT,
  previous_contact_id TEXT,
  self_reported_test INTEGER NOT NULL DEFAULT 0,
  submission_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  client_name TEXT,
  client_version TEXT,
  protocol_version TEXT
);
