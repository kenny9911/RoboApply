// backend/src/roboapply/v2/routes/index.ts
//
// RoboApply V2 router aggregate. Mounted at /api/v1/roboapply/v2 in
// server/src/app.ts. Wires the remaining legacy sub-routers into a single
// Express Router.
//
// WP-75 (ARCH §10.6 step 4) unmounted the dead V2 surfaces: /queue, /activity
// and /integrations (files deleted), /onboarding (replaced by the onboarding
// area, WP-30; deleted) and /jobs (replaced by the job-detail area, WP-34).
// `jobs.ts` stays on disk, unmounted, only because WP-77's
// `server/src/features/match/legacyRoute.test.ts` still imports it; it is
// deleted once that test drops its legacy-route block (see the WP-75 handoff).
//
// All sub-routers apply `requireAuth` at the top of their handlers so the
// gateway layer doesn't have to.

import { Router } from 'express';
import goalRouter from './goal.js';
import trackerRouter from './tracker.js';
import searchRouter from './search.js';
import resumesRouter from './resumes.js';
import insightsRouter from './insights.js';
import preferencesRouter from './preferences.js';
import mockRouter from './mock.js';
import discoverRouter from './discover.js';
import adminRouter from './admin.js';

const router = Router();

router.use('/goal', goalRouter);
router.use('/tracker', trackerRouter);
// @deprecated: still called by CommandPalette and /job-search (see search.ts).
router.use('/search', searchRouter);
router.use('/resumes', resumesRouter);
router.use('/insights', insightsRouter);
router.use('/preferences', preferencesRouter);
router.use('/mock', mockRouter);
// Cross-bank job-search agent team — searches RoboHire + GoHire banks.
router.use('/discover', discoverRouter);
// Admin analytics + profitability console (admin-gated inside the router).
router.use('/admin', adminRouter);

export default router;
