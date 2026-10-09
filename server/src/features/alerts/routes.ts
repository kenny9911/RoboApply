// server/src/features/alerts/routes.ts — (FND-5). Owner: WP-39a.
//
// Alerts have no HTTP routes of their own (see contract.ts): settings are on
// /search-profiles (WP-20) and /notifications/preferences (WP-39b). This
// factory exists so WP-39a can add an alerts endpoint later without a new
// file; features/index.ts does not mount it while it is empty.

import { Router } from 'express';
import type { FeatureRouterDeps } from '../index.js';

export function createAlertsRouter(_deps: FeatureRouterDeps = {}): Router {
  return Router();
}
