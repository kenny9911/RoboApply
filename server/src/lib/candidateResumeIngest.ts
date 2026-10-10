// server/src/lib/candidateResumeIngest.ts
//
// Candidate-app resume ingest. Reuses RoboHire's PURE parse functions — text
// extraction → ResumeParseAgent → summary — WITHOUT touching the recruiter
// `Resume` table or recruiter match quota. Original bytes are persisted to
// candidate-scoped object storage (a distinct keyspace, so they never
// co-mingle with recruiter resume originals).
//
// Residency (TASK_PLAN.md WP-15, REQ-WP15-03): the brand of the upload decides
// where the file may be parsed and what may be stored.
//   - GoHire's parse service is called only for a brand it is switched on for,
//     with that brand passed explicitly, and never for a RoboApply upload
//     when the caller sets `forceLocalParser` (a user without the cross-border
//     consent). GoApply ignores that flag: GoHire is its in-country parser.
//   - GoApply images go to GoHire only; when it cannot read one the upload
//     fails (`image_parse_unavailable`). No local vision OCR for them.
//   - After parse and summary, on EVERY path, `applyResumeUploadPolicy(brand, …)`
//     decides what is handed back for storage: on GoApply offshore (CN-0)
//     government ID numbers and health details are redacted and photo fields
//     dropped, and no original file is kept.
//   - The original goes to the brand's own bucket, or nowhere.
//
// Lives in `lib/` on purpose: the boundary-locked V2 routes
// (server/src/roboapply/v2/*) may import `lib/*` but NOT `services/*`
// (scripts/check-roboapply-v2-boundary.mjs). This module is the single seam
// through which V2 reaches PDFService / DocumentParsingService /
// ResumeSummaryService / ResumeOriginalFileStorageService.
//
// Quota: parsing is FREE (mirrors recruiter upload-parse, which also does not
// debit match quota). No writeDeductionLog here. The caller keeps the per-user
// daily upload cap (RAResumeService).

import path from 'node:path';
import { pdfService } from '../services/PDFService.js';
import { documentParsingService, DocumentParsingService } from '../services/DocumentParsingService.js';
import { resumeParseAgent } from '../agents/ResumeParseAgent.js';
import { goHireResumeParseService } from '../services/GoHireResumeParseService.js';
import { generateResumeSummaryHighlight } from '../services/ResumeSummaryService.js';
import { normalizeExtractedText } from '../services/ResumeParserService.js';
import {
  resumeOriginalFileStorageService,
  type ResumeOriginalFileRef,
} from '../services/ResumeOriginalFileStorageService.js';
import { logger } from '../services/LoggerService.js';
import { getBrand, type BrandId } from '../platform/brand/registry.js';
import { applyResumeUploadPolicy, isImageUpload } from '../platform/residency/uploadPolicy.js';
import { resolveWriteBrand } from '../platform/residency/writeBrand.js';
import type { ParsedResume, SkillsDetailed } from '../types/index.js';

// Candidate resume originals get their OWN keyspace so they are never
// co-mingled with recruiter resume originals in the bucket.
const CANDIDATE_KEYSPACE = 'roboapply-resumes';

// PostgreSQL rejects the NUL byte (0x00) in TEXT columns AND in jsonb strings
// ("unsupported Unicode escape sequence"). PDF extraction and LLM output can
// carry NUL + other C0 control chars, which would make the RAResumeVariant
// create throw a 500. Strip them from EVERY value before it is persisted.
// Tab (9), newline (10) and CR (13) are preserved.
function stripControl(input: string): string {
  let out = '';
  for (let k = 0; k < input.length; k += 1) {
    const c = input.charCodeAt(k);
    if (c === 9 || c === 10 || c === 13 || c > 31) out += input[k];
  }
  return out;
}

/** Coerce any value to a string (LLM fields are not guaranteed to be strings). */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

/** Strip DB-unsafe control chars from a value coerced to string. */
function cleanText(s: unknown): string {
  return stripControl(str(s));
}

/** Recursively strip DB-unsafe control chars from every string in a value so a
 *  jsonb column (parsedData) can never receive a NUL byte. */
function deepClean<T>(value: T): T {
  if (typeof value === 'string') return stripControl(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepClean(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = deepClean((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

export class CandidateResumeIngestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CandidateResumeIngestError';
    this.code = code;
  }
}

export interface CandidateResumeOriginalRef {
  provider: string;
  key: string;
  fileName: string;
  mimeType: string;
  size: number;
  checksum: string;
}

export interface CandidateResumeIngestResult {
  rawText: string;
  parsed: ParsedResume;
  summary: string;
  highlight: string;
  markdown: string;
  /** Best display name: parsed name → cleaned filename → fallback. */
  displayName: string;
  original: CandidateResumeOriginalRef | null;
}

/** Whether an uploaded file is an accepted resume document. Delegates to the
 *  recruiter-side accepted-MIME list (PDF / DOCX / XLSX / TXT / MD / JSON). */
export function isAcceptedResumeUpload(mimetype: string, filename?: string): boolean {
  return DocumentParsingService.isAcceptedUpload(mimetype, filename);
}

async function extractText(
  buffer: Buffer,
  mimetype: string,
  filename: string,
  requestId?: string,
): Promise<string> {
  if (mimetype === 'application/pdf') {
    return pdfService.extractText(buffer, requestId);
  }
  return documentParsingService.extractText(buffer, mimetype, filename, requestId);
}

/**
 * Run the full candidate ingest: extract → parse → summarize → (optionally)
 * store the original. Throws CandidateResumeIngestError on unrecoverable
 * extraction/parse failures; summary + original-file failures are non-fatal.
 */
export async function ingestCandidateResume(params: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  userId: string;
  requestId?: string;
  /** Persist the original bytes to candidate-scoped storage. Default true. */
  storeOriginal?: boolean;
  /** Optional source-specific transform applied to the extracted text BEFORE
   *  parsing (e.g. a LinkedIn "Save to PDF" footer cleaner). Runs after the
   *  standard normalize + control-byte strip. Must be a pure, non-throwing
   *  string→string fn; a throw is swallowed and the untransformed text is used. */
  textTransform?: (raw: string) => string;
  /** Caller's selected UI locale. Threaded ONLY into the summary/highlight LLM
   *  call — extraction and parsing are language-agnostic, but the summary is
   *  user-facing prose rendered on the résumé card, so it must come back in the
   *  locale the user is reading the app in (not the résumé's own language). */
  locale?: string | null;
  /** Brand that owns the upload (default: the brand of the current request or unit of work). */
  brand?: BrandId;
  /**
   * RoboApply: read the file with the local parser only, with no call to the
   * GoHire parse service. Set for a RoboApply user who has not agreed to
   * `intl_cross_border_cn_parse`, or when the caller asks for the local parser.
   * Ignored on GoApply: GoHire is the in-country parser there, and the local
   * pipeline can end in vision OCR on a scanned PDF, which GoApply does not use.
   */
  forceLocalParser?: boolean;
}): Promise<CandidateResumeIngestResult> {
  const { buffer, fileName, mimeType, userId, requestId, textTransform } = params;

  // Residency (TASK_PLAN.md WP-15, REQ-WP15-03). The brand decides where the
  // file may be parsed and what may be stored. When it cannot be known (no
  // request context on a deployment that serves both brands) the stricter
  // GoApply rule applies: nothing goes to GoHire or to a bucket, and the text
  // is redacted before it is returned.
  const brandId = resolveWriteBrand(params.brand);
  const policyBrand: BrandId = brandId ?? 'goapply';
  const cnMarket = getBrand(policyBrand).market === 'cn';
  const imageUpload = isImageUpload(mimeType, fileName);

  // 1+2. Extract text, then parse to structured JSON.
  //
  // PREFERRED PATH: GoHire's parse-resume endpoint does both in ONE call and is
  // the primary route for plain PDF uploads where the brand may use it. The
  // local pipeline (pdftotext → rasterize → vision-LLM OCR → ResumeParseAgent)
  // is not reliable on image-only scans: the vision model can return text that
  // is not on the page. See GoHireResumeParseService.
  //
  // The LinkedIn import path is deliberately excluded: it supplies a
  // `textTransform` that strips "Save to PDF" footers from the extracted text
  // BEFORE parsing, and a remote parse returns text and structure together with
  // no seam to apply it. That path keeps the local pipeline.
  //
  // GoApply images go to GoHire only (CN plan G-resume): an image is never
  // handed to local vision OCR. When GoHire cannot read it the upload fails.
  let rawText: string;
  let parsed: ParsedResume | undefined;

  const cnImage = cnMarket && imageUpload;
  // The local-parser flag is a RoboApply privacy choice; it never takes a
  // GoApply file off the in-country parser.
  const forceLocal = params.forceLocalParser === true && !cnMarket;
  const useRemote = cnImage || (!textTransform && !forceLocal);
  const remoteParse = useRemote && brandId
    ? await goHireResumeParseService.parseResumeFile({
        buffer,
        fileName,
        mimeType,
        requestId,
        brand: brandId,
        allowImages: cnImage,
      })
    : null;

  if (cnImage && !remoteParse) {
    throw new CandidateResumeIngestError(
      'image_parse_unavailable',
      'This image could not be read right now. Upload a PDF or Word file instead.',
    );
  }

  if (remoteParse) {
    rawText = cleanText(normalizeExtractedText(remoteParse.rawText));
    parsed = remoteParse.parsed;
  } else {
    // FALLBACK: local extraction (pure; no DB, no quota). cleanText strips
    // DB-unsafe control bytes so the persisted rawText can never carry a NUL.
    try {
      rawText = cleanText(normalizeExtractedText(await extractText(buffer, mimeType, fileName, requestId)));
      if (textTransform) {
        try {
          rawText = cleanText(textTransform(rawText));
        } catch (transformErr) {
          logger.warn(
            'RA_RESUME_INGEST',
            'textTransform failed; using untransformed text',
            { userId, error: transformErr instanceof Error ? transformErr.message : String(transformErr) },
            requestId,
          );
        }
      }
    } catch (err) {
      throw new CandidateResumeIngestError(
        'extract_failed',
        err instanceof Error ? err.message : 'Could not read the file',
      );
    }
  }

  if (!rawText || rawText.trim().length < 20) {
    throw new CandidateResumeIngestError('empty_text', 'No readable text found in the file');
  }

  if (!parsed) {
    // Parse → structured JSON (pure; deterministic heuristic fallback inside).
    try {
      parsed = await resumeParseAgent.parse(rawText, requestId);
    } catch (err) {
      throw new CandidateResumeIngestError(
        'parse_failed',
        err instanceof Error ? err.message : 'Could not parse the résumé',
      );
    }
  }
  // Deep-clean every string in the parse so the jsonb `parsedData` column can
  // never receive a NUL byte (PostgreSQL rejects it → 500).
  parsed = deepClean(parsed);

  // 3. Summary + highlight (pure; deterministic fallback inside — non-fatal).
  let summary = '';
  let highlight = '';
  try {
    const s = await generateResumeSummaryHighlight(parsed, requestId, params.locale);
    summary = cleanText(s.summary);
    highlight = cleanText(s.highlight);
  } catch (err) {
    logger.warn(
      'RA_RESUME_INGEST',
      'summary generation failed; continuing without summary',
      { userId, error: err instanceof Error ? err.message : String(err) },
      requestId,
    );
  }

  // Serialize to markdown defensively — a malformed parse must never 500.
  let markdown: string;
  try {
    markdown = cleanText(parsedResumeToMarkdown(parsed, rawText));
  } catch (err) {
    logger.warn(
      'RA_RESUME_INGEST',
      'markdown serialization failed; falling back to raw text',
      { userId, error: err instanceof Error ? err.message : String(err) },
      requestId,
    );
    markdown = rawText;
  }
  if (!markdown.trim()) markdown = rawText;

  // 4. The brand's storage rule, on EVERY path (GoHire, local PDF fallback,
  // Word/text, LinkedIn text): on GoApply offshore (CN-0) government ID numbers
  // and health details are redacted and photo fields dropped before anything is
  // handed back for storage. RoboApply content comes back as parsed.
  const applied = applyResumeUploadPolicy(policyBrand, { rawText, markdown, parsed, summary, highlight });
  rawText = applied.rawText;
  markdown = applied.markdown ?? markdown;
  parsed = applied.parsed ?? parsed;
  summary = applied.summary ?? '';
  highlight = applied.highlight ?? '';

  const displayName =
    str(parsed.name).trim() || cleanNameFromFilename(fileName) || 'My résumé';

  // 5. Persist original bytes to the brand's own storage (best-effort). Never
  // when the brand's rule says discard, and never without a known brand.
  const storeOriginal = params.storeOriginal !== false && applied.storeOriginal && Boolean(brandId);
  let original: CandidateResumeOriginalRef | null = null;
  if (storeOriginal && brandId && resumeOriginalFileStorageService.isConfigured(brandId)) {
    try {
      const stored = await resumeOriginalFileStorageService.saveFile({
        buffer,
        fileName,
        mimeType,
        size: buffer.byteLength,
        userId,
        requestId,
        keyspace: CANDIDATE_KEYSPACE,
        brand: brandId,
      });
      if (stored) {
        original = {
          provider: stored.provider,
          key: stored.key,
          fileName: stored.fileName,
          mimeType: stored.mimeType,
          size: stored.size,
          checksum: stored.checksum,
        };
      }
    } catch (err) {
      logger.warn(
        'RA_RESUME_INGEST',
        'original file storage failed; keeping parsed result',
        { userId, error: err instanceof Error ? err.message : String(err) },
        requestId,
      );
    }
  }

  return { rawText, parsed, summary, highlight, markdown, displayName, original };
}

/** Download a previously-stored candidate resume original. */
export async function readCandidateResumeOriginal(
  ref: ResumeOriginalFileRef,
  requestId?: string,
): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  return resumeOriginalFileStorageService.readFile(ref, requestId);
}

// ── Serialization ──────────────────────────────────────────────────────────

function skillsToLines(skills: ParsedResume['skills']): string[] {
  if (!skills) return [];
  if (Array.isArray(skills)) {
    const flat = skills.map((s) => String(s).trim()).filter(Boolean);
    return flat.length ? [flat.join(' · ')] : [];
  }
  const detailed = skills as SkillsDetailed;
  const out: string[] = [];
  const groups: Array<[string, string[] | undefined]> = [
    ['Technical', detailed.technical],
    ['Frameworks', detailed.frameworks],
    ['Tools', detailed.tools],
    ['Languages', detailed.languages],
    ['Soft skills', detailed.soft],
    ['Other', detailed.other],
  ];
  for (const [label, arr] of groups) {
    const vals = (Array.isArray(arr) ? arr : []).map((s) => str(s).trim()).filter(Boolean);
    if (vals.length) out.push(`**${label}:** ${vals.join(' · ')}`);
  }
  return out;
}

/**
 * Deterministically render a ParsedResume to markdown so an uploaded résumé
 * works immediately with the rest of the V2 surface (editor / tailor / match,
 * all of which key off `resumeMarkdown`). No LLM call.
 */
export function parsedResumeToMarkdown(parsed: ParsedResume, fallbackText?: string): string {
  const lines: string[] = [];
  const name = str(parsed.name).trim();
  if (name) lines.push(`# ${name}`);

  const contact = [parsed.email, parsed.phone, parsed.address, parsed.linkedin, parsed.github, parsed.portfolio]
    .map((s) => str(s).trim())
    .filter(Boolean);
  if (contact.length) lines.push('', contact.join(' · '));

  const summaryText = str(parsed.summary).trim();
  if (summaryText) {
    lines.push('', '## Summary', '', summaryText);
  }

  const skillLines = skillsToLines(parsed.skills);
  if (skillLines.length) lines.push('', '## Skills', '', ...skillLines);

  if (Array.isArray(parsed.experience) && parsed.experience.length) {
    lines.push('', '## Experience');
    for (const e of parsed.experience) {
      const header = [e.role, e.company].filter(Boolean).join(' — ');
      const when = e.duration || [e.startDate, e.endDate].filter(Boolean).join(' – ');
      const meta = [when, e.location].filter(Boolean).join(' · ');
      lines.push('', `**${header || 'Role'}**${meta ? ` · ${meta}` : ''}`);
      const bullets = Array.isArray(e.achievements) && e.achievements.length
        ? e.achievements
        : e.description ? [e.description] : [];
      for (const b of bullets) {
        const t = str(b).trim();
        if (t) lines.push(`- ${t}`);
      }
    }
  }

  if (Array.isArray(parsed.projects) && parsed.projects.length) {
    lines.push('', '## Projects');
    for (const p of parsed.projects) {
      const meta = [p.role, p.date].filter(Boolean).join(' · ');
      lines.push('', `**${p.name || 'Project'}**${meta ? ` · ${meta}` : ''}`);
      if (p.description) lines.push(`- ${str(p.description).trim()}`);
      if (Array.isArray(p.technologies) && p.technologies.length) {
        lines.push(`- _${p.technologies.map((x) => str(x)).join(', ')}_`);
      }
    }
  }

  if (Array.isArray(parsed.education) && parsed.education.length) {
    lines.push('', '## Education');
    for (const ed of parsed.education) {
      const degree = [ed.degree, ed.field].filter(Boolean).join(', ');
      const when = ed.year || [ed.startDate, ed.endDate].filter(Boolean).join(' – ');
      const inst = [ed.institution, when].filter(Boolean).join(' · ');
      lines.push('', `**${inst || ed.institution || 'Education'}**${degree ? ` — ${degree}` : ''}`);
      for (const a of Array.isArray(ed.achievements) ? ed.achievements : []) {
        const t = str(a).trim();
        if (t) lines.push(`- ${t}`);
      }
    }
  }

  if (Array.isArray(parsed.certifications) && parsed.certifications.length) {
    lines.push('', '## Certifications');
    for (const c of parsed.certifications) {
      const meta = [c.issuer, c.date].filter(Boolean).join(' · ');
      lines.push(`- ${c.name}${meta ? ` (${meta})` : ''}`);
    }
  }

  if (Array.isArray(parsed.awards) && parsed.awards.length) {
    lines.push('', '## Awards');
    for (const a of parsed.awards) {
      const meta = [a.issuer, a.date].filter(Boolean).join(' · ');
      lines.push(`- ${a.name}${meta ? ` (${meta})` : ''}`);
    }
  }

  if (Array.isArray(parsed.languages) && parsed.languages.length) {
    const langs = parsed.languages
      .map((l) => [l.language, l.proficiency].filter(Boolean).join(' — '))
      .filter(Boolean);
    if (langs.length) lines.push('', '## Languages', '', langs.join(' · '));
  }

  const md = lines.join('\n').trim();
  // If the parse was so sparse that we rendered no real section body (only a
  // name/contact header, e.g. a name-only LLM parse), fall back to the raw
  // extracted text so the résumé content isn't lost from the editor / tailor /
  // match surfaces (which all read resumeMarkdown, not rawText).
  const hasSectionBody = /^##\s/m.test(md);
  if (hasSectionBody) return md;
  const fallback = fallbackText?.trim();
  return fallback || md;
}

function cleanNameFromFilename(filename: string): string {
  const base = path.basename(filename || '', path.extname(filename || ''));
  return base
    .replace(/[_\-]+/g, ' ')
    .replace(/\b(resume|cv|c\.v\.|curriculum vitae|简历|履歴書|이력서)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
