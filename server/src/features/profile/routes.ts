// server/src/features/profile/routes.ts — the profile API (WP-19; ARCHITECTURE.md §3.3).
// Mounted by features/index.ts at /api/v1/roboapply/profile (seeker session). No flag:
// the profile exists on both brands; field-level rules (market, `eeoAnswers`,
// CN-0 photo) are enforced by the service.
//
//   GET    /                          → ProfileView
//   PATCH  /                          ProfilePatch → ProfileView
//   POST   /education                 → ProfileEducationView (201)
//   PATCH  /education/:id             → ProfileEducationView
//   DELETE /education/:id             → null
//   POST   /experience                → ProfileExperienceView (201)
//   PATCH  /experience/:id            → ProfileExperienceView
//   DELETE /experience/:id            → null
//   PUT    /skills                    → ProfileView
//   GET    /sensitive                 → SensitiveAnswersView (owner only; no-store)
//   PUT    /sensitive                 → SensitiveAnswersView ({} deletes them)
//   POST   /sync-from-resume          { variantId } → { variantId, parsed, diff }
//   POST   /sync-from-resume/apply    { variantId, accept[] } → ProfileView

import { Router, type Request } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { parseBody, parseParams, requireUserId, route } from '../../platform/http.js';
import { getCurrentBrandOrDefault, type BrandedRequest } from '../../platform/brand/index.js';
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
import { createProfileService, type ProfileContext, type ProfileServiceImpl } from './service.js';

export interface ProfileRouterDeps extends FeatureRouterDeps {
  service?: ProfileServiceImpl;
}

let defaultService: ProfileServiceImpl | null = null;
const lazyDefault = () => (defaultService ??= createProfileService());

function ctxOf(req: Request): ProfileContext {
  return { brand: (req as Partial<BrandedRequest>).brand ?? getCurrentBrandOrDefault() };
}

export function createProfileRouter(deps: ProfileRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const svc = () => deps.service ?? lazyDefault();

  router.get('/', ...auth, route(async (req) => svc().get(requireUserId(req), ctxOf(req))));
  router.patch(
    '/',
    ...auth,
    route(async (req) => svc().patch(requireUserId(req), parseBody(req, ProfilePatchSchema), ctxOf(req))),
  );

  router.post(
    '/education',
    ...auth,
    route(async (req) => svc().addEducation(requireUserId(req), parseBody(req, EducationBodySchema), ctxOf(req)), { status: 201 }),
  );
  router.patch(
    '/education/:id',
    ...auth,
    route(async (req) => {
      const { id } = parseParams(req, RowParamsSchema);
      return svc().updateEducation(requireUserId(req), id, parseBody(req, EducationPatchSchema), ctxOf(req));
    }),
  );
  router.delete(
    '/education/:id',
    ...auth,
    route(async (req) => {
      const { id } = parseParams(req, RowParamsSchema);
      await svc().deleteEducation(requireUserId(req), id, ctxOf(req));
      return null;
    }),
  );

  router.post(
    '/experience',
    ...auth,
    route(async (req) => svc().addExperience(requireUserId(req), parseBody(req, ExperienceBodySchema), ctxOf(req)), { status: 201 }),
  );
  router.patch(
    '/experience/:id',
    ...auth,
    route(async (req) => {
      const { id } = parseParams(req, RowParamsSchema);
      return svc().updateExperience(requireUserId(req), id, parseBody(req, ExperiencePatchSchema), ctxOf(req));
    }),
  );
  router.delete(
    '/experience/:id',
    ...auth,
    route(async (req) => {
      const { id } = parseParams(req, RowParamsSchema);
      await svc().deleteExperience(requireUserId(req), id, ctxOf(req));
      return null;
    }),
  );

  router.put('/skills', ...auth, route(async (req) => svc().putSkills(requireUserId(req), parseBody(req, PutSkillsBodySchema), ctxOf(req))));

  router.get(
    '/sensitive',
    ...auth,
    route(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      return svc().getSensitive(requireUserId(req), ctxOf(req));
    }),
  );
  router.put(
    '/sensitive',
    ...auth,
    route(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      return svc().putSensitive(requireUserId(req), parseBody(req, SensitiveAnswersSchema), ctxOf(req));
    }),
  );

  router.post(
    '/sync-from-resume',
    ...auth,
    route(async (req) => svc().syncPreview(requireUserId(req), parseBody(req, SyncFromResumeBodySchema).variantId, ctxOf(req))),
  );
  router.post(
    '/sync-from-resume/apply',
    ...auth,
    route(async (req) => {
      const body = parseBody(req, SyncFromResumeApplyBodySchema);
      return svc().syncApply(requireUserId(req), body.variantId, body.accept, ctxOf(req));
    }),
  );

  return router;
}
