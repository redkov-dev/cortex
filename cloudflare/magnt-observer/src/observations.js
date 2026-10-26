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

// Private source operations; callers never query this module's tables directly.
export async function readObservation(db, id) {
  const row = await db.prepare('SELECT observation_id, created_at, goal, blocker, tried, self_reported_test FROM observed_task_signals WHERE observation_id = ?').bind(id).first();
  return row ? { ...row, source_type: 'observation', source_id: row.observation_id } : null;
}
export async function observationSourceVersion(db) {
  const row = await db.prepare('SELECT COALESCE(MAX(rowid), 0) AS watermark, COUNT(*) AS count FROM observed_task_signals').first();
  return [row.watermark, row.count];
}
export async function listObservationSources(db, { before, includeTests = false, limit = 51 } = {}) {
  const where = ['(? = 1 OR self_reported_test = 0)'];
  const args = [includeTests ? 1 : 0];
  if (before) {
    where.push('(created_at < ? OR (created_at = ? AND observation_id < ?))');
    args.push(before.time, before.time, before.id);
  }
  const rows = (await db.prepare("SELECT observation_id AS source_id, created_at, substr(goal, 1, 300) AS summary, self_reported_test FROM observed_task_signals WHERE "
    + where.join(' AND ') + ' ORDER BY created_at DESC, observation_id DESC LIMIT ?').bind(...args, limit).all()).results;
  return rows.map(row => ({ ...row, source_type: 'observation' }));
}
