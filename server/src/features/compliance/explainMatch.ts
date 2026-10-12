// server/src/features/compliance/explainMatch.ts
//
// "Why this job" / 为什么推荐 copy rules (PIPL Art. 24: automated decisions
// must be explainable and the user must be able to opt out of
// personalisation). The feed and job detail (WP-33, WP-34) render the
// returned lines with `t(line.key, line.params)` wherever a score is shown.
//
// Rules:
//   1. Personalised ranking runs only with the user's choice (GoApply:
//      `personalized_recommendation` granted; RoboApply: always). Otherwise
//      the explanation says the list is sorted by date posted and filters,
//      and carries no reasons or gaps.
//   2. Reasons come from scored dimensions only (title & level, skills,
//      industry, logistics, career path), strongest weighted contribution
//      first, at most three. When the scorer kept evidence, the line carries
//      one quote (`params.evidence`, `params.source` = resume | posting) that
//      the UI shows under it. No dimension → no reason (never invented).
//   3. Gaps name low-scoring dimensions and missing skills; "not stated"
//      dimensions say the posting did not say, never that the user lacks it.
//   4. No percentages beyond the tier word, and no personal attributes
//      (age, gender, birthplace, photo, family, EEO answers) — they are not
//      inputs to the score, and the notice says which inputs are.
//   5. Always: "This is not your chance of getting hired." A deterministic
//      pre-score says it is a quick estimate. GoApply adds how to turn
//      personalisation off (or on) in Settings.

import { tierForScore, type FitTierKey, type MatchDimensionKey } from '../match/contract.js';
import type { ExplainLine, MatchExplanation } from './contract.js';

export interface ExplainDimension {
  key: MatchDimensionKey;
  weight: number;
  score: number | null;
  status: 'scored' | 'not_stated';
  evidence?: Array<{ text: string; source: 'resume' | 'posting' }>;
}

export interface ExplainMatchInput {
  market: 'intl' | 'cn';
  /** False when the user turned personalisation off or has not chosen (GoApply). */
  personalized: boolean;
  score?: number | null;
  /**
   * The tier the card shows for this fit (`Fit.tier`, the feed badge's tier).
   * Pass it wherever there is one: the headline then names the same tier as
   * the card. A fit's tier is not always `tierForScore(score)` with the
   * default thresholds (a recomputed AI row keeps its tier by hysteresis, and
   * the thresholds are an admin setting). Absent or null → computed from the score.
   */
  tier?: FitTierKey | null;
  kind?: 'pre' | 'ai';
  dimensions?: ExplainDimension[];
  skills?: { aligned: string[]; missing: string[] };
}

export const EXPLAIN_MAX_REASONS = 3;
export const EXPLAIN_MAX_SKILLS = 3;
const REASON_MIN_SCORE = 60;
const GAP_MAX_SCORE = 50;
const MAX_TEXT = 120;
const MAX_SKILL = 40;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function skillList(skills: string[]): string {
  return skills
    .map((s) => clip(s, MAX_SKILL))
    .filter(Boolean)
    .slice(0, EXPLAIN_MAX_SKILLS)
    .join(', ');
}

function line(key: string, params?: Record<string, string | number>): ExplainLine {
  return params ? { key, params } : { key };
}

/**
 * Parts that are `not_stated` as often because the PERSON's side is missing
 * as because the posting's is: under estimate v2 the role part is null for
 * anyone with no role evidence (a student with no work history, on every
 * card), and industry and logistics likewise. This function is not told which
 * side is missing, so for these parts it says "Not enough to compare …"
 * (`legal.explain.notCompared.*`) and never "The posting does not say …",
 * which would be a false statement about a posting (D3; on GoApply this text
 * is the PIPL Art. 24 explanation). New keys, not new wording under the old
 * ones: a changed English string leaves the eight translated bundles saying
 * the old sentence until the i18n pass. `skills` keeps `notStated` (that part
 * is not stated only when the posting lists no skill), and `career_path` was
 * always worded neutrally.
 */
const NOT_COMPARED_KEYS: ReadonlySet<MatchDimensionKey> = new Set<MatchDimensionKey>(['title_level', 'industry', 'logistics']);

export function explainMatch(input: ExplainMatchInput): MatchExplanation {
  const notices: ExplainLine[] = [];

  if (!input.personalized) {
    notices.push(line('legal.explain.notice.factorsNone'));
    if (input.market === 'cn') notices.push(line('legal.explain.notice.turnOn'));
    return { mode: 'non_personalized', headline: line('legal.explain.headline.nonPersonalized'), reasons: [], gaps: [], notices };
  }

  const dims = input.dimensions ?? [];
  const reasons: ExplainLine[] = [];
  const gaps: ExplainLine[] = [];

  const scored = dims
    .filter((d) => d.status === 'scored' && typeof d.score === 'number')
    .sort((a, b) => b.weight * (b.score ?? 0) - a.weight * (a.score ?? 0));

  for (const d of scored) {
    if (reasons.length >= EXPLAIN_MAX_REASONS) break;
    if ((d.score ?? 0) < REASON_MIN_SCORE) continue;
    const ev = (d.evidence ?? []).find((e) => e.text.trim());
    reasons.push(
      ev
        ? line(`legal.explain.reason.${d.key}`, { evidence: clip(ev.text, MAX_TEXT), source: ev.source })
        : line(`legal.explain.reason.${d.key}`),
    );
  }
  const aligned = skillList(input.skills?.aligned ?? []);
  if (aligned && reasons.length < EXPLAIN_MAX_REASONS && !reasons.some((r) => r.key === 'legal.explain.reason.skills')) {
    reasons.push(line('legal.explain.reason.skillsAligned', { skills: aligned }));
  }

  for (const d of dims) {
    if (d.status === 'not_stated') gaps.push(line(`legal.explain.${NOT_COMPARED_KEYS.has(d.key) ? 'notCompared' : 'notStated'}.${d.key}`));
    else if (typeof d.score === 'number' && d.score < GAP_MAX_SCORE) gaps.push(line(`legal.explain.gap.${d.key}`));
  }
  const missing = skillList(input.skills?.missing ?? []);
  if (missing) gaps.push(line('legal.explain.gap.skillsMissing', { skills: missing }));

  const tier: FitTierKey | null = typeof input.score === 'number' ? (input.tier ?? tierForScore(input.score)) : null;
  const headline = tier ? line('legal.explain.headline.personalized', { tier }) : line('legal.explain.headline.personalizedNoScore');

  notices.push(line('legal.explain.notice.notHiringChance'));
  if (input.kind === 'pre') notices.push(line('legal.explain.notice.quickEstimate'));
  notices.push(line('legal.explain.notice.factors'));
  if (input.market === 'cn') notices.push(line('legal.explain.notice.turnOff'));

  return { mode: 'personalized', headline, reasons, gaps, notices };
}

/** Every key explainMatch can emit (the bundle test checks they all exist). */
export const EXPLAIN_KEYS: readonly string[] = (() => {
  const dims: MatchDimensionKey[] = ['title_level', 'skills', 'industry', 'logistics', 'career_path'];
  return [
    'legal.explain.headline.personalized',
    'legal.explain.headline.personalizedNoScore',
    'legal.explain.headline.nonPersonalized',
    'legal.explain.reason.skillsAligned',
    'legal.explain.gap.skillsMissing',
    'legal.explain.notice.notHiringChance',
    'legal.explain.notice.quickEstimate',
    'legal.explain.notice.factors',
    'legal.explain.notice.factorsNone',
    'legal.explain.notice.turnOff',
    'legal.explain.notice.turnOn',
    ...dims.map((d) => `legal.explain.reason.${d}`),
    ...dims.map((d) => `legal.explain.gap.${d}`),
    ...dims.map((d) => `legal.explain.${NOT_COMPARED_KEYS.has(d) ? 'notCompared' : 'notStated'}.${d}`),
  ];
})();
