// server/src/features/cn/interview/contract.ts — the GoApply AI-interview
// practice format: wire types and constants (TASK_PLAN.md WP-66; catalog
// F-INT-06; CN_TW_LAUNCH_PLAN.md §4.2 WP-VOICE-CN).
//
// The format is modelled on the one-way, timed AI interviews that mainland
// employers commonly use for campus and early-career hiring. User copy says
// "模拟企业常用的 AI 面试形式" and never names a vendor; nothing here claims
// anything about real interview outcomes.
//
// The client mirror of the rubric (components/features/practice-cn/rubric.ts)
// copies these shapes; a parity test keeps them equal.

/** Format id, registered in server/src/interview-engine/catalog/interviewFormats.ts (market `cn`). */
export const CN_AI_INTERVIEW_FORMAT_ID = 'cn_ai_interview';

/** The format runs 20–30 minutes; the default plan is 25. */
export const CN_FORMAT_MIN_MINUTES = 20;
export const CN_FORMAT_MAX_MINUTES = 30;
export const CN_FORMAT_DEFAULT_MINUTES = 25;

/**
 * General interview types a GoApply practice runs in this format. Skill
 * exercises (live coding, case, design critique …) keep their own format.
 */
export const CN_FORMAT_COMPATIBLE_TYPES: readonly string[] = [
  CN_AI_INTERVIEW_FORMAT_ID,
  'screening',
  'behavioral',
  'culture',
];

/** Sections of the script, in running order. */
export const CN_SECTION_IDS = [
  'self_intro',
  'motivation',
  'behavioral',
  'situational',
  'logic',
  'role',
  'closing',
] as const;
export type CnSectionId = (typeof CN_SECTION_IDS)[number];

/** One question of a zh question set. `zh` is primary; `en` serves GoApply's English locale. */
export interface CnQuestion {
  id: string;
  section: CnSectionId;
  zh: string;
  en: string;
  /** True when a good answer is one real story (checked for STAR completeness). */
  story: boolean;
  /** One-line hint shown before answering (zh / en). */
  hintZh: string;
  hintEn: string;
}

/** One section of the script with its timing. */
export interface CnScriptSection {
  id: CnSectionId;
  /** How many questions this section asks. */
  questions: number;
  /** Thinking time before each answer, seconds. */
  prepSeconds: number;
  /** Answer time limit per question, seconds. */
  answerSeconds: number;
}

/** A planned question in a built script. */
export interface CnPlannedQuestion extends CnQuestion {
  /** 0-based running order. */
  order: number;
  prepSeconds: number;
  answerSeconds: number;
}

export interface CnScript {
  formatId: typeof CN_AI_INTERVIEW_FORMAT_ID;
  minutes: number;
  language: 'zh' | 'en';
  questions: CnPlannedQuestion[];
}

// ─── Rubric and report ─────────────────────────────────────────────────────

/** The three report areas: communication, logic, behaviour. */
export const CN_AREA_KEYS = ['communication', 'logic', 'behaviour'] as const;
export type CnAreaKey = (typeof CN_AREA_KEYS)[number];

/**
 * Where an area value comes from:
 *   ai_review    — the AI review of this practice (shown with the AI label);
 *   text_checks  — the free text checks on the transcript (no model);
 *   star_check   — the STAR check below (no model);
 *   mixed        — the AI review did not finish everywhere (client only,
 *                  when it cannot tell which part finished).
 */
export type CnAreaBasis = 'ai_review' | 'text_checks' | 'star_check' | 'mixed';

export interface CnAreaScore {
  key: CnAreaKey;
  /** 0–100, or null when there is nothing to score ("—"). */
  value: number | null;
  basis: CnAreaBasis;
}

export const STAR_PARTS = ['situation', 'task', 'action', 'result'] as const;
export type StarPart = (typeof STAR_PARTS)[number];

export interface StarCheck {
  situation: boolean;
  task: boolean;
  action: boolean;
  result: boolean;
  /** Parts present, 0–4. */
  parts: number;
  missing: StarPart[];
}

export interface FillerHit {
  word: string;
  count: number;
}

export interface FillerCount {
  total: number;
  /** Most frequent first, ties in list order. */
  top: FillerHit[];
}

/** One answer of the practice, as checked. */
export interface CnAnswerCheck {
  /** 0-based answer order. */
  index: number;
  /** The question asked before this answer, or null when none was recorded. */
  question: string | null;
  /** Answer length: characters (Chinese) or words (other text). */
  length: number;
  /** STAR check, or null when the question did not ask for a story. */
  star: StarCheck | null;
  fillers: FillerCount;
}

export interface CnStarSummary {
  /** Answers to story questions. */
  storyAnswers: number;
  /** Story answers with all four parts. */
  complete: number;
  /** The part missing most often across story answers, or null. */
  missingMost: StarPart | null;
}

export interface CnFillerSummary {
  total: number;
  /** Fillers per 100 units of answer text, one decimal; null with no answer text. */
  per100: number | null;
  /** `chars` for Chinese answers, `words` otherwise. */
  unit: 'chars' | 'words';
  top: FillerHit[];
}

/** The GoApply practice report block (stored as `report.cn` on a GoApply InterviewSession). */
export interface CnPracticeReport {
  version: 1;
  formatId: string;
  language: string;
  generatedAt: string;
  areas: CnAreaScore[];
  star: CnStarSummary;
  fillers: CnFillerSummary;
  answers: CnAnswerCheck[];
}

/** A transcript turn in the shape both practice paths can provide. */
export interface CnTurn {
  role: 'interviewer' | 'candidate';
  text: string;
}

/** Breakdown rows as stored on a session (canonical or the scorer's English keys). */
export interface CnBreakdownRow {
  key: string;
  value: number;
}
