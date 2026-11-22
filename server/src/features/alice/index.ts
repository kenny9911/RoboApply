// server/src/features/alice/index.ts — public surface of Alice, the application agent
// (docs/alice/ALICE.md). Other areas import from here only.

export * from './contract.js';
export { createAliceRouter, type AliceRouterOptions } from './routes.js';
export { createAliceService, getAliceService, breaksD1, numbersAreFacts, type AliceContext, type AliceService, type TurnContext } from './service.js';
export { createMemoryAliceStore, createPrismaAliceStore, isMissingAliceTable, type AliceStore } from './store.js';
export { createAliceAgents, type AliceAgents } from './agents.js';
export type { AliceDeps } from './deps.js';
export { ALICE_SKILLS } from './skills/index.js';
