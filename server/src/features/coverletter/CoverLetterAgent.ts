// server/src/features/coverletter/CoverLetterAgent.ts
//
// The cover-letter writer and its adversarial fact-checker (WP-37).
//
// The writer reuses the RoboApplyAuthorAgent prompt approach (hard "never
// invent" rules, one concrete detail from the post, valid/invalid few-shot,
// a citation for every claim, strict JSON) with the clone's changes: tone
// presets (Plain · Warm · Formal), length presets (Short · Standard), a
// citation on EVERY sentence (`resume` | `posting`), and the rule that facts
// from the job post are the employer's, never the candidate's. No watermark,
// no persona name, and no name or contact details in the prompt: the caller
// passes `resumeForLlm` text with PII redacted, the profile snapshot from
// `profileSnapshotForLlm`, and places the signature after the model ran.
//
// The fact-checker is the claim-checker ported from SeekerResumeTailorAgent
// (same adversarial procedure, fail-closed), pointed at a letter instead of
// a tailored resume. The deterministic checks in claimCheck.ts run first.
//
// Both run only after `aiAllowed(user)` and the brand's `ai.text` capability
// (the service never loads this module otherwise: zero LLMService calls).

import { BaseAgent } from '../../agents/BaseAgent.js';
import { getTaskModel, getTaskReasoningEffort } from '../../lib/llm/llmTaskSettings.js';
import { currentBrandPersona } from '../../platform/brand/persona.js';
import type { LetterLength, LetterTone } from './contract.js';
import type { ModelCite, SentenceKind } from './claimCheck.js';

// ── shared types ─────────────────────────────────────────────────────────

export interface WriterSentence {
  text: string;
  kind: SentenceKind;
  cites: ModelCite[];
}

export interface WriterOutput {
  greeting: string;
  paragraphs: WriterSentence[][];
  closing: string;
}

export interface WriterInput {
  mode: 'write' | 'rewrite';
  tone: LetterTone;
  length: LetterLength;
  locale: string;
  job: { title: string; company: string; text: string };
  /** Resume text for the prompt (resumeForLlm + PII redaction). */
  resumeText: string;
  /** profileSnapshotForLlm().text (may be empty). */
  profileText: string;
  /** rewrite: the current letter (PII-redacted; the user's own sentences replaced by [[USER_n]] tokens) and the user's instruction. */
  currentLetter?: string;
  instruction?: string;
  /** Second attempt: what failed the fact check. */
  retryNote?: string;
}

const KINDS: readonly SentenceKind[] = ['experience', 'motivation', 'company', 'other'];

function clip(s: unknown, max: number): string {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

function parseJsonObject(response: string): Record<string, unknown> | null {
  if (!response || typeof response !== 'string') return null;
  const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  for (const candidate of [cleaned, cleaned.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Parse the writer's JSON; malformed parts are dropped (an empty letter fails the check). */
export function parseWriterOutput(response: string): WriterOutput {
  const parsed = parseJsonObject(response);
  if (!parsed) return { greeting: '', paragraphs: [], closing: '' };
  const paragraphs: WriterSentence[][] = [];
  const rawParas = Array.isArray(parsed.paragraphs) ? parsed.paragraphs.slice(0, 8) : [];
  for (const p of rawParas) {
    const rawSentences = Array.isArray(p) ? p : p && typeof p === 'object' && Array.isArray((p as { sentences?: unknown }).sentences) ? (p as { sentences: unknown[] }).sentences : [];
    const sentences: WriterSentence[] = [];
    for (const s of rawSentences.slice(0, 12)) {
      if (!s || typeof s !== 'object') continue;
      const ss = s as Record<string, unknown>;
      const text = clip(ss.text, 1_200);
      if (!text) continue;
      const kindRaw = clip(ss.kind, 20) as SentenceKind;
      const cites: ModelCite[] = [];
      for (const c of Array.isArray(ss.cites) ? ss.cites.slice(0, 4) : []) {
        if (!c || typeof c !== 'object') continue;
        const cc = c as Record<string, unknown>;
        const source = clip(cc.source, 10);
        const quote = clip(cc.quote, 600);
        if ((source === 'resume' || source === 'posting' || source === 'letter') && quote) cites.push({ source, quote });
      }
      sentences.push({ text, kind: KINDS.includes(kindRaw) ? kindRaw : 'other', cites });
    }
    if (sentences.length) paragraphs.push(sentences);
  }
  return { greeting: clip(parsed.greeting, 200), paragraphs, closing: clip(parsed.closing, 120) };
}

const TONE_RULES: Record<LetterTone, string> = {
  plain: 'Plain: short sentences, everyday words, no flourishes, no exclamation marks.',
  warm: 'Warm: friendly and personal, still specific; one sentence may say why this team appeals to the candidate.',
  formal: 'Formal: polite, complete sentences, no contractions, no slang.',
};

const LENGTH_RULES: Record<LetterLength, string> = {
  short: 'Short: 3 body paragraphs, about 120–180 words in total (Chinese/Japanese: about 200–320 characters).',
  standard: 'Standard: 3–4 body paragraphs, about 250–350 words in total (Chinese/Japanese: about 400–600 characters).',
};

export class CoverLetterWriterAgent extends BaseAgent<WriterInput, WriterOutput> {
  constructor() {
    super('CoverLetterWriterAgent');
  }

  protected getTemperature(): number {
    // Room for wording; the checks downstream are strict.
    return 0.5;
  }

  protected getMaxTokens(): number | undefined {
    return 4_000;
  }

  protected getReasoningEffort() {
    return getTaskReasoningEffort('writing');
  }

  protected getResponseFormat(): 'json_object' {
    return 'json_object';
  }

  /** The letter IS the artifact: the 'content' scope, so it is written in the requested language. */
  protected getLocaleDirective(locale: string): string | null {
    return this.language.getStrictOutputLanguageDirective(locale, 'content') ?? super.getLocaleDirective(locale);
  }

  protected getAgentPrompt(): string {
    return `${currentBrandPersona('application writer')}. You write ONE cover letter for ONE candidate and ONE job. The candidate will read it, edit it and send it themselves.

## Hard rules

1. Never invent skills, employers, titles, dates, numbers or results. Every fact about the candidate must come from the RESUME or PROFILE below.
2. The JOB POST describes the employer. Its requirements, tools, products and numbers are the EMPLOYER'S facts, never the candidate's. If the post asks for Rust and the resume has no Rust, do NOT say the candidate used Rust. You may say the candidate would learn it, or talk about what the resume does show.
3. Name ONE concrete detail from the job post (a product, a team goal, a requirement) and connect it to something on the resume. No generic praise ("I'm excited about your mission").
4. Cite EVERY sentence of the body. Each sentence has "cites": one or more { "source": "resume" | "posting", "quote": "<a line copied EXACTLY from that source>" }. A sentence about the candidate's experience cites the RESUME. A sentence about the employer or the role cites the POST. Quotes are copied character for character, in the language the source is written in; never translate or shorten a quote's words.
5. Label each sentence "kind": "experience" (what the candidate did or knows), "motivation" (why this role), "company" (about the employer), or "other".
6. No name, email, phone number or address anywhere: the signature is added later. Do not invent a recipient's name; use a neutral greeting.
7. Do not say the letter was sent, will be sent, or that anyone applies for the candidate.

## Few-shot (shape only; these examples are not about this candidate)

Valid — Resume: "Led migration of 7 Postgres clusters to AWS Aurora, cutting query p95 from 380ms to 120ms." Post: "You will own database performance."
{ "text": "At my last role I led a migration of seven Postgres clusters to Aurora that cut p95 query time from 380ms to 120ms.", "kind": "experience", "cites": [{ "source": "resume", "quote": "Led migration of 7 Postgres clusters to AWS Aurora, cutting query p95 from 380ms to 120ms." }] }

Invalid — Resume: "Backend engineer, Go and Postgres." Post: "Rust experience required."
"I have shipped Rust services in production." ✗ The resume has no Rust. Corrected: "I build backend services in Go, and the post's focus on Rust is something I would ramp up on quickly." with cites to the resume line and the post line.

## Output (strict JSON only, no prose, no code fences)
{
  "greeting": "<a neutral greeting>",
  "paragraphs": [ [ { "text": "<sentence>", "kind": "experience|motivation|company|other", "cites": [ { "source": "resume|posting", "quote": "<exact line>" } ] } ] ],
  "closing": "<a closing word such as Sincerely, without a name>"
}`;
  }

  protected formatInput(input: WriterInput, locale?: string): string {
    const blocks: string[] = [];
    const reminder = this.outputLanguageReminder(locale ?? input.locale);
    if (reminder) blocks.push(reminder);
    blocks.push(`Letter language: ${input.locale}`);
    blocks.push(`Tone: ${TONE_RULES[input.tone]}\nLength: ${LENGTH_RULES[input.length]}`);
    blocks.push(`## JOB POST\nCompany: ${input.job.company || '(not listed)'}\nTitle: ${input.job.title}\n\n${input.job.text.slice(0, 9_000)}`);
    blocks.push(`## RESUME\n${input.resumeText.slice(0, 10_000)}`);
    if (input.profileText.trim()) blocks.push(`## PROFILE (the candidate's own answers)\n${input.profileText.slice(0, 3_000)}`);
    if (input.mode === 'rewrite') {
      blocks.push(
        `## CURRENT LETTER\n${(input.currentLetter ?? '').slice(0, 8_000)}\n\n## WHAT THE CANDIDATE ASKED\n${(input.instruction ?? '').slice(0, 1_000)}\n\nRewrite the letter as asked. A sentence you keep from the current letter may cite { "source": "letter", "quote": "<that sentence, copied exactly>" }. Everything else follows the hard rules.\n\nTokens such as [[USER_1]] stand for sentences the candidate wrote themselves. Keep each token exactly as written, as its own sentence ({ "text": "[[USER_1]]", "kind": "other", "cites": [{ "source": "letter", "quote": "[[USER_1]]" }] }), unless the candidate asked to remove that part. Never rewrite, translate or explain a token.`,
      );
    }
    if (input.retryNote) blocks.push(input.retryNote);
    blocks.push(input.mode === 'rewrite' ? 'Rewrite the letter. Output ONLY the JSON.' : 'Write the letter. Output ONLY the JSON.');
    return blocks.join('\n\n');
  }

  protected parseOutput(response: string): WriterOutput {
    return parseWriterOutput(response);
  }

  async run(input: WriterInput, options: { requestId?: string; signal?: AbortSignal } = {}): Promise<WriterOutput> {
    return this.execute(input, input.job.text, options.requestId, input.locale, getTaskModel('writing'), options.signal);
  }
}

// ── Adversarial fact-check (ported from SeekerResumeTailorAgent) ──────────

export interface FactCheckInput {
  resumeText: string;
  postingText: string;
  /** Body sentences to check, numbered from 1. */
  sentences: string[];
  locale: string;
}

export interface FactCheckViolation {
  sentence: number;
  claim: string;
  severity: 'hallucination' | 'mismatch' | 'metric' | 'posting_as_experience';
  originalSupport: string;
}

export interface FactCheckOutput {
  passed: boolean;
  violations: FactCheckViolation[];
}

const SEVERITIES: readonly FactCheckViolation['severity'][] = ['hallucination', 'mismatch', 'metric', 'posting_as_experience'];

/** Fail closed: anything unparseable is a failed check. */
export function parseFactCheckOutput(response: string): FactCheckOutput {
  const parsed = parseJsonObject(response);
  if (!parsed) return { passed: false, violations: [{ sentence: 0, claim: 'Fact-check output unparseable', severity: 'mismatch', originalSupport: 'NONE' }] };
  const violations: FactCheckViolation[] = [];
  for (const v of Array.isArray(parsed.violations) ? parsed.violations.slice(0, 30) : []) {
    if (!v || typeof v !== 'object') continue;
    const vv = v as Record<string, unknown>;
    const sev = clip(vv.severity, 30) as FactCheckViolation['severity'];
    violations.push({
      sentence: Number.isFinite(Number(vv.sentence)) ? Number(vv.sentence) : 0,
      claim: clip(vv.claim, 600),
      severity: SEVERITIES.includes(sev) ? sev : 'mismatch',
      originalSupport: clip(vv.originalSupport, 600) || 'NONE',
    });
  }
  return { passed: parsed.passed === true && violations.length === 0, violations };
}

export class CoverLetterFactCheckAgent extends BaseAgent<FactCheckInput, FactCheckOutput> {
  constructor() {
    super('CoverLetterFactCheckAgent');
  }

  protected getTemperature(): number {
    return 0;
  }

  protected getMaxTokens(): number | undefined {
    return 4_000;
  }

  protected getReasoningEffort() {
    return getTaskReasoningEffort('rewrite');
  }

  protected getResponseFormat(): 'json_object' {
    return 'json_object';
  }

  /** The checker comments on documents: 'analysis' scope; quotes stay verbatim. */
  protected getLocaleDirective(locale: string): string | null {
    const d = this.language.getStrictOutputLanguageDirective(locale, 'analysis');
    return d
      ? `${d}\n"claim" and "originalSupport" are quotations: copy them VERBATIM, in the language they are written in. "severity" stays one of the English values.`
      : super.getLocaleDirective(locale);
  }

  protected getAgentPrompt(): string {
    return `You are an adversarial fact-checker. You get a RESUME (the only ground truth about the candidate), a JOB POST (facts about the employer) and the numbered sentences of a COVER LETTER. Find every sentence that states something about the candidate that the resume does not support.

PROCEDURE
1. For every skill, tool, employer, title, project, degree, certification, number and time period the letter attributes to the candidate, find it in the resume. Not found → "hallucination".
2. Numbers about the candidate must match the resume exactly ("10" becoming "12" → "metric").
3. A requirement, tool or fact from the JOB POST written as the candidate's own experience → "posting_as_experience".
4. A changed scope (e.g. "helped with" became "led") → "mismatch".
5. Sentences about the employer, the role or the candidate's motivation are fine when they do not claim experience.

OUTPUT (strict JSON only):
{ "passed": true|false, "violations": [ { "sentence": <number>, "claim": "<the offending words>", "severity": "hallucination"|"mismatch"|"metric"|"posting_as_experience", "originalSupport": "<what the resume says, or NONE>" } ] }
Any violation means passed=false.`;
  }

  protected formatInput(input: FactCheckInput): string {
    const numbered = input.sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return `## RESUME\n${input.resumeText.slice(0, 12_000)}\n\n## JOB POST\n${input.postingText.slice(0, 9_000)}\n\n## COVER LETTER SENTENCES\n${numbered}`;
  }

  protected parseOutput(response: string): FactCheckOutput {
    return parseFactCheckOutput(response);
  }

  async run(input: FactCheckInput, options: { requestId?: string; signal?: AbortSignal } = {}): Promise<FactCheckOutput> {
    return this.execute(input, undefined, options.requestId, input.locale, getTaskModel('rewrite'), options.signal);
  }
}
