// Runs in the user's Cloudflare Build environment, never queries an account.
import { readFile, writeFile } from 'node:fs/promises';

const d1 = process.env.MAGNT_D1_DATABASE_ID;
const kv = process.env.MAGNT_OAUTH_KV_ID;
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(d1 ?? '') || !/^[0-9a-f]{32}$/i.test(kv ?? '')) {
  throw new Error('Set MAGNT_D1_DATABASE_ID to the EXISTING magnt-contacts ID and MAGNT_OAUTH_KV_ID to the owner KV ID in Build variables. No resources were created.');
}
const template = JSON.parse(await readFile('wrangler.core.jsonc', 'utf8'));
template.d1_databases[0].database_id = d1;
template.kv_namespaces[0].id = kv;
await writeFile('wrangler.core.generated.json', JSON.stringify(template, null, 2) + '\n', { mode: 0o600 });
console.log('Prepared core deployment with explicit existing storage bindings.');
