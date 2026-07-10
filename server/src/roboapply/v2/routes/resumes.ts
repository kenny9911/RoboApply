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
//   GET    /:id/coach-tips  — V3 editor coach tips (free, deterministic)
//
// Quota note: `tailored_for_jd` create + `/rewrite` + `/tailor-diff` are
// LLM ops — they write a `ra_resume_tailor` deduction row on SUCCESS only
// (failures / graceful fallbacks pay zero). `/coach-tips` is free.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireAuth } from '../lib/raAuth.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { renderResumePdf, renderResumeDocx } from '../lib/resumeExport.js';
import { logger } from '../../../services/LoggerService.js';
import {
  isAcceptedResumeUpload,
  readCandidateResumeOriginal,
} from '../../../lib/candidateResumeIngest.js';
import { isLinkedInUrlImportConfigured } from '../../../lib/linkedin/linkedInImport.js';
import {
  raResumeService,
  ResumeInUseError,
  ResumeNotFoundError,
  ResumeUploadError,
  ResumeValidationError,
  type RAResumeKind,
  type ResumeCreateInput,
} from '../services/RAResumeService.js';
import {
  raResumeAIService,
  ResumeNotFoundError as ResumeAINotFoundError,
  RewriteValidationError,
  type RewriteInput,
  type TailorDiffInput,
} from '../services/RAResumeAIService.js';

const router = Router();

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
router.post('/upload', requireAuth, handleResumeUpload, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(422).json({ error: 'file_required', code: 'file_required' });
    }
    const nameRaw = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const resume = await raResumeService.uploadAndCreate(userId, {
      buffer: file.buffer,
      fileName: file.originalname || 'resume',
      mimeType: file.mimetype || 'application/octet-stream',
      name: nameRaw || undefined,
      requestId: (req as any).requestId,
    });
    return res.status(201).json({ resume });
  } catch (err) {
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

// ── Import from LinkedIn ────────────────────────────────────────────────────
// GET  /import-linkedin/config — whether this deployment offers URL import.
// POST /import-linkedin        — mode 'pdf' (Save-to-PDF upload) | 'url'
//                                (config-gated enrichment fetch). FREE, like
//                                /upload. URL mode 422s `url_import_not_configured`
//                                until LINKEDIN_ENRICH_API_KEY is set.
// Registered before GET /:id (distinct multi-segment paths; order kept for clarity).
router.get('/import-linkedin/config', requireAuth, (_req: Request, res: Response) => {
  return res.json({ urlImportEnabled: isLinkedInUrlImportConfigured() });
});

router.post('/import-linkedin', requireAuth, handleResumeUpload, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const file = (req as Request & { file?: Express.Multer.File }).file;
    const modeRaw = typeof req.body?.mode === 'string' ? req.body.mode : '';
    const mode: 'pdf' | 'url' =
      modeRaw === 'url' || modeRaw === 'pdf' ? modeRaw : file ? 'pdf' : 'url';
    const linkedinUrl =
      typeof req.body?.linkedinUrl === 'string' ? req.body.linkedinUrl.trim() : '';
    const nameRaw = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

    const resume = await raResumeService.importFromLinkedIn(userId, {
      mode,
      buffer: file?.buffer,
      fileName: file?.originalname,
      mimeType: file?.mimetype,
      linkedinUrl: linkedinUrl || undefined,
      name: nameRaw || undefined,
      requestId: (req as any).requestId,
    });
    return res.status(201).json({ resume });
  } catch (err) {
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

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const resume = await raResumeService.getById(userId, req.params.id);
    return res.json({ resume });
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

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
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

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
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
router.post('/:id/primary', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const resume = await raResumeService.setPrimary(userId, req.params.id);
    return res.json({ resume });
  } catch (err) {
    if (err instanceof ResumeNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
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
router.get('/:id/original-file', requireAuth, async (req: Request, res: Response) => {
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

// GET /:id/export?format=pdf — render the variant's CURRENT markdown to a
// real downloadable file (owner-only). Unlike /original-file (which echoes the
// uploaded bytes), this exports the BUILT/TAILORED resume itself. PDF today;
// docx is added alongside renderResumeDocx.
router.get('/:id/export', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const format = String(req.query.format ?? 'pdf').toLowerCase();
    if (format !== 'pdf' && format !== 'docx') {
      return res.status(422).json({ error: 'unsupported_format', supported: ['pdf', 'docx'] });
    }
    const variant = await raResumeService.getById(userId, req.params.id);
    const markdown = variant.resumeMarkdown ?? '';
    const isPdf = format === 'pdf';
    const buffer = isPdf ? await renderResumePdf(markdown) : await renderResumeDocx(markdown);
    const ext = isPdf ? 'pdf' : 'docx';
    const contentType = isPdf
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    // ASCII filename for legacy clients + RFC 5987 filename* for CJK names.
    const rawName = (variant.name || 'resume').trim() || 'resume';
    const asciiName =
      rawName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\/]/g, '_').trim() || 'resume';
    const encoded = encodeURIComponent(rawName);
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}.${ext}"; filename*=UTF-8''${encoded}.${ext}`,
    );
    return res.send(buffer);
  } catch (err) {
    if (err instanceof ResumeNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
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
router.post('/:id/rewrite', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as RewriteInput;
    const result = await raResumeAIService.rewrite(userId, req.params.id, body, getRequestLocale(req));
    return res.json(result);
  } catch (err) {
    if (err instanceof ResumeAINotFoundError) {
      return res.status(404).json({ error: 'not_found' });
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
router.post('/:id/tailor-diff', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as TailorDiffInput;
    const result = await raResumeAIService.tailorDiff(userId, req.params.id, body, getRequestLocale(req));
    return res.json(result);
  } catch (err) {
    if (err instanceof ResumeAINotFoundError) {
      return res.status(404).json({ error: 'not_found' });
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
router.post('/:id/tailor-apply', requireAuth, async (req: Request, res: Response) => {
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
router.get('/:id/coach-tips', requireAuth, async (req: Request, res: Response) => {
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
