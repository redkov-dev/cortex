-- Stores minimal task descriptions observed through valid search calls.
-- These records are private demand telemetry and are never returned as shared experience.
CREATE TABLE IF NOT EXISTS observed_task_signals (
  observation_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  goal TEXT NOT NULL CHECK (length(goal) BETWEEN 1 AND 1000),
  blocker TEXT CHECK (blocker IS NULL OR length(blocker) BETWEEN 1 AND 1000),
  tried TEXT CHECK (tried IS NULL OR length(tried) BETWEEN 1 AND 2000),
  self_reported_test INTEGER NOT NULL DEFAULT 0 CHECK (self_reported_test IN (0, 1))
);

CREATE INDEX IF NOT EXISTS observed_task_signals_recent
  ON observed_task_signals (self_reported_test, created_at DESC, observation_id DESC);
