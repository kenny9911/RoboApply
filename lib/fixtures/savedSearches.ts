// lib/fixtures/savedSearches.ts
//
// 4 RASavedSearch rows for the demo. Names match the F1 spec: AI Engineer
// remote at $200k, NYC Software Engineer, Staff Engineer SF, ML Platform any.

import type { RASavedSearch } from '../api/v2/types';

export const FIXTURE_SAVED_SEARCHES: RASavedSearch[] = [
  {
    id: 'cm_ss_001',
    userId: 'cm_user_demo',
    name: 'Remote AI Engineer · $200k+',
    query: {
      q: 'AI Engineer',
      workType: 'remote',
      salaryMin: 200000,
      salaryCurrency: 'USD',
      sortBy: 'match_desc',
    },
    lastRunAt: '2026-05-25T19:00:00.000Z',
    createdAt: '2026-05-10T11:00:00.000Z',
    updatedAt: '2026-05-25T19:00:00.000Z',
  },
  {
    id: 'cm_ss_002',
    userId: 'cm_user_demo',
    name: 'NYC Software Engineer',
    query: {
      q: 'Software Engineer',
      location: 'New York',
      datePosted: '30d',
      sortBy: 'recent',
    },
    lastRunAt: '2026-05-22T08:30:00.000Z',
    createdAt: '2026-05-12T14:00:00.000Z',
    updatedAt: '2026-05-22T08:30:00.000Z',
  },
  {
    id: 'cm_ss_003',
    userId: 'cm_user_demo',
    name: 'Staff Engineer · SF',
    query: {
      q: 'Staff Engineer',
      location: 'San Francisco',
      salaryMin: 240000,
      salaryCurrency: 'USD',
      sortBy: 'salary_desc',
    },
    lastRunAt: '2026-05-20T17:00:00.000Z',
    createdAt: '2026-05-08T10:00:00.000Z',
    updatedAt: '2026-05-20T17:00:00.000Z',
  },
  {
    id: 'cm_ss_004',
    userId: 'cm_user_demo',
    name: 'ML Platform · any',
    query: {
      q: 'ML Engineer Platform',
      sortBy: 'match_desc',
    },
    lastRunAt: null,
    createdAt: '2026-05-19T09:00:00.000Z',
    updatedAt: '2026-05-19T09:00:00.000Z',
  },
];
