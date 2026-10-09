// server/src/features/extension/index.ts — public surface of EXT (FND-5; owner WP-55a).

export * from './contract.js';
export { createExtensionPublicRouter, createExtensionRouter, requireExtensionDevice } from './routes.js';
export { EXTENSION_WORK_KINDS } from './workers.js';
