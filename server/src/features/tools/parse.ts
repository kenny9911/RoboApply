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
//   - local parser: text extraction, then
//       RoboApply: the structured parse when the brand's text model is on
//         (`ai.text`); `aiAllowed` is always true on RoboApply;
//       GoApply: never a model. `aiAllowed` (TASK_PLAN §2.2) is true there
//         only with an `ai_resume_parsing` grant, which an anonymous visitor
//         cannot hold, and the tool's processing notice does not cover AI;
//     otherwise a deterministic heading pass over the text (`textToMarkdown`).
// The result is markdown in the shape the resume check rules read.

import { HttpError } from '../../platform/http.js';
import { isEnabled } from '../../platform/flags.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { TOOLS_ERROR_REASONS } from './contract.js';

export interface ParseInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  brand: ProductBrand;
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

const SECTION_WORDS =
  /^(?:summary|profile|about(?: me)?|objective|professional summary|experience|work experience|employment(?: history)?|work history|career history|internships?|projects?|education|academic background|skills|technical skills|core skills|competenc(?:e|ies)|certifications?|tools|languages|awards|honou?rs|publications|volunteer(?:ing)?(?: experience)?|contact|自我评价|个人评价|自我介绍|个人总结|个人简介|个人优势|简介|工作经历|工作经验|实习经历|实习经验|实践经历|项目经历|项目经验|教育背景|教育经历|学历|专业技能|技能证书|技能|证书|获奖情况|获奖经历|校园经历|基本信息|个人信息|联系方式|求职意向|自我評價|個人簡介|工作經歷|實習經歷|專案經歷|項目經歷|教育背景|學歷|技能|證書|個人資料|聯絡方式)[:：]?$/i;

const BULLET = /^\s*(?:[-*•·▪●◦‣–]|\d+[.)、])\s*/;

/**
 * Deterministic text → markdown for the rules when no structured parse runs:
 * the first short line is the name (`#`), lines that are only a known
 * section word become `##`, bullet glyphs become `- `. Nothing is invented.
 */
export function textToMarkdown(rawText: string): string {
  const lines = (rawText ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let named = false;
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
      out.push(`## ${line.replace(/[:：]$/, '')}`);
      continue;
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

async function toMarkdown(parsed: unknown, rawText: string): Promise<string> {
  const { parsedResumeToMarkdown } = await load<IngestModule>(INGEST);
  return stripControl(parsedResumeToMarkdown(parsed, rawText)).trim();
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

/** The production parser path (see the header). Throws 422 `file_unreadable` when no text comes out. */
/**
 * May the structured parse (a model call) run for this anonymous visitor?
 * Mirrors `aiAllowed` without a user: RoboApply yes (still subject to the
 * brand's `ai.text` flag); GoApply no — there is no account to hold the
 * `ai_resume_parsing` grant.
 */
export function anonymousAiAllowed(brand: ProductBrand): boolean {
  return brand.market !== 'cn';
}

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

  if (anonymousAiAllowed(input.brand) && (await isEnabled('ai.text', { brand: input.brand }))) {
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
