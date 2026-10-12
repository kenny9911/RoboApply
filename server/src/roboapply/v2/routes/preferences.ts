// backend/src/roboapply/v2/routes/preferences.ts
//
// Mounted at /api/v1/roboapply/v2/preferences.
//
//   GET   /  -> { preferences: RAPreferences, options: RAPreferenceOptions }
//   PATCH /  -> { preferences: RAPreferences }   (partial deep-merge update)
//
// The frontend contract (`RaV2Api.preferences`) is:
//   get()        -> PreferencesGetResponse    ({ preferences, options })
//   update(body) -> PreferencesUpdateResponse ({ preferences })
// `update` takes a Partial<RAPreferences>, so the verb is PATCH (mirrors the
// `_real.ts` `roboApi.patch` convention used for other partial updates).
//
// Both handlers scope to the authed user via `requireAuth`; first-time users
// get the service's default blob. Options are static.
//
// WP-20: the job-targeting keys of the blob (`roleTitles`, `workModes`,
// `cities`, `salaryMinK`, …) are projected from / written through to the
// user's active search profile (features/search, the one preference store);
// see RAPreferencesService. A search-profile error on PATCH answers with its
// platform code (e.g. 409 version_conflict after the service's one retry,
// 422 invalid_request) instead of a bare 500.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { normalizeRaLocale } from '../lib/raLocale.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/brandContext.js';
import { logger } from '../../../services/LoggerService.js';
import prisma from '../../../lib/prisma.js';
import { raPreferencesService } from '../services/RAPreferencesService.js';
import { searchErrorToHttpError } from '../../../features/search/index.js';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await raPreferencesService.get(userId);
    return res.json(result);
  } catch (err) {
    logger.error('RA_V2_PREFERENCES', 'GET /preferences failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(422).json({
        error: 'invalid_preferences',
        details: { reason: 'body_must_be_object' },
      });
    }
    // `updatedAt` is server-owned — strip it so a client can't pin a stale stamp.
    if ('updatedAt' in body) delete body.updatedAt;
    const result = await raPreferencesService.update(userId, body);
    return res.json(result);
  } catch (err) {
    const mapped = searchErrorToHttpError(err);
    if (mapped) {
      return res.status(mapped.status).json({ error: mapped.code, code: mapped.code, details: mapped.details });
    }
    logger.error('RA_V2_PREFERENCES', 'PATCH /preferences failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /locale — persist the user's chosen UI language to their SeekerProfile.
//
// The candidate app's language switcher is authoritative for the live UI via
// the `robo_locale` cookie (which is echoed on every API call as the
// `X-Robo-Locale` header). This endpoint additionally persists the choice so
// requestless background jobs (weekly-insights cron, match-score refresh,
// digest emails) generate content in the language the user reads the app in.
//
// Best-effort from the client's perspective: the UI does not block on it.
router.put('/locale', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const raw = (req.body ?? {}) as { locale?: unknown };
    const locale = normalizeRaLocale(
      typeof raw.locale === 'string' ? raw.locale : undefined,
    );
    // Only a locale the request's brand serves (nine on RoboApply, zh/en on
    // GoApply; WP-12 R7) — the switchers never offer another one.
    if (!locale || !(getCurrentBrandOrDefault().locales as readonly string[]).includes(locale)) {
      return res.status(422).json({ error: 'invalid_locale' });
    }
    await prisma.seekerProfile.updateMany({
      where: { userId },
      data: { locale },
    });
    return res.json({ locale });
  } catch (err) {
    logger.error('RA_V2_PREFERENCES', 'PUT /preferences/locale failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
