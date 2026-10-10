// backend/src/roboapply/v2/routes/index.ts
//
// RoboApply V2 router aggregate. Mounted at /api/v1/roboapply/v2 in
// server/src/app.ts. Wires the remaining legacy sub-routers into a single
// Express Router.
//
// Unmounted and deleted so far:
//   - WP-75 (ARCH §10.6 step 4): /queue, /activity, /integrations, and
//     /onboarding (replaced by the onboarding area, WP-30);
//   - INT-13 (wave5 WP-93 #44): /jobs (replaced by the job-detail area, WP-34,
//     and the match area's scoring, WP-18). The legacy score route sent the
//     unstripped resume to the model and had no daily cap;
//   - INT-13 (wave5 WP-93 #46): /search (replaced by POST /feed/query, WP-32)
//     together with RAJobIndexService.
// `index.unmounted.test.ts` keeps each of these paths answering 404.
//
// Still mounted on purpose: /discover (owner decision pending, wave5 WP-93
// #52) and /mock (owner + Track A decision pending).
//
// All sub-routers apply `requireAuth` at the top of their handlers so the
// gateway layer doesn't have to.

import { Router } from 'express';
import goalRouter from './goal.js';
import trackerRouter from './tracker.js';
import resumesRouter from './resumes.js';
import insightsRouter from './insights.js';
import preferencesRouter from './preferences.js';
import mockRouter from './mock.js';
import discoverRouter from './discover.js';
import adminRouter from './admin.js';

const router = Router();

router.use('/goal', goalRouter);
router.use('/tracker', trackerRouter);
router.use('/resumes', resumesRouter);
router.use('/insights', insightsRouter);
router.use('/preferences', preferencesRouter);
router.use('/mock', mockRouter);
// Cross-bank job-search agent team — searches RoboHire + GoHire banks.
router.use('/discover', discoverRouter);
// Admin analytics + profitability console (admin-gated inside the router).
router.use('/admin', adminRouter);

export default router;
