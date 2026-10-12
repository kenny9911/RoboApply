// backend/src/roboapply/v2/routes/tracker.ts
//
// Mounted at /api/v1/roboapply/v2/tracker.
//
//   GET    /          — list w/ status filter + paging + sort; WP-38 adds
//                       view=stage|date, q (title/company/notes), source
//   GET    /:id       — single entry (owner-only; 404 otherwise)
//   POST   /          — create (jobId OR externalSnapshot required)
//   PATCH  /:id       — partial update; WP-38 adds outcome, stageDetail,
//                       interviewAt, offer. Every change writes an
//                       RATrackerEvent; a move to applied stamps dateApplied.
//   DELETE /:id       — soft delete (stamps `deletedAt`; hidden from every read)
//   POST   /bulk      — bulk status / excitement / deadline patch
//
// Response shapes stay the pre-clone ones (`{ entries, statusCounts, total }`,
// `{ entry }`, `{ error }`); the entry view only gained fields. The new paths
// (follow-ups, export.csv, events, artifacts) live in
// server/src/features/tracker/routes.ts, mounted after this router: `GET /:id`
// passes their reserved ids on with `next()`.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { logger } from '../../../services/LoggerService.js';
import {
  ALL_TRACKER_STATUSES,
  TrackerBulkBodySchema,
  TrackerCreateBodySchema,
  TrackerListQuerySchema,
  TrackerPatchBodySchema,
} from '../../../features/tracker/index.js';
import {
  raTrackerService,
  TrackerDuplicateError,
  TrackerInvalidInputError,
  TrackerNotFoundError,
} from '../services/RATrackerService.js';

const router = Router();

/** Ids that belong to the feature router's paths (`GET /follow-ups`, `GET /export.csv`). */
export const RESERVED_TRACKER_IDS: ReadonlySet<string> = new Set(['follow-ups', 'export.csv']);

const KNOWN_STATUSES = new Set<string>(ALL_TRACKER_STATUSES);

type ZodIssueLike = { path: PropertyKey[]; message: string };

function invalid(res: Response, error: string, issues?: ZodIssueLike[]) {
  return res.status(422).json({
    error,
    code: 'invalid_request',
    issues: issues?.map((i) => ({ path: i.path.map(String), message: i.message })),
  });
}

function domainError(res: Response, err: unknown): Response | null {
  if (err instanceof TrackerNotFoundError) return res.status(404).json({ error: 'not_found' });
  if (err instanceof TrackerDuplicateError) return res.status(409).json({ error: 'duplicate_tracker_entry', code: 'duplicate' });
  if (err instanceof TrackerInvalidInputError) {
    if (err.reason === 'not_owner') return res.status(403).json({ error: 'not_owner', message: err.message });
    return res.status(422).json({ error: err.reason, code: err.reason, message: err.message });
  }
  return null;
}

function fail(res: Response, req: Request, what: string, err: unknown) {
  if (domainError(res, err)) return;
  logger.error('RA_V2_TRACKER', `${what} failed`, {
    userId: req.user?.id,
    entryId: (req.params as { id?: string }).id,
    error: err instanceof Error ? err.message : String(err),
  });
  res.status(500).json({ error: 'internal_error' });
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
  // Unknown status values are ignored (pre-clone behaviour), not rejected.
  const raw = req.query.status;
  const statuses = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
    (s): s is string => typeof s === 'string' && KNOWN_STATUSES.has(s),
  );
  const parsed = TrackerListQuerySchema.safeParse({ ...req.query, status: statuses.length > 0 ? statuses : undefined });
  if (!parsed.success) return invalid(res, 'invalid_query', parsed.error.issues);
  try {
    return res.json(await raTrackerService.list(req.user!.id, parsed.data));
  } catch (err) {
    return fail(res, req, 'list', err);
  }
});

// POST /bulk must precede GET /:id so it's not captured by the param route.
router.post('/bulk', requireAuth, async (req: Request, res: Response) => {
  const { ids, patch } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(422).json({ error: 'ids_required' });
  if (!patch || typeof patch !== 'object') return res.status(422).json({ error: 'patch_required' });
  const parsed = TrackerBulkBodySchema.safeParse({ ids, patch });
  if (!parsed.success) return invalid(res, 'invalid_body', parsed.error.issues);
  try {
    return res.json(await raTrackerService.bulk(req.user!.id, parsed.data));
  } catch (err) {
    return fail(res, req, 'bulk', err);
  }
});

router.get('/:id', requireAuth, async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  if (RESERVED_TRACKER_IDS.has(req.params.id)) return next();
  try {
    const entry = await raTrackerService.getById(req.user!.id, req.params.id);
    return res.json({ entry });
  } catch (err) {
    return fail(res, req, 'get', err);
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = TrackerCreateBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const missing = parsed.error.issues.some((i) => i.message === 'Missing jobId or externalSnapshot');
    return invalid(res, missing ? 'Missing jobId or externalSnapshot' : 'invalid_body', parsed.error.issues);
  }
  try {
    const entry = await raTrackerService.create(req.user!.id, parsed.data);
    return res.status(201).json({ entry });
  } catch (err) {
    return fail(res, req, 'create', err);
  }
});

router.patch('/:id', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  const parsed = TrackerPatchBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, 'invalid_body', parsed.error.issues);
  try {
    const entry = await raTrackerService.patch(req.user!.id, req.params.id, parsed.data);
    return res.json({ entry });
  } catch (err) {
    return fail(res, req, 'patch', err);
  }
});

router.delete('/:id', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    await raTrackerService.delete(req.user!.id, req.params.id);
    return res.status(204).send();
  } catch (err) {
    return fail(res, req, 'delete', err);
  }
});

export default router;
