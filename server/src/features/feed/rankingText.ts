// server/src/features/feed/rankingText.ts
//
// The published texts of the Recommended order: what /help/ranking shows
// (WP-40) and what the ranking code itself reads. They live in their own file
// so a ranking change edits this file and ranking.ts, and nothing else of the
// feed contract (SM-12). contract.ts re-exports the three names; the web
// mirror (components/features/marketing/catalog.ts) is compared with them by
// components/features/marketing/__tests__/links.test.ts.
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
  { key: 'freshness', weight: 0.2, what: 'How recently the job was posted: 100 × (0.7 × e^(−hours / 48) + 0.3 × e^(−hours / 336)); a post no longer listed by its source counts from when it was last seen.' },
  { key: 'affinity', weight: 0.15, what: 'Your own actions: saving, applying and hiding jobs, and companies you marked as preferred; fades 2% a day.' },
  { key: 'source_quality', weight: 0.1, what: 'How complete the posting is: pay listed, a known application system, a real posting date, a detailed description.' },
] as const;

/**
 * Ordering rules besides the weighted factors (also listed on /help/ranking).
 * `sponsorship_first` applies under every sort, within each retrieval window
 * (the first one: up to 400 candidates from the newest, the closest in words
 * and the closest in meaning; then the next older ones).
 * `points`: what the rule adds to a Recommended rank (negative: takes away);
 * null when it reorders, hides or works through a factor instead.
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
  {
    key: 'wrong_title',
    points: null,
    when: 'You marked a job "Not interested: wrong title".',
    what: 'Each time you do it, the weight of that role and the weight of that title each go down by 0.25 (weights run from −1 to 1); this fades 2% a day. The "your own actions" factor is the average of the role, company and skills weights, and of the title weight when it is below zero. A title is only ever moved down this way, never up, and your filters are not changed.',
  },
  {
    key: 'seen_skipped',
    points: -10,
    when: 'A job was in your list on three or more visits and you never opened it.',
    what: 'It ranks lower in Recommended: 5 points after three visits, 7.5 after four and 10 from five on.',
  },
  {
    key: 'same_role_collapse',
    points: null,
    when: 'A company posts the same role in several places.',
    what: 'You see one card, the best ranked of those postings, and it lists the other places, at most ten. A posting for the same place, or for an eleventh other place, stays a card of its own.',
  },
] as const;

/**
 * "Seen and skipped" (ORDERING_RULES `seen_skipped`): a job the person was
 * shown on `fromImpressions` or more visits and never opened loses
 * `points[i]` rank points at `fromImpressions + i` impressions, and the last
 * value from there on. An impression is one visit: a job counts once per feed
 * session, however often its card scrolls past (repo `recordImpressions`).
 */
export const SEEN_SKIPPED = { fromImpressions: 3, points: [5, 7.5, 10] } as const;

/**
 * Same role, several places (ORDERING_RULES `same_role_collapse`): the most
 * other places one card names and links (`FeedItem.alsoIn.jobIds`), and so the
 * most postings a card holds besides its own. A further place of the role
 * becomes a card of its own (ranking.ts `collapseSameRole`).
 */
export const ALSO_IN_MAX = 10;

/**
 * The weight "Not interested: wrong title" adds to the role and to the title
 * (ORDERING_RULES `wrong_title`; affinity.ts applies it). It is the change of
 * each WEIGHT, not of the factor: the factor averages the role, company and
 * skills weights (and the title weight when negative), so one mark moves it
 * by 0.25 / 3 for a job of the same role and by 0.5 / 4 for the same role and
 * title: about 4 and 6 of its 100 points.
 */
export const WRONG_TITLE_WEIGHT = -0.25;

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
 * The freshness curve (MATCH 4.11; ranking.ts `freshness` reads it):
 * 100 × (fastShare · e^(−h / fastHours) + (1 − fastShare) · e^(−h / slowHours)),
 * steep for two days with a slow tail over two weeks, so a 10-day-old job
 * (about 15) still outranks a 40-day-old one (about 2). `staleAfterHours`: a
 * job its source has not listed for longer than this counts from when it was
 * last seen, when that is older than its posting date.
 */
export const FRESHNESS_CURVE = { fastHours: 48, slowHours: 336, fastShare: 0.7, staleAfterHours: 48 } as const;
