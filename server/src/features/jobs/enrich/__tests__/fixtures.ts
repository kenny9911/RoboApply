// Test fixtures for job enrichment (WP-17). Anonymized postings written for
// these tests; no real employer's text. Not compiled with the server.

import type { EnrichJobRecord } from '../reconcile.js';

export const INTL_POSTING = [
  'Acme Analytics is hiring a Backend Engineer to build data APIs for retail clients.',
  'You will design services in Python and Go, and run them on Kubernetes.',
  'Requirements: 3+ years of backend experience, strong SQL, and experience with PostgreSQL.',
  'Nice to have: Kafka and Terraform.',
  'We are unable to sponsor work visas for this role.',
  'Applicants must be US citizens due to a government contract.',
  'Benefits include health insurance and a learning budget.',
].join('\n');

export const CN_POSTING = [
  '某某能源集团是一家中央企业，现招聘数据分析师。',
  '岗位职责：负责业务数据分析，搭建数据报表。',
  '任职要求：本科及以上学历，熟悉SQL和Python。',
  '表现优秀者可协助办理北京落户。',
].join('\n');

export function makeJob(overrides: Partial<EnrichJobRecord> = {}): EnrichJobRecord {
  return {
    id: 'job_1',
    market: 'intl',
    visibility: 'public',
    ownerUserId: null,
    sourceBoard: 'activejobs',
    title: 'Backend Engineer',
    titleNormalized: 'backend engineer',
    companyName: 'Acme Analytics',
    companyNameNormalized: 'acme analytics',
    description: INTL_POSTING,
    descriptionPlain: INTL_POSTING,
    qualifications: null,
    responsibilities: null,
    benefits: null,
    taxonomyIds: [],
    primaryTaxonomyId: null,
    seniority: null,
    educationLevel: null,
    skills: [],
    skillsDetail: null,
    sponsorship: null,
    sponsorshipEvidence: null,
    citizenshipRequired: null,
    clearanceRequired: null,
    employerTags: [],
    fraudFlags: null,
    marketTags: null,
    summary: null,
    enrichedAt: null,
    enrichVersion: null,
    enrichModel: null,
    archivedAt: null,
    ...overrides,
  };
}

/** A model reply for INTL_POSTING (as the model would send it). */
export function intlModelReply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taxonomyId: 'backend_engineer',
    seniority: 'mid',
    educationLevel: null,
    skills: [
      { skill: 'Python', kind: 'hard', required: true },
      { skill: 'Go', kind: 'hard', required: true },
      { skill: 'SQL', kind: 'hard', required: true },
      { skill: 'Kafka', kind: 'hard', required: false },
    ],
    sponsorship: { status: 'not_offered', quote: 'We are unable to sponsor work visas for this role.' },
    citizenshipRequired: { value: true, quote: 'Applicants must be US citizens due to a government contract.' },
    clearanceRequired: null,
    summary: 'Build data APIs for retail clients in Python and Go. The team runs services on Kubernetes. Third sentence dropped.',
    employerTags: [],
    ...overrides,
  };
}
