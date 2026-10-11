// @vitest-environment node
//
// jobs-maintain additions (INT-05):
//   - WP-42: a public ATS board posting never expires by date; a posting the
//     board stopped listing is archived with its own reason ('source_removed');
//   - WP-17 → WP-16b: the enrichment catch-up — a stale-version row is queued
//     once, a rules-only row only when a model is configured and the budget is
//     above 0, and the per-run cap is respected.
// A small in-memory RAJob table plays the two SELECTs and the expiry UPDATE:
// no database, no network, no model.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../../platform/brand/index.js';
import type { EnqueueManyItem } from '../../../platform/queue/index.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { normalizeSql } from '../../../test/sqlSnapshot.js';
import { ENRICH_VERSION, RULES_CHECKED_MODEL, RULES_ONLY_MODEL, enrichDedupeKey, enrichJob } from '../enrich/index.js';
import { makeJob } from '../enrich/__tests__/fixtures.js';
import { resolveExpiresAt } from '../normalize/identity.js';
import { normalizeProviderJob } from '../normalize/index.js';
import { PUBLIC_ATS } from '../sources/atsPublic/contract.js';
import type { JobSourceAdapter } from '../sources/index.js';
import type { IngestDb } from './db.js';
import {
  BANK_BOARDS,
  ENRICH_REQUEUE_PER_RUN,
  NO_DATE_EXPIRY_BOARDS,
  buildExpireSql,
  buildRulesOnlySql,
  buildStaleEnrichSql,
  rulesRetryDedupeKey,
  runEnrichCatchUp,
  runMaintenance,
  staleEnrichDedupeKey,
} from './maintain.js';
import { runIngestQuery, type LeasedQueryRow } from './pipeline.js';
import { createIngestFake } from './testkit.js';
import { archiveClosedBankJobs } from './upsert.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const DAY = 86_400_000;
const robo = getBrand('roboapply');
const go = getBrand('goapply');

interface JobRow {
  id: string;
  market: string;
  visibility: string;
  sourceBoard: string;
  archivedAt: Date | null;
  closeReason: string | null;
  expiresAt: Date | null;
  postedAt: Date | null;
  enrichVersion: number | null;
  enrichModel: string | null;
  enrichedAt: Date | null;
}

const row = (over: Partial<JobRow> & { id: string }): JobRow => ({
  market: 'intl',
  visibility: 'public',
  sourceBoard: 'activejobs',
  archivedAt: null,
  closeReason: null,
  expiresAt: null,
  postedAt: new Date(NOW.getTime() - DAY),
  enrichVersion: ENRICH_VERSION,
  enrichModel: 'test/model',
  enrichedAt: new Date(NOW.getTime() - DAY),
  ...over,
});

/** Plays buildExpireSql, buildStaleEnrichSql and buildRulesOnlySql over `rows` (the dedupe repair updates nothing). */
function tableDb(rows: JobRow[]): { db: IngestDb; sql: string[] } {
  const sql: string[] = [];
  const byEnriched = (a: JobRow, b: JobRow) => (a.enrichedAt?.getTime() ?? -1) - (b.enrichedAt?.getTime() ?? -1) || (a.id < b.id ? -1 : 1);
  const read = (strings: TemplateStringsArray | { text: string; values: unknown[] }, ...values: unknown[]) => {
    const text = normalizeSql('text' in strings ? strings.text : strings.join('?'));
    const vals = 'text' in strings ? strings.values : values;
    sql.push(text);
    return { text, vals };
  };
  const db = {
    async $executeRaw(strings: TemplateStringsArray | { text: string; values: unknown[] }, ...values: unknown[]) {
      const { text, vals } = read(strings, ...values);
      if (!text.includes(`"closeReason" = 'expired'`)) return 0;
      const [market, boards, days] = vals as [string, string[], number];
      let n = 0;
      for (const r of rows) {
        if (r.market !== market || r.visibility !== 'public' || r.archivedAt || boards.includes(r.sourceBoard)) continue;
        const pastExpiry = !!r.expiresAt && r.expiresAt.getTime() < NOW.getTime();
        const tooOld = !r.expiresAt && !!r.postedAt && r.postedAt.getTime() < NOW.getTime() - days * DAY;
        if (!pastExpiry && !tooOld) continue;
        r.archivedAt = NOW;
        r.closeReason = 'expired';
        n += 1;
      }
      return n;
    },
    async $queryRaw(strings: TemplateStringsArray | { text: string; values: unknown[] }, ...values: unknown[]) {
      const { text, vals } = read(strings, ...values);
      if (text.includes('"enrichVersion" <')) {
        const [market, version, limit] = vals as [string, number, number];
        return rows.filter((r) => r.market === market && !r.archivedAt && r.enrichVersion !== null && r.enrichVersion < version).sort(byEnriched).slice(0, limit).map((r) => ({ id: r.id }));
      }
      if (text.includes('"enrichModel" =')) {
        const [market, version, model, limit] = vals as [string, number, string, number];
        return rows.filter((r) => r.market === market && !r.archivedAt && r.enrichVersion === version && r.enrichModel === model).sort(byEnriched).slice(0, limit).map((r) => ({ id: r.id }));
      }
      return [];
    },
  };
  return { db: db as unknown as IngestDb, sql };
}

/** A queue with the platform's dedupe rule: an item whose key exists is skipped. */
function queue() {
  const items: EnqueueManyItem[] = [];
  const enqueueMany = vi.fn(async (batch: EnqueueManyItem[]) => {
    let inserted = 0;
    for (const item of batch) {
      if (items.some((i) => i.options?.dedupeKey === item.options?.dedupeKey)) continue;
      items.push(item);
      inserted += 1;
    }
    return { inserted };
  });
  return { items, enqueueMany, ids: () => items.map((i) => (i.payload as { jobId: string }).jobId) };
}

describe('date expiry never applies to a public ATS board posting (WP-42)', () => {
  it('normalize: an ats_public job has no expiry date, whatever the board says and however old it is', () => {
    const posted = new Date(NOW.getTime() - 200 * DAY);
    expect(resolveExpiresAt('ats_public', null, posted)).toBeNull();
    expect(resolveExpiresAt('ats_public', '2026-01-01', posted)).toBeNull();
    // Control: a search provider's posting expires 45 days after it was posted.
    expect(resolveExpiresAt('activejobs', null, posted)).toEqual(new Date(posted.getTime() + 45 * DAY));
    const job = normalizeProviderJob(
      { externalId: 'appier:1', title: 'Backend Engineer', company: 'Appier', applyUrl: 'https://boards.greenhouse.io/appier/jobs/1', sourceBoard: 'greenhouse', description: 'Build services.', postedAt: posted.toISOString() },
      'ats_public',
      { now: NOW },
    );
    expect(job.expiresAt).toBeNull();
    expect(job.sourceBoard).toBe('greenhouse');
  });

  it('maintain: an ats_public job with an old postedAt is not expired; a search-provider job of the same age is', async () => {
    const old = new Date(NOW.getTime() - 200 * DAY);
    const rows = [
      row({ id: 'ats_old', sourceBoard: 'greenhouse', postedAt: old }),
      row({ id: 'ats_lever_old', sourceBoard: 'lever', postedAt: old }),
      row({ id: 'bank_old', sourceBoard: 'robohire', postedAt: old }),
      row({ id: 'search_old', sourceBoard: 'activejobs', postedAt: old }),
      row({ id: 'search_past_expiry', sourceBoard: 'jsearch', expiresAt: new Date(NOW.getTime() - DAY) }),
      row({ id: 'search_fresh', sourceBoard: 'activejobs' }),
      row({ id: 'private_old', visibility: 'private', sourceBoard: 'user_import', postedAt: old }),
    ];
    const { db } = tableDb(rows);
    const res = await runMaintenance(db, 'intl', [], { perQueryTracking: false });
    expect(res.expired).toBe(2);
    const archived = rows.filter((r) => r.archivedAt).map((r) => r.id);
    expect(archived.sort()).toEqual(['search_old', 'search_past_expiry']);
    expect(rows.find((r) => r.id === 'ats_old')).toMatchObject({ archivedAt: null, closeReason: null });
  });

  it('the boards excluded from date expiry are the banks plus every public ATS', () => {
    expect([...NO_DATE_EXPIRY_BOARDS]).toEqual([...BANK_BOARDS, ...PUBLIC_ATS]);
    expect(normalizeSql(buildExpireSql('intl').text)).toContain('"sourceBoard" <> ALL(');
  });
});

describe('a source closes its own postings with its own reason (WP-42)', () => {
  const stored = () => [
    { id: 'a', sourceBoard: 'greenhouse', externalId: 'appier:1', archivedAt: null, visibility: 'public', closeReason: null },
    { id: 'b', sourceBoard: 'greenhouse', externalId: 'appier:2', archivedAt: null, visibility: 'public', closeReason: null },
    { id: 'c', sourceBoard: 'gohire', externalId: 'g1', archivedAt: null, visibility: 'public', closeReason: null },
  ];

  it('archiveClosedBankJobs writes the given reason; the default stays bank_closed', async () => {
    const fake = createFakePrisma({ seed: { rAJob: stored() } });
    expect(await archiveClosedBankJobs(fake as unknown as IngestDb, 'greenhouse', ['appier:1'], NOW, 'source_removed')).toBe(1);
    expect(await archiveClosedBankJobs(fake as unknown as IngestDb, 'gohire', ['g1'], NOW)).toBe(1);
    const rows = fake.$rows('rAJob');
    expect(rows.find((r) => r.id === 'a')).toMatchObject({ closeReason: 'source_removed', archivedAt: NOW, closedAt: NOW });
    expect(rows.find((r) => r.id === 'b')).toMatchObject({ closeReason: null, archivedAt: null });
    expect(rows.find((r) => r.id === 'c')).toMatchObject({ closeReason: 'bank_closed' });
  });

  it('a closed board archives with source_removed through the pipeline; a bank adapter that gives no reason archives as bank_closed', async () => {
    const lease = (provider: string): LeasedQueryRow => ({ id: `q_${provider}`, market: 'intl', provider, params: { q: '', country: '*', datePosted: 'all' }, origin: 'bank_sync', demandScore: 0, priority: 1, consecutiveEmpty: 0 });
    const adapter = (provider: JobSourceAdapter['provider'], sourceBoards: string[], closeReason?: 'source_removed'): JobSourceAdapter => ({
      provider,
      kind: 'cursor',
      markets: ['intl'],
      sourceBoards,
      isEnabled: () => true,
      supportsCountry: () => false,
      dailyCallLimit: () => null,
      fetch: async () => ({ jobs: [], calls: 1, closedExternalIds: provider === 'ats_public' ? ['appier:1'] : ['r1'], ...(closeReason ? { closeReason } : {}), exhausted: true, cursor: null }),
    });
    const { fake, db } = createIngestFake({
      seed: {
        rAJob: [
          { id: 'a', sourceBoard: 'greenhouse', externalId: 'appier:1', archivedAt: null, visibility: 'public', closeReason: null },
          { id: 'r', sourceBoard: 'robohire', externalId: 'r1', archivedAt: null, visibility: 'public', closeReason: null },
        ],
      },
    });
    const ctx = { db, brand: 'roboapply' as const, market: 'intl' as const, now: NOW, enqueueMany: async () => ({ inserted: 0 }) };
    const board = await runIngestQuery(ctx, adapter('ats_public', ['greenhouse', 'lever'], 'source_removed'), lease('ats_public'));
    const bank = await runIngestQuery(ctx, adapter('bank_robohire', ['robohire']), lease('bank_robohire'));
    expect(board.closed).toBe(1);
    expect(bank.closed).toBe(1);
    expect(fake.$rows('rAJob').find((r) => r.id === 'a')).toMatchObject({ closeReason: 'source_removed', archivedAt: NOW });
    expect(fake.$rows('rAJob').find((r) => r.id === 'r')).toMatchObject({ closeReason: 'bank_closed', archivedAt: NOW });
  });
});

describe('enrichment catch-up', () => {
  const withModel = { enrichModel: () => ({ available: true, model: 'openai/gpt-cheap' }) };
  const noModel = { enrichModel: () => ({ available: false }) };

  it('a stale-version row is enqueued once: a second run queues nothing while the item exists', async () => {
    const rows = [row({ id: 'stale', enrichVersion: ENRICH_VERSION - 1 }), row({ id: 'current' }), row({ id: 'never', enrichVersion: null, enrichedAt: null })];
    const { db } = tableDb(rows);
    const q = queue();
    const first = await runEnrichCatchUp(db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withModel });
    expect(first).toEqual({ staleQueued: 1, rulesQueued: 0, modelAvailable: true });
    expect(q.items).toEqual([{ kind: 'job.enrich', payload: { jobId: 'stale' }, options: { dedupeKey: enrichDedupeKey('stale'), brand: 'roboapply' } }]);
    const second = await runEnrichCatchUp(db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withModel });
    expect(second.staleQueued).toBe(0);
    expect(q.items).toHaveLength(1);
    // One enrichment per job per version: the key is the enrich area's own.
    expect(staleEnrichDedupeKey('stale', ENRICH_VERSION)).toBe(enrichDedupeKey('stale'));
    expect(staleEnrichDedupeKey('stale', 7)).toBe(enrichDedupeKey('stale', 7));
  });

  it('a rules-only row is enqueued only when a model is configured, with `force`, once per model id', async () => {
    const rows = [row({ id: 'rules', enrichModel: RULES_ONLY_MODEL }), row({ id: 'modelled' })];
    const { db } = tableDb(rows);

    // GoApply without a domestic model: nothing to retry with.
    const none = queue();
    expect(await runEnrichCatchUp(tableDb(rows.map((r) => ({ ...r, market: 'cn' }))).db, 'cn', { brand: go, enqueueMany: none.enqueueMany, env: {}, ...noModel })).toEqual({ staleQueued: 0, rulesQueued: 0, modelAvailable: false });
    expect(none.items).toHaveLength(0);

    const q = queue();
    const first = await runEnrichCatchUp(db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withModel });
    expect(first).toEqual({ staleQueued: 0, rulesQueued: 1, modelAvailable: true });
    expect(q.items).toEqual([
      { kind: 'job.enrich', payload: { jobId: 'rules', force: true }, options: { dedupeKey: rulesRetryDedupeKey('rules', 'openai/gpt-cheap', ENRICH_VERSION), brand: 'roboapply' } },
    ]);
    // The next night, the item still queued (or deferred by the budget): no second item for the same pass.
    expect((await runEnrichCatchUp(db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withModel })).rulesQueued).toBe(0);
    // A row that still owes its pass when the model changes is queued for the new model at once.
    const other = await runEnrichCatchUp(db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, enrichModel: () => ({ available: true, model: 'openai/gpt-better' }) });
    expect(other.rulesQueued).toBe(1);
    expect(rulesRetryDedupeKey('rules', 'openai/gpt-cheap', ENRICH_VERSION)).not.toBe(rulesRetryDedupeKey('rules', 'openai/gpt-better', ENRICH_VERSION));
    expect(rulesRetryDedupeKey('rules', undefined, ENRICH_VERSION)).toMatch(/^job\.enrich:rules:v\d+:model:[0-9a-f]{10}$/);
  });

  describe('the model pass is recorded on the row, not in the queue (the queue prunes finished items after 7 days)', () => {
    const plain = 'Build APIs in Python and Go. Benefits include dental.';
    /** Ingest covered taxonomy, seniority and 5 skills, and the posting has nothing only a model can cite. */
    const covered = { descriptionPlain: plain, description: plain, primaryTaxonomyId: 'backend_engineer', taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'], seniority: 'mid', skills: ['python', 'go', 'sql', 'kafka', 'terraform'] };
    const stamped = { enrichedAt: new Date(NOW.getTime() - 3 * DAY), enrichVersion: ENRICH_VERSION, enrichModel: RULES_ONLY_MODEL };

    /**
     * The drain: every queued item runs the real `enrichJob` against the
     * table (its row update lands on the row the catch-up reads). Then the
     * prune: finished items — and their dedupe keys — are gone.
     */
    async function drainAndPrune(
      q: ReturnType<typeof queue>,
      rows: JobRow[],
      records: Map<string, ReturnType<typeof makeJob>>,
      opts: { llm: () => Promise<string>; consent?: boolean; env?: Record<string, string | undefined> },
    ) {
      let modelCalls = 0;
      let rowWrites = 0;
      const outcomes: string[] = [];
      for (const item of q.items.splice(0)) {
        const payload = item.payload as { jobId: string; force?: boolean };
        const outcome = await enrichJob(
          payload,
          { attempt: 5, maxAttempts: 5 },
          {
            repo: {
              loadJob: async (id) => (records.has(id) ? { ...records.get(id)! } : null),
              saveJob: async (id, update) => {
                rowWrites += 1;
                Object.assign(records.get(id)!, update);
                const r = rows.find((x) => x.id === id)!;
                if (update.enrichModel !== undefined) r.enrichModel = update.enrichModel;
                if (update.enrichedAt !== undefined) r.enrichedAt = update.enrichedAt;
                if (update.enrichVersion !== undefined) r.enrichVersion = update.enrichVersion;
              },
              saveKeywords: async () => {},
              logCost: async () => {},
            },
            llm: {
              chatWithUsage: async (_messages, o) => {
                modelCalls += 1;
                return { content: await opts.llm(), usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, model: o.model ?? 'stack-default-model' };
              },
            },
            budget: async () => ({ allowed: true, retryAfterSec: 0, limit: 8000 }),
            aiAllowed: async () => opts.consent ?? true,
            afterEnrich: async () => {},
            env: opts.env ?? { LLM_ENRICH_MODEL: 'openai/gpt-cheap' },
            now: () => NOW,
          },
        );
        outcomes.push(outcome.status === 'rules_only' ? `rules_only:${outcome.reason}` : outcome.status);
      }
      return { modelCalls, rowWrites, outcomes };
    }

    it('a job that stays rules-only after its forced pass is not queued again once its work item is pruned', async () => {
      const records = new Map([
        // The model has nothing to add.
        ['covered', makeJob({ id: 'covered', ...covered, ...stamped })],
        // The model call fails on every attempt.
        ['failing', makeJob({ id: 'failing', ...stamped })],
        // A user's own import whose owner has not allowed AI.
        ['no_consent', makeJob({ id: 'no_consent', visibility: 'private', ownerUserId: 'u_private', sourceBoard: 'user_import', ...stamped })],
      ]);
      const rows = [...records.keys()].map((id) => row({ id, enrichModel: RULES_ONLY_MODEL, enrichedAt: stamped.enrichedAt }));
      const { db } = tableDb(rows);
      const q = queue();
      const run = () => runEnrichCatchUp(db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withModel });

      expect((await run()).rulesQueued).toBe(3);
      const first = await drainAndPrune(q, rows, records, { llm: () => Promise.reject(new Error('upstream 503')), consent: false });
      expect(first.outcomes.sort()).toEqual(['rules_only:covered', 'rules_only:llm_failed', 'rules_only:no_ai_consent']);
      expect(first.modelCalls).toBe(1); // only the public job that needed the model reached it
      expect(rows.map((r) => r.enrichModel)).toEqual([RULES_CHECKED_MODEL, RULES_CHECKED_MODEL, RULES_CHECKED_MODEL]);

      // Seven days later the queue has forgotten all three items. Night after night: nothing is queued,
      // so no row is rewritten, no market hook reruns and no model call is made for them again.
      expect(q.items).toHaveLength(0);
      for (let night = 0; night < 3; night++) {
        expect(await run()).toEqual({ staleQueued: 0, rulesQueued: 0, modelAvailable: true });
        const again = await drainAndPrune(q, rows, records, { llm: () => Promise.reject(new Error('upstream 503')), consent: false });
        expect(again).toEqual({ modelCalls: 0, rowWrites: 0, outcomes: [] });
      }
    });

    it('a pass that the model completes leaves the model id on the row; a pass that found no model leaves the row owed', async () => {
      const records = new Map([['r', makeJob({ id: 'r', ...stamped })]]);
      const rows = [row({ id: 'r', enrichModel: RULES_ONLY_MODEL })];
      const { db } = tableDb(rows);
      const q = queue();
      const run = () => runEnrichCatchUp(db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withModel });

      // GoApply-style drain with no usable model (the env changed between the cron and the drain): still owed.
      const cnRecords = new Map([['c', makeJob({ id: 'c', market: 'cn', ...stamped })]]);
      const cnRows = [row({ id: 'c', market: 'cn', enrichModel: RULES_ONLY_MODEL })];
      const cnQ = queue();
      const cnRun = () => runEnrichCatchUp(tableDb(cnRows).db, 'cn', { brand: go, enqueueMany: cnQ.enqueueMany, env: {}, ...withModel });
      expect((await cnRun()).rulesQueued).toBe(1);
      expect((await drainAndPrune(cnQ, cnRows, cnRecords, { llm: async () => '{}', env: {} })).outcomes).toEqual(['rules_only:no_model']);
      expect(cnRows[0]!.enrichModel).toBe(RULES_ONLY_MODEL);
      expect((await cnRun()).rulesQueued).toBe(1);

      expect((await run()).rulesQueued).toBe(1);
      const done = await drainAndPrune(q, rows, records, { llm: async () => JSON.stringify({ taxonomyId: 'backend_engineer', seniority: 'mid', skills: [] }) });
      expect(done.outcomes).toEqual(['enriched']);
      expect(rows[0]!.enrichModel).toBe('openai/gpt-cheap');
      expect((await run()).rulesQueued).toBe(0);
    });

    it('settled rows do not fill the oldest-first window: rows that still owe a pass are reached under a small cap', async () => {
      const rows = [
        ...Array.from({ length: 5 }, (_, i) => row({ id: `settled${i}`, enrichModel: RULES_CHECKED_MODEL, enrichedAt: new Date(NOW.getTime() - (30 - i) * DAY) })),
        row({ id: 'owed_a', enrichModel: RULES_ONLY_MODEL, enrichedAt: new Date(NOW.getTime() - 2 * DAY) }),
        row({ id: 'owed_b', enrichModel: RULES_ONLY_MODEL, enrichedAt: new Date(NOW.getTime() - DAY) }),
      ];
      const q = queue();
      expect(await runEnrichCatchUp(tableDb(rows).db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, limit: 2, ...withModel })).toMatchObject({ rulesQueued: 2 });
      expect(q.ids()).toEqual(['owed_a', 'owed_b']);
    });
  });

  it('ENRICH_DAILY_JOBS=0 means no model pass even with a model configured; a budget above 0 allows it', async () => {
    const rows = [row({ id: 'rules', enrichModel: RULES_ONLY_MODEL })];
    const off = queue();
    expect(await runEnrichCatchUp(tableDb(rows).db, 'intl', { brand: robo, enqueueMany: off.enqueueMany, env: { ENRICH_DAILY_JOBS: '0' }, ...withModel })).toEqual({ staleQueued: 0, rulesQueued: 0, modelAvailable: false });
    const on = queue();
    expect((await runEnrichCatchUp(tableDb(rows).db, 'intl', { brand: robo, enqueueMany: on.enqueueMany, env: { ENRICH_DAILY_JOBS: '10' }, ...withModel })).rulesQueued).toBe(1);
  });

  // Parity wave (plan §3.3): GoApply's enrichment runs on the shared model by default. A mainland
  // model is required only behind the operator's wall (`CN_LLM_DOMESTIC_ONLY`).
  it('the real model rule: GoApply uses the shared model by default and needs a mainland one only behind the wall; RoboApply uses the stack default', async () => {
    const cnRows = [row({ id: 'cn_rules', market: 'cn', enrichModel: RULES_ONLY_MODEL })];
    const WALL = { CN_LLM_DOMESTIC_ONLY: 'true' };
    const run = (env: Record<string, string>, enqueueMany: ReturnType<typeof queue>['enqueueMany']) => runEnrichCatchUp(tableDb(cnRows).db, 'cn', { brand: go, enqueueMany, env });

    // Default: the shared enrichment model, or GoApply's own (any vendor), serves GoApply.
    const shared = queue();
    expect(await run({ LLM_ENRICH_MODEL: 'openai/gpt-cheap' }, shared.enqueueMany)).toEqual({ staleQueued: 0, rulesQueued: 1, modelAvailable: true });
    expect(shared.items[0]!.options).toMatchObject({ brand: 'goapply' });
    expect((await run({ CN_LLM_ENRICH_MODEL: 'openai/gpt-cheap' }, queue().enqueueMany)).modelAvailable).toBe(true);
    // No model anywhere: rules only, nothing queued for a model pass.
    const none = queue();
    expect((await run({}, none.enqueueMany)).modelAvailable).toBe(false);

    // Behind the wall an international model, shared or GoApply's own, is not used.
    expect((await run({ ...WALL, LLM_ENRICH_MODEL: 'openai/gpt-cheap' }, none.enqueueMany)).modelAvailable).toBe(false);
    expect((await run({ ...WALL, CN_LLM_ENRICH_MODEL: 'openai/gpt-cheap' }, none.enqueueMany)).modelAvailable).toBe(false);
    expect(none.items).toHaveLength(0);
    const cn = queue();
    expect(await run({ ...WALL, CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat' }, cn.enqueueMany)).toEqual({ staleQueued: 0, rulesQueued: 1, modelAvailable: true });
    expect(cn.items[0]!.options).toMatchObject({ brand: 'goapply' });

    const intl = queue();
    expect((await runEnrichCatchUp(tableDb([row({ id: 'r', enrichModel: RULES_ONLY_MODEL })]).db, 'intl', { brand: robo, enqueueMany: intl.enqueueMany, env: { LLM_MODEL: 'openai/gpt-default' } })).rulesQueued).toBe(1);
    // RoboApply never reads GoApply's wall or its CN_ values.
    expect((await runEnrichCatchUp(tableDb([row({ id: 'r', enrichModel: RULES_ONLY_MODEL })]).db, 'intl', { brand: robo, enqueueMany: queue().enqueueMany, env: { ...WALL, LLM_MODEL: 'openai/gpt-default' } })).modelAvailable).toBe(true);
  });

  it('the cap is respected: stale rows first (oldest enrichment first), the rest of the cap for rules-only rows', async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row({ id: `stale${i}`, enrichVersion: ENRICH_VERSION - 1, enrichedAt: new Date(NOW.getTime() - (10 - i) * DAY) })),
      ...Array.from({ length: 6 }, (_, i) => row({ id: `rules${i}`, enrichModel: RULES_ONLY_MODEL, enrichedAt: new Date(NOW.getTime() - (10 - i) * DAY) })),
    ];
    const tight = queue();
    expect(await runEnrichCatchUp(tableDb(rows).db, 'intl', { brand: robo, enqueueMany: tight.enqueueMany, env: {}, limit: 4, ...withModel })).toMatchObject({ staleQueued: 4, rulesQueued: 0 });
    expect(tight.ids()).toEqual(['stale0', 'stale1', 'stale2', 'stale3']);

    const mixed = queue();
    expect(await runEnrichCatchUp(tableDb(rows).db, 'intl', { brand: robo, enqueueMany: mixed.enqueueMany, env: {}, limit: 8, ...withModel })).toMatchObject({ staleQueued: 6, rulesQueued: 2 });
    expect(mixed.ids()).toEqual(['stale0', 'stale1', 'stale2', 'stale3', 'stale4', 'stale5', 'rules0', 'rules1']);

    const none = queue();
    expect(await runEnrichCatchUp(tableDb(rows).db, 'intl', { brand: robo, enqueueMany: none.enqueueMany, env: {}, limit: 0, ...withModel })).toMatchObject({ staleQueued: 0, rulesQueued: 0 });
    expect(none.enqueueMany).not.toHaveBeenCalled();
    expect(ENRICH_REQUEUE_PER_RUN).toBe(500);
  });

  it('archived rows and other markets are never queued; runMaintenance reports the total and skips the step without options', async () => {
    const rows = [
      row({ id: 'gone', enrichVersion: 0, archivedAt: NOW }),
      row({ id: 'cn_stale', market: 'cn', enrichVersion: 0 }),
      row({ id: 'stale', enrichVersion: 0 }),
      row({ id: 'rules', enrichModel: RULES_ONLY_MODEL }),
    ];
    const q = queue();
    const res = await runMaintenance(tableDb(rows).db, 'intl', [], { perQueryTracking: false, enrich: { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withModel } });
    expect(res.enrichQueued).toBe(2);
    expect(q.ids()).toEqual(['stale', 'rules']);
    const skipped = tableDb(rows);
    expect((await runMaintenance(skipped.db, 'intl', [], { perQueryTracking: false })).enrichQueued).toBe(0);
    expect(skipped.sql.some((t) => t.includes('"enrichVersion"'))).toBe(false);
  });

  it('the two reads are bounded, market-scoped and skip archived rows', () => {
    const stale = buildStaleEnrichSql('intl', 3, 50);
    expect(normalizeSql(stale.text)).toBe(
      'SELECT "id" FROM "RAJob" WHERE "market" = $1 AND "archivedAt" IS NULL AND "enrichVersion" < $2::int ORDER BY "enrichedAt" ASC NULLS FIRST, "id" ASC LIMIT $3::int',
    );
    expect(stale.values).toEqual(['intl', 3, 50]);
    const rules = buildRulesOnlySql('cn', 3, RULES_ONLY_MODEL, 20);
    expect(normalizeSql(rules.text)).toBe(
      'SELECT "id" FROM "RAJob" WHERE "market" = $1 AND "archivedAt" IS NULL AND "enrichVersion" = $2::int AND "enrichModel" = $3 ORDER BY "enrichedAt" ASC NULLS FIRST, "id" ASC LIMIT $4::int',
    );
    expect(rules.values).toEqual(['cn', 3, 'rules', 20]);
  });
});
