// backend/src/roboapply/v2/routes/index.ts
//
// RoboApply V2 router aggregate. Mounted at /api/v1/roboapply/v2 in
// backend/src/index.ts. Wires the sub-routers (goal, tracker, search, jobs,
// resumes, insights, preferences, queue, activity) into a single Express
// Router.
//
// All sub-routers apply `requireAuth` at the top of their handlers so the
// gateway layer doesn't have to.

import { Router } from 'express';
import goalRouter from './goal.js';
import trackerRouter from './tracker.js';
import searchRouter from './search.js';
import jobsRouter from './jobs.js';
import resumesRouter from './resumes.js';
import insightsRouter from './insights.js';
import preferencesRouter from './preferences.js';
import queueRouter from './queue.js';
import activityRouter from './activity.js';
import integrationsRouter from './integrations.js';
import mockRouter from './mock.js';
import onboardingRouter from './onboarding.js';
import adminRouter from './admin.js';

const router = Router();

router.use('/goal', goalRouter);
router.use('/tracker', trackerRouter);
router.use('/search', searchRouter);
router.use('/jobs', jobsRouter);
router.use('/resumes', resumesRouter);
router.use('/insights', insightsRouter);
router.use('/preferences', preferencesRouter);
router.use('/queue', queueRouter);
router.use('/activity', activityRouter);
router.use('/integrations', integrationsRouter);
router.use('/mock', mockRouter);
router.use('/onboarding', onboardingRouter);
// Admin analytics + profitability console (admin-gated inside the router).
router.use('/admin', adminRouter);

export default router;
