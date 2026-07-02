// lib/fixtures/goal.ts
//
// Single `RACareerGoal` for the demo user. Tied to the prompt-specified
// "AI Software Engineer" target, $180k-$260k USD, weekly goal 5, US-remote.
// The target date sits ~16 weeks after BASE_NOW (see jobs fixture) — feels
// realistic in the demo without being so distant the UI shows "in a year".

import type { RACareerGoal } from '../api/v2/types';

export const FIXTURE_GOAL: RACareerGoal = {
  id: 'cm_goal_001',
  userId: 'cm_user_demo',
  targetTitle: 'AI Software Engineer',
  targetDate: '2026-09-15',
  targetSalaryMin: 180000,
  targetSalaryMax: 260000,
  targetSalaryCurrency: 'USD',
  weeklyApplicationGoal: 5,
  preferredLocations: {
    countries: ['US'],
    cities: ['New York', 'San Francisco', 'Seattle', 'Austin'],
    remoteOk: true,
    hybridOk: true,
  },
  preferredWorkType: 'remote',
  seniority: 'senior',
  notesMarkdown:
    'Looking for AI-product roles at companies with serious LLM infra. Prefer remote-first or NYC hybrid; would relocate for the right team. Avoid pure-research positions — I want to ship.',
  createdAt: '2026-05-01T18:30:00.000Z',
  updatedAt: '2026-05-20T09:12:00.000Z',
};
