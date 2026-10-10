// server/src/features/onboarding-cn/routes.ts — GoApply onboarding data routes (WP-31).
//
// NOT MOUNTED YET: features/index.ts is a hot file. Handoff request to INT
// (WP-93): mount `createOnboardingCnRouter()` at
// /api/v1/roboapply/onboarding/cn, and add the `lib/api` wrappers. Until
// then the web steps read the school and place lists from the bundled data
// files and the market panel through the onboarding wrapper.
//
//   GET /schools?q=&limit=        → CnSchoolSearchResponse (MOE lists, with source and as-of)
//   GET /provinces                → CnProvincesResponse (GB/T 2260)
//   GET /market-snapshot?roles=&taxonomyIds=&cities=&class=
//                                 → CnMarketSnapshotResponse (D3 counts; pay only at ≥20 rows)
//   GET /defaults                 → { graduationClass: { yingjie, zaixiao }, graduationMonth }
//
// Seeker session required. GoApply only: on RoboApply every route answers
// 404 feature_disabled (the screens do not exist there).

import { Router, type RequestHandler } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/index.js';
import { fail, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { CnMarketSnapshotQuerySchema, CnSchoolSearchQuerySchema } from './contract.js';
import { CN_DEFAULT_GRADUATION_MONTH, defaultGraduationClass } from './classYear.js';
import { provincesResponse, schoolSearchResponse } from './data.js';
import { cnMarketSnapshot, type SnapshotDb } from './marketSnapshot.js';

export interface OnboardingCnRouterDeps extends FeatureRouterDeps {
  db?: SnapshotDb;
  now?: () => Date;
}

/** GoApply only; RoboApply answers 404 feature_disabled. */
const goapplyOnly: RequestHandler = (_req, res, next) => {
  if (getCurrentBrandOrDefault().id !== 'goapply') {
    fail(res, 'feature_disabled', 'Not available here.');
    return;
  }
  next();
};

export function createOnboardingCnRouter(deps: OnboardingCnRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const now = deps.now ?? (() => new Date());
  const gate = goapplyOnly;

  router.get('/schools', ...auth, gate, route(async (req) => {
    const q = parseQuery(req, CnSchoolSearchQuerySchema);
    return schoolSearchResponse(q.q, q.limit);
  }));
  router.get('/provinces', ...auth, gate, route(async () => provincesResponse()));
  router.get('/market-snapshot', ...auth, gate, route(async (req) => {
    const q = parseQuery(req, CnMarketSnapshotQuerySchema);
    return cnMarketSnapshot(q, { db: deps.db, now: now() });
  }));
  router.get('/defaults', ...auth, gate, route(async () => {
    const at = now();
    return {
      graduationClass: { yingjie: defaultGraduationClass('yingjie', at), zaixiao: defaultGraduationClass('zaixiao', at) },
      graduationMonth: CN_DEFAULT_GRADUATION_MONTH,
    };
  }));
  return router;
}
