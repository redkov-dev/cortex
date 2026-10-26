import { prepareObservedSignal } from './observations.js';
import { prepareGoalNotification } from './notification-queue.js';

// This workflow composes module operations without owning either table's SQL.
// Public search stays independent of this best-effort observation transaction.
export async function saveObservedSignal(db, input, { notifyOwner = false } = {}) {
  const observation = prepareObservedSignal(db, input);
  const statements = [observation.statement];
  if (notifyOwner && input.is_test !== true) statements.push(prepareGoalNotification(db, observation));
  const results = await db.batch(statements);
  if (results.some((result) => !result.success)) throw new Error('Write not confirmed');
  return { observation_id: observation.observationId };
}
