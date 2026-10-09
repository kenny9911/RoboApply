// server/src/features/uistate/routes.ts
//
// GET   /api/v1/roboapply/ui-state  → { state, lastFeedVisitAt, updatedAt }
// PATCH /api/v1/roboapply/ui-state  body UiStatePatch → same shape
//
// Seeker session required (requireAuth + requireSeekerProfile). Mounted by
// FND-5's mountFeatures at `/ui-state` (TASK_PLAN.md §4.1.a). No flag.

import { Router, type RequestHandler } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { parseBody, requireUserId, route } from '../../platform/http.js';
import { UiStatePatchSchema } from './contract.js';
import { UiStateService, uiStateService } from './service.js';

export interface UiStateRouterDeps {
  /** Auth chain (default: requireAuth + requireSeekerProfile). */
  auth?: readonly RequestHandler[];
  service?: UiStateService;
  now?: () => Date;
}

export function createUiStateRouter(deps: UiStateRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.auth ?? seekerAuth)];
  const service = deps.service ?? uiStateService;
  const now = deps.now ?? (() => new Date());

  router.get('/', ...auth, route(async (req) => service.get(requireUserId(req))));

  router.patch(
    '/',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const patch = parseBody(req, UiStatePatchSchema);
      return service.patch(userId, patch, now());
    }),
  );

  return router;
}

const uiStateRouter = createUiStateRouter();
export default uiStateRouter;
