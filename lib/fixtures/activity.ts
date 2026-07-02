// lib/fixtures/activity.ts
//
// Activity-log + agent-stats seed data — ported from the V3 prototype's `LOG`
// (3 day-groups) and the hardcoded orb / stat-strip numbers in
// RoboApply_V3/data.jsx + app.jsx.
//
// Conversions:
//   - The proto's JSX `body` (with <span className="co"> / <strong> /
//     <span className="reasoning">) → a plain MARKDOWN string. Company names
//     become **bold**; the trailing "reasoning" clause is appended as a normal
//     sentence (the V3 LogEntry renders the whole body via sanitized markdown).
//   - `kind` / `meta` are carried verbatim.
//   - Day labels ("Today · Thu, May 26") are kept as display strings; `dateUtc`
//     + each entry's `at` are computed RELATIVE to "now" (day 0 = today, etc.)
//     so the feed is always live and `activity.feed({days})` can slice it.
//
// `FIXTURE_AGENT_STATS` carries the proto's numbers. The stub derives the few
// fields that are derivable (e.g. `inQueue` from the queue fixture) so the demo
// stays consistent when the user sends queue items.

import type { RAActivityDay, RAAgentStats } from '../api/v2/types';

const DAY_MS = 86_400_000;

/** ISO timestamp `daysAgo` days back at `hh:mm` UTC. Keeps the feed anchored
 *  to "today" so the 7-day window always covers it. */
function at(daysAgo: number, hh: number, mm: number): string {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
}

/** YYYY-MM-DD for `daysAgo` days back. */
function dateUtc(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

export const FIXTURE_ACTIVITY: RAActivityDay[] = [
  {
    label: 'Today · Thu, May 26',
    dateUtc: dateUtc(0),
    entries: [
      {
        id: 'cm_act_001',
        at: at(0, 11, 42),
        kind: 'success',
        bodyMarkdown:
          'Applied to **Lattice** — **Lead PM, Performance**. Submitted cover, resume, and 4 screening answers.',
        meta: '8m saved',
        relatedJobId: 'm2',
      },
      {
        id: 'cm_act_002',
        at: at(0, 11, 38),
        kind: 'action',
        bodyMarkdown:
          'Drafted cover letter for **Lattice**. Emphasized your performance-review work at Mavn and quoted Priya R.’s recent Medium post about feedback loops.',
        meta: 'Step 3 of 4',
        relatedJobId: 'm2',
      },
      {
        id: 'cm_act_003',
        at: at(0, 11, 31),
        kind: 'action',
        bodyMarkdown:
          'Tailored resume for **Lattice**. Moved your “feedback infrastructure” bullet to the top. Trimmed the 2019 marketing role.',
        meta: 'Step 2 of 4',
        relatedJobId: 'm2',
      },
      {
        id: 'cm_act_004',
        at: at(0, 9, 14),
        kind: 'note',
        bodyMarkdown:
          'Scanned 184 new postings overnight. 12 met your match threshold; 2 sent to your queue, 10 surfaced as matches.',
        meta: '94 → 79',
        relatedJobId: null,
      },
      {
        id: 'cm_act_005',
        at: at(0, 8, 2),
        kind: 'note',
        bodyMarkdown:
          'Skipped **Plaid** auto-apply. Score fell below your 80 threshold after the JD update mentioned “3+ yrs fintech required.”',
        meta: '79 score',
        relatedJobId: 'm5',
      },
    ],
  },
  {
    label: 'Yesterday · Wed, May 25',
    dateUtc: dateUtc(1),
    entries: [
      {
        id: 'cm_act_006',
        at: at(1, 16, 18),
        kind: 'success',
        bodyMarkdown:
          'Applied to **Notion** — **Sr. PM, Enterprise**. Got autoresponder confirming receipt.',
        meta: '11m saved',
        relatedJobId: null,
      },
      {
        id: 'cm_act_007',
        at: at(1, 14, 51),
        kind: 'note',
        bodyMarkdown:
          'Updated resume narrative. You marked 2 jobs as “mission match” yesterday — strengthened your top-of-resume summary to lean into impact-driven work.',
        meta: 'Auto-tuned',
        relatedJobId: null,
      },
      {
        id: 'cm_act_008',
        at: at(1, 10, 2),
        kind: 'success',
        bodyMarkdown:
          'Applied to **Vercel** — **Product Manager, Cloud**. Custom cover + portfolio.',
        meta: '9m saved',
        relatedJobId: null,
      },
      {
        id: 'cm_act_009',
        at: at(1, 9, 33),
        kind: 'action',
        bodyMarkdown:
          'Declined 3 recruiter messages on your behalf. Asia-only roles — outside your stated location preference.',
        meta: 'Auto-declined',
        relatedJobId: null,
      },
    ],
  },
  {
    label: 'Tue, May 24',
    dateUtc: dateUtc(2),
    entries: [
      {
        id: 'cm_act_010',
        at: at(2, 15, 40),
        kind: 'success',
        bodyMarkdown: 'Applied to **Linear** — **Senior PM**.',
        meta: '7m saved',
        relatedJobId: null,
      },
      {
        id: 'cm_act_011',
        at: at(2, 13, 12),
        kind: 'note',
        bodyMarkdown:
          'Connected your calendar. Will schedule first-round screens automatically when responses come in.',
        meta: 'Integration',
        relatedJobId: null,
      },
    ],
  },
];

export const FIXTURE_AGENT_STATS: RAAgentStats = {
  sent: 14,
  replies: 3,
  hoursSaved: 11.5,
  autoAppliedToday: 3,
  scannedOvernight: 184,
  matchedAboveThreshold: 12,
  inQueue: 2,
  draftsWritten: 22,
  replyRate: 0.14,
  hoursSavedLifetime: 42,
  currentAction: null,
};
