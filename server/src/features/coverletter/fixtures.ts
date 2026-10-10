// server/src/features/coverletter/fixtures.ts
//
// Shared test fixtures for the cover-letter area (WP-37): a resume, a job
// post, writer outputs (a clean letter and one that writes a job-post fact as
// the candidate's own experience) and a service factory over the in-memory
// store. No vitest imports; nothing here touches a database or a model.

import type { CreditService } from '../../platform/credits/index.js';
import type { WriterOutput } from './CoverLetterAgent.js';
import { createMemoryCoverLetterStore, type MemoryCoverLetterStore } from './memoryStore.js';
import { CoverLetterService, type CoverLetterDeps, type PostingSnapshot, type RewriteBudget } from './service.js';

export const FIXTURE_USER = 'u_cl';

export const RESUME_MD = `# Sam Lee
*sam.lee@example.test · +1 415 555 0100 · Oakland*

## Summary
Backend engineer with 6 years building payment APIs in Go and Postgres.

## Experience
### Acme Pay · Senior Backend Engineer · 2021 – present
- Led migration of 7 Postgres clusters to AWS Aurora, cutting query p95 from 380ms to 120ms.
- Built the refunds API in Go serving 40 merchants.

### Bolt Labs · Backend Engineer · 2018 – 2021
- Wrote billing jobs in Go and Python.

## Skills
Go, Postgres, Python, AWS`;

export const JOB = {
  id: 'job_1',
  title: 'Senior Backend Engineer',
  companyName: 'Stripe',
  descriptionPlain:
    'You will own database performance for the payments platform. Rust experience required. We run Kubernetes across 3 regions.',
  qualifications: '5+ years of backend engineering. Experience with Postgres.',
  responsibilities: null,
};

export const CLEAN_LETTER: WriterOutput = {
  greeting: 'Dear Hiring Manager,',
  paragraphs: [
    [
      {
        text: 'Your post says the team will own database performance for the payments platform.',
        kind: 'company',
        cites: [{ source: 'posting', quote: 'You will own database performance for the payments platform.' }],
      },
      {
        text: 'At Acme Pay I led a migration of 7 Postgres clusters to AWS Aurora that cut query p95 from 380ms to 120ms.',
        kind: 'experience',
        cites: [{ source: 'resume', quote: 'Led migration of 7 Postgres clusters to AWS Aurora, cutting query p95 from 380ms to 120ms.' }],
      },
    ],
    [
      {
        text: 'I also built the refunds API in Go serving 40 merchants.',
        kind: 'experience',
        cites: [{ source: 'resume', quote: 'Built the refunds API in Go serving 40 merchants.' }],
      },
      {
        text: 'The post asks for Rust, which I have not used yet and would learn on the job.',
        kind: 'motivation',
        cites: [{ source: 'posting', quote: 'Rust experience required.' }],
      },
    ],
  ],
  closing: 'Sincerely,',
};

/** Writes the employer's requirement (Rust, Kubernetes) as the candidate's own experience. */
export const POSTING_AS_EXPERIENCE_LETTER: WriterOutput = {
  greeting: 'Dear Hiring Manager,',
  paragraphs: [
    [
      {
        text: 'I have shipped Rust services on Kubernetes across 3 regions.',
        kind: 'experience',
        cites: [{ source: 'posting', quote: 'We run Kubernetes across 3 regions.' }],
      },
    ],
  ],
  closing: 'Sincerely,',
};

export interface FixtureOptions {
  credits: Pick<CreditService, 'withCredit'>;
  write?: CoverLetterDeps['write'];
  factCheck?: CoverLetterDeps['factCheck'];
  ai?: () => boolean;
  market?: 'intl' | 'cn';
  footerEnabled?: boolean;
  rewriteLimit?: number;
  unverified?: number;
  /** Keep pasted posts (the SR-37-1 column); false behaves like the Prisma twin today. */
  keepPostings?: boolean;
  now?: () => Date;
}

export interface Fixture {
  store: MemoryCoverLetterStore;
  service: CoverLetterService;
  labelLogs: Array<{ kind: string; artifactId: string; contentId: string; provider: string }>;
  writerInputs: Parameters<CoverLetterDeps['write']>[0][];
  rewritesUsed: Map<string, number>;
  postings: Map<string, PostingSnapshot>;
}

/** Same steps as the real deps, minus the database, the model and the PII library. */
export function createFixture(options: FixtureOptions): Fixture {
  const store = createMemoryCoverLetterStore({ now: options.now });
  store.variants.set('rv_1', { id: 'rv_1', userId: FIXTURE_USER, name: 'Backend resume', kind: 'base', resumeMarkdown: RESUME_MD });
  store.jobs.set(JOB.id, { ...JOB, market: options.market ?? 'intl', ownerUserId: null });
  store.trackerEntries.set('te_1', { id: 'te_1', userId: FIXTURE_USER, coverLetterId: null });
  store.trackerEntries.set('te_other', { id: 'te_other', userId: 'someone_else', coverLetterId: null });
  const labelLogs: Fixture['labelLogs'] = [];
  const writerInputs: Fixture['writerInputs'] = [];
  const rewritesUsed = new Map<string, number>();
  const postings = new Map<string, PostingSnapshot>();
  const limit = options.rewriteLimit ?? 20;
  const stripHeader = (md: string) => md.split('\n').filter((l) => !/^#\s|^\*.*@/.test(l)).join('\n').trim();

  const deps: CoverLetterDeps = {
    store,
    credits: options.credits,
    aiAvailable: async () => (options.ai ? options.ai() : true),
    brandId: () => (options.market === 'cn' ? 'goapply' : 'roboapply'),
    market: () => options.market ?? 'intl',
    profileText: async () => 'Target role: Backend engineer',
    resumeForPrompt: (md) => stripHeader(md),
    // Name and email placeholders, like redactPii with LLM_PII_KINDS.
    redact: (text, name) => (name ? text.split(name).join('[name]') : text).replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'),
    unverifiedClaims: async () => options.unverified ?? 0,
    write: async (input, opts) => {
      writerInputs.push(input);
      return (options.write ?? (async () => structuredClone(CLEAN_LETTER)))(input, opts);
    },
    factCheck: options.factCheck ?? (async () => ({ passed: true, violations: [] })),
    rewriteBudget: async (letterId, cost): Promise<RewriteBudget> => {
      const used = (rewritesUsed.get(letterId) ?? 0) + cost;
      rewritesUsed.set(letterId, used);
      // Like consumeRateLimit: a cost-0 read at the limit is allowed with nothing left (the adapter adds the reset time).
      return { allowed: used <= limit, remaining: Math.max(0, limit - used), retryAfterSec: used >= limit ? 3600 : 0 };
    },
    modelId: () => 'openrouter/openai/gpt-test',
    label: {
      implicit: ({ contentId, provider }) => ({
        pdfInfo: { AIGenerated: 'true', AIContentID: contentId, AIProvider: provider },
        docxCustomProperties: { AIGenerated: 'true', AIContentID: contentId, AIProvider: provider },
        xmp: `<rdf:Description rdf:about="" xmlns:aigc="urn:test"><aigc:ContentID>${contentId}</aigc:ContentID></rdf:Description>`,
      }),
      newContentId: (brand) => `${brand === 'goapply' ? 'GA' : 'RA'}-test-${labelLogs.length + 1}`,
      footerLine: (locale) => (locale.startsWith('zh') ? '本文件部分内容由人工智能辅助生成，请核对后使用。' : 'Parts of this document were generated with AI assistance.'),
      footerEnabled: () => options.footerEnabled ?? false,
      log: async (input) => {
        // Mirrors logAiContentLabel: only GoApply writes a row.
        if (input.brand === 'goapply') labelLogs.push({ kind: input.kind, artifactId: input.artifactId, contentId: input.contentId, provider: input.provider });
      },
    },
    postings: {
      read: async (id) => (options.keepPostings === false ? null : (postings.get(id) ?? null)),
      write: async (id, snapshot) => {
        if (options.keepPostings !== false) postings.set(id, snapshot);
      },
    },
    now: options.now,
  };
  return { store, service: new CoverLetterService(deps), labelLogs, writerInputs, rewritesUsed, postings };
}
