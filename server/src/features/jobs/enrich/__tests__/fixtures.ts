// Test fixtures for job enrichment (WP-17). Anonymized postings written for
// these tests; no real employer's text. Not compiled with the server.

import type { EnrichJobRecord } from '../reconcile.js';
import { buildSkillMap, enrichVocabularyOf, type CanonicalizeJobOptions, type EnrichSkillsPort, type EnrichVocabulary, type SkillMap } from '../skills.js';
import { buildVocabulary, canonicalizeMany, skillIdsInText, type CanonicalSkill, type SkillRecord, type SkillSnapshot } from '../../../skills/index.js';

export const INTL_POSTING = [
  'Acme Analytics is hiring a Backend Engineer to build data APIs for retail clients.',
  'You will design services in Python and Go, and run them on Kubernetes.',
  'Requirements: 3+ years of backend experience, strong SQL, and experience with PostgreSQL.',
  'Nice to have: Kafka and Terraform.',
  'We are unable to sponsor work visas for this role.',
  'Applicants must be US citizens due to a government contract.',
  'Benefits include health insurance and a learning budget.',
].join('\n');

/** A line that says what the employer does (SM-10), and the posting with it. */
export const INTL_BUSINESS_LINE = 'Acme Analytics builds B2B SaaS software that retailers use to forecast demand.';
export const INTL_POSTING_WITH_BUSINESS = `${INTL_POSTING}\n${INTL_BUSINESS_LINE}`;

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

// ── A fixture vocabulary (SYNTHETIC: written for these tests, not the committed seed) ──

function skill(id: string, labelEn: string, extra: Partial<SkillRecord> = {}): SkillRecord {
  return { id, kind: 'hard', labelEn, labelZh: null, labelZhHant: null, aliases: [], parentId: null, esco: null, onet: null, status: 'reviewed', ...extra };
}

/** Reviewed skills in three scripts, two soft skills, two certificates and one unreviewed skill. */
export const FIXTURE_SKILLS: SkillRecord[] = [
  skill('python', 'Python'),
  skill('go', 'Go', { aliases: ['golang'], everydayWord: true }),
  skill('sql', 'SQL', { parentId: 'relational_databases' }),
  skill('relational_databases', 'Relational databases', { labelZh: '关系型数据库', labelZhHant: '關聯式資料庫' }),
  skill('postgresql', 'PostgreSQL', { aliases: ['postgres', 'psql'], parentId: 'sql' }),
  skill('mysql', 'MySQL', { parentId: 'sql' }),
  skill('kafka', 'Kafka', { aliases: ['apache kafka'] }),
  skill('terraform', 'Terraform'),
  skill('kubernetes', 'Kubernetes', { aliases: ['k8s'] }),
  skill('grpc', 'gRPC'),
  skill('rest_apis', 'REST APIs', { aliases: ['rest api', 'restful apis'] }),
  skill('distributed_systems', 'Distributed systems', { labelZh: '分布式系统', labelZhHant: '分散式系統' }),
  skill('machine_learning', 'Machine learning', { labelZh: '机器学习', labelZhHant: '機器學習' }),
  skill('data_analysis', 'Data analysis', { labelZh: '数据分析', labelZhHant: '資料分析' }),
  skill('salesforce', 'Salesforce'),
  skill('communication', 'Communication', { kind: 'soft', labelZh: '沟通能力', labelZhHant: '溝通能力' }),
  skill('teamwork', 'Teamwork', { kind: 'soft', labelZh: '团队合作', labelZhHant: '團隊合作' }),
  skill('cpa', 'CPA', { kind: 'certification', labelZh: '注册会计师', aliases: ['certified public accountant'] }),
  skill('teacher_certificate', 'Teacher qualification certificate', { kind: 'certification', labelZh: '教师资格证', labelZhHant: '教師資格證' }),
  // Met in an earlier posting and not reviewed yet: shown, never scored.
  skill('featureflag', 'Feature flags', { status: 'unreviewed', aliasKeys: ['featureflag'] }),
];

export function fixtureVocabulary(records: readonly SkillRecord[] = FIXTURE_SKILLS, droppedKeys: readonly string[] = []): SkillSnapshot {
  return buildVocabulary(records, { droppedKeys });
}

/** The snapshot as enrichment reads it (the real text rule of features/skills over the fixture). */
export function fixtureEnrichVocabulary(snapshot: SkillSnapshot = fixtureVocabulary()): EnrichVocabulary {
  return enrichVocabularyOf(snapshot, skillIdsInText);
}

/** What the vocabulary says about `terms`, by exact alias only (the pure path of features/skills). */
export async function fixtureSkillMap(terms: readonly string[], snapshot: SkillSnapshot = fixtureVocabulary()): Promise<SkillMap> {
  return buildSkillMap(terms, await canonicalizeMany(terms, { vocabulary: snapshot }), fixtureEnrichVocabulary(snapshot));
}

export interface FakeSkillsPort {
  port: EnrichSkillsPort;
  /** Every `canonicalize` call: one per job. */
  calls: Array<{ terms: string[]; options: CanonicalizeJobOptions }>;
  /** Every `countMentions` call. */
  mentions: string[][];
  snapshot: SkillSnapshot;
  /**
   * True: the embedding step is off (no embedding key, or no label vectors
   * yet), so a public posting gets the exact-alias answer and nothing is
   * created, like a user's own import. A test may switch it mid-way.
   */
  embeddingOff: boolean;
}

/**
 * A vocabulary port over a fixture snapshot. `write: true` creates an
 * unreviewed skill for a string the vocabulary does not know (what the default
 * port does once the embedding step found no neighbour); `guesses` maps a
 * string to the skill an embedding neighbour would give it. No embedding
 * client, no database.
 */
export function fakeSkillsPort(options: { snapshot?: SkillSnapshot; guesses?: Record<string, string>; fails?: boolean; embeddingOff?: boolean } = {}): FakeSkillsPort {
  const snapshot = options.snapshot ?? fixtureVocabulary();
  const fake: FakeSkillsPort = {
    snapshot,
    calls: [],
    mentions: [],
    embeddingOff: options.embeddingOff ?? false,
    port: {
      vocabulary: async () => fixtureEnrichVocabulary(snapshot),
      canonicalize: async (terms, opts) => {
        fake.calls.push({ terms: [...terms], options: opts });
        if (options.fails) throw new Error('vocabulary down');
        const writes = opts.write && !fake.embeddingOff;
        const guessOf = (term: string): string | undefined => (writes ? options.guesses?.[term] : undefined);
        const rest = terms.filter((t) => !guessOf(t));
        const mapped: CanonicalSkill[] = await canonicalizeMany(rest, { vocabulary: snapshot, ...(writes ? { create: async () => undefined } : {}) });
        const byTerm = new Map(rest.map((t, i) => [t, mapped[i]!] as const));
        return terms.map((t) => {
          const guess = guessOf(t);
          return guess ? { skillId: guess, status: snapshot.reviewed(guess) ? ('reviewed' as const) : ('unreviewed' as const), via: 'embedding' as const } : byTerm.get(t)!;
        });
      },
      countMentions: async (ids) => {
        fake.mentions.push([...ids]);
      },
    },
  };
  return fake;
}
