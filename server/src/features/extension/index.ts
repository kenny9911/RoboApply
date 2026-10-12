// server/src/features/extension/index.ts — public surface of EXT (owner WP-55a).
//
//   createExtensionRouter / createExtensionPublicRouter   mounted by features/index.ts
//   requireExtensionDevice                                 device auth (scoped to /ext/*)
//   classifyQuestion / PROTECTED_QUESTION_TYPES            which questions AI may draft
//   draftableLanguage                                      questions AI may draft (en/zh only)
//   EXTENSION_ATS_TYPES / extensionAtsTypesFor(market)     ATS types with an adapter
//   hasConnectedDevice(userId, brand)                      Ready to apply setup (WP-52)

export * from './contract.js';
export { createExtensionPublicRouter, createExtensionRouter, requireExtensionDevice, EXT_RATE_LIMITS } from './routes.js';
export type { ExtensionRouterDeps } from './routes.js';
export { createRequireExtensionDevice } from './auth.js';
export { createExtensionService, type ExtensionService, type ExtensionDeps } from './service.js';
export { classifyQuestion, draftableLanguage, findBankAnswer, isProtectedQuestionType } from './questionTypes.js';
export { compareVersions, isBelowMinVersion } from './tokens.js';
export { EXTENSION_ATS_TYPES, extensionAtsTypesFor } from './supported.js';
export { EXTENSION_WORK_KINDS } from './workers.js';

/**
 * True when the user has at least one paired, unrevoked extension device on
 * this brand. Read by Ready to apply's setup step (WP-52 `extensionConnected`
 * seam; added at the Wave 4 gate).
 */
export async function hasConnectedDevice(userId: string, brand: string): Promise<boolean> {
  const { default: prisma } = await import('../../lib/prisma.js');
  return (await prisma.rAExtensionDevice.count({ where: { userId, brand, revokedAt: null } })) > 0;
}
