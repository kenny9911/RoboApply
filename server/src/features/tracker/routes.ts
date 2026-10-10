// server/src/features/tracker/routes.ts — the new tracker paths (WP-38).
//
// Mounted by features/index.ts at /api/v1/roboapply/v2/tracker AFTER the
// legacy V2 router. The legacy router's `GET /:id` hands the reserved ids
// `follow-ups` and `export.csv` on with `next()`, so both reach this router.
//
//   GET  /follow-ups        facts: no reply in 10 days, follow-up due, interview tomorrow, deadline soon
//   GET  /export.csv        every application as CSV (5 a day per user)
//   GET  /:id/events        timeline (newest first; reminder ledger rows hidden)
//   POST /:id/events        add a note to the timeline
//   GET  /:id/artifacts     the exact files sent with this application

import { Router, type RequestHandler } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/index.js';
import { HttpError, parseBody, parseParams, requireUserId, route } from '../../platform/http.js';
import { DAY, rateLimit, type RateWindow } from '../../platform/ratelimit/index.js';
import type { FeatureRouterDeps } from '../index.js';
import { AddTrackerNoteBodySchema, TRACKER_EXPORT_DAILY_LIMIT, TrackerEntryParamsSchema, type FollowUpsResponse } from './contract.js';
import { trackerCsv } from './csv.js';
import { zonedDayKey } from './facts.js';
import { trackerCore, TrackerDuplicateError, TrackerInvalidInputError, TrackerNotFoundError, type TrackerCore } from './service.js';

export const TRACKER_EXPORT_LIMIT_NAME = 'trackerExportPerUser';
export const TRACKER_EXPORT_WINDOWS: readonly RateWindow[] = [{ limit: TRACKER_EXPORT_DAILY_LIMIT, windowSec: DAY }];

export interface TrackerRouterOptions {
  core?: TrackerCore;
  /** Rate-limit factory (tests inject a recorder). */
  limiter?: (name: string, windows: readonly RateWindow[]) => RequestHandler;
}

const defaultLimiter = (name: string, windows: readonly RateWindow[]): RequestHandler => rateLimit({ name, windows, by: 'user' });

/** Map the tracker's domain errors onto the platform envelope. */
export function trackerHttpError(err: unknown): never {
  if (err instanceof TrackerNotFoundError) throw new HttpError('not_found', err.message, { reason: err.reason });
  if (err instanceof TrackerDuplicateError) throw new HttpError('conflict', err.message, { reason: err.reason });
  if (err instanceof TrackerInvalidInputError) throw new HttpError('invalid_request', err.message, { reason: err.reason });
  throw err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return trackerHttpError(err);
  }
}

export function createTrackerRouter(deps: FeatureRouterDeps = {}, options: TrackerRouterOptions = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const core = options.core ?? trackerCore;
  const limiter = options.limiter ?? defaultLimiter;

  router.get(
    '/follow-ups',
    ...auth,
    route(async (req): Promise<FollowUpsResponse> => ({ items: await core.followUps(requireUserId(req)) })),
  );

  router.get(
    '/export.csv',
    ...auth,
    limiter(TRACKER_EXPORT_LIMIT_NAME, TRACKER_EXPORT_WINDOWS),
    route(async (req, res) => {
      const userId = requireUserId(req);
      // `?tz=<IANA name>`: the zone the page is showing dates in (the browser's). A missing or unknown name falls back to the stored zone.
      const asked = typeof req.query.tz === 'string' ? req.query.tz : null;
      const [entries, timeZone] = await Promise.all([core.exportEntries(userId), core.timeZone(userId, asked)]);
      // Dates in the file, and the date in its name, are the user's own (not the UTC date).
      const csv = trackerCsv(entries, getRequestLocale(req), getCurrentBrandOrDefault(), { timeZone });
      const stamp = zonedDayKey(new Date(), timeZone);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="applications-${stamp}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(csv);
    }),
  );

  router.get(
    '/:id/events',
    ...auth,
    route(async (req) => {
      const { id } = parseParams(req, TrackerEntryParamsSchema);
      return { items: await guarded(() => core.events(requireUserId(req), id)) };
    }),
  );

  router.post(
    '/:id/events',
    ...auth,
    route(
      async (req) => {
        const { id } = parseParams(req, TrackerEntryParamsSchema);
        const { note } = parseBody(req, AddTrackerNoteBodySchema);
        return guarded(() => core.addNote(requireUserId(req), id, note));
      },
      { status: 201 },
    ),
  );

  router.get(
    '/:id/artifacts',
    ...auth,
    route(async (req) => {
      const { id } = parseParams(req, TrackerEntryParamsSchema);
      return { items: await guarded(() => core.artifacts(requireUserId(req), id)) };
    }),
  );

  return router;
}
