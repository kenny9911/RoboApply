// server/src/features/match/keywordRows.ts
//
// The keyword check (PRODUCT F-RES-08): requirements met / not met rows —
// title, years, education, skills n/m, keywords n/m — computed from the same
// fit components as the score. Deterministic and free; no second scale (the
// 0–100 fit score stays the only number). Used on job detail and in
// tailoring (WP-22's keyword report and WP-36a call `keywordRows`).
//
// "Your resume mentions it" is a whole-word, case-insensitive search of the
// resume text (substring for CJK terms) plus the user's profile skills.

import type { KeywordRow, KeywordRowStatus } from './contract.js';
import { degreeMeets, jobSkillList, mentions, normalizeText, skillKey, titleOverlap, userShows, type MatchJob, type MatchUser } from './preScore.js';

export interface KeywordInput {
  keyword: string;
  importance: 'high' | 'medium' | 'low';
}

/** Keywords shown in the check: high and medium importance, at most this many. */
export const MAX_KEYWORDS = 15;
export const MAX_SKILLS = 20;

export { mentions, normalizeText };

function ratioStatus(found: number, total: number): KeywordRowStatus {
  if (total === 0) return 'not_stated';
  if (found === total) return 'met';
  if (found * 2 >= total) return 'partly';
  return 'not_met';
}

export interface KeywordRowsJob extends MatchJob {
  minYears: number | null;
}

export function buildKeywordRows(input: {
  job: KeywordRowsJob;
  user: MatchUser;
  /** Resume text (markdown) the check reads; '' when the user has none. */
  resumeText: string;
  keywords: KeywordInput[] | null;
}): KeywordRow[] {
  const { job, user } = input;
  const shown = { skills: user.skills, resumeTextNorm: normalizeText(input.resumeText) };
  const skillSet = new Set(user.skills.map(skillKey));
  const has = (term: string) => userShows(shown, term, skillSet);

  // Title and level: the same taxonomy overlap the score uses.
  const overlap = titleOverlap(user, job);
  const title: KeywordRow = {
    key: 'title',
    status: overlap === null ? 'unknown' : overlap >= 1 ? 'met' : overlap >= 0.6 ? 'partly' : 'not_met',
    need: job.title,
    have: user.recentTitle ?? user.targetTitles[0] ?? null,
    found: null,
    total: null,
    items: [],
  };

  const years: KeywordRow = {
    key: 'years',
    status: job.minYears === null ? 'not_stated' : user.yearsExperience === null ? 'unknown' : user.yearsExperience >= job.minYears ? 'met' : 'not_met',
    need: job.minYears,
    have: user.yearsExperience,
    found: null,
    total: null,
    items: [],
  };

  const meets = degreeMeets(user.highestDegree, job.educationLevel);
  const education: KeywordRow = {
    key: 'education',
    status: !job.educationLevel || job.educationLevel === 'none' ? 'not_stated' : meets === null ? 'unknown' : meets ? 'met' : 'not_met',
    need: job.educationLevel && job.educationLevel !== 'none' ? job.educationLevel : null,
    have: user.highestDegree,
    found: null,
    total: null,
    items: [],
  };

  const skillItems = jobSkillList(job)
    .slice(0, MAX_SKILLS)
    .map((s) => ({ term: s.skill, found: has(s.skill), required: s.required }));
  const skillsFound = skillItems.filter((s) => s.found).length;
  const skills: KeywordRow = {
    key: 'skills',
    status: ratioStatus(skillsFound, skillItems.length),
    need: null,
    have: null,
    found: skillItems.length ? skillsFound : null,
    total: skillItems.length || null,
    items: skillItems,
  };

  const kw = (input.keywords ?? [])
    .filter((k) => k && typeof k.keyword === 'string' && k.keyword.trim() && k.importance !== 'low')
    .filter((k, i, arr) => arr.findIndex((o) => skillKey(o.keyword) === skillKey(k.keyword)) === i)
    .slice(0, MAX_KEYWORDS)
    .map((k) => ({ term: k.keyword.trim(), found: has(k.keyword) }));
  const kwFound = kw.filter((k) => k.found).length;
  const keywords: KeywordRow = {
    key: 'keywords',
    status: ratioStatus(kwFound, kw.length),
    need: null,
    have: null,
    found: kw.length ? kwFound : null,
    total: kw.length || null,
    items: kw,
  };

  return [title, years, education, skills, keywords];
}
