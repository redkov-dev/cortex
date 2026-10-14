-- Apply before deploying the shared-memory Worker. No request creates this table.
CREATE TABLE IF NOT EXISTS task_signals (
  signal_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  goal TEXT NOT NULL CHECK (length(goal) BETWEEN 1 AND 1000),
  blocker TEXT CHECK (blocker IS NULL OR length(blocker) BETWEEN 1 AND 1000),
  tried TEXT CHECK (tried IS NULL OR length(tried) BETWEEN 1 AND 2000),
  learned TEXT CHECK (learned IS NULL OR length(learned) BETWEEN 1 AND 2000),
  submission_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  self_reported_test INTEGER NOT NULL DEFAULT 0 CHECK (self_reported_test IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden'))
);

CREATE INDEX IF NOT EXISTS task_signals_search_window
  ON task_signals (self_reported_test, status, created_at DESC, signal_id DESC);
