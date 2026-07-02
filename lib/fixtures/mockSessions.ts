// lib/fixtures/mockSessions.ts
//
// Recent mock-interview sessions + the scored report — ported from the V3
// prototype's `RECENT_SESSIONS` and `InterviewResults` numbers
// (RoboApply_V3/data.jsx + interview.jsx).
//
// `FIXTURE_MOCK_SESSIONS` feeds `mock.recentSessions` (synthetic ids added —
// the proto rows had none). `FIXTURE_MOCK_SCORE` feeds `mock.score`: overall
// 82, delta +11, 5 breakdown rows, strengths + gaps (the contract's spec'd
// numbers). The real impl reads the existing `lib/mockInterview/store.ts`
// localStorage + the heuristic scorer in `lib/mockInterview/ai.ts`.

import type { MockScoreResponse, RAMockSessionSummary } from '../api/v2/types';

export const FIXTURE_MOCK_SESSIONS: RAMockSessionSummary[] = [
  {
    id: 'cm_ms_001',
    role: 'Senior PM',
    interviewerName: 'Dr. Voss',
    typeLabel: 'Behavioral',
    score: 78,
    when: '2 days ago',
    note: 'Strong on metrics. Watch hedging on conflict questions.',
  },
  {
    id: 'cm_ms_002',
    role: 'Senior PM',
    interviewerName: 'Kai',
    typeLabel: 'System Design',
    score: 71,
    when: '4 days ago',
    note: 'Good framing. Get to the bottleneck faster.',
  },
  {
    id: 'cm_ms_003',
    role: 'Senior PM',
    interviewerName: 'June',
    typeLabel: 'Culture & Values',
    score: 85,
    when: '1 week ago',
    note: 'Authentic. Best session yet.',
  },
];

export const FIXTURE_MOCK_SCORE: MockScoreResponse = {
  overall: 82,
  delta: 11,
  durationMinutes: 25,
  breakdown: [
    {
      key: 'Structure',
      value: 84,
      note: 'Clear STAR arc on most answers — task setup was crisp.',
    },
    {
      key: 'Specificity',
      value: 88,
      note: 'Real numbers in every story. This is your strongest dimension.',
    },
    {
      key: 'Communication',
      value: 80,
      note: 'Good pace. A few filler runs when buying time — pause instead.',
    },
    {
      key: 'Confidence',
      value: 76,
      note: 'You hedged on the manager-disagreement question. Own the position.',
    },
    {
      key: 'Role fit',
      value: 83,
      note: 'Patient-experience framing landed well for a healthtech panel.',
    },
  ],
  strengths: [
    'Every answer carried a concrete metric — interviewers trust numbers over adjectives.',
    'Strong self-awareness on the reversal question; the rollback story showed judgment.',
    'Specific company reference instead of generic mission talk.',
  ],
  gaps: [
    'Hedged on the conflict question — commit to a real position next time.',
    'Trim filler before the first sentence; a one-beat pause reads as more composed.',
    'On the 30-day question, pick one bet rather than the listen/learn/lead cliché.',
  ],
};
