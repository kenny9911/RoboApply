// server/src/lib/candidateResumeIngest.ts
//
// Candidate-app resume ingest. Reuses RoboHire's PURE parse functions — text
// extraction → ResumeParseAgent → summary — WITHOUT touching the recruiter
// `Resume` table or recruiter match quota. Original bytes are persisted to
// candidate-scoped object storage (a distinct keyspace, so they never
// co-mingle with recruiter resume originals).
//
// Brand rules (TASK_PLAN.md WP-15, REQ-WP15-03; D5, GOAPPLY_PARITY_PLAN.md
// §3.6): the brand of the upload decides which parser is tried first and
// where the file is kept. The capability is the same on both brands.
//   - The brand is the explicit one, else the unit of work's, else the stored
//     brand of the owning user (`resolveOwnerWriteBrand`). A worker with no
//     brand context therefore still files a GoApply upload as GoApply.
//   - GoHire's parse service is called only for a brand it is switched on for,
//     with that brand passed explicitly, and never for a RoboApply upload
//     when the caller sets `forceLocalParser` (a user without the cross-border
//     consent). GoApply ignores that flag: GoHire is its preferred parser.
//   - GoHire is a preference, not a requirement. When it is not configured or
//     cannot read the file, a GoApply PDF or image is read by the local
//     pipeline, exactly as on RoboApply.
//   - After parse and summary, on EVERY path, `applyResumeUploadPolicy(brand, …)`
//     decides what is handed back for storage. By default nothing changes on
//     either brand; GoApply under `CN_STORAGE_MODE=redact|discard` has
//     government ID numbers and health details removed first.
//   - The original goes to the store the brand writes to (GoApply: its own
//     bucket, else the shared store under `goapply/`), or nowhere when the
//     brand's rule says so.
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
import { resolveOwnerWriteBrand } from '../platform/residency/writeBrand.js';
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
   * Ignored on GoApply: GoHire is its preferred parser, tried first whenever
   * it is configured (the local pipeline is the fallback).
   */
  forceLocalParser?: boolean;
}): Promise<CandidateResumeIngestResult> {
  const { buffer, fileName, mimeType, userId, requestId, textTransform } = params;

  // The brand decides which parser is tried first and where the file is kept
  // (see the header). Explicit brand, else the unit of work, else the owning
  // user's stored brand. When it still cannot be known (no context, no such
  // user, a deployment that serves both brands) nothing goes to GoHire or to a
  // bucket, and GoApply's storage rule applies to the text: it is the one an
  // operator may have tightened (CN_STORAGE_MODE).
  const brandId = await resolveOwnerWriteBrand(params.brand, userId);
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
  // GoApply images go to GoHire first (wrapped into a one-page PDF). When
  // GoHire is not configured or cannot read one, the image is read by the
  // local pipeline, as a RoboApply image is.
  let rawText: string;
  let parsed: ParsedResume | undefined;

  const cnImage = cnMarket && imageUpload;
  // The local-parser flag is a RoboApply privacy choice; it never takes a
  // GoApply file off its preferred parser.
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
  // Word/text, LinkedIn text). By default the content comes back as parsed on
  // both brands. GoApply under CN_STORAGE_MODE=redact|discard: government ID
  // numbers and health details are redacted (and under discard photo fields
  // dropped) before anything is handed back for storage.
  const applied = applyResumeUploadPolicy(policyBrand, { rawText, markdown, parsed, summary, highlight });
  rawText = applied.rawText;
  markdown = applied.markdown ?? markdown;
  parsed = applied.parsed ?? parsed;
  summary = applied.summary ?? '';
  highlight = applied.highlight ?? '';

  const displayName =
    str(parsed.name).trim() || cleanNameFromFilename(fileName) || 'My résumé';

  // 5. Persist original bytes to the store the brand writes to (best-effort).
  // Never when the brand's rule says discard, and never without a known brand.
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

/** The language the stored markdown's section titles and skill labels are written in. */
export type ResumeDocLanguage = 'en' | 'zh' | 'zh-TW';

type DocHeading = 'summary' | 'skills' | 'experience' | 'internship' | 'projects' | 'education' | 'certifications' | 'awards' | 'languages';
type SkillGroupKey = 'technical' | 'frameworks' | 'tools' | 'languages' | 'soft' | 'other';

/**
 * Section titles by resume language. The zh / zh-TW titles are the ones the
 * guided builder writes (features/resume/builder/sections.ts) and the editor,
 * the export and Resume check all recognise.
 */
const DOC_HEADINGS: Record<ResumeDocLanguage, Record<DocHeading, string>> = {
  en: {
    summary: 'Summary',
    skills: 'Skills',
    experience: 'Experience',
    internship: 'Experience',
    projects: 'Projects',
    education: 'Education',
    certifications: 'Certifications',
    awards: 'Awards',
    languages: 'Languages',
  },
  zh: {
    summary: '个人总结',
    skills: '专业技能',
    experience: '工作经历',
    internship: '实习经历',
    projects: '项目经历',
    education: '教育背景',
    certifications: '证书',
    awards: '获奖情况',
    languages: '语言能力',
  },
  'zh-TW': {
    summary: '個人摘要',
    skills: '專長',
    experience: '工作經歷',
    internship: '實習經歷',
    projects: '專案經歷',
    education: '學歷',
    certifications: '證照',
    awards: '獲獎紀錄',
    languages: '語言能力',
  },
};

const SKILL_GROUP_LABELS: Record<ResumeDocLanguage, Record<SkillGroupKey, string>> = {
  en: { technical: 'Technical', frameworks: 'Frameworks', tools: 'Tools', languages: 'Languages', soft: 'Soft skills', other: 'Other' },
  zh: { technical: '技术', frameworks: '框架', tools: '工具', languages: '语言', soft: '软技能', other: '其他' },
  'zh-TW': { technical: '技術', frameworks: '框架', tools: '工具', languages: '語言', soft: '軟實力', other: '其他' },
};

const HAN_RE = /[㐀-鿿]/g;
const TRADITIONAL_RE = /[個學實經專證歷與為這國從來時們說對開關點數據業務責體發現應網絡資訊軟設計畫團隊優勢領導項驗語執環維護測試動態產銷運營]/g;
const SIMPLIFIED_RE = /[个学实经专证历与为这国从来时们说对开关点数据业务责体发现应网络资讯软设计划团队优势领导项验语执环维护测试动态产销运营]/g;

/**
 * The language a parsed resume is written in, from its own text (summary,
 * roles, bullets, schools): a Chinese resume gets Chinese section titles.
 * Japanese and Korean resumes keep the English titles (no title set for them).
 */
export function resumeDocLanguage(parsed: ParsedResume, fallbackText = ''): ResumeDocLanguage {
  const parts: string[] = [str(parsed.summary)];
  for (const e of Array.isArray(parsed.experience) ? parsed.experience : []) {
    parts.push(str(e.role), str(e.description), ...(Array.isArray(e.achievements) ? e.achievements.map(str) : []));
  }
  for (const p of Array.isArray(parsed.projects) ? parsed.projects : []) parts.push(str(p.name), str(p.description));
  for (const ed of Array.isArray(parsed.education) ? parsed.education : []) parts.push(str(ed.institution), str(ed.degree), str(ed.field));
  let text = parts.join(' ');
  if (text.replace(/\s/g, '').length < 20) text = fallbackText;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const han = (text.match(HAN_RE) ?? []).length;
  if (letters === 0 || han < letters * 0.2) return 'en';
  if (/[぀-ヿ]/.test(text) || /[가-힯]/.test(text)) return 'en';
  const traditional = (text.match(TRADITIONAL_RE) ?? []).length;
  const simplified = (text.match(SIMPLIFIED_RE) ?? []).length;
  return traditional > simplified ? 'zh-TW' : 'zh';
}

/**
 * One bullet's text. A bullet glyph the parser kept from the source file
 * ("· 负责…", "• Built…") is dropped: the markdown already marks the line
 * with "- ", and the export would print two marks ("• ·").
 */
function bulletText(v: unknown): string {
  return str(v).trim().replace(/^(?:[·•▪◦●○■□◆▶➢]|[-–—*]\s)\s*/, '').trim();
}

function skillsToLines(skills: ParsedResume['skills'], lang: ResumeDocLanguage = 'en'): string[] {
  if (!skills) return [];
  if (Array.isArray(skills)) {
    const flat = skills.map((s) => String(s).trim()).filter(Boolean);
    return flat.length ? [flat.join(' · ')] : [];
  }
  const detailed = skills as SkillsDetailed;
  const out: string[] = [];
  const L = SKILL_GROUP_LABELS[lang];
  const colon = lang === 'en' ? ':' : '：';
  const groups: Array<[string, string[] | undefined]> = [
    [L.technical, detailed.technical],
    [L.frameworks, detailed.frameworks],
    [L.tools, detailed.tools],
    [L.languages, detailed.languages],
    [L.soft, detailed.soft],
    [L.other, detailed.other],
  ];
  for (const [label, arr] of groups) {
    const vals = (Array.isArray(arr) ? arr : []).map((s) => str(s).trim()).filter(Boolean);
    if (vals.length) out.push(`**${label}${colon}** ${vals.join(' · ')}`);
  }
  return out;
}

/** A year, or a year-and-month, anywhere in the text ("2019", "2019-03", "2019年3月", "Mar 2019"). */
const DATE_IN_TEXT = /(?:19|20)\d{2}/;

/**
 * When a role ran, as the resume line shows it. A parser may put a computed
 * length in `duration` ("4 years 8 months") beside the real `startDate` and
 * `endDate`; a line with no date on it loses the role's years everywhere the
 * markdown is read (the editor, Resume check, the keyword report). So the
 * dates win over a `duration` that holds no date. A `duration` that carries a
 * date range ("2019.03 - 2023.06") is kept as written.
 */
function experienceWhen(e: { duration?: unknown; startDate?: unknown; endDate?: unknown }): string {
  const duration = str(e.duration).trim();
  const dates = [e.startDate, e.endDate].map((d) => str(d).trim()).filter(Boolean).join(' – ');
  if (duration && (DATE_IN_TEXT.test(duration) || !str(e.startDate).trim())) return duration;
  return dates || duration;
}

/** True when every role is an internship (a student resume: the section is 实习经历). */
function allInternships(experience: ParsedResume['experience']): boolean {
  const list = Array.isArray(experience) ? experience : [];
  return list.length > 0 && list.every((e) => e.employmentType === 'internship' || /实习|實習|\bintern(?:ship)?\b/i.test(str(e.role)));
}

/**
 * The stored resume markdown for a parsed upload.
 *
 * Format contract (lib/resumeStructure.ts reads exactly this, and a test
 * round-trips it through the editor's parser and serializer):
 *   **Role — Company** · When · Location     experience head
 *   **School · When** — Degree, Field        education head
 *   **Label:** a · b                         one skills line per group
 * Section titles and skill labels follow the resume's own language
 * (`resumeDocLanguage`): a Chinese resume is not given English headings.
 */
export function parsedResumeToMarkdown(parsed: ParsedResume, fallbackText?: string): string {
  const lines: string[] = [];
  const lang = resumeDocLanguage(parsed, fallbackText);
  const H = DOC_HEADINGS[lang];
  const name = str(parsed.name).trim();
  if (name) lines.push(`# ${name}`);

  const contact = [parsed.email, parsed.phone, parsed.address, parsed.linkedin, parsed.github, parsed.portfolio]
    .map((s) => str(s).trim())
    .filter(Boolean);
  if (contact.length) lines.push('', contact.join(' · '));

  const summaryText = str(parsed.summary).trim();
  if (summaryText) {
    lines.push('', `## ${H.summary}`, '', summaryText);
  }

  const skillLines = skillsToLines(parsed.skills, lang);
  if (skillLines.length) lines.push('', `## ${H.skills}`, '', ...skillLines);

  if (Array.isArray(parsed.experience) && parsed.experience.length) {
    lines.push('', `## ${allInternships(parsed.experience) ? H.internship : H.experience}`);
    for (const e of parsed.experience) {
      const header = [e.role, e.company].filter(Boolean).join(' — ');
      const when = experienceWhen(e);
      const meta = [when, e.location].filter(Boolean).join(' · ');
      lines.push('', `**${header || 'Role'}**${meta ? ` · ${meta}` : ''}`);
      const bullets = Array.isArray(e.achievements) && e.achievements.length
        ? e.achievements
        : e.description ? [e.description] : [];
      for (const b of bullets) {
        const t = bulletText(b);
        if (t) lines.push(`- ${t}`);
      }
    }
  }

  if (Array.isArray(parsed.projects) && parsed.projects.length) {
    lines.push('', `## ${H.projects}`);
    for (const p of parsed.projects) {
      const meta = [p.role, p.date].filter(Boolean).join(' · ');
      lines.push('', `**${p.name || 'Project'}**${meta ? ` · ${meta}` : ''}`);
      if (bulletText(p.description)) lines.push(`- ${bulletText(p.description)}`);
      if (Array.isArray(p.technologies) && p.technologies.length) {
        lines.push(`- _${p.technologies.map((x) => str(x)).join(', ')}_`);
      }
    }
  }

  if (Array.isArray(parsed.education) && parsed.education.length) {
    lines.push('', `## ${H.education}`);
    for (const ed of parsed.education) {
      const degree = [ed.degree, ed.field].filter(Boolean).join(', ');
      const when = ed.year || [ed.startDate, ed.endDate].filter(Boolean).join(' – ');
      const inst = [ed.institution, when].filter(Boolean).join(' · ');
      lines.push('', `**${inst || ed.institution || 'Education'}**${degree ? ` — ${degree}` : ''}`);
      for (const a of Array.isArray(ed.achievements) ? ed.achievements : []) {
        const t = bulletText(a);
        if (t) lines.push(`- ${t}`);
      }
    }
  }

  if (Array.isArray(parsed.certifications) && parsed.certifications.length) {
    lines.push('', `## ${H.certifications}`);
    for (const c of parsed.certifications) {
      const meta = [c.issuer, c.date].filter(Boolean).join(' · ');
      lines.push(`- ${c.name}${meta ? ` (${meta})` : ''}`);
    }
  }

  if (Array.isArray(parsed.awards) && parsed.awards.length) {
    lines.push('', `## ${H.awards}`);
    for (const a of parsed.awards) {
      const meta = [a.issuer, a.date].filter(Boolean).join(' · ');
      lines.push(`- ${a.name}${meta ? ` (${meta})` : ''}`);
    }
  }

  if (Array.isArray(parsed.languages) && parsed.languages.length) {
    const langs = parsed.languages
      .map((l) => [l.language, l.proficiency].filter(Boolean).join(' — '))
      .filter(Boolean);
    if (langs.length) lines.push('', `## ${H.languages}`, '', langs.join(' · '));
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
