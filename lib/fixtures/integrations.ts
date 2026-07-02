// lib/fixtures/integrations.ts
//
// Connected-services seed data — ported from the V3 prototype's `INTEGRATIONS`
// (6 providers; LinkedIn / GCal / GitHub connected, Gmail / Slack / Notion not)
// in RoboApply_V3/data.jsx.
//
// Conversions from the proto shape → `RAIntegration`:
//   - `id`   → `provider`
//   - `ic`   → `brandColor`
//   - `desc` → `description`
//   (name / connected / account carry over verbatim.)

import type { RAIntegration } from '../api/v2/types';

export const FIXTURE_INTEGRATIONS: RAIntegration[] = [
  {
    provider: 'linkedin',
    name: 'LinkedIn',
    description: 'Pull profile data + apply on platform',
    connected: true,
    account: 'maya@chen.io',
    brandColor: '#0A66C2',
  },
  {
    provider: 'gmail',
    name: 'Gmail',
    description: 'Auto-detect responses + classify replies',
    connected: false,
    account: null,
    brandColor: '#EA4335',
  },
  {
    provider: 'gcal',
    name: 'Google Calendar',
    description: 'Schedule interviews · know your blockers',
    connected: true,
    account: 'maya@chen.io',
    brandColor: '#4285F4',
  },
  {
    provider: 'slack',
    name: 'Slack',
    description: 'Get notifications in your work / DM space',
    connected: false,
    account: null,
    brandColor: '#4A154B',
  },
  {
    provider: 'notion',
    name: 'Notion',
    description: 'Export tracker rows to your job-hunt DB',
    connected: false,
    account: null,
    brandColor: '#FFFFFF',
  },
  {
    provider: 'github',
    name: 'GitHub',
    description: 'Pull starred repos as portfolio evidence',
    connected: true,
    account: 'mayachen',
    brandColor: '#FFFFFF',
  },
];
