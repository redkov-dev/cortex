import schema from "../migrations/0001_contacts.sql";

const initialized = new WeakMap();

async function ensureTable(db) {
  // First-contact initialization also supports a newly auto-provisioned D1.
  // The same idempotent schema is available as an ordinary Wrangler migration.
  let ready = initialized.get(db);
  if (!ready) {
    ready = db.prepare(schema).run().then((result) => {
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
