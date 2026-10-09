// server/src/features/profile/routes.ts — STUB (FND-5). Owner: WP-19.
// Mounted by features/index.ts at /api/v1/roboapply/profile (seeker session).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  EducationBodySchema,
  EducationPatchSchema,
  ExperienceBodySchema,
  ExperiencePatchSchema,
  ProfilePatchSchema,
  PutSkillsBodySchema,
  RowParamsSchema,
  SensitiveAnswersSchema,
  SyncFromResumeApplyBodySchema,
  SyncFromResumeBodySchema,
} from './contract.js';

function stub(what: string, s: { params?: ZodType; query?: ZodType; body?: ZodType } = {}): RequestHandler {
  return markStub(
    route(async (req) => {
      if (s.params) parseParams(req, s.params);
      if (s.query) parseQuery(req, s.query);
      if (s.body) parseBody(req, s.body);
      throw new NotImplementedError(what);
    }),
  );
}

export function createProfileRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];

  router.get('/', ...auth, stub('profile.get'));
  router.patch('/', ...auth, stub('profile.patch', { body: ProfilePatchSchema }));

  router.post('/education', ...auth, stub('profile.addEducation', { body: EducationBodySchema }));
  router.patch('/education/:id', ...auth, stub('profile.updateEducation', { params: RowParamsSchema, body: EducationPatchSchema }));
  router.delete('/education/:id', ...auth, stub('profile.deleteEducation', { params: RowParamsSchema }));

  router.post('/experience', ...auth, stub('profile.addExperience', { body: ExperienceBodySchema }));
  router.patch('/experience/:id', ...auth, stub('profile.updateExperience', { params: RowParamsSchema, body: ExperiencePatchSchema }));
  router.delete('/experience/:id', ...auth, stub('profile.deleteExperience', { params: RowParamsSchema }));

  router.put('/skills', ...auth, stub('profile.putSkills', { body: PutSkillsBodySchema }));

  router.get('/sensitive', ...auth, stub('profile.getSensitive'));
  router.put('/sensitive', ...auth, stub('profile.putSensitive', { body: SensitiveAnswersSchema }));

  router.post('/sync-from-resume', ...auth, stub('profile.syncPreview', { body: SyncFromResumeBodySchema }));
  router.post('/sync-from-resume/apply', ...auth, stub('profile.syncApply', { body: SyncFromResumeApplyBodySchema }));

  return router;
}
