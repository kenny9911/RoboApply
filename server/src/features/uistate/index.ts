// server/src/features/uistate/index.ts — public surface of the UI-state area.
// Mount path: /api/v1/roboapply/ui-state (FND-5 mountFeatures).

export { default as uiStateRouter, createUiStateRouter } from './routes.js';
export type { UiStateRouterDeps } from './routes.js';
export { UiStateService, applyUiStatePatch, normalizeUiState, uiStateService } from './service.js';
export {
  EMPTY_UI_STATE,
  UI_KEY_RE,
  UI_STATE_LIMITS,
  UiStatePatchSchema,
  UiStateSchema,
} from './contract.js';
export type { Dismissal, UiState, UiStatePatch, UiStateResponse, UiValue } from './contract.js';
