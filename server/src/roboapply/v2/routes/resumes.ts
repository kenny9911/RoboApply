// server/src/roboapply/v2/routes/resumes.ts
//
// Mounted at /api/v1/roboapply/v2/resumes.
//
//   GET    /                — list variant summaries (newest lastEditedAt first)
//   POST   /                — create (kind discriminator: base|tailored_for_jd|from_template).
//                             `tailored_for_jd` runs a tailor session: one
//                             `tailor` credit (send `Idempotency-Key`), the
//                             claim check, `unverifiedClaims`; answers
//                             `{ resume, tailorSessionId, pendingClaims }`
//   GET    /:id             — single variant (owner-only)
//   PATCH  /:id             — name + markdown patch (stale-marks downstream scores)
//   DELETE /:id             — soft delete (409 if only base + tracker dependents)
//   POST   /:id/rewrite     — V3 inline AI rewrite (bullet | summary | skills);
//                             503 ai_unavailable when the user's AI consent is
//                             off or the brand has no text model (WP-22)
//   POST   /:id/tailor-diff — retired: 410 gone (use POST /tailor-sessions)
//   POST   /:id/tailor-apply — retired: 410 gone (use POST /tailor-sessions)
//   GET    /:id/coach-tips  — V3 editor coach tips (free, deterministic)
//   PATCH  /:id/layout      — template, page size, spacing, accent, date format (WP-36b)
//   GET    /:id/export      — PDF/DOCX; 409 unverified_claims; records the file
//                             on an application with ?trackerEntryId= (WP-36b)
//   POST   /:id/export      — the same, with an optional photo from the user's
//                             device (JSON `{ format, nameStyle?, trackerEntryId?,
//                             photo? }`; data: URL, JPEG/PNG ≤ 512 KB). The photo
//                             is placed by the renderer and never stored; a
//                             file recorded on an application (stored) is made
//                             without it on every brand (X-Photo-Omitted: 1). WP-65.
//
// Hub rules (WP-36b): up to 5 base resumes (409 resume_limit_reached);
// tailored versions do not count. Uploads check the brand's file storage
// first (503 storage_unavailable on the mainland stack without CN_S3_*).
// Uploads and LinkedIn PDF imports share a persisted cap of 10 a day per user
// (429 rate_limited + Retry-After, details.reason resume_upload_daily_limit).
// POST /upload on RoboApply reads the file with the local parser when the form
// carries `localParser=1`, and always for a user without a live
// `intl_cross_border_cn_parse` grant (the GoHire parser is never used then).
// GoApply ignores `localParser`: GoHire is its in-country parser.
// GoApply: a file is read only with the user's AI consent (`ai_resume_parsing`);
// without it both upload routes answer 503 ai_unavailable (details.reason
// ai_consent_required) before the file is read, and no model is called.
// There is no LinkedIn URL import (TASK_PLAN.md H9).
//
// Tailoring (INT-10): every tailored version comes from a tailor session
// (features/resume/tailor). The old tailor-diff / tailor-apply pair skipped
// the `tailor` credit, the claim check and `unverifiedClaims`; its last caller
// (the editor's TailorModal) is gone, so both routes answer 410. They keep the
// GoApply phone and AI-consent gates in front, as before.

import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireAuth } from '../lib/raAuth.js';
import { legacyAiGates } from '../lib/legacyAiGates.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { FILE_NAME_STYLE_KEYS, defaultPageFor, photoTypeOf, withExportPhoto, type FileNameStyleKey } from '../lib/resumeExport.js';
import { logger } from '../../../services/LoggerService.js';
import {
  isAcceptedResumeUpload,
  readCandidateResumeOriginal,
} from '../../../lib/candidateResumeIngest.js';
import { resumeOriginalFileStorageService } from '../../../services/ResumeOriginalFileStorageService.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/brandContext.js';
import { PatchLayoutBodySchema, getLayoutService } from '../../../features/resume/index.js';
import { HttpError, fail, mapError } from '../../../platform/http.js';
import { CreditReplayError, CreditsExhaustedError, creditService } from '../../../platform/credits/index.js';
import { AuthCnError } from '../../../features/auth-cn/index.js';
import {
  BASE_RESUME_LIMIT,
  raResumeService,
  registerResumeArtifactDeleters,
  ResumeInUseError,
  ResumeLimitError,
  ResumeNotFoundError,
  ResumeParseConsentError,
  ResumeUploadError,
  ResumeUploadLimitError,
  ResumeValidationError,
  TrackerEntryNotFoundError,
  UnverifiedClaimsError,
  type ExportFormat,
  type RAResumeKind,
  type ResumeCreateInput,
} from '../services/RAResumeService.js';
import {
  AiUnavailableError,
  raResumeAIService,
  ResumeNotFoundError as ResumeAINotFoundError,
  RewriteValidationError,
  __test as rewriteFallbacks,
  type ResumeRewriteResult,
  type RewriteInput,
} from '../services/RAResumeAIService.js';

const router = Router();

// The artifact-file deleters (compliance retention, account purge) are
// registered when this router loads at boot.
void registerResumeArtifactDeleters().catch((err) => {
  logger.error('RA_V2_RESUMES', 'artifact deleter registration failed', {
    error: err instanceof Error ? err.message : String(err),
  });
});

/** 409 body when every base slot is taken. */
function limitBody() {
  return { error: 'resume_limit_reached', code: 'resume_limit_reached', details: { limit: BASE_RESUME_LIMIT } };
}

/**
 * Residency (WP-15 REQ-WP15-04): refuse an upload before reading the file when
 * the brand's storage is required but missing.
 */
function requireUploadStorage(req: Request, res: Response, next: (err?: any) => void): void {
  try {
    resumeOriginalFileStorageService.assertAvailable();
    next();
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'storage_unavailable') {
      res.status(503).json({ error: 'storage_unavailable', code: 'storage_unavailable' });
      return;
    }
    if (code === 'brand_context_missing') {
      res.status(500).json({ error: 'brand_context_missing', code: 'brand_context_missing' });
      return;
    }
    next(err);
  }
}

/** 429 `rate_limited` with `Retry-After` once the day's uploads are used up. */
function uploadLimitResponse(res: Response, err: ResumeUploadLimitError): Response {
  return fail(res, 'rate_limited', err.message, {
    reason: 'resume_upload_daily_limit',
    limit: err.limit,
    retryAfterSec: err.retryAfterSec,
  });
}

/** 503 `ai_unavailable` for a GoApply upload without the AI consent (nothing was read). */
function parseConsentResponse(res: Response): Response {
  return res.status(503).json({ error: 'ai_unavailable', code: 'ai_unavailable', details: { reason: 'ai_consent_required' } });
}

/** A multipart flag is on when it is `1` or `true`. */
function flagOn(value: unknown): boolean {
  return typeof value === 'string' && /^(?:1|true)$/i.test(value.trim());
}

const VALID_KINDS: RAResumeKind[] = ['base', 'tailored_for_jd', 'from_template'];

// ── Upload (multipart) ──────────────────────────────────────────────────────
// Memory storage (in-RAM Buffer) — the buffer goes straight into the candidate
// ingest pipeline; nothing hits disk. Boundary-safe: `multer` is an npm module
// and the accepted-format check lives in `lib/candidateResumeIngest`.
const MAX_RESUME_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

const uploadResume = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (isAcceptedResumeUpload(file.mimetype, file.originalname)) {
      cb(null, true);
      return;
    }
    const err: any = new Error('unsupported_format');
    err.code = 'UNSUPPORTED_FORMAT';
    cb(err);
  },
});

/** Wrap multer so its errors become structured JSON instead of a 500. */
function handleResumeUpload(req: Request, res: Response, next: (err?: any) => void): void {
  uploadResume.single('file')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'file_too_large', code: 'file_too_large' });
        return;
      }
      if (err.code === 'UNSUPPORTED_FORMAT') {
        res.status(415).json({ error: 'unsupported_format', code: 'unsupported_format' });
        return;
      }
      res.status(400).json({ error: 'upload_failed', code: 'upload_failed' });
      return;
    }
    next();
  });
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const kindRaw = req.query.kind;
    const kind =
      typeof kindRaw === 'string' && VALID_KINDS.includes(kindRaw as RAResumeKind)
        ? (kindRaw as RAResumeKind)
        : undefined;
    const resumes = await raResumeService.list(userId, kind);
    return res.json({ resumes });
  } catch (err) {
    logger.error('RA_V2_RESUMES', 'list failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as { kind?: string; name?: unknown } & Record<string, unknown>;
    if (!body.kind || !VALID_KINDS.includes(body.kind as RAResumeKind)) {
      return res.status(422).json({
        error: 'invalid_kind',
        details: { allowed: VALID_KINDS },
      });
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return res.status(422).json({ error: 'name_required' });
    }
    if (body.kind === 'base') {
      if (typeof (body as any).resumeMarkdown !== 'string') {
        return res.status(422).json({ error: 'resumeMarkdown_required' });
      }
    }
    if (body.kind === 'tailored_for_jd') {
      if (
        typeof (body as any).basedOnVariantId !== 'string' ||
        typeof (body as any).targetJobId !== 'string'
      ) {
        return res.status(422).json({
          error: 'invalid_tailored_input',
          details: { required: ['basedOnVariantId', 'targetJobId'] },
        });
      }
    }
    if (body.kind === 'from_template') {
      if (typeof (body as any).templateKey !== 'string') {
        return res.status(422).json({ error: 'templateKey_required' });
      }
    }
    if (body.kind === 'tailored_for_jd') {
      // A tailor session: one `tailor` credit, the claim check, unverifiedClaims.
      const header = req.get('Idempotency-Key')?.trim();
      const result = await raResumeService.createTailoredForJob(
        userId,
        { name: body.name as string, basedOnVariantId: (body as any).basedOnVariantId, targetJobId: (body as any).targetJobId },
        { idempotencyKey: header && header.length <= 120 ? header : `legacy-tailor:${crypto.randomUUID()}`, locale: getRequestLocale(req) },
      );
      return res.status(201).json(result);
    }
    const resume = await raResumeService.create(userId, body as unknown as ResumeCreateInput, getRequestLocale(req));
    return res.status(201).json({ resume });
  } catch (err) {
    if (err instanceof ResumeLimitError) {
      return res.status(409).json(limitBody());
    }
    // GoApply: a WeChat account binds a phone before any AI feature.
    if (err instanceof AuthCnError) {
      return res.status(err.status).json({ success: false, code: err.code, error: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    // Tailor-session errors keep their platform envelope (404 not_found,
    // 503 ai_unavailable, 402 credits_exhausted, 409 conflict, …).
    const mapped = mapError(err);
    if (!mapped.unexpected) {
      for (const [k, v] of Object.entries(mapped.headers)) res.setHeader(k, v);
      return res.status(mapped.status).json({ ...mapped.body, error: mapped.body.code, message: mapped.body.error });
    }
    if (err instanceof ResumeNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err instanceof ResumeValidationError) {
      return res.status(422).json({ error: err.message });
    }
    logger.error('RA_V2_RESUMES', 'create failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /upload — multipart résumé upload → parse → new base variant.
// FREE (no quota debit), matching recruiter upload-parse. Reuses the RoboHire
// parse pipeline via lib/candidateResumeIngest; writes ONLY candidate tables.
router.post('/upload', requireAuth, requireUploadStorage, handleResumeUpload, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(422).json({ error: 'file_required', code: 'file_required' });
    }
    const nameRaw = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    // Opaque per-file token (see RAResumeVariant.uploadIdempotencyKey). Bounded
    // and optional: an absent or oversized key just means no replay protection,
    // never a rejected upload.
    const keyRaw =
      typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.trim() : '';
    const resume = await raResumeService.uploadAndCreate(userId, {
      buffer: file.buffer,
      fileName: file.originalname || 'resume',
      mimeType: file.mimetype || 'application/octet-stream',
      name: nameRaw || undefined,
      idempotencyKey: keyRaw && keyRaw.length <= 200 ? keyRaw : undefined,
      // RoboApply: `localParser=1` keeps the file on this server (no GoHire
      // parse). The service also forces it for a RoboApply user without the
      // `intl_cross_border_cn_parse` grant, and ignores the flag on GoApply.
      localParser: flagOn(req.body?.localParser),
      requestId: (req as any).requestId,
    }, getRequestLocale(req));
    return res.status(201).json({ resume });
  } catch (err) {
    if (err instanceof ResumeLimitError) {
      return res.status(409).json(limitBody());
    }
    if (err instanceof ResumeUploadLimitError) {
      return uploadLimitResponse(res, err);
    }
    if (err instanceof ResumeParseConsentError) {
      return parseConsentResponse(res);
    }
    if (err instanceof ResumeUploadError) {
      return res.status(422).json({ error: err.code, code: err.code });
    }
    logger.error('RA_V2_RESUMES', 'upload failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Import from a LinkedIn PDF export ───────────────────────────────────────
// GET  /import-linkedin/config — kept for older clients; URL import is gone
//                                (TASK_PLAN.md H9), so it always says false.
// POST /import-linkedin        — the user's own "Save to PDF" export (mode
//                                'pdf'). FREE, like /upload. mode 'url' → 422
//                                url_import_removed.
router.get('/import-linkedin/config', requireAuth, (_req: Request, res: Response) => {
  return res.json({ urlImportEnabled: false });
});

router.post('/import-linkedin', requireAuth, requireUploadStorage, handleResumeUpload, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const file = (req as Request & { file?: Express.Multer.File }).file;
    const modeRaw = typeof req.body?.mode === 'string' ? req.body.mode : '';
    const mode: 'pdf' | 'url' = modeRaw === 'url' ? 'url' : 'pdf';
    const nameRaw = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

    const resume = await raResumeService.importFromLinkedIn(userId, {
      mode,
      buffer: file?.buffer,
      fileName: file?.originalname,
      mimeType: file?.mimetype,
      name: nameRaw || undefined,
      requestId: (req as any).requestId,
    }, getRequestLocale(req));
    return res.status(201).json({ resume });
  } catch (err) {
    if (err instanceof ResumeLimitError) {
      return res.status(409).json(limitBody());
    }
    if (err instanceof ResumeUploadLimitError) {
      return uploadLimitResponse(res, err);
    }
    if (err instanceof ResumeParseConsentError) {
      return parseConsentResponse(res);
    }
    if (err instanceof ResumeUploadError) {
      return res.status(422).json({ error: err.code, code: err.code });
    }
    logger.error('RA_V2_RESUMES', 'linkedin import failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/:id', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const resume = await raResumeService.getById(userId, req.params.id);
    return res.json({ resume: { ...resume, defaultPage: requestDefaultPage(req) } });
  } catch (err) {
    if (err instanceof ResumeNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_RESUMES', 'get failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/:id', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const resume = await raResumeService.patch(userId, req.params.id, req.body ?? {});
    return res.json({ resume });
  } catch (err) {
    if (err instanceof ResumeNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_RESUMES', 'patch failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.delete('/:id', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    await raResumeService.delete(userId, req.params.id);
    return res.status(204).send();
  } catch (err) {
    if (err instanceof ResumeNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err instanceof ResumeInUseError) {
      return res.status(409).json({
        error: 'in_use',
        code: 'has_dependents',
        details: { trackerCount: err.trackerCount },
      });
    }
    logger.error('RA_V2_RESUMES', 'delete failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /:id/primary — mark this variant as the user's primary résumé.
router.post('/:id/primary', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const resume = await raResumeService.setPrimary(userId, req.params.id);
    return res.json({ resume });
  } catch (err) {
    if (err instanceof ResumeNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err instanceof ResumeValidationError) {
      // A tailored version cannot be the primary (F-RES-02).
      return res.status(422).json({ error: 'not_base_resume', message: err.message });
    }
    logger.error('RA_V2_RESUMES', 'setPrimary failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /:id/original-file — stream the stored original upload (owner-only).
router.get('/:id/original-file', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const ref = await raResumeService.getOriginalFileRef(userId, req.params.id);
    if (!ref) {
      return res.status(404).json({ error: 'no_original_file' });
    }
    const { buffer, fileName, mimeType } = await readCandidateResumeOriginal(
      ref,
      (req as any).requestId,
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName.replace(/"/g, '')}"`);
    return res.send(buffer);
  } catch (err) {
    if (err instanceof ResumeNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_RESUMES', 'original-file failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /:id/layout — template, page size, spacing, accent, date format.
// Validated by the RES contract (ResumeLayoutSchema); merged into the stored
// layout. Mounted here, before the RES feature router, so this handler wins.
router.patch('/:id/layout', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  const parsed = PatchLayoutBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(422).json({
      error: 'validation_failed',
      code: 'validation_failed',
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }
  try {
    // WP-65: the RES layout service merges the WP-36b keys plus `personal`,
    // `photo` and `headingLanguage` (RAResumeService.patchLayout drops them).
    await getLayoutService().patch(req.user!.id, req.params.id, parsed.data.layout as Record<string, unknown>);
    const resume = await raResumeService.getById(req.user!.id, req.params.id);
    return res.json({ resume: { ...resume, defaultPage: requestDefaultPage(req) } });
  } catch (err) {
    if (err instanceof ResumeNotFoundError || (err instanceof HttpError && err.code === 'not_found')) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_RESUMES', 'layout failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** The visitor's country from the edge (Vercel), when present. */
function requestCountry(req: Request): string | null {
  const raw = req.headers['x-vercel-ip-country'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
}

/** Letter or A4 for this request when the resume has no page size saved. */
function requestDefaultPage(req: Request): 'letter' | 'a4' {
  const brand = getCurrentBrandOrDefault();
  return defaultPageFor({ market: brand.market, country: requestCountry(req), locale: getRequestLocale(req) });
}

// GET /:id/export?format=pdf|docx&nameStyle=&trackerEntryId= — render the
// variant's CURRENT markdown with its layout (owner-only). 409
// unverified_claims while any inserted claim is unverified (ruling C12). With
// trackerEntryId the exact bytes are kept and an RAApplicationArtifact row
// records sha256 + storage key; its id comes back in X-Artifact-Id. Without
// one, a version tailored for a job is recorded on the user's application for
// that job when there is one (a file with a device photo: the record only,
// no kept copy).
/** Largest photo a download may carry (decoded bytes). */
export const MAX_EXPORT_PHOTO_BYTES = 512 * 1024;

/** A `data:image/jpeg|png;base64,…` URL → bytes, or null when absent; throws 'invalid_photo'. */
export function decodeExportPhoto(raw: unknown): Buffer | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new Error('invalid_photo');
  const m = /^data:image\/(?:jpeg|jpg|png);base64,([A-Za-z0-9+/=\s]+)$/.exec(raw.trim());
  if (!m) throw new Error('invalid_photo');
  const bytes = Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0 || bytes.length > MAX_EXPORT_PHOTO_BYTES || !photoTypeOf(bytes)) throw new Error('invalid_photo');
  return bytes;
}

interface ExportParams {
  format: unknown;
  nameStyle: unknown;
  trackerEntryId: unknown;
  photo?: unknown;
}

async function sendExport(req: Request<{ id: string }>, res: Response, input: ExportParams): Promise<Response> {
  try {
    const userId = req.user!.id;
    const format = String(input.format ?? 'pdf').toLowerCase();
    if (format !== 'pdf' && format !== 'docx') {
      return res.status(422).json({ error: 'unsupported_format', code: 'unsupported_format', supported: ['pdf', 'docx'] });
    }
    const nameStyleRaw = typeof input.nameStyle === 'string' ? input.nameStyle : '';
    if (nameStyleRaw && !(FILE_NAME_STYLE_KEYS as readonly string[]).includes(nameStyleRaw)) {
      return res.status(422).json({ error: 'invalid_name_style', code: 'validation_failed', details: { allowed: FILE_NAME_STYLE_KEYS } });
    }
    const trackerRaw = typeof input.trackerEntryId === 'string' ? input.trackerEntryId.trim() : '';
    if (trackerRaw.length > 64) {
      return res.status(422).json({ error: 'invalid_tracker_entry', code: 'validation_failed' });
    }
    let photo: Buffer | null;
    try {
      photo = decodeExportPhoto(input.photo);
    } catch {
      return res.status(422).json({ error: 'invalid_photo', code: 'validation_failed', details: { reason: 'invalid_photo', maxBytes: MAX_EXPORT_PHOTO_BYTES } });
    }
    const brand = getCurrentBrandOrDefault();
    // The photo is never stored on our servers (every brand; GoApply CN-0
    // minimization and the "stays in this browser" promise). A file recorded on
    // an application is stored as an artifact, so it is made without the photo.
    const photoOmitted = Boolean(photo && trackerRaw);
    if (photoOmitted) photo = null;
    const result = await withExportPhoto(photo, () =>
      raResumeService.exportVariant(userId, req.params.id, {
        format: format as ExportFormat,
        nameStyle: (nameStyleRaw || null) as FileNameStyleKey | null,
        trackerEntryId: trackerRaw || null,
        // No application named (the editor, the hub): a version tailored for a
        // job is recorded on the user's application for that job, if any.
        autoTrack: !trackerRaw,
        photoInFile: Boolean(photo),
        channel: 'download',
        locale: getRequestLocale(req),
        brand: brand.id,
        market: brand.market,
        country: requestCountry(req),
      }),
    );

    // ASCII filename for legacy clients + RFC 5987 filename* for CJK names.
    const asciiName =
      result.fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\/]/g, '_').trim() || `resume.${result.ext}`;
    res.setHeader('Content-Type', result.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    res.setHeader('X-Content-Sha256', result.sha256);
    if (result.artifactId) res.setHeader('X-Artifact-Id', result.artifactId);
    if (photoOmitted) res.setHeader('X-Photo-Omitted', '1');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Artifact-Id, X-Content-Sha256, X-Photo-Omitted');
    return res.send(result.buffer);
  } catch (err) {
    if (err instanceof ResumeNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err instanceof UnverifiedClaimsError) {
      return res.status(409).json({ error: 'unverified_claims', code: 'unverified_claims', details: { count: err.count } });
    }
    if (err instanceof TrackerEntryNotFoundError) {
      return res.status(404).json({ error: 'tracker_entry_not_found', code: 'tracker_entry_not_found' });
    }
    logger.error('RA_V2_RESUMES', 'export failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      format: input.format,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
}

router.get('/:id/export', requireAuth, (req: Request<{ id: string }>, res: Response) =>
  sendExport(req, res, { format: req.query.format, nameStyle: req.query.nameStyle, trackerEntryId: req.query.trackerEntryId }),
);

router.post('/:id/export', requireAuth, (req: Request<{ id: string }>, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return sendExport(req, res, { format: body.format, nameStyle: body.nameStyle, trackerEntryId: body.trackerEntryId, photo: body.photo });
});

// ── V3 inline AI ──────────────────────────────────────────────────────────

// POST /:id/rewrite — bullet | summary | skills inline rewrite.
//
// One `rewrite` credit per call (PRODUCT_PLAN.md §6: rewrite = inline AI edits
// of a bullet, the summary or the skills; 20 a day). The credit is reserved
// before the model runs and committed only when the model wrote what comes
// back. It is released, so the call costs nothing, on any failure (not found,
// validation, AI off) AND when the answer is the service's canned text: the
// rewrite service never throws on a model error, a rejected made-up number or
// an empty answer; it returns a fixed fallback instead (see
// `isCannedRewrite`). This route used to call the model with no credit at
// all: only the Resume check fix panel and the builder spent the bucket.
// `Idempotency-Key` is honoured when the client sends one.

/** Carries the canned answer out of `withCredit`, which releases the reservation on a throw. */
class CannedRewrite extends Error {
  constructor(readonly result: ResumeRewriteResult) {
    super('rewrite_fallback');
  }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Is this result the rewrite service's fixed fallback, i.e. text no model
 * wrote? `RAResumeAIService.rewrite` gives no sign of which path it took, so
 * the route builds the fallback for the same input with the service's own
 * functions and compares. (A model answer identical to the fallback changes
 * nothing for the user and is not charged either.)
 */
async function isCannedRewrite(userId: string, resumeId: string, body: RewriteInput, locale: string | undefined, result: ResumeRewriteResult): Promise<boolean> {
  if (body.mode === 'bullet') {
    return result.rewrite === rewriteFallbacks.fallbackBulletRewrite(body.text, body.action ?? 'improve', locale);
  }
  if (body.mode === 'summary') {
    return sameList((result.options ?? []).map((o) => o.text), rewriteFallbacks.fallbackSummaryOptions(body.text, locale));
  }
  const resume = await raResumeService.getById(userId, resumeId);
  return sameList(result.skills ?? [], rewriteFallbacks.fallbackSkills(resume.resumeMarkdown ?? '', locale));
}

router.post('/:id/rewrite', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as RewriteInput;
    const locale = getRequestLocale(req);
    const header = req.get('Idempotency-Key')?.trim();
    const idempotencyKey = header && header.length <= 120 ? header : `rewrite:${crypto.randomUUID()}`;
    const result = await creditService.withCredit(
      { userId, bucket: 'rewrite', idempotencyKey, refType: 'resume_inline_rewrite', refId: req.params.id },
      async () => {
        const out = await raResumeAIService.rewrite(userId, req.params.id, body, locale);
        if (await isCannedRewrite(userId, req.params.id, body, locale, out)) throw new CannedRewrite(out);
        return out;
      },
    );
    return res.json(result);
  } catch (err) {
    // The model wrote nothing: the user still gets the fallback text, and the
    // credit reserved for this call has been released.
    if (err instanceof CannedRewrite) {
      return res.json(err.result);
    }
    if (err instanceof ResumeAINotFoundError || err instanceof ResumeNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err instanceof AiUnavailableError) {
      return res.status(503).json({ error: 'ai_unavailable', code: 'ai_unavailable' });
    }
    if (err instanceof RewriteValidationError) {
      return res.status(422).json({ error: err.message });
    }
    // 402 credits_exhausted { bucket, resetsAt, upgradable } in the platform
    // envelope the web's credit gate reads; 409 for a replayed key.
    if (err instanceof CreditsExhaustedError) {
      const mapped = mapError(err);
      for (const [k, v] of Object.entries(mapped.headers)) res.setHeader(k, v);
      return res.status(mapped.status).json(mapped.body);
    }
    if (err instanceof CreditReplayError) {
      return fail(res, 'conflict', err.message, { reason: err.code });
    }
    logger.error('RA_V2_RESUMES', 'rewrite failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /:id/tailor-diff and /:id/tailor-apply — retired (INT-10). Tailoring
// is POST /tailor-sessions (one `tailor` credit, claim check, Verify details).
// 410 after the same gates as before, so a caller without the GoApply phone or
// the AI consent still gets 403 / 503 first and no model is ever called here.
function tailorRetired(_req: Request, res: Response): Response {
  return fail(res, 'gone', 'Tailoring moved. Start it from a job or from the resume editor.', {
    reason: 'legacy_tailor_retired',
    replacement: 'POST /api/v1/roboapply/v2/resumes/tailor-sessions',
  });
}
router.post('/:id/tailor-diff', requireAuth, ...legacyAiGates(), tailorRetired);
router.post('/:id/tailor-apply', requireAuth, ...legacyAiGates(), tailorRetired);

// GET /:id/coach-tips — editor coach tips (free, deterministic).
router.get('/:id/coach-tips', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await raResumeAIService.coachTips(userId, req.params.id);
    return res.json(result);
  } catch (err) {
    if (err instanceof ResumeAINotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_RESUMES', 'coachTips failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
