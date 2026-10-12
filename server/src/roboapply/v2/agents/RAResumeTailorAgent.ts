// backend/src/roboapply/v2/agents/RAResumeTailorAgent.ts
//
// RoboApply V2 Agent #3 — Tailor a base resume to a specific JD. Per
// docs/roboapply/v2/04-backend-spec.md §6 — supports `standard` and
// `deep_rewrite` (Premium+ only) complexity tiers.
//
// Contract (BE3 Wave 4):
//   Input  : { baseResumeMarkdown, jobTitle, jobDescription, parsedJD?,
//              complexity: 'standard' | 'deep_rewrite' }
//   Output : { tailoredResumeMarkdown, changeSummary,
//              citationsByLine: Record<lineIndex, citationSource> }
//
// Notes:
//   - Temperature 0.3 (low-creative — accuracy beats voice for resumes)
//   - Model: env-configurable per tier via
//     RA_V2_RESUME_TAILOR_MODEL_STANDARD / RA_V2_RESUME_TAILOR_MODEL_DEEP;
//     otherwise inherits the configured LLM stack.
//   - Max output 2000 tokens (full resume can be long)
//   - CitationGuard pattern from assessmentPipeline/CitationGuardAgent —
//     every quantitative claim in the tailored output must map back to
//     a line in the base resume. We capture `citationsByLine` from the
//     model and validate it locally (string-presence check) — no extra
//     LLM round-trip needed for V2.
//   - Quota: BE2's service writes `ra_resume_tailor` SKU on success.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { logger } from '../../../services/LoggerService.js';
import { llmService } from '../../../services/llm/LLMService.js';
import { languageService } from '../../../services/LanguageService.js';
import { currentBrandPersona } from '../../../platform/brand/persona.js';

// ─── Public types ───────────────────────────────────────────────────────

export type RAResumeTailorComplexity = 'standard' | 'deep_rewrite';

export interface RAResumeTailorParsedJD {
  qualifications?: string;
  responsibilities?: string;
  benefits?: string;
  keywords?: string[];
}

export interface RAResumeTailorInput {
  baseResumeMarkdown: string;
  jobTitle: string;
  /** Target company — set for saved jobs AND for the manual company/title
   *  lane (which may carry no jobDescription at all). */
  companyName?: string;
  jobDescription: string;
  parsedJD?: RAResumeTailorParsedJD;
  complexity: RAResumeTailorComplexity;
  // ── Tailor sessions (WP-36a) ──
  /** Sections the model may change ('summary' | 'experience' | 'skills' |
   *  'projects' | 'education'); omitted → any. The service also enforces it
   *  when it merges the result back (features/resume/tailor/blocks.ts). */
  sections?: string[];
  /** Experience 'quick' (reword and reorder existing bullets only) or 'full'. */
  experienceDepth?: 'quick' | 'full';
  /** The user's optional instruction (≤1000 chars). */
  instruction?: string;
  /** Missing keywords the user confirmed they have — the ONLY new keywords
   *  the model may add. */
  confirmedKeywords?: string[];
  /** `profileSnapshotForLlm(userId).text` (never sensitive fields). */
  profileContext?: string;
}

/** Where a tailored line traces back to in the base resume. */
export interface RACitationSource {
  /** 0-based line index in `baseResumeMarkdown.split('\n')`. -1 means
   *  "structural / unchanged from base" (headings, blank lines, etc.). */
  sourceLineIndex: number;
  /** Optional verbatim copy of the base line for double-check. */
  sourceText?: string;
}

export interface RAResumeTailorOutput {
  /** The full tailored resume in markdown. */
  tailoredResumeMarkdown: string;
  /** Human-readable changelog: "Reworded bullet 2 of Stripe role to..."
   *  Up to ~200 words. */
  changeSummary: string;
  /** Per-tailored-line citations back into the base resume. Keys are the
   *  0-based line index in `tailoredResumeMarkdown.split('\n')`. */
  citationsByLine: Record<number, RACitationSource>;
  /** True if every line with a quantitative claim has a citation that
   *  string-matches the base resume. Soft-failure: false = caller may
   *  retry or fall back to base resume. */
  citationGuardPassed: boolean;
  /** Lines (by tailored index) that failed citation. Empty when
   *  citationGuardPassed = true. */
  citationGuardViolations: number[];
}

// Env var names that override the per-tier model at runtime.
const ENV_MODEL_STANDARD = 'RA_V2_RESUME_TAILOR_MODEL_STANDARD';
const ENV_MODEL_DEEP = 'RA_V2_RESUME_TAILOR_MODEL_DEEP';

// ─── Helpers ────────────────────────────────────────────────────────────

function clipString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/** Lightweight detector for "quantitative claims" — numbers, percentages,
 *  dollar amounts, time ranges. Used by CitationGuard to decide which
 *  lines MUST have a base-resume citation. */
function lineHasQuantitativeClaim(line: string): boolean {
  if (!line || typeof line !== 'string') return false;
  // \d → "5 years", "30%", "$1M", "120ms", "200+ users"
  // Year ranges like "2019-2024", "Jan 2020 – Present" also trip the match.
  return /\d/.test(line);
}

/**
 * Resolve the model for a tailor complexity tier. Reads `process.env` at
 * CALL TIME (not module-load) so it picks up dotenv values regardless of ESM
 * import order — the backend's `dotenv.config()` runs after the agent module
 * is hoisted/evaluated, so a module-level `process.env` read would miss it.
 * Both tiers inherit the configured LLM stack when their override is unset.
 */
export function pickTailorModel(complexity: RAResumeTailorComplexity): string {
  if (complexity === 'deep_rewrite') {
    return process.env[ENV_MODEL_DEEP]?.trim() || llmService.getModel();
  }
  return process.env[ENV_MODEL_STANDARD]?.trim() || llmService.getModel();
}

/**
 * Verify every quantitative claim in the tailored output traces back to
 * a line in the base resume. The check is intentionally lenient:
 *   - Lines without numbers are skipped (they can't fabricate metrics)
 *   - For lines WITH numbers, every digit-run in the tailored line MUST
 *     appear in the cited base line (verbatim substring) OR be a calendar
 *     year between 1990-2099 (years are safe to repeat).
 *
 * Returns the violation indices (empty when guard passes).
 */
export function runCitationGuard(
  baseResumeMarkdown: string,
  tailoredResumeMarkdown: string,
  citationsByLine: Record<number, RACitationSource>,
): { passed: boolean; violations: number[] } {
  const baseLines = baseResumeMarkdown.split('\n');
  const tailoredLines = tailoredResumeMarkdown.split('\n');
  const violations: number[] = [];

  for (let i = 0; i < tailoredLines.length; i++) {
    const tLine = tailoredLines[i];
    if (!lineHasQuantitativeClaim(tLine)) continue;

    const citation = citationsByLine[i];
    if (!citation || citation.sourceLineIndex === undefined) {
      violations.push(i);
      continue;
    }
    // -1 = structural; only allowed if the tailored line is itself
    // structural (no digits) — but we already gated on `lineHasQuantitativeClaim`
    // so structural citation for a digit-bearing line is a violation.
    if (citation.sourceLineIndex < 0) {
      violations.push(i);
      continue;
    }
    if (citation.sourceLineIndex >= baseLines.length) {
      violations.push(i);
      continue;
    }
    const sourceLine = baseLines[citation.sourceLineIndex];

    // Extract digit runs from the tailored line. Each must appear in
    // the source line (verbatim substring) OR be a plausible year.
    const digitRuns = tLine.match(/\d+(?:[.,]\d+)?/g) ?? [];
    let allOk = true;
    for (const run of digitRuns) {
      const plain = run.replace(/[.,]/g, '');
      const asNum = Number(plain);
      const isYear = Number.isFinite(asNum) && asNum >= 1990 && asNum <= 2099;
      if (isYear) continue;
      if (!sourceLine.includes(run)) {
        allOk = false;
        break;
      }
    }
    if (!allOk) violations.push(i);
  }

  return { passed: violations.length === 0, violations };
}

// ─── Agent ──────────────────────────────────────────────────────────────

export class RAResumeTailorAgent extends BaseAgent<
  RAResumeTailorInput,
  RAResumeTailorOutput
> {
  constructor() {
    super('RAResumeTailorAgent');
  }

  protected getTemperature(): number {
    return 0.3;
  }

  protected getMaxTokens(): number | undefined {
    return 2000;
  }

  /**
   * The output language is the RESUME'S OWN language, not the interface
   * language. `run()` passes the base resume's detected language here (the UI
   * locale only when the resume is too short to tell).
   *
   * Every other content agent follows "the selected locale always wins"
   * (BaseAgent.outputLanguageReminder). Tailoring is the exception: the
   * artifact is the candidate's existing document, sent to an employer. With
   * the interface in zh-TW, an English resume tailored for an English post
   * came back fully in Traditional Chinese, and every line was then reported
   * as a new statement. Like the 'content' scope of
   * getStrictOutputLanguageDirective, this states that the document text
   * itself is the output, so the model cannot satisfy it with commentary.
   */
  protected getLocaleDirective(locale: string): string | null {
    const language = this.language.getLanguageFromLocale(locale);
    if (!language) return super.getLocaleDirective(locale);
    return [
      "# OUTPUT LANGUAGE (THE RESUME'S OWN LANGUAGE — HIGHEST PRIORITY)",
      `The base resume is written in ${language}. ${this.language.getLanguageInstructionForLanguage(language)}`,
      `Write the tailored resume, every bullet, summary and skill line of it, and the change summary in ${language}.`,
      `A tailored resume is the SAME document in the SAME language. Never translate it: not into the language of the job posting, and not into the language of the app the candidate uses.`,
      'Keep every heading, skill label, proper noun (people, companies, schools, products) and technical term (e.g. Python, Kubernetes, RAG) exactly as the base resume writes it.',
      'This prompt and its examples are written in English for authoring convenience ONLY — that is NOT a signal about your output language.',
      'JSON keys and any other schema-defined token stay EXACTLY as this prompt specifies — never translated.',
      'This directive OVERRIDES any other language instruction elsewhere in this prompt.',
    ].join('\n');
  }

  protected getAgentPrompt(): string {
    return `${currentBrandPersona('senior resume tailor')}. Take a candidate's base resume and rewrite it to win the listed JD.

## Hard rules — these are absolute

1. **Never invent skills, employers, dates, or numbers.** Every quantitative claim ("led 5-person team", "cut latency 30%", "shipped in 2023") in the tailored output MUST appear verbatim in the base resume. Numbers cannot drift. Dates cannot drift. Employer names cannot drift.

2. **What you CAN change:**
   - Reorder bullets within a role
   - Rewrite framing / verb choice / emphasis
   - Surface JD keywords that the candidate already demonstrates
   - Drop bullets that don't help the application
   - Tighten the summary line
   - Add a tailored objective if the base has none

3. **What you CANNOT change:**
   - Job titles (use the candidate's actual title)
   - Employer names / dates / role durations
   - Concrete numbers (team size, latency, revenue, etc.)
   - Education / certifications
   - Adding skills the candidate doesn't have

4. **Citation table.** For every line in the tailored resume that contains a NUMBER, emit one entry in \`citationsByLine\` mapping the tailored line's 0-based index → the base resume's source line index. Use \`sourceLineIndex: -1\` for purely structural lines (headings, blank, etc.) — but lines with digits MUST cite a real source line. \`sourceText\` is the ONE field that is NOT written in the output language: it is a verbatim copy of the base-resume line, in whatever language that line is already in. Never translate, reword, or clean it up — it exists so a human can diff the claim against the source.

5. **Facts from the job posting are never the candidate's own.** Do not write the employer's name, products, team or tools into the candidate's experience, and do not copy sentences from the posting. Add a keyword the base resume does not show ONLY when it is listed under "Keywords the candidate confirmed".

6. **Sections and structure.** When a "Sections you may change" list is given, change only those sections and copy every other section exactly. Keep every \`##\` heading and every entry line (employer · title · dates: a \`###\` line, or a role line written in bold such as \`**Title — Employer** · dates\`) exactly as written. Keep the label of a skills line (\`**Tools:**\`) as written; only the skills after it may change. Do not add a name, contact line, photo or personal details: they are added back after you answer.

7. **Every change is checked.** Anything you add that the base resume does not show (a number, a skill, a new sentence) is shown to the candidate, who must confirm it is true before the resume can be used. Prefer reframing what is already there.

8. **Change summary.** ≤ 200 words. Bullet list of what you changed and why. The samples that follow are English only because this prompt is; they illustrate the LEVEL OF DETAIL to give (which bullet, which employer, why), not the language to write in — write the summary itself in the output language. E.g. "Reordered Stripe bullets to lead with payments work (matches JD)". "Cut sentence about Jira admin work (not relevant)".

## Output schema (STRICT JSON, no prose around it, no code fences)

{
  "tailoredResumeMarkdown": "string — the full tailored resume, markdown",
  "changeSummary": "string — bullet list, ≤200 words",
  "citationsByLine": {
    "0": { "sourceLineIndex": 0, "sourceText": "verbatim base line, untranslated" },
    "5": { "sourceLineIndex": 12, "sourceText": "verbatim base line, untranslated" }
  }
}

Output ONLY the JSON object.`;
  }

  protected formatInput(input: RAResumeTailorInput, locale?: string): string {
    const parts: string[] = [];
    // Restate the output language HERE, not just in the system prompt: the
    // whole user message below is the base resume + the JD, usually in English,
    // and on a long English payload that bulk out-weighs a system directive.
    // Remove this and a zh user's tailored resume comes back in English.
    const languageLine = this.outputLanguageReminder(locale);
    if (languageLine) parts.push(languageLine);
    parts.push(`Complexity: ${input.complexity}`);
    // OMIT the label when there is no title: the manual tailor lane sends ''
    // when the user named no target title (RAResumeAIService deliberately sends
    // nothing rather than a placeholder), and a dangling "Title:" reads to the
    // model as a blank field to fill in — i.e. an invented target role.
    const targetLines: string[] = [];
    const title = clipString(input.jobTitle, 240);
    if (title) targetLines.push(`Title: ${title}`);
    const company = clipString(input.companyName, 200);
    if (company) targetLines.push(`Company: ${company}`);
    const description = clipString(input.jobDescription, 6_000);
    const targetBlock = targetLines.length > 0 ? `${targetLines.join('\n')}\n\n` : '';
    // The no-description note points at the title/company above, so it only
    // makes sense when at least one of them survived the guard.
    const noDescription =
      targetLines.length > 0
        ? '(No job description provided — tailor toward the company and title above using only what the base resume demonstrates.)'
        : '(No target details provided — sharpen the base resume on its own terms; invent nothing.)';
    parts.push(`## Target job\n${targetBlock}Description:\n${description || noDescription}`);
    const sections = Array.isArray(input.sections) ? input.sections.map((x) => clipString(x, 40)).filter(Boolean) : [];
    if (sections.length > 0) {
      parts.push(`## Sections you may change\n${sections.map((x) => `- ${x}`).join('\n')}\n(Copy every other section exactly.)`);
    }
    if (input.experienceDepth === 'quick') {
      parts.push('## Experience: quick\nKeep every existing bullet. Reword and reorder them; do not add, merge or drop bullets.');
    } else if (input.experienceDepth === 'full') {
      parts.push('## Experience: full\nYou may rewrite, merge, reorder or drop bullets. Never add work the base resume does not show.');
    }
    const confirmed = Array.isArray(input.confirmedKeywords)
      ? input.confirmedKeywords.map((k) => clipString(k, 60)).filter(Boolean).slice(0, 30)
      : [];
    if (confirmed.length > 0) {
      parts.push(`## Keywords the candidate confirmed they have\n${confirmed.map((k) => `- ${k}`).join('\n')}\n(Work each into the most fitting existing line; never invent where it was used.)`);
    }
    const instruction = clipString(input.instruction, 1_000);
    if (instruction) {
      parts.push(`## The candidate's instruction (follow it unless it breaks a hard rule)\n${instruction}`);
    }
    const profile = clipString(input.profileContext, 3_000);
    if (profile) {
      parts.push(`## Candidate profile (context only; anything you add from it is shown to the candidate to confirm)\n${profile}`);
    }
    if (input.parsedJD) {
      const pj = input.parsedJD;
      const blocks: string[] = [];
      if (pj.qualifications) blocks.push(`Qualifications:\n${clipString(pj.qualifications, 2_500)}`);
      if (pj.responsibilities) blocks.push(`Responsibilities:\n${clipString(pj.responsibilities, 2_500)}`);
      if (Array.isArray(pj.keywords) && pj.keywords.length > 0) {
        blocks.push(`Keywords to address:\n${pj.keywords.slice(0, 30).map((k) => `- ${clipString(k, 80)}`).join('\n')}`);
      }
      if (blocks.length > 0) parts.push(`## Parsed JD signals\n${blocks.join('\n\n')}`);
    }
    // Number the base resume so the model can cite by line index.
    const baseNumbered = clipString(input.baseResumeMarkdown, 12_000)
      .split('\n')
      .map((line, idx) => `${idx}\t${line}`)
      .join('\n');
    parts.push(`## Base resume (NUMBERED — cite these line indices in citationsByLine)\n${baseNumbered}`);
    parts.push('Tailor this resume for this job. Output ONLY the JSON object.');
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): RAResumeTailorOutput {
    const fallback: RAResumeTailorOutput = {
      tailoredResumeMarkdown: '',
      changeSummary: '',
      citationsByLine: {},
      citationGuardPassed: false,
      citationGuardViolations: [],
    };
    if (!response || typeof response !== 'string') return fallback;

    const cleaned = response.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          parsed = null;
        }
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fallback;
    }

    const tailoredResumeMarkdown = clipString(parsed.tailoredResumeMarkdown, 16_000);
    const changeSummary = clipString(parsed.changeSummary, 1_500);

    const citationsByLine: Record<number, RACitationSource> = {};
    const rawCitations = parsed.citationsByLine;
    if (rawCitations && typeof rawCitations === 'object' && !Array.isArray(rawCitations)) {
      for (const [k, v] of Object.entries(rawCitations as Record<string, unknown>)) {
        const lineIdx = Number(k);
        if (!Number.isFinite(lineIdx) || lineIdx < 0) continue;
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        const vv = v as Record<string, unknown>;
        const src = Number(vv.sourceLineIndex);
        if (!Number.isFinite(src)) continue;
        const entry: RACitationSource = { sourceLineIndex: Math.trunc(src) };
        const sourceText = clipString(vv.sourceText, 600);
        if (sourceText) entry.sourceText = sourceText;
        citationsByLine[lineIdx] = entry;
      }
    }

    return {
      tailoredResumeMarkdown,
      changeSummary,
      citationsByLine,
      citationGuardPassed: false,
      citationGuardViolations: [],
    };
  }

  /**
   * Public convenience wrapper. Picks the model from `input.complexity`,
   * runs the LLM, then applies CitationGuard against the base resume.
   * Failures throw — caller does NOT debit on throw.
   *
   * On CitationGuard violations the agent returns a successful output
   * with `citationGuardPassed: false` and `citationGuardViolations`
   * populated. BE2's service may retry with a stricter prompt or fall
   * back to the base resume on its own discretion; in both cases the
   * SKU should still be debited because the LLM call did succeed.
   */
  async run(
    input: RAResumeTailorInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RAResumeTailorOutput> {
    const model = pickTailorModel(input.complexity);
    // The resume's own language decides the output language. `options.locale`
    // (the interface language) is only the fallback for a resume too short to tell.
    const locale = resumeDocumentLocale(input.baseResumeMarkdown) ?? options.locale;
    const result = await this.execute(
      input,
      input.jobDescription,
      options.requestId,
      locale,
      model,
      options.signal,
    );

    // Apply CitationGuard string-presence check.
    const guard = runCitationGuard(
      input.baseResumeMarkdown,
      result.tailoredResumeMarkdown,
      result.citationsByLine,
    );
    result.citationGuardPassed = guard.passed;
    result.citationGuardViolations = guard.violations;

    if (!guard.passed) {
      logger.warn(
        'AGENT',
        'RAResumeTailorAgent: citation-guard found unsupported numeric claims',
        {
          model,
          violationCount: guard.violations.length,
          violationLines: guard.violations.slice(0, 10),
        },
        options.requestId,
      );
    }

    return result;
  }
}

const LANGUAGE_LOCALE: Record<string, string> = {
  English: 'en',
  Chinese: 'zh',
  Japanese: 'ja',
  Korean: 'ko',
  German: 'de',
  French: 'fr',
  Spanish: 'es',
  Portuguese: 'pt',
  Russian: 'ru',
  Arabic: 'ar',
  Thai: 'th',
};

/** Common characters that exist only in Traditional / only in Simplified Chinese. */
const TRADITIONAL_ONLY = '個學實經專證歷與為這國會從來時們說對開關點數據業務責體發現應網絡資訊軟設計畫團隊優勢領導項驗語執環維護測試動態產銷運營';
const SIMPLIFIED_ONLY = '个学实经专证历与为这国会从来时们说对开关点数据业务责体发现应网络资讯软设计划团队优势领导项验语执环维护测试动态产销运营';

/**
 * The locale of the language a resume is written in ('en', 'zh', 'zh-TW',
 * 'ja', …), or null when there is too little text to tell. Headings, markdown
 * marks, emails and links are ignored, so an uploaded Chinese resume that
 * still carries English section titles reads as Chinese.
 */
export function resumeDocumentLocale(markdown: string | null | undefined): string | null {
  const text = (markdown ?? '')
    .split('\n')
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join('\n')
    .replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+/g, ' ')
    .replace(/[*_`#>|]/g, ' ');
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters < 40) return null;
  const han = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length;
  const hangul = (text.match(/[\uac00-\ud7af]/g) ?? []).length;
  // CJK text packs a word into a character or two: a fifth of the letters is a CJK document.
  if (hangul > 0 && hangul >= letters * 0.2) return 'ko';
  if (kana > 0 && han + kana >= letters * 0.2 && kana >= han * 0.1) return 'ja';
  if (han >= letters * 0.2) {
    let traditional = 0;
    let simplified = 0;
    for (const ch of text) {
      if (TRADITIONAL_ONLY.includes(ch)) traditional += 1;
      else if (SIMPLIFIED_ONLY.includes(ch)) simplified += 1;
    }
    return traditional > simplified ? 'zh-TW' : 'zh';
  }
  // Mostly Latin text with a few CJK names or terms is not a CJK resume.
  const latinOnly = text.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, ' ');
  return LANGUAGE_LOCALE[languageService.detectLanguage(latinOnly)] ?? null;
}

export const raResumeTailorAgent = new RAResumeTailorAgent();
export default raResumeTailorAgent;

export const __test = {
  pickTailorModel,
  runCitationGuard,
  lineHasQuantitativeClaim,
};
