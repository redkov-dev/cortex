// Transitional deployment: keeps existing public service alive until manual cutover.
import { createObserver } from './observer.js';
import { handleMcp } from './mcp.js';
import { callPublicCore } from './public-core-client.js';
import { processOwnerNotifications } from './owner-notifications.js';
export default createObserver(
  (request, env, ctx, event) => env.MAGNT_CORE_ENABLED === 'true'
    ? callPublicCore(request, env) : handleMcp(request, env, ctx, event),
  env => env.MAGNT_CORE_ENABLED === 'true' ? undefined : processOwnerNotifications(env),
);
