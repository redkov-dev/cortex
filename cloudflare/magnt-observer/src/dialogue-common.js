import { z } from 'zod';
import { OwnerError } from './owner-errors.js';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const token = z.string().regex(/^mdt_[A-Za-z0-9_-]{43}$/).describe('Secret bearer token returned once on creation. Keep private; never place in URLs, shared memory or logs.');
export const DIALOGUE_SCHEMAS = {
  get_dialogue: z.strictObject({ dialogue_token: token, cursor: z.string().max(2000).optional(), sent_message_id: id.optional() }),
  send_dialogue_message: z.strictObject({ dialogue_token: token, body: z.string().trim().min(1).max(4000)
    .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u), submission_id: z.uuid(), in_reply_to_message_id: id.optional() }),
};
export const dialogueEnabled = env => env.DIALOGUE_READ_ENABLED === 'true';
export const dialogueWritable = env => dialogueEnabled(env) && env.DIALOGUE_WRITE_ENABLED === 'true';
export const dialogueCreateEnabled = env => dialogueWritable(env) && env.DIALOGUE_CREATE_ENABLED === 'true';
export const combineGates = (...gates) => ({ sql: gates.map(g => '(' + g.sql + ')').join(' AND '), args: gates.flatMap(g => g.args) });
export function validateDialogueInput(name, raw) {
  const schema = DIALOGUE_SCHEMAS[name];
  const parsed = schema?.safeParse(raw);
  if (!parsed?.success) throw new OwnerError('invalid_arguments', { fields: schema
    ? [...new Set(parsed.error.issues.map(i => Object.hasOwn(schema.shape, i.path[0]) ? i.path[0] : 'arguments'))].slice(0, 8) : ['arguments'] });
  return parsed.data;
}
export const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export function randomSecret() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
export function checkResponseSize(value) {
  if (2 * new TextEncoder().encode(JSON.stringify(JSON.stringify(value))).byteLength > 59 * 1024) throw new OwnerError('message_too_large');
}
export function pollAdvice(lastIncoming, nextActor, hasMore = false) {
  if (hasMore) return { next_poll_at: new Date().toISOString(), retry_after_seconds: 0 };
  if (nextActor !== 'alexander') return { next_poll_at: null, retry_after_seconds: null };
  const age = Date.now() - Date.parse(lastIncoming);
  const seconds = age >= 7 * 86400_000 ? 86400 : age >= 86400_000 ? 21600 : 3600;
  return { next_poll_at: new Date(Date.now() + seconds * 1000).toISOString(), retry_after_seconds: seconds };
}
export async function limitDialogue(env, key, writing = false) {
  const limiter = env[writing ? 'DIALOGUE_WRITE_LIMIT' : 'DIALOGUE_READ_LIMIT'];
  if (!limiter?.limit) throw new OwnerError('storage_unavailable');
  if (!(await limiter.limit({ key })).success) throw new OwnerError('rate_limited', { retry_after_seconds: 60 });
}
async function signingKey(access) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(access.cursor_key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signDialogueCursor(access, after) {
  const body = base64url(new TextEncoder().encode(JSON.stringify({ access: access.access_id, dialogue: access.dialogue_id, after })));
  const sig = await crypto.subtle.sign('HMAC', await signingKey(access), new TextEncoder().encode(body));
  return body + '.' + base64url(new Uint8Array(sig));
}
export async function readDialogueCursor(access, text) {
  if (!text) return 0;
  try {
    const [body, sig, extra] = text.split('.');
    if (extra || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) throw 0;
    const decode = s => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    if (!await crypto.subtle.verify('HMAC', await signingKey(access), decode(sig), new TextEncoder().encode(body))) throw 0;
    const value = JSON.parse(new TextDecoder().decode(decode(body)));
    if (value.access !== access.access_id || value.dialogue !== access.dialogue_id || !Number.isSafeInteger(value.after) || value.after < 0) throw 0;
    return value.after;
  } catch { throw new OwnerError('invalid_cursor'); }
}
