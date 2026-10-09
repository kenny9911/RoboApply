import type { RequestHandler } from 'express';
import { recordUserActivity } from '../lib/userActivity.js';

const RA = '/api/v1/roboapply/v2';
const IE = '/api/v1/interview-engine';

// Explicit action routes only: background polling, /auth/me, admin reads,
// billing checkout creation, and worker callbacks are not functional usage.
const FEATURE_ROUTES: { methods: string[]; path: string; feature: string }[] = [
  { methods: ['POST'], path: `${RA}/job-search/search`, feature: 'job_search' },
  { methods: ['POST'], path: `${RA}/job-search/agent/search`, feature: 'job_search' },
  { methods: ['POST'], path: `${RA}/search/run`, feature: 'job_search' },
  { methods: ['POST'], path: `${RA}/discover/run`, feature: 'job_search' },
  { methods: ['POST'], path: `${RA}/jobs/:id/score`, feature: 'job_match' },
  { methods: ['POST'], path: `${RA}/jobs/:id/save`, feature: 'job_save' },
  { methods: ['POST'], path: `${RA}/jobs/:id/apply`, feature: 'job_apply' },
  { methods: ['POST'], path: `${RA}/resumes`, feature: 'resume_create' },
  { methods: ['POST'], path: `${RA}/resumes/upload`, feature: 'resume_import' },
  { methods: ['POST'], path: `${RA}/resumes/import-linkedin`, feature: 'resume_import' },
  { methods: ['PATCH'], path: `${RA}/resumes/:id`, feature: 'resume_edit' },
  { methods: ['POST'], path: `${RA}/resumes/:id/rewrite`, feature: 'resume_rewrite' },
  { methods: ['POST'], path: `${RA}/resumes/:id/tailor-diff`, feature: 'resume_tailor' },
  { methods: ['POST'], path: `${RA}/resumes/:id/tailor-apply`, feature: 'resume_tailor' },
  { methods: ['POST'], path: `${RA}/mock/start`, feature: 'mock_interview' },
  { methods: ['POST'], path: `${RA}/mock/next-turn`, feature: 'mock_interview' },
  { methods: ['POST'], path: `${RA}/mock/:sessionId/score`, feature: 'mock_interview' },
  { methods: ['POST'], path: `${IE}/sessions`, feature: 'interview_start' },
  { methods: ['POST'], path: `${IE}/sessions/:id/coach`, feature: 'interview_coach' },
  { methods: ['POST'], path: `${IE}/sessions/:id/end`, feature: 'interview_end' },
  { methods: ['POST'], path: `${RA}/tracker`, feature: 'tracker_update' },
  { methods: ['POST'], path: `${RA}/tracker/bulk`, feature: 'tracker_update' },
  { methods: ['PATCH'], path: `${RA}/tracker/:id`, feature: 'tracker_update' },
  { methods: ['POST'], path: `${RA}/onboarding/confirm`, feature: 'onboarding_complete' },
  { methods: ['PATCH', 'PUT'], path: `${RA}/goal`, feature: 'preferences_update' },
  { methods: ['PATCH'], path: `${RA}/preferences`, feature: 'preferences_update' },
];

const routes = FEATURE_ROUTES.map((route) => ({
  ...route,
  pattern: new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}/?$`),
}));

/** One event per successful, authenticated JSON action response. Recording
 * before sending keeps writes inside the serverless request lifetime; using
 * `finish` with an unawaited DB call would lose events on instance suspension.
 */
export const trackFeatureActivity: RequestHandler = (req, res, next) => {
  const path = req.originalUrl.split('?')[0];
  const route = routes.find((candidate) => candidate.methods.includes(req.method) && candidate.pattern.test(path));
  if (!route) return next();

  const originalJson = res.json;
  res.json = function jsonWithActivity(body) {
    res.json = originalJson;
    // Coaching deliberately degrades to HTTP 200 with a null tip on failure
    // (including an unowned session). It did not deliver functional value.
    const failed = body && typeof body === 'object' && (
      body.success === false || Boolean(body.error) ||
      (route.feature === 'interview_coach' && body.coach == null)
    );
    if (!req.user?.id || res.statusCode < 200 || res.statusCode >= 300 || failed) {
      return originalJson.call(this, body);
    }
    void recordUserActivity(req, {
      userId: req.user.id,
      eventType: 'feature_use',
      path: route.path,
      feature: route.feature,
      statusCode: res.statusCode,
    }).then(() => {
      try { originalJson.call(this, body); } catch (error) { next(error); }
    }, next);
    return this;
  };
  next();
};
