export const SHARED_MEMORY_VERSION = "0.2.0";
export const CANDIDATE_LIMIT = 100;
export const MATCH_LIMIT = 3;
export const MIN_SCORE = 0.15;

const STOP_WORDS = new Set((
  "the and for with from this that these those into onto have has had are was were " +
  "will would should could can not but its our your their they them you about " +
  "how what when where which who why trying try need want task goal please " +
  "как что это эта эти тот для при под над или уже еще мне нам вас вам мой " +
  "моя мое мои наш наша наши ваш ваша ваши его она они быть был была было " +
  "будет чтобы нужно надо хочу задача задачи цель получить сделать"
).split(/\s+/));
const SHORT_TERMS = new Set(["ai", "db", "d1", "s3", "ui", "ux", "ml"]);

export function tokens(text) {
  const words = text.normalize("NFKC").toLowerCase().replaceAll("ё", "е").match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((word) => (word.length >= 3 || SHORT_TERMS.has(word)) && !STOP_WORDS.has(word)));
}

const matchingText = ({ goal, blocker, tried }) => [goal, blocker, tried].filter(Boolean).join(" ");

// Input rows are already ordered newest first, with signal_id as a stable tie-break.
// No stemming, translation, embeddings, or claim of semantic relevance.
export function rankSignals(input, rows) {
  const query = tokens(matchingText(input));
  if (!query.size) return [];
  return rows.map((row, order) => {
    const candidate = tokens(matchingText(row));
    const overlap = [...query].filter((token) => candidate.has(token)).length;
    const score = overlap / (query.size + candidate.size - overlap);
    return { row, order, overlap, score };
  }).filter(({ overlap, score }) => overlap >= Math.min(2, query.size) && score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MATCH_LIMIT)
    .map(({ row }) => ({
      signal_id: row.signal_id,
      goal: row.goal,
      blocker: row.blocker ?? null,
      tried: row.tried ?? null,
      learned: row.learned ?? null,
    }));
}

export async function searchSignals(db, input) {
  if (!db) throw new Error("Storage unavailable");
  // Query text is used only for in-memory matching. The search function itself
  // remains read-only; observed task storage is a separate operation.
  const result = await db.prepare(`
    SELECT signal_id, goal, blocker, tried, learned
    FROM task_signals
    WHERE status = 'active' AND self_reported_test = ?
    ORDER BY created_at DESC, signal_id DESC
    LIMIT ?
  `).bind(input.is_test === true ? 1 : 0, CANDIDATE_LIMIT).all();
  if (!result.success) throw new Error("Read not confirmed");
  return result.results.length ? rankSignals(input, result.results) : [];
}

async function hashContent(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function saveSignal(db, input) {
  if (!db) throw new Error("Storage unavailable");
  const content = {
    goal: input.goal,
    blocker: input.blocker ?? null,
    tried: input.tried ?? null,
    learned: input.learned ?? null,
    self_reported_test: input.is_test === true ? 1 : 0,
  };
  const payloadHash = await hashContent(content);
  const signalId = `ts_${crypto.randomUUID()}`;
  const submissionId = input.submission_id ?? crypto.randomUUID();
  const result = await db.prepare(`
    INSERT INTO task_signals (
      signal_id, created_at, goal, blocker, tried, learned,
      submission_id, payload_hash, self_reported_test
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submission_id) DO NOTHING
  `).bind(signalId, new Date().toISOString(), content.goal, content.blocker,
    content.tried, content.learned, submissionId, payloadHash, content.self_reported_test).run();
  if (!result.success) throw new Error("Write not confirmed");
  const saved = await db.prepare(
    "SELECT signal_id, payload_hash FROM task_signals WHERE submission_id = ?",
  ).bind(submissionId).first();
  if (!saved) throw new Error("Write not confirmed");
  if (saved.payload_hash !== payloadHash) return { status: "submission_conflict" };
  return { status: saved.signal_id === signalId ? "accepted" : "duplicate", signal_id: saved.signal_id };
}
