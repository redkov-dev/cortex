// Queue writes are prepared here; an application workflow may commit them with
// the corresponding domain write in one D1 batch.
export function prepareGoalNotification(db, { observationId, createdAt }) {
  return db.prepare(`INSERT INTO owner_notification_outbox
    (notification_id, source_type, source_id, destination, created_at)
    VALUES (?, 'observed_goal', ?, 'owner', ?)
    ON CONFLICT(source_type, source_id, destination) DO NOTHING`)
    .bind(`mn_${crypto.randomUUID()}`, observationId, createdAt);
}
