// Final public deployment has no domain SQL, OAuth or Telegram adapter.
import { createObserver } from './observer.js';
import { callPublicCore } from './public-core-client.js';
export default createObserver(callPublicCore);
