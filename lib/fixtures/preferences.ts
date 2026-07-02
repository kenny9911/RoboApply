// lib/fixtures/preferences.ts
//
// Extended-preferences seed data — ported from the V3 prototype's
// `PREFS_DEFAULTS` plus the option lists `INDUSTRIES` / `COMPANY_STAGES` /
// `COMPANY_SIZES` / `SENIORITY_LABELS` (RoboApply_V3/data.jsx).
//
// Renames applied (per 02-stub-contract.md §5):
//   intent      → intentMarkdown
//   salaryMin/Max → salaryMinK/MaxK
//   remote/hybrid/onsite → workModes { remote, hybrid, onsite }
//   companySize → companySizes
//   defaultResume → defaultResumeId
//
// Fields owned elsewhere are intentionally NOT in this blob:
//   - name / email live on the auth profile (the Preferences page composes them)
//   - targetTitle / salary band / work type / seniority / locations live on
//     `goal` (the proto's numeric `seniority: 3` index maps to `RASeniority` via
//     `goal`, so it's dropped here)
//
// `dataRetention` has no proto value; defaults to '365' (one of 30/90/365/forever).

import type { RAPreferenceOptions, RAPreferences } from '../api/v2/types';

export const FIXTURE_PREFERENCES: RAPreferences = {
  // Identity extras
  phone: '+1 415 555 0142',
  location: 'San Francisco, CA',
  pronouns: 'she/her',
  yearsExp: 4,
  defaultResumeId: 'r1',
  links: {
    linkedin: 'linkedin.com/in/mayachen',
    github: 'github.com/mayachen',
    portfolio: 'mayachen.io',
    x: '',
  },

  // Hunt
  huntActive: true,
  intentMarkdown:
    'Senior PM at a healthtech or climate company. Remote-first, $190k+. Series B/C preferred. No crypto, no defense.',
  roleTitles: ['Senior PM', 'Lead PM', 'Group PM'],
  workModes: { remote: true, hybrid: true, onsite: false },
  cities: ['San Francisco', 'New York', 'Remote · US'],
  salaryMinK: 180,
  salaryMaxK: 230,
  companyStages: {
    seed: false,
    seriesA: true,
    seriesB: true,
    seriesC: true,
    late: true,
    public: false,
  },
  companySizes: ['11–50', '51–200', '201–1000'],
  industriesTarget: ['Healthtech', 'Climate', 'Developer tools', 'Education', 'Consumer'],
  industriesAvoid: ['Crypto', 'Defense', 'Gambling', 'Ad-tech'],
  mustHaves: ['Remote-first', 'Mission-driven', 'Async-friendly'],
  dealbreakers: ['On-call PM rotation', 'In-office 5 days', 'Sub-180k base'],
  workAuth: 'US Citizen — no sponsorship needed',

  // Agent behavior
  aggressiveness: 'balanced',
  matchThreshold: 80,
  dailyCap: 10,
  quietStart: 22,
  quietEnd: 8,
  autoDecline: true,
  autoSchedule: false,
  pauseDuringInterviews: true,
  reScoreWeekly: true,
  coachLoudness: 'nudges',

  // Notifications
  channels: { email: true, push: true, sms: false },
  digest: 'daily',
  notif: {
    newMatch90: { email: true, push: true, sms: false },
    queueReview: { email: true, push: true, sms: false },
    appSent: { email: false, push: true, sms: false },
    response: { email: true, push: true, sms: true },
    interview: { email: true, push: true, sms: true },
  },

  // Privacy
  profileVisibility: 'private',
  blockedCompanies: ['Mavn Health', 'OpenAI'],
  blockedRecruiters: 2,
  dataRetention: '365',

  // Plan
  plan: 'pro',

  updatedAt: '2026-05-26T18:30:00.000Z',
};

export const FIXTURE_PREFERENCE_OPTIONS: RAPreferenceOptions = {
  industries: [
    'Healthtech',
    'Climate',
    'Fintech',
    'Edtech',
    'Developer tools',
    'AI / ML',
    'B2B SaaS',
    'Consumer',
    'E-commerce',
    'Marketplaces',
    'Logistics',
    'Manufacturing',
    'Cybersecurity',
    'Media',
    'Gaming',
    'Hardware',
    'Bio / Pharma',
    'Real estate',
    'Legal-tech',
  ],
  companyStages: [
    { id: 'seed', label: 'Seed', sub: '1–10 ppl · pre-product' },
    { id: 'seriesA', label: 'Series A', sub: '10–50 · product-market' },
    { id: 'seriesB', label: 'Series B', sub: '50–200 · scaling' },
    { id: 'seriesC', label: 'Series C', sub: '200–500 · expansion' },
    { id: 'late', label: 'Late-stage', sub: '500–5000 · pre-IPO' },
    { id: 'public', label: 'Public', sub: '5000+ · post-IPO' },
  ],
  companySizes: ['1–10', '11–50', '51–200', '201–1000', '1001–5000', '5000+'],
  seniorityLabels: ['Intern', 'Junior', 'Mid', 'Senior', 'Staff', 'Principal'],
};
