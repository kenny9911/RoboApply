// server/src/features/extension/index.ts — public surface of EXT (owner WP-55a).
//
//   createExtensionRouter / createExtensionPublicRouter   mounted by features/index.ts
//   requireExtensionDevice                                 device auth (scoped to /ext/*)
//   classifyQuestion / PROTECTED_QUESTION_TYPES            which questions AI may draft
//   draftableLanguage                                      questions AI may draft (en/zh only)
//   EXTENSION_ATS_TYPES / extensionAtsTypesFor(market)     ATS types with an adapter

export * from './contract.js';
export { createExtensionPublicRouter, createExtensionRouter, requireExtensionDevice, EXT_RATE_LIMITS } from './routes.js';
export type { ExtensionRouterDeps } from './routes.js';
export { createRequireExtensionDevice } from './auth.js';
export { createExtensionService, type ExtensionService, type ExtensionDeps } from './service.js';
export { classifyQuestion, draftableLanguage, findBankAnswer, isProtectedQuestionType } from './questionTypes.js';
export { compareVersions, isBelowMinVersion } from './tokens.js';
export { EXTENSION_ATS_TYPES, extensionAtsTypesFor } from './supported.js';
export { EXTENSION_WORK_KINDS } from './workers.js';
