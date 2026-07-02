// lib/fixtures/resumeAI.ts
//
// Resume inline-AI seed data — ported from the V3 prototype's `AI_REWRITES`,
// `AI_SUMMARY_REWRITES`, `TAILOR_DIFF`, and `RESUME_COACH_TIPS`
// (RoboApply_V3/data.jsx). Backs the three new `resumes.*` methods
// (`rewrite` / `tailorDiff` / `coachTips`).
//
//   - FIXTURE_AI_REWRITES   → `resumes.rewrite({ mode:'bullet' })`: keyed by a
//                             synthetic bullet id (`b4`, `b2`) with a `__default`
//                             fallback for any other bullet. Each maps the 6
//                             actions → a rewritten string.
//   - FIXTURE_SUMMARY_REWRITES → `resumes.rewrite({ mode:'summary' })`: 3
//                             options labeled Tight / Numeric / Personality.
//   - FIXTURE_SKILL_SUGGESTIONS → `resumes.rewrite({ mode:'skills' })`.
//   - FIXTURE_TAILOR_DIFF   → `resumes.tailorDiff`: 6 changes, 72 → 94.
//   - FIXTURE_RESUME_COACH_TIPS → `resumes.coachTips`: 4 cycling tips.

import type {
  RAResumeCoachTip,
  RAResumeRewriteAction,
  RATailorDiff,
} from '../api/v2/types';

/** Per-action rewrite map for one bullet. */
export type RewriteByAction = Record<RAResumeRewriteAction, string>;

/** `AI_REWRITES` — keyed by bullet id, with `__default` fallback. */
export const FIXTURE_AI_REWRITES: Record<string, RewriteByAction> = {
  // Weak bullet (b4): "Worked closely with eng and design on retention features."
  b4: {
    improve:
      'Partnered with engineering and design to ship 3 retention features in 2 quarters, lifting D30 retention from 41% to 52%.',
    metrics:
      'Worked with 2 engineers and 1 designer on 3 retention features, lifting D30 retention from 41% to 52% (n=18,400).',
    shorten:
      'Shipped 3 retention features with eng + design; D30 retention rose from 41% to 52%.',
    expand:
      'Partnered with engineering and design across two quarters to scope and ship three retention features — a re-engagement nudge, a personalized welcome, and a streak system. D30 retention rose from 41% to 52%, and the streak system became the team\'s most-cited internal example.',
    confident:
      'Drove 3 retention features from concept to ship, partnering directly with engineering and design. Lifted D30 retention by 11 percentage points.',
    junior:
      'Co-led a retention squad with engineering and design — translated qualitative interview insights into 3 shipped features that lifted D30 retention by 11 points.',
  },
  // Strong-ish bullet (b2): "Led a 4-person squad through three quarters of dashboard work..."
  b2: {
    improve:
      'Led a 4-person squad through three quarters of clinician-dashboard work, shipping ahead of plan in two of them.',
    metrics:
      'Led a 4-person squad through three quarters of dashboard work, shipping 7 of 8 epics on time and 2 quarters ahead of plan.',
    shorten:
      'Led a 4-person squad through three quarters of dashboard work — beat plan twice.',
    expand:
      'Led a 4-person squad (2 eng, 1 design, 1 data) through three quarters of clinician-dashboard work. Shipped 7 of 8 planned epics on time, beat the quarterly plan twice, and our usage NPS rose from 38 to 54 across that period.',
    confident:
      'Owned a 4-person squad and three quarters of clinician-dashboard work. Beat plan twice and lifted usage NPS from 38 to 54.',
    junior:
      'Stepped up from APM to squad lead — drove three quarters of clinician-dashboard work, beat plan twice, and lifted usage NPS from 38 to 54.',
  },
  // Default — used for any other bullet
  __default: {
    improve:
      'Owned [project] end-to-end, partnering with [stakeholders] to ship [outcome]. Lifted [metric] from X to Y.',
    metrics:
      '[Action] [project] that [outcome] — measured by [metric, before → after], over [population, n=__].',
    shorten: 'Shipped [project] — [single sharp outcome].',
    expand:
      'Took [project] from [starting point] through [stages]. Partnered with [stakeholders] across [duration]. Result: [outcome with metric].',
    confident: 'I led / I owned / I drove [project] — [outcome with metric].',
    junior:
      'Translated [school/intern work] into a real-world deliverable — [scope, scale, result].',
  },
};

/** `AI_SUMMARY_REWRITES` — 3 options. The stub labels them Tight / Numeric /
 *  Personality in order. */
export const FIXTURE_SUMMARY_REWRITES: string[] = [
  'Senior PM, 4 years in healthtech. Shipped patient-onboarding redesign that lifted activation 34% and a clinician dashboard that cut manual reporting from 4 hours to 12 min/week. Want to do the same for a mission-driven team where the user is the patient, not the buyer.',
  'Healthtech PM with a habit of cutting steps. Owned 0→1 at Mavn (100k+ MAU) and shipped the payment-recovery flow that saved Stripe SMBs 4.2% in involuntary churn. Looking for a team where measurement matters.',
  "Patient-experience PM who's redesigned an 11-step signup into 4, taught clinicians to trust dashboards, and survived three Stripe shipping seasons. Comes with strong opinions about activation funnels and weak opinions about meeting agendas.",
];

/** Skills suggested from the candidate's bullets (mode:'skills'). */
export const FIXTURE_SKILL_SUGGESTIONS: string[] = [
  'Activation funnel design',
  'Cohort retention analysis',
  'Clinical advisory boards',
  'Patient journey mapping',
  'Experiment design (A/B)',
  'Cross-functional squad leadership',
];

/** `TAILOR_DIFF` — proposed changes for the Ravel Health job (72 → 94). The
 *  stub swaps in the requested job's company/role at call time. */
export const FIXTURE_TAILOR_DIFF: RATailorDiff = {
  jobId: 'm1',
  companyName: 'Ravel Health',
  roleTitle: 'Sr. PM, Patient Experience',
  matchBefore: 72,
  matchAfter: 94,
  changes: [
    {
      id: 'c1',
      section: 'Summary',
      kind: 'rewrite',
      label: 'Rewrite to lead with patient-experience work',
      before:
        'Senior PM with 4 years building patient-facing healthtech at Mavn Health.',
      after:
        'Senior PM with 4 years of patient-experience work at Mavn Health. Specialized in onboarding flows and clinician trust — the two systems Ravel mentions across its JD.',
    },
    {
      id: 'c2',
      section: 'Skills',
      kind: 'add',
      label: 'Add 3 skills from the JD that fit your background',
      added: [
        'Patient journey design',
        'HIPAA / PHI compliance',
        'Clinical advisory boards',
      ],
    },
    {
      id: 'c3',
      section: 'Experience · Mavn',
      kind: 'reorder',
      label: 'Move patient onboarding bullet to the top',
      detail:
        'Ravel\'s JD mentions "onboarding" 4× — your strongest bullet should lead.',
    },
    {
      id: 'c4',
      section: 'Experience · Mavn',
      kind: 'rewrite',
      label: 'Reframe the dashboards bullet around clinician trust',
      before:
        'Led a 4-person squad through three quarters of dashboard work, shipping ahead of plan twice.',
      after:
        "Led a 4-person squad to ship the clinician dashboard Ravel's JD describes — beat plan twice, lifted clinician usage NPS from 38 to 54.",
    },
    {
      id: 'c5',
      section: 'Education',
      kind: 'trim',
      label: 'Trim Cal Hacks line — Ravel hires for clinical depth, not hackathons',
      detail: 'Move freed space to a new Projects entry about OpenClinic.',
    },
    {
      id: 'c6',
      section: 'Header',
      kind: 'rewrite',
      label: 'Change title under your name to match JD wording',
      before: 'Senior Product Manager',
      after: 'Senior Product Manager · Patient Experience',
    },
  ],
};

/** `RESUME_COACH_TIPS` — 4 cycling tips for the editor. Each carries an i18n
 *  `code` (matching the deterministic backend in RAResumeAIService) so the
 *  stub exercises the same localized render path as the real backend; `text`
 *  is the English fallback. */
export const FIXTURE_RESUME_COACH_TIPS: RAResumeCoachTip[] = [
  {
    kind: 'good',
    code: 'metrics_good',
    text: 'Your bullets carry real numbers. Keep that quantified voice across the whole resume.',
  },
  {
    kind: 'careful',
    code: 'summary_long',
    text: 'Your summary runs long. Cut it to two sharp sentences — recruiters skim this first.',
  },
  {
    kind: 'good',
    code: 'strong_verbs',
    text: 'Strong verbs throughout — no "responsible for" or "helped with" anywhere. Keep it.',
  },
  {
    kind: 'careful',
    code: 'weak_verbs',
    params: { count: 2 },
    text: 'Found 2 weak opener(s) like "responsible for" / "helped with". Click ✦ Confident to rewrite with ownership verbs.',
  },
];
