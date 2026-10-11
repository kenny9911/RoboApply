// server/src/features/match/eval/live/judgePrompt.ts
//
// The relevance judge of the live evaluation (MARKET_STRATEGY.md 2.6): a fixed,
// UMBRELA-style prompt that grades one (persona, posting) pair 0-3. Versioned:
// any change to the wording is a new JUDGE_PROMPT_VERSION, which is part of
// the cache key, so old grades are never reused under new instructions.
//
// The judge sees a synthetic persona (never a real user's resume or profile)
// and the text of one posting. It must be a different, stronger model than the
// production scorer (judge.ts refuses otherwise).

export const JUDGE_PROMPT_VERSION = 'judge_v1';

export interface JudgePersona {
  id: string;
  /** What the person is looking for and who they are, in plain lines. */
  summary: string;
  resumeMarkdown: string;
}

export interface JudgePosting {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  payText: string | null;
  description: string;
  qualifications: string | null;
}

export interface JudgeMessage {
  role: 'system' | 'user';
  content: string;
}

const SYSTEM = [
  'You are an experienced recruiter. You judge how well one job posting matches one job seeker.',
  'You are given the job seeker (what they are looking for and their resume) and the posting.',
  'Work through these steps before you answer:',
  '1. What work does the posting ask for, at what level, with which must-have requirements?',
  '2. What does the resume show: recent roles, level, skills, and what the person says they want?',
  '3. How close is the role? How close is the level? Which must-have requirements does the resume show, and which not?',
  '4. Is there a stated condition the person does not meet (a required degree, a class year, no visa sponsorship when they need it)?',
  'Then give one grade:',
  '3 = excellent match: the same kind of work at a level the person could hold now, and the resume shows most must-have requirements.',
  '2 = good match: closely related work or a level one step away, and the resume shows a fair share of the must-have requirements.',
  '1 = related: the same broad field, but a different role, a level two or more steps away, or few must-have requirements shown.',
  '0 = not relevant: different work, or a stated condition rules the person out.',
  'A posting that says too little to judge (no requirements, no level) is at most 2.',
  'An internship is at most 1 for a person with several years of experience.',
  'Judge only what is written. Do not assume skills the resume does not show. The language of the resume and of the posting may differ; that alone never lowers the grade.',
  'Answer with JSON only: {"grade": 0 | 1 | 2 | 3, "reason": "one sentence"}.',
].join('\n');

/** The messages for one pair. Deterministic: the same pair always gives the same text. */
export function buildJudgeMessages(persona: JudgePersona, posting: JudgePosting): JudgeMessage[] {
  const user = [
    '## Job seeker',
    persona.summary.trim(),
    '',
    '### Resume',
    persona.resumeMarkdown.trim(),
    '',
    '## Posting',
    `Title: ${posting.title}`,
    `Employer: ${posting.companyName}`,
    `Location: ${posting.location ?? 'not stated'}`,
    `Pay: ${posting.payText ?? 'not stated'}`,
    '',
    '### Description',
    posting.description.trim() || 'not stated',
    '',
    '### Requirements',
    posting.qualifications?.trim() || 'not stated',
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
