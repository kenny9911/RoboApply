// server/src/features/resume/builder/prompt.ts
//
// Prompt building for the guided builder's AI suggestions (WP-65). Pure.
//
// Hygiene (TASK_PLAN.md §2.2, PRODUCT_PLAN.md §9.4): a builder prompt carries
// only the target title, the entry's title and organization, the user's own
// notes and short context lines. The request schema has no personal-details
// field, and every line that mentions a photo, 籍贯, 政治面貌, gender, birth
// date, family members, marital status, ethnicity or an ID is dropped here;
// emails, phone numbers and ID numbers are masked (platform/pii). Tests assert
// none of them can reach the formatted prompt.

import { LLM_PII_KINDS, redactPii } from '../../../platform/pii/index.js';
import { isSensitiveLine } from '../check/resumeText.js';
import type { BuilderDocLanguage, BuilderDraft, BuilderSuggestBody, BuilderSuggestKind } from '../contract.js';

/** Max suggestions one call returns. */
export const MAX_SUGGESTIONS = 3;

export interface BuilderPromptInput {
  kind: BuilderSuggestKind;
  docLanguage: BuilderDocLanguage;
  targetTitle: string;
  entry: { title: string; organization: string; section: string } | null;
  notes: string;
  context: string[];
}

/**
 * Terms that never reach a builder prompt, on top of `isSensitiveLine` (which
 * covers 籍贯 / 政治面貌 / 性别 / 出生 / 家庭成员 / 照片 / ID lines and their
 * English forms). Party / League membership words name a political status even
 * without the 政治面貌 label.
 */
const EXTRA_SENSITIVE_RE = /中共党员|共青团员|预备党员|民主党派|党员|團員|黨員|\bphoto\b|\bheadshot\b|\bborn in\b|\bbirthplace\b|\bhometown\b|户籍|戶籍|\bpolitical (?:status|affiliation)\b/i;

/** True when a line must not enter a builder prompt. */
export function isPromptSensitive(line: string): boolean {
  return isSensitiveLine(line) || EXTRA_SENSITIVE_RE.test(line);
}

/** Drop sensitive lines and mask contact / ID details. */
export function sanitizePromptText(text: string, knownValues: ReadonlyArray<string | null | undefined> = []): string {
  const kept = (text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !isPromptSensitive(line))
    .join('\n');
  return redactPii(kept, { kinds: LLM_PII_KINDS, knownValues }).text.trim();
}

/** The sanitized prompt input for one suggestion request. */
export function builderPromptInput(body: BuilderSuggestBody, knownValues: ReadonlyArray<string | null | undefined> = []): BuilderPromptInput {
  const clean = (s: string) => sanitizePromptText(s, knownValues);
  return {
    kind: body.kind,
    docLanguage: body.docLanguage,
    targetTitle: clean(body.targetTitle).slice(0, 120),
    entry: body.entry
      ? { title: clean(body.entry.title).slice(0, 120), organization: clean(body.entry.organization).slice(0, 120), section: body.entry.section }
      : null,
    notes: clean(body.notes).slice(0, 2000),
    context: body.context.map(clean).filter(Boolean).slice(0, 40),
  };
}

/**
 * Context lines for a summary / self-evaluation, from a draft: titles,
 * organizations, bullets, skills and certificates. Never the basics (name,
 * contact), the personal details or the photo.
 */
export function draftContextLines(draft: Pick<BuilderDraft, 'intent' | 'education' | 'experience' | 'internship' | 'projects' | 'campus' | 'skills' | 'certificates' | 'awards'>): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t && !isPromptSensitive(t)) out.push(t.slice(0, 400));
  };
  for (const ed of draft.education) push([ed.degree, ed.major, ed.school].filter(Boolean).join(' '));
  for (const e of [...draft.experience, ...draft.internship, ...draft.campus]) {
    push([e.title, e.organization].filter(Boolean).join(', '));
    e.bullets.forEach(push);
  }
  for (const p of draft.projects) {
    push([p.name, p.role].filter(Boolean).join(', '));
    [p.star.situation, p.star.task, p.star.action, p.star.result, ...p.bullets].forEach(push);
  }
  if (draft.skills.length) push(draft.skills.join(', '));
  draft.certificates.forEach(push);
  draft.awards.forEach(push);
  return out.slice(0, 40);
}

const LANGUAGE_NAME: Record<BuilderDocLanguage, string> = {
  en: 'English',
  zh: 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese (Taiwan usage)',
};

/** The system instructions for one kind of suggestion. */
export function builderSystemPrompt(kind: BuilderSuggestKind, lang: BuilderDocLanguage): string {
  const rules = [
    `Write in ${LANGUAGE_NAME[lang]}.`,
    'Use ONLY facts in the notes and context. Never add a number, percentage, tool, employer, award or result that is not written there.',
    'If the notes give no result, describe the work without inventing one.',
    'No first person pronouns in bullets. No personal details (age, gender, birthplace, family, photo, political status).',
    `Return STRICT JSON: {"suggestions":["..."]} with at most ${MAX_SUGGESTIONS} items.`,
  ];
  const task: Record<BuilderSuggestKind, string> = {
    bullets:
      'Turn the notes about ONE resume entry into 2 to 4 resume bullets. Each bullet starts with a strong past-tense verb (or a concise Chinese action phrase), is one sentence, and is at most 30 words (or 60 Chinese characters). Return each bullet as one suggestion.',
    summary:
      'Write one 2 to 3 sentence professional summary for a resume aimed at the target role, from the context lines. Return up to 2 alternative versions as suggestions.',
    self_evaluation:
      'Write one short 自我评价 / self-evaluation paragraph (3 to 4 sentences, at most 120 Chinese characters or 70 English words) from the context lines: strengths shown by the entries, not generic praise. Return up to 2 alternative versions as suggestions.',
  };
  return `You help a job seeker write their own resume. ${task[kind]}\n\nRules:\n- ${rules.join('\n- ')}`;
}

/** The user message for one suggestion request. */
export function formatBuilderPrompt(input: BuilderPromptInput): string {
  const parts: string[] = [];
  if (input.targetTitle) parts.push(`TARGET ROLE: ${input.targetTitle}`);
  if (input.entry) {
    const head = [input.entry.title, input.entry.organization].filter(Boolean).join(' — ');
    parts.push(`ENTRY (${input.entry.section}): ${head || '(untitled)'}`);
  }
  if (input.notes) parts.push(`NOTES:\n${input.notes}`);
  if (input.context.length) parts.push(`CONTEXT:\n${input.context.map((c) => `- ${c}`).join('\n')}`);
  return parts.join('\n\n');
}

/** Parse the model's JSON; tolerant of fences and a bare array. */
export function parseBuilderOutput(raw: string): string[] {
  const text = (raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(text);
    if (!m) return [];
    try {
      data = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(data) ? data : Array.isArray((data as { suggestions?: unknown })?.suggestions) ? (data as { suggestions: unknown[] }).suggestions : [];
  return list
    .map((x) => (typeof x === 'string' ? x : typeof (x as { text?: unknown })?.text === 'string' ? (x as { text: string }).text : ''))
    .map((x) => x.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((x) => x.length > 0 && x.length <= 1200)
    .slice(0, 4);
}
