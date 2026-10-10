// backend/src/roboapply/v2/routes/resumes.ts
//
// Mounted at /api/v1/roboapply/v2/resumes.
//
//   GET    /                — list variant summaries (newest lastEditedAt first)
//   POST   /                — create (kind discriminator: base|tailored_for_jd|from_template)
//   GET    /:id             — single variant (owner-only)
//   PATCH  /:id             — name + markdown patch (stale-marks downstream scores)
//   DELETE /:id             — soft delete (409 if only base + tracker dependents)
//   POST   /:id/rewrite     — V3 inline AI rewrite (bullet | summary | skills)
//   POST   /:id/tailor-diff — V3 propose a tailor diff for a job (does NOT create a variant)
//   (rewrite + tailor-diff answer 503 ai_unavailable when the user's AI consent
//   is off or the brand has no text model; WP-22, TASK_PLAN.md §2.2)
//   GET    /:id/coach-tips  — V3 editor coach tips (free, deterministic)
//   PATCH  /:id/layout      — template, page size, spacing, accent, date format (WP-36b)
//   GET    /:id/export      — PDF/DOCX; 409 unverified_claims; records the file
//                             on an application with ?trackerEntryId= (WP-36b)
//
// Hub rules (WP-36b): up to 5 base resumes (409 resume_limit_reached);
// tailored versions do not count. Uploads check the brand's file storage
// first (503 storage_unavailable on the mainland stack without CN_S3_*).
// There is no LinkedIn URL import (TASK_PLAN.md H9).
//
// Quota note: `tailored_for_jd` create + `/rewrite` + `/tailor-diff` are
// LLM ops — they write a `ra_resume_tailor` deduction row on SUCCESS only
// (failures / graceful fallbacks pay zero). `/coach-tips` is free.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireAuth } from '../lib/raAuth.js';
import { legacyAiGates } from '../lib/legacyAiGates.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { FILE_NAME_STYLE_KEYS, defaultPageFor, type FileNameStyleKey } from '../lib/resumeExport.js';
import { logger } from '../../../services/LoggerService.js';
import {
  isAcceptedResumeUpload,
  readCandidateResumeOriginal,
} from '../../../lib/candidateResumeIngest.js';
import { resumeOriginalFileStorageService } from '../../../services/ResumeOriginalFileStorageService.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/brandContext.js';
import { PatchLayoutBodySchema } from '../../../features/resume/index.js';
import {
  BASE_RESUME_LIMIT,
  raResumeService,
  registerResumeArtifactDeleters,
  ResumeInUseError,
  ResumeLimitError,
  ResumeNotFoundError,
  ResumeUploadError,
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
  type RewriteInput,
  type TailorDiffInput,
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
    const body = (req.body ?? {}) as ResumeCreateInput & { kind?: string };
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
    const resume = await raResumeService.create(userId, body as ResumeCreateInput, getRequestLocale(req));
    return res.status(201).json({ resume });
  } catch (err) {
    if (err instanceof ResumeLimitError) {
      return res.status(409).json(limitBody());
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
      requestId: (req as any).requestId,
    }, getRequestLocale(req));
    return res.status(201).json({ resume });
  } catch (err) {
    if (err instanceof ResumeLimitError) {
      return res.status(409).json(limitBody());
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
    const resume = await raResumeService.patchLayout(req.user!.id, req.params.id, parsed.data.layout as Record<string, unknown>);
    return res.json({ resume: { ...resume, defaultPage: requestDefaultPage(req) } });
  } catch (err) {
    if (err instanceof ResumeNotFoundError) {
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
// records sha256 + storage key; its id comes back in X-Artifact-Id.
router.get('/:id/export', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const format = String(req.query.format ?? 'pdf').toLowerCase();
    if (format !== 'pdf' && format !== 'docx') {
      return res.status(422).json({ error: 'unsupported_format', code: 'unsupported_format', supported: ['pdf', 'docx'] });
    }
    const nameStyleRaw = typeof req.query.nameStyle === 'string' ? req.query.nameStyle : '';
    if (nameStyleRaw && !(FILE_NAME_STYLE_KEYS as readonly string[]).includes(nameStyleRaw)) {
      return res.status(422).json({ error: 'invalid_name_style', code: 'validation_failed', details: { allowed: FILE_NAME_STYLE_KEYS } });
    }
    const trackerRaw = typeof req.query.trackerEntryId === 'string' ? req.query.trackerEntryId.trim() : '';
    if (trackerRaw.length > 64) {
      return res.status(422).json({ error: 'invalid_tracker_entry', code: 'validation_failed' });
    }
    const brand = getCurrentBrandOrDefault();
    const result = await raResumeService.exportVariant(userId, req.params.id, {
      format: format as ExportFormat,
      nameStyle: (nameStyleRaw || null) as FileNameStyleKey | null,
      trackerEntryId: trackerRaw || null,
      channel: 'download',
      locale: getRequestLocale(req),
      brand: brand.id,
      market: brand.market,
      country: requestCountry(req),
    });

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
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Artifact-Id, X-Content-Sha256');
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
      format: req.query.format,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── V3 inline AI ──────────────────────────────────────────────────────────

// POST /:id/rewrite — bullet | summary | skills inline rewrite.
router.post('/:id/rewrite', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as RewriteInput;
    const result = await raResumeAIService.rewrite(userId, req.params.id, body, getRequestLocale(req));
    return res.json(result);
  } catch (err) {
    if (err instanceof ResumeAINotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err instanceof AiUnavailableError) {
      return res.status(503).json({ error: 'ai_unavailable', code: 'ai_unavailable' });
    }
    if (err instanceof RewriteValidationError) {
      return res.status(422).json({ error: err.message });
    }
    logger.error('RA_V2_RESUMES', 'rewrite failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /:id/tailor-diff — propose a tailor diff for a (resume, job) pair.
router.post('/:id/tailor-diff', requireAuth, ...legacyAiGates(), async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as TailorDiffInput;
    const result = await raResumeAIService.tailorDiff(userId, req.params.id, body, getRequestLocale(req));
    return res.json(result);
  } catch (err) {
    if (err instanceof ResumeAINotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err instanceof AiUnavailableError) {
      return res.status(503).json({ error: 'ai_unavailable', code: 'ai_unavailable' });
    }
    if (err instanceof RewriteValidationError) {
      return res.status(422).json({ error: err.message });
    }
    logger.error('RA_V2_RESUMES', 'tailorDiff failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /:id/tailor-apply — persist a tailor PREVIEW as a new tailored variant.
// Deterministic: no LLM re-run and no new charge (the tailor was billed at
// /tailor-diff). Body: { tailoredResumeMarkdown, changes?, acceptedChangeIds?,
// targetJobId?, targetCompany?, targetTitle?, name? }. `acceptedChangeIds`
// (omitted = accept all) reverts the deselected reversible changes in the
// tailored markdown before persisting. targetCompany/targetTitle carry the
// manual-target lineage when there is no saved job.
router.post('/:id/tailor-apply', requireAuth, ...legacyAiGates(), async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as {
      tailoredResumeMarkdown?: string;
      changes?: unknown;
      acceptedChangeIds?: unknown;
      targetJobId?: string;
      targetCompany?: string;
      targetTitle?: string;
      name?: string;
    };
    const resume = await raResumeService.applyTailoredMarkdown(userId, req.params.id, {
      tailoredResumeMarkdown: String(body.tailoredResumeMarkdown ?? ''),
      changes: Array.isArray(body.changes) ? (body.changes as any) : [],
      acceptedChangeIds: Array.isArray(body.acceptedChangeIds)
        ? (body.acceptedChangeIds as string[])
        : null,
      targetJobId: typeof body.targetJobId === 'string' ? body.targetJobId : undefined,
      targetCompany: typeof body.targetCompany === 'string' ? body.targetCompany : undefined,
      targetTitle: typeof body.targetTitle === 'string' ? body.targetTitle : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
    });
    return res.status(201).json({ resume });
  } catch (err) {
    if (err instanceof ResumeNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err instanceof ResumeValidationError) {
      return res.status(422).json({ error: err.message });
    }
    logger.error('RA_V2_RESUMES', 'tailorApply failed', {
      userId: req.user?.id,
      resumeId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

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
