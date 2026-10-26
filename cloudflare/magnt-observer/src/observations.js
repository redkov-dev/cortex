// Private demand observations own their SQL and expose operations to workflows.
export function prepareObservedSignal(db, input) {
  if (!db) throw new Error('Storage unavailable');
  const observationId = `ots_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const statement = db.prepare(`
    INSERT INTO observed_task_signals (
      observation_id, created_at, goal, blocker, tried, self_reported_test
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(observationId, createdAt, input.goal, input.blocker ?? null,
    input.tried ?? null, input.is_test === true ? 1 : 0);
  return { observationId, createdAt, statement };
}

export async function readObservedGoal(db, observationId) {
  return db.prepare(`SELECT observation_id, created_at, goal FROM observed_task_signals
    WHERE observation_id = ? AND self_reported_test = 0`).bind(observationId).first();
}
