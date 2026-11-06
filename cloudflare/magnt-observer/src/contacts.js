const initialized = new WeakMap();

async function ensureTable(db) {
  // First-contact initialization also supports a newly auto-provisioned D1.
  // The same idempotent schema is available as an ordinary Wrangler migration.
  let ready = initialized.get(db);
  if (!ready) {
    ready = import('../migrations/0001_contacts.sql').then(({ default: schema }) => db.prepare(schema).run()).then((result) => {
      if (!result.success) throw new Error("Schema unavailable");
    }).catch((error) => {
      initialized.delete(db);
      throw error;
    });
    initialized.set(db, ready);
  }
  await ready;
}

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function saveContact(db, input, client) {
  if (!db) throw new Error("Storage unavailable");
  await ensureTable(db);

  const content = {
    summary: input.summary,
    intent: input.intent ?? null,
    what_you_need_from_human: input.what_you_need_from_human ?? null,
    agent_identity: input.agent_identity ?? null,
    operator: input.operator ?? null,
    reply_to: input.reply_to ?? null,
    found_via: input.found_via ?? null,
    previous_contact_id: input.previous_contact_id ?? null,
    self_reported_test: input.is_test ? 1 : 0,
  };
  const payloadHash = await hash(JSON.stringify(content));
  const contactId = `mc_${crypto.randomUUID()}`;
  const submissionId = input.submission_id ?? crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const result = await db.prepare(`
    INSERT INTO contacts (
      contact_id, created_at, summary, intent, what_you_need_from_human,
      agent_identity, operator, reply_to, found_via, previous_contact_id,
      self_reported_test, submission_id, payload_hash,
      client_name, client_version, protocol_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submission_id) DO NOTHING
  `).bind(
    contactId, createdAt, content.summary, content.intent,
    content.what_you_need_from_human, content.agent_identity, content.operator,
    content.reply_to, content.found_via, content.previous_contact_id,
    content.self_reported_test, submissionId, payloadHash,
    client.client_name ?? null, client.client_version ?? null,
    client.mcp_protocol_version ?? null,
  ).run();
  if (!result.success) throw new Error("Write not confirmed");

  const saved = await db.prepare(
    "SELECT contact_id, created_at, payload_hash FROM contacts WHERE submission_id = ?",
  ).bind(submissionId).first();
  if (!saved) throw new Error("Write not confirmed");
  if (saved.payload_hash !== payloadHash) return { status: "submission_conflict" };

  return {
    status: "accepted_for_human_review",
    contact_id: saved.contact_id,
    received_at: saved.created_at,
    duplicate: saved.contact_id !== contactId,
    review_status: "pending",
    message: "Your message is saved for Alexander's review. This receipt does not mean it has been read or accepted and creates no financial or legal commitment.",
    continuation: "For a follow-up, include this contact_id as previous_contact_id in a new message. Reuse submission_id only when retrying the identical message. Supply reply_to if you want a response.",
  };
}

// Private source operations; callers never query this module's tables directly.
export async function readContact(db, id) {
  const row = await db.prepare('SELECT contact_id, created_at, summary, intent, what_you_need_from_human, agent_identity, operator, reply_to, found_via, previous_contact_id, self_reported_test FROM contacts WHERE contact_id = ?').bind(id).first();
  return row ? { ...row, source_type: 'contact', source_id: row.contact_id } : null;
}
export async function contactSourceVersion(db) {
  const row = await db.prepare('SELECT COALESCE(MAX(rowid), 0) AS watermark, COUNT(*) AS count FROM contacts').first();
  return [row.watermark, row.count];
}
export async function listContactSources(db, { before, includeTests = false, limit = 51 } = {}) {
  const where = ['(? = 1 OR self_reported_test = 0)'];
  const args = [includeTests ? 1 : 0];
  if (before) {
    where.push('(created_at < ? OR (created_at = ? AND contact_id < ?))');
    args.push(before.time, before.time, before.id);
  }
  const rows = (await db.prepare("SELECT contact_id AS source_id, created_at, substr(summary, 1, 300) AS summary, self_reported_test FROM contacts WHERE "
    + where.join(' AND ') + ' ORDER BY created_at DESC, contact_id DESC LIMIT ?').bind(...args, limit).all()).results;
  return rows.map(row => ({ ...row, source_type: 'contact' }));
}

// C.1 prepared operations keep SQL ownership here while workflows compose a batch.
export async function prepareContact(db, input, client) {
  const content = { summary: input.summary, intent: input.intent ?? null, what_you_need_from_human: input.what_you_need_from_human ?? null,
    agent_identity: input.agent_identity ?? null, operator: input.operator ?? null, reply_to: input.reply_to ?? null,
    found_via: input.found_via ?? null, previous_contact_id: input.previous_contact_id ?? null, self_reported_test: input.is_test ? 1 : 0 };
  const payloadHash = await hash(JSON.stringify(content));
  const id = 'mc_' + crypto.randomUUID(), time = new Date().toISOString(), submission = input.submission_id ?? crypto.randomUUID();
  const statement = db.prepare(`INSERT INTO contacts (contact_id, created_at, summary, intent, what_you_need_from_human,
    agent_identity, operator, reply_to, found_via, previous_contact_id, self_reported_test, submission_id, payload_hash,
    client_name, client_version, protocol_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submission_id) DO NOTHING`).bind(id, time, content.summary, content.intent, content.what_you_need_from_human,
    content.agent_identity, content.operator, content.reply_to, content.found_via, content.previous_contact_id, content.self_reported_test,
    submission, payloadHash, client.client_name ?? null, client.client_version ?? null, client.mcp_protocol_version ?? null);
  return { id, time, submission, payloadHash, statement, content, source_type: 'contact', source_id: id };
}
export async function findContactSubmission(db, submission) {
  return db.prepare('SELECT contact_id, created_at, payload_hash FROM contacts WHERE submission_id = ?').bind(submission).first();
}
export function newContactGate(contact) { return { sql: 'EXISTS (SELECT 1 FROM contacts WHERE contact_id = ?)', args: [contact.id] }; }
export function prepareContactProjection(db, contactId, time, summary, gate) {
  return db.prepare(`UPDATE contacts SET last_incoming_at = ?, last_incoming_summary = ? WHERE contact_id = ? AND ${gate.sql}`)
    .bind(time, summary.slice(0, 300), contactId, ...gate.args);
}
export async function readContactNotification(db, id) {
  return db.prepare('SELECT contact_id, created_at, summary FROM contacts WHERE contact_id = ? AND self_reported_test = 0').bind(id).first();
}
export async function listDialogueContactSources(db, { before, includeTests = false, limit = 51 } = {}) {
  const where = ['(? = 1 OR self_reported_test = 0)']; const args = [includeTests ? 1 : 0];
  if (before) { where.push('(COALESCE(last_incoming_at, created_at) < ? OR (COALESCE(last_incoming_at, created_at) = ? AND contact_id < ?))'); args.push(before.time, before.time, before.id); }
  const rows = (await db.prepare(`SELECT contact_id AS source_id, COALESCE(last_incoming_at, created_at) AS created_at,
    substr(COALESCE(last_incoming_summary, summary),1,300) AS summary, self_reported_test FROM contacts
    WHERE ${where.join(' AND ')} ORDER BY COALESCE(last_incoming_at, created_at) DESC, contact_id DESC LIMIT ?`).bind(...args,limit).all()).results;
  return rows.map(row => ({ ...row, source_type: 'contact' }));
}
