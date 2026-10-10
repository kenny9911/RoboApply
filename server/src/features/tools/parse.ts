// server/src/features/tools/parse.ts
//
// Reading a visitor's file through the brand's parser path (WP-57; TASK_PLAN.md
// WP-15, R-16). The same pieces a signed-in upload uses
// (lib/candidateResumeIngest.ts), minus what an anonymous run must not do:
//   - no original file is stored (the buffer lives only in this request);
//   - no AI summary/highlight call (nothing shows it);
//   - GoApply: GoHire's parse API when it is configured for the brand
//     (`goHireResumeParseService` returns null otherwise, or on any failure);
//   - RoboApply: always the local parser. A RoboApply owner opt-in to GoHire
//     parsing (OD-3) needs the `intl_cross_border_cn_parse` consent, which an
//     anonymous visitor cannot give, so the tool never sends it there;
//   - local parser: text extraction, then the structured parse when the
//     brand's text model is on (`ai.text`) and the visitor may be read by a
//     model (`anonymousAiAllowed`): always on RoboApply; on GoApply only for
//     a run that carried the ticked processing notice, which names the AI
//     read (there is no account to hold an `ai_resume_parsing` grant, so the
//     notice of this one run is the consent);
//     otherwise a deterministic heading pass over the text (`textToMarkdown`).
// The result is markdown in the shape the resume check rules read. It is the
// file as parsed — roles are bold lines or plain lines, not the editor's `###`
// entry headings; the requirement rows get those through entries.ts.

import { HttpError } from '../../platform/http.js';
import { isEnabled } from '../../platform/flags.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { TOOLS_ERROR_REASONS } from './contract.js';
import { findDateRange, isExperienceHeading, isRoleSubLabel, isSubLabel } from './entries.js';

export interface ParseInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  brand: ProductBrand;
  /**
   * GoApply: this run carried the ticked processing notice
   * (TOOLS_CONSENT_VERSION; the service refuses the run without it). The
   * notice covers the AI read, so the structured parse may run.
   */
  consented?: boolean;
  requestId?: string;
  signal?: AbortSignal;
}

export interface ParsedUpload {
  /** Resume as markdown (`# name`, `## Section`, `- bullet`). */
  markdown: string;
  /** A name for the resume if the visitor keeps it (the file name without extension). */
  name: string;
  /** Which path read it. */
  via: 'gohire' | 'local_ai' | 'local_text';
}

export type ParseUpload = (input: ParseInput) => Promise<ParsedUpload>;

/** PostgreSQL rejects NUL in jsonb; strip C0 controls except tab/newline/CR. */
export function stripControl(input: string): string {
  let out = '';
  for (let k = 0; k < input.length; k += 1) {
    const c = input.charCodeAt(k);
    if (c === 9 || c === 10 || c === 13 || c > 31) out += input[k];
  }
  return out;
}

export function unreadable(message = 'We could not read text from this file.'): HttpError {
  return new HttpError('invalid_request', message, { reason: TOOLS_ERROR_REASONS.unreadable });
}

/** The file name without its extension and path, tidied for a resume name. */
export function nameFromFile(fileName: string): string {
  const base = (fileName || '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return stem.slice(0, 80) || 'Resume';
}

// Lines that are only one of these are section headings. The list matters to
// the requirement rows as much as to the checklist: an "Education and
// training" or "Volunteer work" heading the pass does not know leaves those
// dated lines inside the experience section, and they would count as years of
// work (entries.ts).
const SECTION_WORDS_EN = [
  'summary', 'profile', 'about(?: me)?', 'objective', '(?:professional|career|executive) summary', 'summary of qualifications',
  'career objective', 'personal statement', 'professional profile',
  'experience', '(?:work|professional|relevant|related|industry|additional|other|research|teaching|leadership|internship|academic|volunteer(?:ing)?) experiences?',
  'employment(?: history)?', 'work history', 'career history', 'professional background', 'internships?',
  '(?:selected |personal |academic |side |key )?projects?',
  'education', 'education (?:and|&) (?:training|certifications?|qualifications|credentials)', 'educational background',
  'academic (?:background|qualifications|history)', 'academics', 'schooling', 'continuing education',
  'qualifications', 'training', 'courses', '(?:relevant )?coursework',
  'professional (?:development|training|certifications?|licen[sc]es?|qualifications)',
  'training (?:and|&) (?:certifications?|courses|development)', 'courses (?:and|&) certifications?', 'certifications? (?:and|&) courses',
  'skills', '(?:technical|core|key|professional|additional) skills', 'skills (?:and|&) (?:tools|expertise|interests|abilities|technologies)',
  '(?:core )?competenc(?:e|ies)', 'technologies', 'tools',
  'certificat(?:e|ion)s?', 'certifications? (?:and|&) (?:licen[sc]es?|training)', 'licen[sc]es?', 'licensure', 'credentials',
  'licen[sc]es? (?:and|&) certifications?',
  '(?:professional )?(?:affiliations|memberships|associations|organi[sz]ations)',
  '(?:affiliations|memberships) (?:and|&) (?:affiliations|memberships|associations)',
  'languages', 'awards', 'honou?rs', '(?:honou?rs|awards) (?:and|&) (?:honou?rs|awards|recognition|achievements)', 'achievements',
  'accomplishments', 'publications', 'presentations', 'conferences', 'patents',
  'volunteer(?:ing)?(?: work| service| activities)?', 'community (?:service|involvement|engagement)',
  'leadership', 'leadership (?:and|&) (?:activities|involvement|service|volunteering)',
  'activities', 'extracurricular activities', 'interests', 'hobbies',
  'references', 'additional information', 'contact',
];
const SECTION_WORDS_CJK =
  '自我评价|个人评价|自我介绍|个人总结|个人简介|个人优势|简介|工作经历|工作经验|实习经历|实习经验|实践经历|项目经历|项目经验|教育背景|教育经历|学历|专业技能|技能证书|技能|证书|获奖情况|获奖经历|校园经历|基本信息|个人信息|联系方式|求职意向|自我評價|個人簡介|工作經歷|實習經歷|專案經歷|項目經歷|教育背景|學歷|技能|證書|個人資料|聯絡方式' +
  // Sections that follow the jobs on a Chinese resume and carry dates of their own.
  '|培训经历|培训经验|培训情况|教育培训|在校经历|在校情况|社会实践(?:经历)?|社团经历|社团活动|学生工作(?:经历)?|志愿者经历|志愿服务|资格证书|荣誉奖项|所获荣誉|语言能力|兴趣爱好|培訓經歷|在校經歷|社會實踐(?:經歷)?|社團經歷|志工經歷|證照|語言能力';
const SECTION_WORDS = new RegExp(`^(?:${SECTION_WORDS_EN.join('|')}|${SECTION_WORDS_CJK})[:：]?$`, 'i');

// A bullet glyph, a dash or star that starts a bullet (not `**bold**`, a rule
// `---` or a number `-5%`), or a list number: "1. Led…", "2) Led…", "1、负责…",
// and "1.负责…" / "1.Led…" with no space, the usual way a Chinese resume
// numbers duties. A line that begins with a date ("2024.01 - Present",
// "12.2019 – 03.2022") is not a numbered bullet — a digit follows the dot — and
// neither is "3.5 years"; a date used to lose its year here ("- 01 - Present").
const BULLET = /^\s*(?:[•·▪●◦‣]\s*|[-–*](?![-–*\d])\s*|\d{1,2}[.)](?:\s+|(?=[^\d\s]))|\d{1,2}、\s*)/;

const labelKey = (line: string): string => line.trim().replace(/[:：]$/, '').trim().toLowerCase();
/** How a heading is written: with a colon or not, in capitals or not. */
const styleOf = (line: string): string => `${/[:：]$/.test(line) ? 'colon' : 'bare'}/${/\p{Ll}/u.test(line) ? 'mixed' : 'caps'}`;

/**
 * Deterministic text → markdown for the rules when no structured parse runs:
 * the first short line is the name (`#`), lines that are only a known
 * section word become `##`, bullet glyphs become `- `. Nothing is invented.
 *
 * Some section words also label part of a role ("Achievements:",
 * "Technologies", "Key Projects" under each job). Read as a section, the label
 * would end the experience section and every later job would fall outside it,
 * so such a line stays a body line when it is plainly a label:
 *   - it appears more than once in the file (a section heading does not), or
 *   - it sits inside an experience section and is written differently from
 *     that section's heading (`EXPERIENCE` … `Achievements:`).
 */
export function textToMarkdown(rawText: string): string {
  const lines = (rawText ?? '').replace(/\r\n?/g, '\n').split('\n');
  const labelCount = new Map<string, number>();
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length <= 40 && isSubLabel(line)) labelCount.set(labelKey(line), (labelCount.get(labelKey(line)) ?? 0) + 1);
  }
  const out: string[] = [];
  let named = false;
  /** The style of the heading that opened the experience section we are in, or null outside one. */
  let experienceStyle: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      out.push('');
      continue;
    }
    if (!named) {
      named = true;
      if (line.length <= 60 && !SECTION_WORDS.test(line)) {
        out.push(`# ${line}`);
        continue;
      }
    }
    if (line.length <= 40 && SECTION_WORDS.test(line)) {
      const label =
        (isSubLabel(line) && (labelCount.get(labelKey(line)) ?? 0) > 1) ||
        (isRoleSubLabel(line) && experienceStyle !== null && styleOf(line) !== experienceStyle);
      if (!label) {
        const title = line.replace(/[:：]$/, '');
        experienceStyle = isExperienceHeading(title) ? styleOf(line) : null;
        out.push(`## ${title}`);
        continue;
      }
    }
    if (BULLET.test(raw)) {
      const text = raw.replace(BULLET, '').trim();
      if (text) out.push(`- ${text}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The document parsers and the ingest helpers are loaded by a computed
// specifier: the web typecheck reaches this file through the feature mount
// table, and those modules import untyped packages (word-extractor,
// html-to-text) that only the server build (noImplicitAny off) accepts. They
// are statically imported by lib/candidateResumeIngest.ts, so the server
// bundle traces them either way.
const DOCUMENT_PARSING = '../../services/DocumentParsingService.js';
const INGEST = '../../lib/candidateResumeIngest.js';

interface DocumentParsingModule {
  documentParsingService: { extractText(buffer: Buffer, mimetype: string, filename?: string, requestId?: string): Promise<string> };
}
interface IngestModule {
  parsedResumeToMarkdown(parsed: unknown, fallbackText?: string): string;
}

const load = <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The structured parse with every job's dates readable. The ingest markdown
 * prints a job's `duration` when the parse gives one, and the parse may give a
 * computed length there ("4 years 8 months") beside the real `startDate` and
 * `endDate`; the rows would then find no date range on that job and drop its
 * years. Where `duration` holds no date range and the job has a start date,
 * the dates take its place. Nothing else changes; the input is not mutated.
 */
export function withReadableDates(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const experience = (parsed as { experience?: unknown }).experience;
  if (!Array.isArray(experience)) return parsed;
  return {
    ...parsed,
    experience: experience.map((item: unknown) => {
      if (!item || typeof item !== 'object') return item;
      const e = item as { duration?: unknown; startDate?: unknown; endDate?: unknown };
      const start = str(e.startDate);
      if (!start || findDateRange(str(e.duration))) return item;
      return { ...item, duration: [start, str(e.endDate)].filter(Boolean).join(' – ') };
    }),
  };
}

async function toMarkdown(parsed: unknown, rawText: string): Promise<string> {
  const { parsedResumeToMarkdown } = await load<IngestModule>(INGEST);
  return stripControl(parsedResumeToMarkdown(withReadableDates(parsed), rawText)).trim();
}

async function extractLocalText(input: ParseInput): Promise<string> {
  const { normalizeExtractedText } = await import('../../services/ResumeParserService.js');
  let text: string;
  if (input.mimeType === 'application/pdf' || /\.pdf$/i.test(input.fileName)) {
    const { pdfService } = await import('../../services/PDFService.js');
    text = await pdfService.extractText(input.buffer, input.requestId, input.signal);
  } else {
    const { documentParsingService } = await load<DocumentParsingModule>(DOCUMENT_PARSING);
    text = await documentParsingService.extractText(input.buffer, input.mimeType, input.fileName, input.requestId);
  }
  return stripControl(normalizeExtractedText(text ?? ''));
}

/**
 * May the structured parse (a model call) run for this anonymous visitor?
 * Mirrors `aiAllowed` without a user, and is still subject to the brand's
 * `ai.text` flag. RoboApply: yes. GoApply: only when the run carried the
 * ticked processing notice (`consented`); a visitor has no account to hold an
 * `ai_resume_parsing` grant, so the notice of the run is what allows it.
 */
export function anonymousAiAllowed(brand: ProductBrand, consented = false): boolean {
  return brand.market !== 'cn' || consented === true;
}

/** The production parser path (see the header). Throws 422 `file_unreadable` when no text comes out. */
export const defaultParseUpload: ParseUpload = async (input) => {
  const name = nameFromFile(input.fileName);

  if (input.brand.market === 'cn') {
    const { goHireResumeParseService } = await import('../../services/GoHireResumeParseService.js');
    const remote = await goHireResumeParseService.parseResumeFile({
      buffer: input.buffer,
      fileName: input.fileName,
      mimeType: input.mimeType,
      requestId: input.requestId,
      signal: input.signal,
      brand: input.brand.id,
    });
    if (remote) {
      const markdown = await toMarkdown(remote.parsed, remote.rawText);
      if (markdown.length >= 20) return { markdown, name, via: 'gohire' };
    }
  }

  let rawText: string;
  try {
    rawText = await extractLocalText(input);
  } catch {
    throw unreadable();
  }
  if (rawText.trim().length < 20) throw unreadable();

  if (anonymousAiAllowed(input.brand, input.consented) && (await isEnabled('ai.text', { brand: input.brand }))) {
    try {
      const { resumeParseAgent } = await import('../../agents/ResumeParseAgent.js');
      const parsed = await resumeParseAgent.parse(rawText, input.requestId, input.signal);
      const markdown = await toMarkdown(parsed, rawText);
      if (markdown.length >= 20) return { markdown, name, via: 'local_ai' };
    } catch {
      // The structured parse failed or timed out: the text pass below still reads the file.
    }
  }
  return { markdown: textToMarkdown(rawText), name, via: 'local_text' };
};
