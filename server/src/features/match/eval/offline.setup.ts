// Vitest setup of the eval config: the specs are in-memory, so there is never a network (offline.ts).
import { installOfflineGuard, pinOfflineEnv } from './offline.js';

pinOfflineEnv();
installOfflineGuard();
