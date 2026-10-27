// Offline test bundle: no Wrangler, account credentials, telemetry or remote APIs.
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';

await rm('dist-local', { recursive: true, force: true });
await mkdir('dist-local', { recursive: true });
await build({ entryPoints: { index: 'src/index.js', core: 'src/core.js', 'owner-gateway': 'src/owner-gateway.js', 'public-gateway': 'src/public-gateway.js', 'test-core': 'test/support/core-fixture-worker.js' }, outdir: 'dist-local',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'],
  loader: { '.sql': 'text' }, logLevel: 'warning',
});
console.log('Local Worker bundle ready. No Cloudflare API calls.');
