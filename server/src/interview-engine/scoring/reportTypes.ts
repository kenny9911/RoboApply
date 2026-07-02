// backend/src/interview-engine/scoring/reportTypes.ts
//
// Canonical types for the RICH, LOCALIZED, LLM-generated interview report.
// Stored as-is in InterviewSession.report (Json?) — NO Prisma migration. The
// `version` field gates rich rendering:
//   'deterministic' → score-only (Phase A placeholder, or a legacy session)
//   '2'             → LLM-enriched (Phase B complete; possibly `degraded`)
//
// All prose fields are written by the LLM NATIVELY in `language` (= the
// session's interview language) — never machine-translated from English. The
// dimension `key`s and the rating/priority enums are stable identifiers the
// frontend localizes via t(); they are NOT translated by the LLM.

import type { InterviewScore, ScoreBreakdownItem } from './interviewScorer.js';

/** Fixed scoring taxonomy. Labels are localized on the frontend via t(`report.dim.${key}`). */
export type DimensionKey =
  | 'structure'
  | 'specificity'
  | 'communication'
  | 'confidence'
  | 'roleFit';

export const DIMENSION_KEYS: readonly DimensionKey[] = [
  'structure',
  'specificity',
  'communication',
  'confidence',
  'roleFit',
];

/** Map the deterministic scorer's English keys (and any LLM variants) → canonical. */
export function toCanonicalDimKey(raw: string): DimensionKey | null {
  const k = (raw ?? '').trim();
  const legacy: Record<string, DimensionKey> = {
    Structure: 'structure',
    Specificity: 'specificity',
    Communication: 'communication',
    Confidence: 'confidence',
    'Role fit': 'roleFit',
    'Role Fit': 'roleFit',
    'Role-fit': 'roleFit',
  };
  if (legacy[k]) return legacy[k];
  const lower = k.toLowerCase();
  const match = DIMENSION_KEYS.find((d) => d.toLowerCase() === lower);
  return match ?? null;
}

export interface RichBreakdownItem {
  key: DimensionKey;
  value: number; // 0-100
  note: string; // LLM prose in `language`
}

export type QuestionRating = 'strong' | 'adequate' | 'weak' | 'missed';

export interface QuestionAnalysisItem {
  /** Sequential 0-based display order + stable React key (assigned by orchestrator). */
  questionIndex: number;
  /** Matched blueprint question index, or null for an off-script (improvised) question. */
  blueprintIndex: number | null;
  /** Planned but never asked/answered. */
  missed: boolean;
  /** The question text — verbatim as asked, or the blueprint text when missed. */
  question: string;
  /** 1-3 sentence paraphrase of what the candidate said. Empty when missed. */
  answerSummary: string;
  /** Optional short verbatim quote (<=160 chars). */
  keyQuote?: string;
  /** REQUIRED (user ask: 分析). What the answer demonstrated vs. the ideal signal. */
  analysis: string;
  /** REQUIRED (user ask: 纠正). Specific gap/error. Empty string only for a 'strong' item. */
  correction: string;
  /** REQUIRED (user ask: 建议). Forward-looking, concrete advice. */
  suggestion: string;
  /** Reference answer grounded in THIS candidate's context (a guideline, not a script). */
  modelAnswer: string;
  rating: QuestionRating;
  score: number; // 0-100
  /** Optional short signal chips, e.g. ["no metric","good STAR"]. Max 4. */
  tags?: string[];
}

export type RecommendationPriority = 'high' | 'medium' | 'low';

export interface Recommendation {
  /** Short imperative title (4-8 words), in `language`. */
  title: string;
  priority: RecommendationPriority;
  /** 2-4 sentences citing a SPECIFIC transcript moment + why it fell short. */
  detail: string;
  /** A before→after rewrite; "before" recycles the candidate's actual words. */
  example: string;
  /** A specific drill (format + count + duration). Optional. */
  drill?: string;
  /** Optional link to a scoring dimension for UI cross-highlight. */
  linkedDimension?: DimensionKey;
}

export interface DeterministicBaseline {
  overall: number;
  breakdown: ScoreBreakdownItem[]; // English-keyed, untouched
}

/** The three independently-failable LLM sections of the rich report. */
export type ReportSection = 'holistic' | 'questionAnalysis' | 'recommendations';

/** The full rich report stored in InterviewSession.report (Json?). */
export interface RichInterviewReport {
  version: '2';
  generatedAt: string; // ISO-8601
  language: string; // BCP-47 = session.language; all prose is in this language
  durationSec: number | null;

  // ── Holistic scorecard (also mirrored to the flat columns) ──
  overall: number;
  breakdown: RichBreakdownItem[]; // exactly 5, canonical keys, canonical order
  strengths: string[]; // 2-4 evidence-grounded sentences
  gaps: string[]; // 2-4 evidence-grounded sentences
  summary: string; // 3-5 sentence executive narrative

  // ── New sections ──
  recommendations: Recommendation[]; // 3-5, ordered high→medium→low; [] if degraded
  questionAnalysis: QuestionAnalysisItem[]; // [] if degraded

  // ── Audit ──
  deterministicBaseline: DeterministicBaseline;
  degraded: boolean; // true if any agent fell back
  /**
   * Which LLM sections actually failed. The serializer nulls a failed
   * section's data so the UI shows an honest "unavailable" state — a bare []
   * from a failure renders as "nothing to flag", i.e. unearned praise.
   * Optional: absent on reports persisted before this field existed.
   */
  failedSections?: ReportSection[];
  /**
   * True when the session had too few substantive answers to run the LLM
   * agents at all — the empty sections are genuine, not a failure (so
   * `degraded` stays false).
   */
  tooShort?: boolean;
}

/** The Phase-A placeholder shape persisted synchronously before LLM enrichment. */
export interface DeterministicReport {
  version: 'deterministic';
  score: InterviewScore;
  durationSec: number | null;
}
