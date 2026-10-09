// server/src/features/tools/routes.ts — STUB (FND-5). Owner: WP-57.
// Mounted by features/index.ts at /api/v1/public/tools (public; multipart
// bodies are parsed by WP-57's upload middleware, so the stubs read nothing).

import { Router } from 'express';
import { NotImplementedError, markStub, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';

export function createToolsPublicRouter(_deps: FeatureRouterDeps = {}): Router {
  const router = Router();

  router.post(
    '/resume-check',
    markStub(
      route(async () => {
        throw new NotImplementedError('tools.resumeCheck');
      }),
    ),
  );
  router.post(
    '/resume-job-match',
    markStub(
      route(async () => {
        throw new NotImplementedError('tools.resumeJobMatch');
      }),
    ),
  );

  return router;
}
