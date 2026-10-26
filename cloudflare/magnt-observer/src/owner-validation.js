import { z } from 'zod';
import { OwnerError } from './owner-errors.js';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const cursor = z.string().min(1).max(2000);
const conversation = id.refine(value => value.startsWith('oc_'));
const write = { conversation_id: conversation, expected_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1), submission_id: z.uuid() };
export const OWNER_SCHEMAS = {
  list_inbox: z.strictObject({ view: z.enum(['needs_attention', 'all', 'archived']).default('needs_attention'),
    source: z.enum(['all', 'contact', 'observation']).default('all'), include_tests: z.boolean().default(false),
    cursor: cursor.optional(), limit: z.number().int().min(1).max(50).default(20) }),
  read_conversation: z.strictObject({ reference: id, cursor: cursor.optional(), limit: z.number().int().min(1).max(50).default(20) }),
  write_reply: z.strictObject({ ...write, mode: z.enum(['draft', 'publish']),
    body: z.string().trim().min(1).max(8000).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u), reply_id: id.optional() }),
  update_inbox: z.strictObject({ ...write, action: z.enum(['acknowledge', 'archive', 'restore']), through_event_id: id.optional() }),
};
export function validateOwnerInput(tool, value) {
  const schema = OWNER_SCHEMAS[tool];
  const parsed = schema?.safeParse(value);
  if (!parsed?.success) {
    const fields = schema ? [...new Set(parsed.error.issues.map(issue =>
      Object.hasOwn(schema.shape, issue.path[0]) ? issue.path[0] : 'arguments'))].slice(0, 8) : ['arguments'];
    throw new OwnerError('invalid_arguments', { fields });
  }
  return parsed.data;
}
const version = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
const listCursor = z.strictObject({ kind: z.literal('inbox'), version: z.literal(1),
  view: z.enum(['needs_attention', 'all', 'archived']), source: z.enum(['all', 'contact', 'observation']), tests: z.boolean(),
  epoch: z.number().int().positive(), contacts: version, observations: version,
  before: z.strictObject({ time: z.iso.datetime(), id }) });
const conversationCursor = z.strictObject({ kind: z.literal('conversation'), version: z.literal(1),
  conversation_id: conversation, revision: z.number().int().positive(), after: z.number().int().nonnegative() });
export function encodeCursor(value) { return btoa(JSON.stringify({ ...value, version: 1 })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
export function decodeCursor(text, kind) {
  if (typeof text !== 'string' || text.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new OwnerError('invalid_cursor');
  try { return (kind === 'inbox' ? listCursor : conversationCursor).parse(JSON.parse(atob(text.replaceAll('-', '+').replaceAll('_', '/')))); }
  catch { throw new OwnerError('invalid_cursor'); }
}
