// backend/src/lib/candidateResumeIngest.ts
//
// Candidate-app (RoboApply) resume ingest. Reuses RoboHire's PURE parse
// functions — text extraction → ResumeParseAgent → summary — WITHOUT touching
// the recruiter `Resume` table or recruiter match quota. Original bytes are
// persisted to candidate-scoped object storage (a distinct keyspace, so they
// never co-mingle with recruiter resume originals).
//
// Lives in `lib/` on purpose: the boundary-locked V2 routes
// (backend/src/roboapply/v2/*) may import `lib/*` but NOT `services/*`
// (scripts/check-roboapply-v2-boundary.mjs). This module is the single seam
// through which V2 reaches PDFService / DocumentParsingService /
// ResumeSummaryService / ResumeOriginalFileStorageService.
//
// Quota: parsing is FREE (mirrors recruiter upload-parse, which also does not
// debit match quota). No writeDeductionLog here. The only billable RoboApply
// resume op remains `ra_resume_tailor` in RAResumeService.

import path from 'node:path';
import { pdfService } from '../services/PDFService.js';
import { documentParsingService, DocumentParsingService } from '../services/DocumentParsingService.js';
import { resumeParseAgent } from '../agents/ResumeParseAgent.js';
import { generateResumeSummaryHighlight } from '../services/ResumeSummaryService.js';
import { normalizeExtractedText } from '../services/ResumeParserService.js';
import {
  resumeOriginalFileStorageService,
  type ResumeOriginalFileRef,
} from '../services/ResumeOriginalFileStorageService.js';
import { logger } from '../services/LoggerService.js';
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
}): Promise<CandidateResumeIngestResult> {
  const { buffer, fileName, mimeType, userId, requestId, textTransform } = params;
  const storeOriginal = params.storeOriginal !== false;

  // 1. Extract text (pure; no DB, no quota). cleanText strips DB-unsafe
  // control bytes so the persisted rawText can never carry a NUL.
  let rawText: string;
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
  if (!rawText || rawText.trim().length < 20) {
    throw new CandidateResumeIngestError('empty_text', 'No readable text found in the file');
  }

  // 2. Parse → structured JSON (pure; deterministic heuristic fallback inside).
  let parsed: ParsedResume;
  try {
    parsed = await resumeParseAgent.parse(rawText, requestId);
  } catch (err) {
    throw new CandidateResumeIngestError(
      'parse_failed',
      err instanceof Error ? err.message : 'Could not parse the résumé',
    );
  }
  // Deep-clean every string in the parse so the jsonb `parsedData` column can
  // never receive a NUL byte (PostgreSQL rejects it → 500).
  parsed = deepClean(parsed);

  // 3. Summary + highlight (pure; deterministic fallback inside — non-fatal).
  let summary = '';
  let highlight = '';
  try {
    const s = await generateResumeSummaryHighlight(parsed, requestId);
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
  const displayName =
    str(parsed.name).trim() || cleanNameFromFilename(fileName) || 'My résumé';

  // 4. Persist original bytes to candidate-scoped storage (best-effort).
  let original: CandidateResumeOriginalRef | null = null;
  if (storeOriginal && resumeOriginalFileStorageService.isConfigured()) {
    try {
      const stored = await resumeOriginalFileStorageService.saveFile({
        buffer,
        fileName,
        mimeType,
        size: buffer.byteLength,
        userId,
        requestId,
        keyspace: CANDIDATE_KEYSPACE,
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
