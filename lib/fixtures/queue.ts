// lib/fixtures/queue.ts
//
// Review-queue seed data — ported from the V3 prototype's `QUEUE` array
// (RoboApply_V3/data.jsx). Two items: Ravel Health (94) and Watershed (88).
//
// Conversions from the proto shape → `RAQueueItem`:
//   - `cover[]` paragraphs       → a single `coverLetterMarkdown`
//                                   (`paras.join('\n\n')`)
//   - `checks[]` `{k,v}`         → `{ key, value }`
//   - `countdown` ("Auto-applies in 18m") → an ISO `plannedSubmitAt`
//                                   (now + 18m / now + 42m) so the card's live
//                                   countdown renders against a real timestamp.
//
// `plannedSubmitAt` is computed once at module load. The stub deep-clones this
// on first read, so the timestamps stay fixed for a session — close enough to
// "live" for the demo without drifting on every render.

import type { RAQueueItem } from '../api/v2/types';

const NOW = Date.now();
const MIN_MS = 60_000;

export const FIXTURE_QUEUE: RAQueueItem[] = [
  {
    id: 'cm_q_ravel',
    jobId: 'm1',
    title: 'Senior Product Manager, Patient Experience',
    companyName: 'Ravel Health',
    companyLogoUrl: null,
    location: 'Remote · US',
    matchScore: 94,
    plannedSubmitAt: new Date(NOW + 18 * MIN_MS).toISOString(),
    status: 'pending',
    coverLetterMarkdown: [
      "Ravel's onboarding flow caught my attention — the friction you're solving in patient intake mirrors a problem I owned end-to-end at Mavn Health. I rebuilt the new-patient signup over a 14-week sprint and lifted activation 34%.",
      "Two things I'd bring on day one: a tested framework for measuring activation across cohorts (not just a north-star number), and direct experience working with a clinical advisory board to validate UX changes. Happy to walk through the playbook.",
    ].join('\n\n'),
    checks: [
      { key: 'Resume', value: 'Tailored — emphasized healthtech work' },
      { key: 'Cover', value: 'Custom, 2 paragraphs' },
      { key: 'Questions', value: '4 of 4 answered' },
      { key: 'Portfolio', value: 'Linked patient-flow case study' },
    ],
    createdAt: new Date(NOW - 12 * MIN_MS).toISOString(),
    updatedAt: new Date(NOW - 12 * MIN_MS).toISOString(),
  },
  {
    id: 'cm_q_watershed',
    jobId: 'm3',
    title: 'Senior PM, Reporting',
    companyName: 'Watershed',
    companyLogoUrl: null,
    location: 'Remote · US/UK',
    matchScore: 88,
    plannedSubmitAt: new Date(NOW + 42 * MIN_MS).toISOString(),
    status: 'pending',
    coverLetterMarkdown: [
      "Watershed's reporting product sits exactly where I want to spend the next chapter — translating messy operational data into something execs actually act on. At Mavn I owned the clinician dashboard that reduced manual reporting time from 4 hours to 12 minutes per week.",
      "I'll be upfront: my last shipping context was B2C, not B2B SaaS. That said, the underlying problem — building reports a busy professional trusts on the first read — is the same one I solved for clinicians.",
    ].join('\n\n'),
    checks: [
      { key: 'Resume', value: 'Tailored — reframed dashboards as B2B' },
      { key: 'Cover', value: 'Custom, acknowledges B2B gap' },
      { key: 'Questions', value: '5 of 5 answered' },
      { key: 'Portfolio', value: 'Linked dashboard case study' },
    ],
    createdAt: new Date(NOW - 35 * MIN_MS).toISOString(),
    updatedAt: new Date(NOW - 35 * MIN_MS).toISOString(),
  },
];
