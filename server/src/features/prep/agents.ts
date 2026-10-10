// server/src/features/prep/agents.ts — the two AI writers of the question bank (WP-59).
//
//   PrepQuestionSetAgent  practice questions written from ONE job post (and the
//                         titles of the company's other open posts). The output
//                         is practice material, never a claim about what the
//                         company asks: the prompt forbids it and the service
//                         drops any question that says so (rules.ts).
//   PrepGuideAgent        the answer guide for one question (approach, what it
//                         tests, common mistakes, a rubric, follow-ups).
//
// Neither prompt carries anything about the user: no resume, no profile, no
// name. Both run only after `aiAllowed(user)` and the brand's `ai.text`
// capability (the service never loads this module otherwise: zero LLMService
// calls). GoApply calls pass the content-safety filter inside LLMService.

import { BaseAgent } from '../../agents/BaseAgent.js';
import { getTaskModel, getTaskReasoningEffort } from '../../lib/llm/llmTaskSettings.js';
import { currentBrandPersona } from '../../platform/brand/persona.js';
import { JOB_SET_SIZE, QUESTION_CATEGORIES, type QuestionGuide } from './contract.js';
import { asCategory, asDifficulty } from './rules.js';
import type { QuestionCategory, QuestionDifficulty } from './contract.js';

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

function clip(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function list(v: unknown, maxItems: number, maxLen: number): string[] {
  return Array.isArray(v) ? v.map((s) => clip(s, maxLen)).filter(Boolean).slice(0, maxItems) : [];
}

// ── Question set ─────────────────────────────────────────────────────────

export interface QuestionSetInput {
  locale: string;
  job: { title: string; company: string; text: string };
  /** Titles of the company's other open posts (context only). */
  otherTitles: string[];
  /** GoApply adds HR-round questions (HR面). */
  includeHrRound: boolean;
}

export interface GeneratedQuestion {
  title: string;
  body: string;
  category: QuestionCategory;
  difficulty: QuestionDifficulty | null;
}

export function parseQuestionSet(response: string): GeneratedQuestion[] {
  const parsed = parseJsonObject(response);
  const raw = parsed && Array.isArray(parsed.questions) ? parsed.questions : [];
  const out: GeneratedQuestion[] = [];
  for (const item of raw.slice(0, JOB_SET_SIZE + 4)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const body = clip(r.question ?? r.body, 1_000);
    if (body.length < 10) continue;
    const title = clip(r.title, 160) || body.slice(0, 160);
    out.push({ title, body, category: asCategory(r.category), difficulty: asDifficulty(r.difficulty) });
  }
  return out;
}

export class PrepQuestionSetAgent extends BaseAgent<QuestionSetInput, GeneratedQuestion[]> {
  constructor() {
    super('PrepQuestionSetAgent');
  }

  protected getTemperature(): number {
    return 0.6;
  }

  protected getMaxTokens(): number | undefined {
    return 3_000;
  }

  protected getReasoningEffort() {
    return getTaskReasoningEffort('writing');
  }

  protected getResponseFormat(): 'json_object' {
    return 'json_object';
  }

  /** The questions ARE the artifact: written in the requested language. */
  protected getLocaleDirective(locale: string): string | null {
    return this.language.getStrictOutputLanguageDirective(locale, 'content') ?? super.getLocaleDirective(locale);
  }

  protected getAgentPrompt(): string {
    return `${currentBrandPersona('interview practice writer')}. You write ${JOB_SET_SIZE} practice interview questions for ONE job post, so a candidate can rehearse before their interview.

## Hard rules

1. These are PRACTICE questions you wrote from the job post. Never say or imply that the company asks them, that candidates reported them, or that they come from real interviews. No "commonly asked at", no "candidates say", no "real interview question".
2. Base every question on something the JOB POST says: a responsibility, a requirement, a tool, a product, a team goal. The titles of the company's other open posts are context only (what the team is building); do not invent facts about the company.
3. Mix kinds: behavioural questions about past work, questions about the role's skills, and — only when the post is for an engineering role — one coding or system design question. Keep each question answerable in a 30–45 minute interview.
4. Plain wording. One question per item; no multi-part lists.
5. Never copy questions from a published test, assessment or book.
6. Category is one of: ${QUESTION_CATEGORIES.join(', ')}. Use "hr" only when asked for HR-round questions. Difficulty is easy, medium or hard.

## Output (strict JSON only, no prose, no code fences)
{ "questions": [ { "title": "<a short label, under 10 words>", "question": "<the question as the interviewer would say it>", "category": "<category>", "difficulty": "easy|medium|hard" } ] }`;
  }

  protected formatInput(input: QuestionSetInput, locale?: string): string {
    const blocks: string[] = [];
    const reminder = this.outputLanguageReminder(locale ?? input.locale);
    if (reminder) blocks.push(reminder);
    blocks.push(`Question language: ${input.locale}`);
    blocks.push(`## JOB POST\nCompany: ${input.job.company || '(not listed)'}\nTitle: ${input.job.title}\n\n${input.job.text.slice(0, 9_000)}`);
    if (input.otherTitles.length) blocks.push(`## OTHER OPEN POSTS AT THIS COMPANY (titles only)\n${input.otherTitles.map((t) => `- ${t.slice(0, 160)}`).join('\n')}`);
    if (input.includeHrRound) blocks.push('Include 2 HR-round questions (motivation, career plans, expectations) with category "hr".');
    blocks.push(`Write ${JOB_SET_SIZE} questions. Output ONLY the JSON.`);
    return blocks.join('\n\n');
  }

  protected parseOutput(response: string): GeneratedQuestion[] {
    return parseQuestionSet(response);
  }

  async run(input: QuestionSetInput, options: { requestId?: string } = {}): Promise<GeneratedQuestion[]> {
    return this.execute(input, input.job.text, options.requestId, input.locale, getTaskModel('writing'));
  }
}

// ── Guide ────────────────────────────────────────────────────────────────

export interface GuideInput {
  locale: string;
  question: { title: string; body: string; category: string };
}

export function parseGuide(response: string): QuestionGuide | null {
  const parsed = parseJsonObject(response);
  if (!parsed) return null;
  const guide: QuestionGuide = {
    approach: clip(parsed.approach, 1_500),
    whatTheyTest: list(parsed.whatTheyTest, 6, 300),
    commonMistakes: list(parsed.commonMistakes, 6, 300),
    rubric: list(parsed.rubric, 6, 300),
    followUps: list(parsed.followUps, 5, 300),
  };
  return guide.approach || guide.whatTheyTest?.length ? guide : null;
}

export class PrepGuideAgent extends BaseAgent<GuideInput, QuestionGuide | null> {
  constructor() {
    super('PrepGuideAgent');
  }

  protected getTemperature(): number {
    return 0.4;
  }

  protected getMaxTokens(): number | undefined {
    return 2_000;
  }

  protected getReasoningEffort() {
    return getTaskReasoningEffort('writing');
  }

  protected getResponseFormat(): 'json_object' {
    return 'json_object';
  }

  protected getLocaleDirective(locale: string): string | null {
    return this.language.getStrictOutputLanguageDirective(locale, 'content') ?? super.getLocaleDirective(locale);
  }

  protected getAgentPrompt(): string {
    return `${currentBrandPersona('interview practice coach')}. You explain how to prepare an answer to ONE interview question.

## Rules
1. Practical and plain: how to structure an answer, what a good answer shows, what to avoid.
2. Do not claim to know how any company scores answers. The rubric is a general one for this kind of question.
3. Do not invent facts about any company, and do not say who asks this question.
4. For coding or design questions, describe the approach and trade-offs in words; no full solution code.

## Output (strict JSON only, no prose, no code fences)
{ "approach": "<3–6 sentences>", "whatTheyTest": ["<skill>"], "commonMistakes": ["<mistake>"], "rubric": ["<what a strong answer includes>"], "followUps": ["<a likely follow-up question>"] }`;
  }

  protected formatInput(input: GuideInput, locale?: string): string {
    const blocks: string[] = [];
    const reminder = this.outputLanguageReminder(locale ?? input.locale);
    if (reminder) blocks.push(reminder);
    blocks.push(`Guide language: ${input.locale}`);
    blocks.push(`## QUESTION (${input.question.category})\n${input.question.title}\n\n${input.question.body.slice(0, 2_000)}`);
    blocks.push('Write the guide. Output ONLY the JSON.');
    return blocks.join('\n\n');
  }

  protected parseOutput(response: string): QuestionGuide | null {
    return parseGuide(response);
  }

  async run(input: GuideInput, options: { requestId?: string } = {}): Promise<QuestionGuide | null> {
    return this.execute(input, undefined, options.requestId, input.locale, getTaskModel('writing'));
  }
}
