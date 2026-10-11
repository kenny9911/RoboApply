// server/src/features/feed/rankingText.ts
//
// The published texts of the Recommended order: what /help/ranking shows
// (WP-40) and what the ranking code itself reads. They live in their own file
// so a ranking change edits this file and ranking.ts, and nothing else of the
// feed contract (MKT-2H pre-wiring for phase M4; SM-12). contract.ts re-exports
// the three names, so every importer and the web mirror
// (components/features/marketing/catalog.ts) are unchanged.
//
// No import: the web reads the feed contract's types, and this file with them.

// ── Ranking factors (public "How ranking works" page, /help/ranking, WP-40) ──

/**
 * Every factor of the Recommended order, with its weight. There is NO boost
 * for recruiter-bank jobs (a filter only, ARCH §4.8). WP-40 lists these on
 * /help/ranking; tests pin them so the page and the code cannot drift.
 */
export const RANKING_FACTORS = [
  { key: 'fit', weight: 0.55, what: 'Fit score: the AI score when one exists, otherwise the quick estimate. Both are on the same scale. Until a market has enough scored jobs to line the two up, a job with an AI score is ranked halfway between its quick estimate and its AI score.' },
  { key: 'freshness', weight: 0.2, what: 'How recently the job was posted: 100 × e^(−hours since posting / 72).' },
  { key: 'affinity', weight: 0.15, what: 'Your own actions: saving, applying and hiding jobs, and companies you marked as preferred; fades 2% a day.' },
  { key: 'source_quality', weight: 0.1, what: 'How complete the posting is: pay listed, a known application system, a real posting date, a detailed description.' },
] as const;

/**
 * Ordering rules besides the weighted factors (also listed on /help/ranking).
 * `sponsorship_first` applies under every sort, within each retrieval window
 * (the newest 400 matching jobs, then the next older ones).
 */
export const ORDERING_RULES = [
  {
    key: 'sponsorship_first',
    points: null,
    when: 'You said you need visa sponsorship (RoboApply).',
    what: 'Jobs whose posting mentions sponsorship come first, in the order you chose; jobs whose posting says it does not sponsor are hidden.',
  },
  {
    key: 'skills_boost',
    points: 10,
    when: 'Skills is the only filter that narrows your list.',
    what: 'Jobs that require more of your chosen skills rank higher in Recommended: up to 10 points, in proportion to how many of them the job asks for.',
  },
] as const;

/** Points added to a Recommended rank for the career goal chosen in onboarding (`onboardingAnswers.goal`). */
export const GOAL_ADJUSTMENTS = {
  more_senior: { points: 6, when: 'The job is above the lowest level you selected.' },
  management: { points: 6, when: 'The job manages people (role type or title).' },
  higher_pay: { points: 6, when: 'The listed pay is above your minimum, in the same currency.' },
  flexibility: { points: 4, when: 'The job is remote or hybrid.' },
  new_industry: { points: 0, when: 'No adjustment.' },
  different_role: { points: 0, when: 'No adjustment.' },
  learn_skills: { points: 0, when: 'No adjustment.' },
  work_life_balance: { points: 0, when: 'No adjustment.' },
  job_security: { points: 0, when: 'No adjustment.' },
} as const;

/**
 * The freshness curve the ranking change of phase M4 switches to (MATCH 4.11):
 * 100 × (fastShare · e^(−h / fastHours) + (1 − fastShare) · e^(−h / slowHours)),
 * steep for two days with a slow tail over two weeks. NOT READ YET: the value
 * in use is `FEED_LIMITS.freshnessHalfLifeHours` and the published text of the
 * `freshness` factor above says so. The M4 change reads this, rewrites that
 * text and deletes the old constant.
 */
export const FRESHNESS_CURVE = { fastHours: 48, slowHours: 336, fastShare: 0.7 } as const;
