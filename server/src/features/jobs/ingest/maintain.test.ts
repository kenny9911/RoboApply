// @vitest-environment node
//
// jobs-maintain additions (INT-05):
//   - WP-42 / MKT-3C (JI-10): a posting past the deadline its source states is
//     archived whatever the source; only an aggregator's row is archived by
//     its posting age; a posting the board stopped listing is archived with
//     its own reason ('source_removed');
//   - MKT-3C (JI-5, JC-7): stored dedupe priorities follow PROVIDER_META;
//   - MKT-3C (PAR carry-over 7b): a bank row with no page a candidate can
//     open is archived (its bank has no posting page, or the row's link is
//     not that page while the bank's sync is not running), and the bank's
//     sync then starts from the beginning;
//   - WP-17 → WP-16b: the enrichment catch-up — a stale-version row is queued
//     once, a rules-only row only when a model is configured and the budget is
//     above 0, and the per-run cap is respected;
//   - MKT-5C (JI-10; MARKET_STRATEGY 1.5 "Closure", M-22): a public mainland
//     row no source has confirmed for 45 days is archived as 'expired'; the
//     rule exists for market `cn` only and never touches a user's import;
//   - MKT-5C (carry-over M4): a version bump reaches the newest postings
//     first, and a row that still holds a skill with no canonical id is queued
//     for a skills-only pass once the brand's embedding model has label
//     vectors in RASkill.
// A small in-memory RAJob table plays the SELECTs and the UPDATEs: no
// database, no network, no model.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../../platform/brand/index.js';
import type { EnqueueManyItem } from '../../../platform/queue/index.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { normalizeSql } from '../../../test/sqlSnapshot.js';
import { ENRICH_VERSION, RULES_CHECKED_MODEL, RULES_ONLY_MODEL, enrichDedupeKey, enrichJob, skillRemapDedupeKey } from '../enrich/index.js';
import { makeJob } from '../enrich/__tests__/fixtures.js';
import { bankMarket } from '../../../roboapply/v2/lib/raCrossBankMatch.js';
import { resolveExpiresAt } from '../normalize/identity.js';
import { AGE_EXPIRY_BOARDS, PROVIDER_META, normalizeProviderJob, type NormalizeProvider } from '../normalize/index.js';
import { PUBLIC_ATS } from '../sources/atsPublic/contract.js';
import type { JobSourceAdapter } from '../sources/index.js';
import { MAX_AGE_DAYS } from './config.js';
import type { IngestDb } from './db.js';
import {
  BANK_BOARDS,
  BANK_SYNC_PROVIDER,
  CN_UNSEEN_DAYS,
  DEAD_BANK_LINK_SCAN_LIMIT,
  ENRICH_REQUEUE_PER_RUN,
  alignSourcePriority,
  archiveDeadBankLinks,
  archiveUnseenMainland,
  buildAlignPrioritySql,
  buildExpireSql,
  buildRestartBankSyncSql,
  buildRulesOnlySql,
  buildSkillRemapSql,
  buildSkillVectorProbeSql,
  buildStaleEnrichSql,
  buildUnseenMainlandSql,
  priorityTargets,
  rulesRetryDedupeKey,
  runEnrichCatchUp,
  runMaintenance,
  staleEnrichDedupeKey,
} from './maintain.js';
import { runIngestQuery, type LeasedQueryRow } from './pipeline.js';
import { createIngestFake } from './testkit.js';
import { archiveClosedBankJobs, pickCanonical, type DedupeCandidate } from './upsert.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const DAY = 86_400_000;
const robo = getBrand('roboapply');
const go = getBrand('goapply');

/** Both banks have a posting page (synthetic hosts). */
const TEMPLATE = { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://example.test/p/{id}', ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://example.test/r/{id}' };
const bankAdapter = (provider: NormalizeProvider, board: string, enabled: boolean): JobSourceAdapter =>
  ({ provider, kind: 'cursor', markets: [board === 'gohire' ? 'cn' : 'intl'], sourceBoards: [board], isEnabled: () => enabled, supportsCountry: () => false, dailyCallLimit: () => null, fetch: async () => ({ jobs: [], calls: 0, exhausted: true, cursor: null }) }) as unknown as JobSourceAdapter;
/** The state in which step 4 has nothing to do: both banks have a posting page and their sync runs. */
const BANKS_RUNNING = [bankAdapter('bank_robohire', 'robohire', true), bankAdapter('bank_gohire', 'gohire', true)];
const BANKS_LISTED = { perQueryTracking: false, deadBankLinks: { env: TEMPLATE } } as const;

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
  sourcePriority: number;
  /** When a source last confirmed the row listed (step 2b). */
  lastSeenAt: Date;
  /** `skillsDetail[].via` of the row's skills (step 6c reads "has an entry with via 'none'"). */
  skillVias: string[];
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
  sourcePriority: 10,
  lastSeenAt: new Date(NOW.getTime() - DAY),
  skillVias: [],
  ...over,
});

/**
 * Plays buildExpireSql, buildUnseenMainlandSql, buildAlignPrioritySql,
 * buildStaleEnrichSql, buildRulesOnlySql, buildSkillVectorProbeSql and
 * buildSkillRemapSql over `rows`, reading each statement's own parameters (the
 * dedupe repair updates nothing). Every statement is recorded in `sql`.
 * `skillVectorModels`: the embedding model tags RASkill holds a label vector of.
 */
function tableDb(rows: JobRow[], opts: { skillVectorModels?: string[] } = {}): { db: IngestDb; sql: string[] } {
  const sql: string[] = [];
  const byEnriched = (a: JobRow, b: JobRow) => (a.enrichedAt?.getTime() ?? -1) - (b.enrichedAt?.getTime() ?? -1) || (a.id < b.id ? -1 : 1);
  // ORDER BY "postedAt" DESC NULLS LAST, "id" ASC
  const newestFirst = (a: JobRow, b: JobRow) => (b.postedAt?.getTime() ?? Number.NEGATIVE_INFINITY) - (a.postedAt?.getTime() ?? Number.NEGATIVE_INFINITY) || (a.id < b.id ? -1 : 1);
  const read = (strings: TemplateStringsArray | { text: string; values: unknown[] }, ...values: unknown[]) => {
    const text = normalizeSql('text' in strings ? strings.text : strings.join('?'));
    const vals = 'text' in strings ? strings.values : values;
    sql.push(text);
    return { text, vals };
  };
  const db = {
    // Step 4 reads and closes bank rows through the client (a row's id stands for its externalId here).
    rAJob: {
      async findMany(args: { where: { market: string; sourceBoard: string } }) {
        return rows
          .filter((r) => r.market === args.where.market && r.sourceBoard === args.where.sourceBoard && !r.archivedAt && r.visibility === 'public')
          .map((r) => ({ externalId: r.id, applyUrl: null }));
      },
      async updateMany(args: { where: { sourceBoard: string; externalId: { in: string[] } }; data: { archivedAt: Date; closeReason: string } }) {
        let count = 0;
        for (const r of rows) {
          if (r.sourceBoard !== args.where.sourceBoard || !args.where.externalId.in.includes(r.id) || r.archivedAt || r.visibility !== 'public') continue;
          r.archivedAt = args.data.archivedAt;
          r.closeReason = args.data.closeReason;
          count += 1;
        }
        return { count };
      },
    },
    async $executeRaw(strings: TemplateStringsArray | { text: string; values: unknown[] }, ...values: unknown[]) {
      const { text, vals } = read(strings, ...values);
      if (text.includes('SET "sourcePriority" =')) {
        const [priority, market, boards, other] = vals as [number, string, string[], number];
        let n = 0;
        for (const r of rows) {
          if (r.market !== market || r.archivedAt || !boards.includes(r.sourceBoard) || r.sourcePriority === other) continue;
          r.sourcePriority = priority;
          n += 1;
        }
        return n;
      }
      if (text.includes('"lastSeenAt" < now()')) {
        // Step 2b: the market is a parameter of the statement's own (always the mainland), then the import board, then the days.
        const [market, importBoard, days] = vals as [string, string, number];
        let n = 0;
        for (const r of rows) {
          if (r.market !== market || r.visibility !== 'public' || r.archivedAt || r.sourceBoard === importBoard) continue;
          if (r.lastSeenAt.getTime() >= NOW.getTime() - days * DAY) continue;
          r.archivedAt = NOW;
          r.closeReason = 'expired';
          n += 1;
        }
        return n;
      }
      if (!text.includes(`"closeReason" = 'expired'`)) return 0;
      // Past a stated deadline: any board. No deadline: by age, and only the boards the statement names.
      const [market, ageBoards, days] = vals as [string, string[], number];
      let n = 0;
      for (const r of rows) {
        if (r.market !== market || r.visibility !== 'public' || r.archivedAt) continue;
        const pastExpiry = !!r.expiresAt && r.expiresAt.getTime() < NOW.getTime();
        const tooOld = !r.expiresAt && ageBoards.includes(r.sourceBoard) && !!r.postedAt && r.postedAt.getTime() < NOW.getTime() - days * DAY;
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
        return rows.filter((r) => r.market === market && !r.archivedAt && r.enrichVersion !== null && r.enrichVersion < version).sort(newestFirst).slice(0, limit).map((r) => ({ id: r.id }));
      }
      if (text.includes('FROM "RASkill"')) {
        const [modelTag] = vals as [string];
        return (opts.skillVectorModels ?? []).includes(modelTag) ? [{ one: 1 }] : [];
      }
      if (text.includes('"skillsDetail" @>')) {
        const [market, version, limit] = vals as [string, number, number];
        return rows
          .filter((r) => r.market === market && !r.archivedAt && r.visibility === 'public' && r.enrichVersion === version && r.skillVias.includes('none'))
          .sort(newestFirst)
          .slice(0, limit)
          .map((r) => ({ id: r.id }));
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

describe('expiry (WP-42; MKT-3C JI-10): a stated deadline for every source, posting age for aggregators only', () => {
  it('normalize: an employer-board posting has no expiry however old it is, unless its board states a deadline', () => {
    const posted = new Date(NOW.getTime() - 300 * DAY);
    expect(resolveExpiresAt('ats_public', null, posted)).toBeNull();
    // MKT-3C: a deadline the board states (Greenhouse application_deadline) is kept; it used to be thrown away.
    expect(resolveExpiresAt('ats_public', '2026-10-17T00:00:00Z', posted)).toEqual(new Date('2026-10-17T00:00:00Z'));
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

  it('ACCEPT: a 300-day-old posting still listed by its board survives; an aggregator row of the same age does not', async () => {
    const old = new Date(NOW.getTime() - 300 * DAY);
    const rows = [
      row({ id: 'ats_old', sourceBoard: 'greenhouse', postedAt: old }),
      row({ id: 'ats_lever_old', sourceBoard: 'lever', postedAt: old }),
      row({ id: 'ats_future_board', sourceBoard: 'workable', postedAt: old }), // a board system no list names yet (MKT-5B)
      row({ id: 'bank_old', sourceBoard: 'robohire', postedAt: old }),
      row({ id: 'gohire_old', sourceBoard: 'gohire', postedAt: old }),
      row({ id: 'tw_open_old', sourceBoard: 'tw_open_data', postedAt: old }),
      row({ id: 'tw_gov_old', sourceBoard: 'tw_gov_jobs', postedAt: old }),
      row({ id: 'usajobs_old', sourceBoard: 'usajobs', postedAt: old }),
      row({ id: 'search_old', sourceBoard: 'activejobs', postedAt: old }),
      row({ id: 'jsearch_old', sourceBoard: 'jsearch', postedAt: old }),
      row({ id: 'linkedin_old', sourceBoard: 'linkedin', postedAt: old }),
      row({ id: 'search_past_expiry', sourceBoard: 'jsearch', expiresAt: new Date(NOW.getTime() - DAY) }),
      row({ id: 'search_fresh', sourceBoard: 'activejobs' }),
      row({ id: 'search_45_days_less_an_hour', sourceBoard: 'jsearch', postedAt: new Date(NOW.getTime() - 45 * DAY + 3_600_000) }),
      row({ id: 'private_old', visibility: 'private', sourceBoard: 'user_import', postedAt: old }),
    ];
    const { db } = tableDb(rows);
    // The banks have a posting page and their sync runs, so step 4 closes nothing: this is the expiry rule alone.
    const res = await runMaintenance(db, 'intl', BANKS_RUNNING, BANKS_LISTED);
    expect(res).toMatchObject({ expired: 4, deadBankLinks: 0 });
    expect(rows.filter((r) => r.archivedAt).map((r) => r.id).sort()).toEqual(['jsearch_old', 'linkedin_old', 'search_old', 'search_past_expiry']);
    for (const id of ['ats_old', 'ats_lever_old', 'ats_future_board', 'bank_old', 'gohire_old', 'tw_open_old', 'tw_gov_old', 'usajobs_old']) {
      expect(rows.find((r) => r.id === id), id).toMatchObject({ archivedAt: null, closeReason: null });
    }
  });

  it('ACCEPT: a stated deadline that has passed archives the row of any source; one that has not, and no deadline, do not', async () => {
    const old = new Date(NOW.getTime() - 300 * DAY);
    const lastWeek = new Date(NOW.getTime() - 7 * DAY);
    const nextWeek = new Date(NOW.getTime() + 7 * DAY);
    const boards = ['greenhouse', 'smartrecruiters', 'robohire', 'gohire', 'tw_open_data', 'tw_gov_jobs', 'usajobs', 'activejobs', 'jsearch'];
    const rows = boards.flatMap((b) => [
      row({ id: `${b}_deadline_passed`, sourceBoard: b, expiresAt: lastWeek }),
      // A 台灣就業通 STOP_DATE of yesterday is "the day after" today.
      row({ id: `${b}_deadline_yesterday`, sourceBoard: b, expiresAt: new Date(NOW.getTime() - 1) }),
      row({ id: `${b}_deadline_next_week`, sourceBoard: b, postedAt: old, expiresAt: nextWeek }),
    ]);
    const { db } = tableDb(rows);
    const res = await runMaintenance(db, 'intl', BANKS_RUNNING, BANKS_LISTED);
    expect(res).toMatchObject({ expired: boards.length * 2, deadBankLinks: 0 });
    for (const b of boards) {
      expect(rows.find((r) => r.id === `${b}_deadline_passed`), b).toMatchObject({ archivedAt: NOW, closeReason: 'expired' });
      expect(rows.find((r) => r.id === `${b}_deadline_yesterday`), b).toMatchObject({ archivedAt: NOW, closeReason: 'expired' });
      // A deadline that has not passed keeps even a 300-day-old aggregator row: the deadline decides, not the age.
      expect(rows.find((r) => r.id === `${b}_deadline_next_week`), b).toMatchObject({ archivedAt: null, closeReason: null });
    }
    // A second run finds nothing more to archive.
    expect((await runMaintenance(db, 'intl', BANKS_RUNNING, BANKS_LISTED)).expired).toBe(0);
  });

  it('the statement: one market, public live rows, any board past its deadline, and age only for the aggregator boards', () => {
    const sql = buildExpireSql('cn');
    expect(normalizeSql(sql.text)).toBe(
      `UPDATE "RAJob" SET "archivedAt" = now(), "closedAt" = COALESCE("closedAt", now()), "closeReason" = 'expired', "updatedAt" = now() ` +
        `WHERE "market" = $1 AND "visibility" = 'public' AND "archivedAt" IS NULL ` +
        `AND ("expiresAt" < now() OR ("expiresAt" IS NULL AND "sourceBoard" = ANY($2::text[]) AND "postedAt" < now() - make_interval(days => $3::int)))`,
    );
    expect(sql.values).toEqual(['cn', ['activejobs', 'linkedin', 'jsearch'], 45]);
    expect(sql.values[1]).toEqual([...AGE_EXPIRY_BOARDS]);
    expect(MAX_AGE_DAYS).toBe(45);
    // The age rule names the boards it applies to: a board nobody listed is safe by default.
    expect(normalizeSql(sql.text)).not.toContain('<> ALL(');
    for (const board of [...BANK_BOARDS, ...PUBLIC_ATS, 'tw_open_data', 'tw_gov_jobs', 'usajobs', 'user_import']) expect(AGE_EXPIRY_BOARDS).not.toContain(board);
  });

  it('the banks are written to the markets raCrossBankMatch names', () => {
    // (The list of boards with no date expiry is gone: the expiry step names the boards that DO expire by age.)
    expect(BANK_BOARDS.map((b) => bankMarket(b))).toEqual(['intl', 'cn']);
  });
});

describe('MKT-5C JI-10: a mainland row no source has confirmed for 45 days is archived (step 2b)', () => {
  const seen = (days: number) => new Date(NOW.getTime() - days * DAY);
  /** The GoHire bank has a posting page and its sync runs, so step 4 closes nothing here. */
  const CN = [bankAdapter('bank_gohire', 'gohire', true)];

  it('ACCEPT: a mainland board row not seen for 46 days is archived as expired; one seen 44 days ago is not', async () => {
    const rows = [
      row({ id: 'cn_board_46', market: 'cn', sourceBoard: 'smartrecruiters', lastSeenAt: seen(46) }),
      row({ id: 'cn_board_44', market: 'cn', sourceBoard: 'smartrecruiters', lastSeenAt: seen(44) }),
      row({ id: 'cn_board_45_less_an_hour', market: 'cn', sourceBoard: 'greenhouse', lastSeenAt: new Date(NOW.getTime() - 45 * DAY + 3_600_000) }),
    ];
    const res = await runMaintenance(tableDb(rows).db, 'cn', CN, BANKS_LISTED);
    expect(res).toMatchObject({ unseenMainland: 1, expired: 0 });
    expect(rows.find((r) => r.id === 'cn_board_46')).toMatchObject({ archivedAt: NOW, closeReason: 'expired' });
    expect(rows.find((r) => r.id === 'cn_board_44')).toMatchObject({ archivedAt: null, closeReason: null });
    expect(rows.find((r) => r.id === 'cn_board_45_less_an_hour')).toMatchObject({ archivedAt: null });
    expect(CN_UNSEEN_DAYS).toBe(45);
  });

  it('every mainland source falls under it (board, bank, feed, a board no list names), whatever its posted date; a user\'s import never does', async () => {
    const fresh = new Date(NOW.getTime() - DAY);
    const rows = [
      // Posted yesterday and listed with a far deadline, but unseen for 60 days: the source stopped being read.
      ...['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'gohire', 'activejobs', 'beisen', 'workable'].map((b) =>
        row({ id: `cn_${b}`, market: 'cn', sourceBoard: b, postedAt: fresh, expiresAt: new Date(NOW.getTime() + 30 * DAY), lastSeenAt: seen(60) }),
      ),
      row({ id: 'cn_import_public', market: 'cn', sourceBoard: 'user_import', lastSeenAt: seen(400) }),
      row({ id: 'cn_import_private', market: 'cn', sourceBoard: 'user_import', visibility: 'private', lastSeenAt: seen(400) }),
      row({ id: 'cn_private_other', market: 'cn', sourceBoard: 'greenhouse', visibility: 'private', lastSeenAt: seen(400) }),
      row({ id: 'cn_archived', market: 'cn', sourceBoard: 'greenhouse', lastSeenAt: seen(400), archivedAt: seen(300), closeReason: 'source_removed' }),
    ];
    const res = await runMaintenance(tableDb(rows).db, 'cn', CN, BANKS_LISTED);
    expect(res.unseenMainland).toBe(8);
    expect(rows.filter((r) => r.closeReason === 'expired').map((r) => r.id).sort()).toEqual(['cn_activejobs', 'cn_ashby', 'cn_beisen', 'cn_gohire', 'cn_greenhouse', 'cn_lever', 'cn_smartrecruiters', 'cn_workable']);
    for (const id of ['cn_import_public', 'cn_import_private', 'cn_private_other']) expect(rows.find((r) => r.id === id), id).toMatchObject({ archivedAt: null, closeReason: null });
    // A row closed earlier keeps its own reason.
    expect(rows.find((r) => r.id === 'cn_archived')).toMatchObject({ closeReason: 'source_removed' });
    // A second run finds nothing more.
    expect((await runMaintenance(tableDb(rows).db, 'cn', CN, BANKS_LISTED)).unseenMainland).toBe(0);
  });

  it('ACCEPT: an international board or bank row not seen for 60 days is untouched: the step does not run for that market at all', async () => {
    const rows = [
      row({ id: 'intl_board', sourceBoard: 'greenhouse', lastSeenAt: seen(60), postedAt: seen(300) }),
      row({ id: 'intl_bank', sourceBoard: 'robohire', lastSeenAt: seen(60) }),
      row({ id: 'intl_tw', sourceBoard: 'tw_open_data', lastSeenAt: seen(60) }),
      // The mainland row of the same table is not this run's market.
      row({ id: 'cn_board', market: 'cn', sourceBoard: 'greenhouse', lastSeenAt: seen(60) }),
    ];
    const { db, sql } = tableDb(rows);
    const res = await runMaintenance(db, 'intl', BANKS_RUNNING, BANKS_LISTED);
    expect(res).toMatchObject({ unseenMainland: 0, expired: 0 });
    expect(rows.every((r) => r.archivedAt === null)).toBe(true);
    expect(sql.some((t) => t.includes('"lastSeenAt" <'))).toBe(false);
    expect(await archiveUnseenMainland(db, 'intl')).toBe(0);
    // The same table, the mainland run: only its own row.
    expect(await archiveUnseenMainland(db, 'cn')).toBe(1);
    expect(rows.filter((r) => r.archivedAt).map((r) => r.id)).toEqual(['cn_board']);
  });

  it('the statement: the mainland market as a constant of the rule, public live rows, never a user import, 45 days by last seen', () => {
    const stmt = buildUnseenMainlandSql();
    expect(normalizeSql(stmt.text)).toBe(
      `UPDATE "RAJob" SET "archivedAt" = now(), "closedAt" = COALESCE("closedAt", now()), "closeReason" = 'expired', "updatedAt" = now() ` +
        `WHERE "market" = $1 AND "visibility" = 'public' AND "archivedAt" IS NULL AND "sourceBoard" <> $2 AND "lastSeenAt" < now() - make_interval(days => $3::int)`,
    );
    expect(stmt.values).toEqual(['cn', 'user_import', 45]);
    // It reads no posted date and no deadline: a row is unseen however fresh its posting looks.
    expect(stmt.text).not.toContain('"postedAt"');
    expect(stmt.text).not.toContain('"expiresAt"');
  });

  it('it runs after the stated-validity step and before the priorities and the dedupe repair, so a hand-over happens in the same run', async () => {
    const rows = [row({ id: 'cn_unseen', market: 'cn', sourceBoard: 'greenhouse', lastSeenAt: seen(50), sourcePriority: 5 })];
    const { db, sql } = tableDb(rows);
    const res = await runMaintenance(db, 'cn', CN, BANKS_LISTED);
    expect(res).toEqual({ expired: 0, missed: 0, unseenMainland: 1, priorityAligned: 0, deadBankLinks: 0, dedupeRepaired: 0, missedRule: false, enrichQueued: 0 });
    const at = (needle: string) => sql.findIndex((t) => t.includes(needle));
    expect(at('"expiresAt" < now()')).toBeLessThan(at('"lastSeenAt" < now()'));
    expect(at('"lastSeenAt" < now()')).toBeLessThan(at('SET "sourcePriority" ='));
    expect(at('"lastSeenAt" < now()')).toBeLessThan(at('WITH ranked AS'));
    // The archive moves `updatedAt`, which is what the repair reads to find the group.
    expect(sql[at('"lastSeenAt" < now()')]).toContain('"updatedAt" = now()');
  });
});

describe('MKT-3C JI-5 / JC-7: stored dedupe priorities follow PROVIDER_META (alignSourcePriority)', () => {
  it('the targets are the two providers whose number changed, read from PROVIDER_META', () => {
    expect(priorityTargets()).toEqual([
      { boards: ['greenhouse', 'lever', 'ashby', 'smartrecruiters'], priority: 5 },
      { boards: ['gohire'], priority: 3 },
    ]);
    expect(priorityTargets()[0]).toEqual({ boards: [...PUBLIC_ATS], priority: PROVIDER_META.ats_public.sourcePriority });
    expect(priorityTargets()[1]).toEqual({ boards: [PROVIDER_META.bank_gohire.sourceBoard], priority: PROVIDER_META.bank_gohire.sourcePriority });
  });

  it('the statement: one market, live rows of the boards that carry another number', () => {
    const sql = buildAlignPrioritySql('cn', ['gohire'], 3);
    expect(normalizeSql(sql.text)).toBe(
      'UPDATE "RAJob" SET "sourcePriority" = $1::int, "updatedAt" = now() WHERE "market" = $2 AND "archivedAt" IS NULL AND "sourceBoard" = ANY($3::text[]) AND "sourcePriority" <> $4::int',
    );
    expect(sql.values).toEqual([3, 'cn', ['gohire'], 3]);
  });

  it('ACCEPT: after one run no live ats row has priority 10 and no gohire row has 15; a second run updates nothing', async () => {
    const rows = [
      ...PUBLIC_ATS.map((b) => row({ id: `cn_${b}`, market: 'cn', sourceBoard: b, sourcePriority: 10 })),
      row({ id: 'cn_gohire', market: 'cn', sourceBoard: 'gohire', sourcePriority: 15 }),
      row({ id: 'cn_gohire_2', market: 'cn', sourceBoard: 'gohire', sourcePriority: 15 }),
      row({ id: 'cn_gohire_right', market: 'cn', sourceBoard: 'gohire', sourcePriority: 3 }),
      row({ id: 'cn_gohire_archived', market: 'cn', sourceBoard: 'gohire', sourcePriority: 15, archivedAt: NOW, closeReason: 'bank_closed' }),
      row({ id: 'cn_feed', market: 'cn', sourceBoard: 'activejobs', sourcePriority: 10 }),
      row({ id: 'intl_greenhouse', market: 'intl', sourceBoard: 'greenhouse', sourcePriority: 10 }),
      row({ id: 'intl_robohire', market: 'intl', sourceBoard: 'robohire', sourcePriority: 15 }),
    ];
    const { db, sql } = tableDb(rows);
    expect(await alignSourcePriority(db, 'cn')).toBe(6);
    expect(sql).toHaveLength(2); // one UPDATE per provider
    const live = rows.filter((r) => r.market === 'cn' && !r.archivedAt);
    expect(live.filter((r) => (PUBLIC_ATS as readonly string[]).includes(r.sourceBoard)).map((r) => r.sourcePriority)).toEqual([5, 5, 5, 5]);
    expect(live.filter((r) => r.sourceBoard === 'gohire').map((r) => r.sourcePriority)).toEqual([3, 3, 3]);
    // Not touched: another provider, an archived row (the upsert writes the number when it comes back), the other market.
    expect(rows.find((r) => r.id === 'cn_feed')!.sourcePriority).toBe(10);
    expect(rows.find((r) => r.id === 'cn_gohire_archived')!.sourcePriority).toBe(15);
    expect(rows.find((r) => r.id === 'intl_greenhouse')!.sourcePriority).toBe(10);
    // Idempotent.
    expect(await alignSourcePriority(db, 'cn')).toBe(0);
    // The international market is aligned by its own run; the RoboHire bank keeps 15.
    expect(await alignSourcePriority(db, 'intl')).toBe(1);
    expect(rows.find((r) => r.id === 'intl_greenhouse')!.sourcePriority).toBe(5);
    expect(rows.find((r) => r.id === 'intl_robohire')!.sourcePriority).toBe(15);
  });

  it('runMaintenance aligns priorities after the expiry and before the dedupe repair, and reports the count', async () => {
    const rows = [row({ id: 'a', sourceBoard: 'lever', sourcePriority: 10 }), row({ id: 'b', sourceBoard: 'greenhouse', sourcePriority: 5 })];
    const { db, sql } = tableDb(rows);
    const first = await runMaintenance(db, 'intl', [], { perQueryTracking: false, deadBankLinks: { env: {} } });
    expect(first).toEqual({ expired: 0, missed: 0, unseenMainland: 0, priorityAligned: 1, deadBankLinks: 0, dedupeRepaired: 0, missedRule: false, enrichQueued: 0 });
    const at = (needle: string) => sql.findIndex((t) => t.includes(needle));
    // The first UPDATE of the run is still the expiry; the dedupe repair (both steps) sees the new numbers.
    expect(sql.findIndex((t) => t.startsWith('UPDATE "RAJob"'))).toBe(at(`"closeReason" = 'expired'`));
    expect(at(`"closeReason" = 'expired'`)).toBeLessThan(at('SET "sourcePriority" ='));
    expect(at('SET "sourcePriority" =')).toBeLessThan(at('WITH touched AS'));
    expect(at('WITH touched AS')).toBeLessThan(at('WITH ranked AS'));
    // A row whose number changed counts as touched, so its group is ranked again in the same run.
    expect(sql[at('SET "sourcePriority" =')]).toContain('"updatedAt" = now()');
    expect((await runMaintenance(db, 'intl', [], { perQueryTracking: false, deadBankLinks: { env: {} } })).priorityAligned).toBe(0);
  });
});

describe('MKT-3C (PAR carry-over 7b; review finding 4): a bank row with no page a candidate can open', () => {
  const seed = () => [
    // Stored before the bank had a posting page: the old link, which is "Page not found".
    { id: 'old_link', market: 'cn', sourceBoard: 'gohire', externalId: 'g1', applyUrl: 'https://www.gohire.top/jobs/g1', archivedAt: null, visibility: 'public', closeReason: null },
    // Written by a sync that ran with the template: its link is the bank's page.
    { id: 'page_link', market: 'cn', sourceBoard: 'gohire', externalId: 'g2', applyUrl: 'https://example.test/p/g2', archivedAt: null, visibility: 'public', closeReason: null },
    // Another job's page is not this job's page.
    { id: 'wrong_page', market: 'cn', sourceBoard: 'gohire', externalId: 'g3', applyUrl: 'https://example.test/p/g2', archivedAt: null, visibility: 'public', closeReason: null },
    { id: 'already_closed', market: 'cn', sourceBoard: 'gohire', externalId: 'g4', applyUrl: 'https://www.gohire.top/jobs/g4', archivedAt: new Date('2026-09-01T00:00:00Z'), visibility: 'public', closeReason: 'bank_closed' },
    { id: 'board_row', market: 'cn', sourceBoard: 'greenhouse', externalId: 'acme:1', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', archivedAt: null, visibility: 'public', closeReason: null },
    { id: 'robohire_old_link', market: 'intl', sourceBoard: 'robohire', externalId: 'r1', applyUrl: 'https://www.robohire.io/jobs/r1', archivedAt: null, visibility: 'public', closeReason: null },
  ];
  const state = (fake: ReturnType<typeof createFakePrisma>) => Object.fromEntries(fake.$rows('rAJob').map((r) => [r.id, r.closeReason ?? null]));
  /** The "start the bank's sync from the beginning" statements a run issued, as [market, provider]. */
  const restarts = (fake: ReturnType<typeof createFakePrisma>) => fake.$sql.calls.filter((c) => c.text.startsWith('UPDATE "RAIngestQuery"')).map((c) => c.values);

  it('the bank\'s sync is not running and the bank has a template: the old links are archived as no_apply_target, page links stay', async () => {
    const fake = createFakePrisma({ seed: { rAJob: seed() } });
    const n = await archiveDeadBankLinks(fake as unknown as IngestDb, 'cn', [bankAdapter('bank_gohire', 'gohire', false)], { env: TEMPLATE, now: NOW });
    expect(n).toBe(2);
    expect(state(fake)).toEqual({ old_link: 'no_apply_target', page_link: null, wrong_page: 'no_apply_target', already_closed: 'bank_closed', board_row: null, robohire_old_link: null });
    expect(fake.$rows('rAJob').find((r) => r.id === 'old_link')).toMatchObject({ archivedAt: NOW, closedAt: NOW });
    // 'no_apply_target' is a reason the upsert revives when the bank lists the row again (upsert.test.ts pins the list),
    // and the bank's next sync starts from the beginning, so it lists every row again.
    expect(restarts(fake)).toEqual([['cn', 'bank_gohire']]);
    // A second run has nothing left to do, and restarts nothing.
    expect(await archiveDeadBankLinks(fake as unknown as IngestDb, 'cn', [bankAdapter('bank_gohire', 'gohire', false)], { env: TEMPLATE, now: NOW })).toBe(0);
    expect(restarts(fake)).toHaveLength(1);
  });

  it('a bank that is not among the brand\'s sources at all is a bank whose sync is not running', async () => {
    const fake = createFakePrisma({ seed: { rAJob: seed() } });
    expect(await archiveDeadBankLinks(fake as unknown as IngestDb, 'cn', [], { env: TEMPLATE, now: NOW })).toBe(2);
    expect(state(fake).old_link).toBe('no_apply_target');
  });

  it('a template and a running sync: nothing is archived (its first pass with the template rewrites every link) and nothing restarts', async () => {
    const running = createFakePrisma({ seed: { rAJob: seed() } });
    expect(await archiveDeadBankLinks(running as unknown as IngestDb, 'cn', [bankAdapter('bank_gohire', 'gohire', true)], { env: TEMPLATE, now: NOW })).toBe(0);
    expect(state(running).old_link).toBeNull();
    expect(running.$sql.calls).toHaveLength(0);
  });

  it('review finding 4: a bank with NO template has every open row archived as no_apply_target, whether or not its sync runs', async () => {
    const noTemplate = [{}, { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: '' }, { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'http://example.test/p/{id}' }, { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://example.test/p/' }];
    const syncStates = [[], [bankAdapter('bank_gohire', 'gohire', false)], [bankAdapter('bank_gohire', 'gohire', true)]];
    for (const env of noTemplate) {
      for (const adapters of syncStates) {
        const fake = createFakePrisma({ seed: { rAJob: seed() } });
        // Every open public GoHire row, the one whose link was a page under a former template included: no link can be judged without one.
        expect(await archiveDeadBankLinks(fake as unknown as IngestDb, 'cn', adapters, { env, now: NOW })).toBe(3);
        // A closure that stands keeps its reason; the employer-board row and the other market's bank are not this bank's rows.
        expect(state(fake)).toEqual({ old_link: 'no_apply_target', page_link: 'no_apply_target', wrong_page: 'no_apply_target', already_closed: 'bank_closed', board_row: null, robohire_old_link: null });
        expect(restarts(fake)).toEqual([['cn', 'bank_gohire']]);
        expect(await archiveDeadBankLinks(fake as unknown as IngestDb, 'cn', adapters, { env, now: NOW })).toBe(0);
        expect(restarts(fake)).toHaveLength(1);
      }
    }
    // The RoboHire bank follows the same rule in its own market.
    const intl = createFakePrisma({ seed: { rAJob: seed() } });
    expect(await archiveDeadBankLinks(intl as unknown as IngestDb, 'intl', [], { env: {}, now: NOW })).toBe(1);
    expect(state(intl)).toMatchObject({ robohire_old_link: 'no_apply_target', old_link: null, page_link: null });
    expect(restarts(intl)).toEqual([['intl', 'bank_robohire']]);
  });

  it('the restart statement clears only the cursor of that bank\'s sync in that market', () => {
    const sql = buildRestartBankSyncSql('cn', 'bank_gohire');
    expect(normalizeSql(sql.text)).toBe(`UPDATE "RAIngestQuery" SET "params" = "params" - 'cursor' WHERE "market" = $1 AND "provider" = $2 AND ("params" -> 'cursor') IS NOT NULL`);
    expect(sql.values).toEqual(['cn', 'bank_gohire']);
    // Not the schedule, and not updatedAt (the planner's "last demanded" stamp).
    expect(sql.text).not.toMatch(/nextRunAt|updatedAt|enabled/);
    for (const bank of BANK_BOARDS) {
      expect(PROVIDER_META[BANK_SYNC_PROVIDER[bank]]).toMatchObject({ sourceBoard: bank, fromRecruiterBank: true });
    }
  });

  it('each market handles its own bank: a GoApply run never touches RoboHire rows, and the reverse', async () => {
    const fake = createFakePrisma({ seed: { rAJob: seed() } });
    await archiveDeadBankLinks(fake as unknown as IngestDb, 'cn', [], { env: TEMPLATE, now: NOW });
    expect(state(fake).robohire_old_link).toBeNull();
    expect(await archiveDeadBankLinks(fake as unknown as IngestDb, 'intl', [bankAdapter('bank_robohire', 'robohire', false)], { env: TEMPLATE, now: NOW })).toBe(1);
    expect(state(fake).robohire_old_link).toBe('no_apply_target');
    expect(state(fake).page_link).toBeNull();
    expect(restarts(fake)).toEqual([['cn', 'bank_gohire'], ['intl', 'bank_robohire']]);
    expect(DEAD_BANK_LINK_SCAN_LIMIT).toBe(20_000);
  });

  it('a link that differs only in how the URL is written is the same page', async () => {
    const fake = createFakePrisma({ seed: { rAJob: [{ id: 'same', market: 'cn', sourceBoard: 'gohire', externalId: 'g 9', applyUrl: 'https://example.test/p/g%209', archivedAt: null, visibility: 'public', closeReason: null }] } });
    expect(await archiveDeadBankLinks(fake as unknown as IngestDb, 'cn', [], { env: { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://EXAMPLE.test/p/{id}' }, now: NOW })).toBe(0);
  });

  it('runMaintenance runs the step with the cron\'s env and reports the count', async () => {
    const { fake, db } = createIngestFake({ seed: { rAJob: seed() } });
    const res = await runMaintenance(db, 'cn', [bankAdapter('bank_gohire', 'gohire', false)], { perQueryTracking: false, deadBankLinks: { env: TEMPLATE, now: NOW } });
    expect(res).toMatchObject({ deadBankLinks: 2, expired: 0 });
    expect(Object.fromEntries(fake.$rows('rAJob').map((r) => [r.id, r.closeReason ?? null])).old_link).toBe('no_apply_target');
  });

  // The lists show canonical rows only and hold a bank row whose bank has no posting page (feed/sql.ts
  // `scopePredicates`). With GoHire at priority 3 a held GoHire row would stay the canonical row of its group,
  // and the employer-board row of the same posting, the only one a candidate could open, would be on no list.
  describe('review finding 4: a held bank row never keeps the canonical flag from its employer-board twin', () => {
    const LONG_AGO = new Date('2026-08-01T00:00:00Z');
    type Twin = DedupeCandidate & Record<string, unknown>;
    const twins = (): Twin[] => [
      // The state the first maintenance run after the priority change leaves: the GoHire row (3) is canonical, the board row (5) its alternate.
      { id: 'gohire_row', market: 'cn', sourceBoard: 'gohire', externalId: 'g1', applyUrl: 'https://www.gohire.top/jobs/g1', visibility: 'public', archivedAt: null, closeReason: null, dedupeKey: 'k1', sourcePriority: 3, postedAt: LONG_AGO, firstSeenAt: LONG_AGO, updatedAt: LONG_AGO, atsType: null, fromRecruiterBank: true, isCanonical: true, canonicalJobId: null },
      { id: 'board_row', market: 'cn', sourceBoard: 'greenhouse', externalId: 'acme:1#cn', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', visibility: 'public', archivedAt: null, closeReason: null, dedupeKey: 'k1', sourcePriority: 5, postedAt: LONG_AGO, firstSeenAt: LONG_AGO, updatedAt: LONG_AGO, atsType: 'greenhouse', fromRecruiterBank: false, isCanonical: false, canonicalJobId: 'gohire_row' },
      // A GoHire row with no twin: it is archived too (it could not be listed), and nothing else is in its group.
      { id: 'gohire_alone', market: 'cn', sourceBoard: 'gohire', externalId: 'g2', applyUrl: 'https://www.gohire.top/jobs/g2', visibility: 'public', archivedAt: null, closeReason: null, dedupeKey: 'k2', sourcePriority: 3, postedAt: LONG_AGO, firstSeenAt: LONG_AGO, updatedAt: LONG_AGO, atsType: null, fromRecruiterBank: true, isCanonical: true, canonicalJobId: null },
    ];
    /** The fake client, with the dedupe repair played by its own rule (`pickCanonical`) over the rows touched in the last two days. */
    function twinDb() {
      const startedAt = Date.now();
      const fake: ReturnType<typeof createFakePrisma> = createFakePrisma({
        seed: { rAJob: twins() },
        sql: {
          respond(call) {
            if (call.text.startsWith('WITH touched AS')) return [];
            if (!call.text.startsWith('WITH ranked AS')) return undefined;
            const market = String(call.values[0]);
            const all = fake.$rows('rAJob') as Twin[];
            const recentKeys = new Set(all.filter((r) => r.market === market && (r.updatedAt as Date).getTime() > startedAt - 2 * DAY).map((r) => r.dedupeKey as string));
            let changed = 0;
            for (const key of recentKeys) {
              const group = all.filter((r) => r.market === market && r.visibility === 'public' && r.archivedAt === null && r.dedupeKey === key);
              const canon = pickCanonical(group);
              for (const r of group) {
                const isCanonical = r.id === canon!.id;
                const canonicalJobId = isCanonical ? null : canon!.id;
                if (r.isCanonical === isCanonical && r.canonicalJobId === canonicalJobId) continue;
                Object.assign(r, { isCanonical, canonicalJobId });
                changed += 1;
              }
            }
            return changed;
          },
        },
      });
      const row = (id: string) => (fake.$rows('rAJob') as Twin[]).find((r) => r.id === id)!;
      return { fake, db: fake as unknown as IngestDb, row };
    }

    it('sync off and no template: after one maintenance run the board row is the canonical row of the group', async () => {
      for (const adapters of [[], [bankAdapter('bank_gohire', 'gohire', false)]]) {
        const { db, row } = twinDb();
        const res = await runMaintenance(db, 'cn', adapters, { perQueryTracking: false, deadBankLinks: { env: {}, now: NOW } });
        expect(res).toMatchObject({ deadBankLinks: 2, dedupeRepaired: 1 });
        expect(row('gohire_row')).toMatchObject({ archivedAt: NOW, closeReason: 'no_apply_target' });
        expect(row('gohire_alone')).toMatchObject({ archivedAt: NOW, closeReason: 'no_apply_target' });
        // The same run: the archive counts as a touch, so the repair ranks the group again without the bank row.
        expect(row('board_row')).toMatchObject({ archivedAt: null, isCanonical: true, canonicalJobId: null });
        // Nothing more on the next run.
        expect(await runMaintenance(db, 'cn', adapters, { perQueryTracking: false, deadBankLinks: { env: {}, now: NOW } })).toMatchObject({ deadBankLinks: 0, dedupeRepaired: 0 });
      }
    });

    it('control: with a posting page and a running sync the GoHire row is listable and stays the canonical row (JC-7)', async () => {
      const { db, row } = twinDb();
      const res = await runMaintenance(db, 'cn', [bankAdapter('bank_gohire', 'gohire', true)], { perQueryTracking: false, deadBankLinks: { env: TEMPLATE, now: NOW } });
      expect(res).toMatchObject({ deadBankLinks: 0, dedupeRepaired: 0 });
      expect(row('gohire_row')).toMatchObject({ archivedAt: null, isCanonical: true });
      expect(row('board_row')).toMatchObject({ isCanonical: false, canonicalJobId: 'gohire_row' });
    });

    it('the international market is not read by a GoApply run', async () => {
      const { fake, db } = twinDb();
      fake.$rows('rAJob').push({ id: 'robohire_row', market: 'intl', sourceBoard: 'robohire', externalId: 'r1', applyUrl: 'https://www.robohire.io/jobs/r1', visibility: 'public', archivedAt: null, closeReason: null, dedupeKey: 'k9', sourcePriority: 15, updatedAt: LONG_AGO, isCanonical: true, canonicalJobId: null });
      await runMaintenance(db, 'cn', [], { perQueryTracking: false, deadBankLinks: { env: {}, now: NOW } });
      expect(fake.$rows('rAJob').find((r) => r.id === 'robohire_row')).toMatchObject({ archivedAt: null, closeReason: null });
    });
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
    expect(first).toEqual({ staleQueued: 1, rulesQueued: 0, modelAvailable: true, skillsQueued: 0 });
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
    expect(await runEnrichCatchUp(tableDb(rows.map((r) => ({ ...r, market: 'cn' }))).db, 'cn', { brand: go, enqueueMany: none.enqueueMany, env: {}, ...noModel })).toEqual({ staleQueued: 0, rulesQueued: 0, modelAvailable: false, skillsQueued: 0 });
    expect(none.items).toHaveLength(0);

    const q = queue();
    const first = await runEnrichCatchUp(db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withModel });
    expect(first).toEqual({ staleQueued: 0, rulesQueued: 1, modelAvailable: true, skillsQueued: 0 });
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
        expect(await run()).toEqual({ staleQueued: 0, rulesQueued: 0, modelAvailable: true, skillsQueued: 0 });
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
    expect(await runEnrichCatchUp(tableDb(rows).db, 'intl', { brand: robo, enqueueMany: off.enqueueMany, env: { ENRICH_DAILY_JOBS: '0' }, ...withModel })).toEqual({ staleQueued: 0, rulesQueued: 0, modelAvailable: false, skillsQueued: 0 });
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
    expect(await run({ LLM_ENRICH_MODEL: 'openai/gpt-cheap' }, shared.enqueueMany)).toEqual({ staleQueued: 0, rulesQueued: 1, modelAvailable: true, skillsQueued: 0 });
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
    expect(await run({ ...WALL, CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat' }, cn.enqueueMany)).toEqual({ staleQueued: 0, rulesQueued: 1, modelAvailable: true, skillsQueued: 0 });
    expect(cn.items[0]!.options).toMatchObject({ brand: 'goapply' });

    const intl = queue();
    expect((await runEnrichCatchUp(tableDb([row({ id: 'r', enrichModel: RULES_ONLY_MODEL })]).db, 'intl', { brand: robo, enqueueMany: intl.enqueueMany, env: { LLM_MODEL: 'openai/gpt-default' } })).rulesQueued).toBe(1);
    // RoboApply never reads GoApply's wall or its CN_ values.
    expect((await runEnrichCatchUp(tableDb([row({ id: 'r', enrichModel: RULES_ONLY_MODEL })]).db, 'intl', { brand: robo, enqueueMany: queue().enqueueMany, env: { ...WALL, LLM_MODEL: 'openai/gpt-default' } })).modelAvailable).toBe(true);
  });

  it('the cap is respected: stale rows first (the newest postings first), the rest of the cap for rules-only rows (oldest enrichment first)', async () => {
    const rows = [
      // stale0 is the newest posting and was enriched most recently: the posting date decides, not the enrichment date.
      ...Array.from({ length: 6 }, (_, i) => row({ id: `stale${i}`, enrichVersion: ENRICH_VERSION - 1, postedAt: new Date(NOW.getTime() - (i + 1) * DAY), enrichedAt: new Date(NOW.getTime() - (i + 1) * DAY) })),
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
    expect((await runMaintenance(skipped.db, 'intl', [], { perQueryTracking: false, deadBankLinks: { env: {} } })).enrichQueued).toBe(0);
    expect(skipped.sql.some((t) => t.includes('"enrichVersion"'))).toBe(false);
  });

  it('a version bump reaches the newest postings first; an undated row comes last', async () => {
    const rows = [
      row({ id: 'old', enrichVersion: 0, postedAt: new Date(NOW.getTime() - 90 * DAY), enrichedAt: null }),
      row({ id: 'undated', enrichVersion: 0, postedAt: null }),
      row({ id: 'new', enrichVersion: 0, postedAt: new Date(NOW.getTime() - DAY) }),
      row({ id: 'mid', enrichVersion: 0, postedAt: new Date(NOW.getTime() - 10 * DAY) }),
    ];
    const q = queue();
    await runEnrichCatchUp(tableDb(rows).db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, limit: 3, enrichModel: () => ({ available: true, model: 'openai/gpt-cheap' }) });
    expect(q.ids()).toEqual(['new', 'mid', 'old']);
  });

  describe('the skills-only pass (step 6c): rows enriched while the embedding step was off', () => {
    const TAG = 'text-embedding-3-large@1024';
    const withTag = { enrichModel: () => ({ available: true, model: 'openai/gpt-cheap' }), embeddingModelTag: () => TAG };
    const unmapped = (id: string, over: Partial<JobRow> = {}) => row({ id, skillVias: ['alias', 'none'], ...over });

    it('a public row at the current version that holds a skill with no id is queued once the model has label vectors, with the remap key', async () => {
      const rows = [unmapped('a'), row({ id: 'mapped', skillVias: ['alias', 'embedding'] }), row({ id: 'no_skills' })];
      const q = queue();
      const first = await runEnrichCatchUp(tableDb(rows, { skillVectorModels: [TAG] }).db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withTag });
      expect(first).toEqual({ staleQueued: 0, rulesQueued: 0, modelAvailable: true, skillsQueued: 1 });
      expect(q.items).toEqual([{ kind: 'job.enrich', payload: { jobId: 'a', skillsOnly: true }, options: { dedupeKey: skillRemapDedupeKey('a', TAG), brand: 'roboapply' } }]);
      // The same vocabulary state never queues the job twice while the item exists.
      expect((await runEnrichCatchUp(tableDb(rows, { skillVectorModels: [TAG] }).db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withTag })).skillsQueued).toBe(0);
      // Another model tag (the vectors were re-embedded) queues it again.
      const other = 'other-model@1024';
      expect((await runEnrichCatchUp(tableDb(rows, { skillVectorModels: [other] }).db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withTag, embeddingModelTag: () => other })).skillsQueued).toBe(1);
    });

    it('nothing is queued without an embedding model, or while RASkill holds no label vector of it', async () => {
      const rows = [unmapped('a')];
      const none = queue();
      const noTag = tableDb(rows, { skillVectorModels: [TAG] });
      expect((await runEnrichCatchUp(noTag.db, 'intl', { brand: robo, enqueueMany: none.enqueueMany, env: {}, ...withTag, embeddingModelTag: () => null })).skillsQueued).toBe(0);
      // No probe and no select without a tag.
      expect(noTag.sql.some((t) => t.includes('"RASkill"') || t.includes('"skillsDetail"'))).toBe(false);
      const noVectors = tableDb(rows, { skillVectorModels: [] });
      expect((await runEnrichCatchUp(noVectors.db, 'intl', { brand: robo, enqueueMany: none.enqueueMany, env: {}, ...withTag })).skillsQueued).toBe(0);
      expect(noVectors.sql.some((t) => t.includes('"RASkill"'))).toBe(true);
      expect(noVectors.sql.some((t) => t.includes('"skillsDetail"'))).toBe(false);
      expect(none.items).toHaveLength(0);
      // The real default: a brand with no embedding key has no tag.
      expect((await runEnrichCatchUp(tableDb(rows, { skillVectorModels: [TAG] }).db, 'intl', { brand: robo, enqueueMany: none.enqueueMany, env: {}, enrichModel: withTag.enrichModel })).skillsQueued).toBe(0);
      // …and with a key it is the platform's tag (the model name and the dimensions).
      const keyed = queue();
      const tag = `text-embedding-3-large@1024`;
      const res = await runEnrichCatchUp(tableDb(rows, { skillVectorModels: [tag] }).db, 'intl', { brand: robo, enqueueMany: keyed.enqueueMany, env: { OPENAI_API_KEY: 'placeholder-for-this-test', EMBED_MODEL: 'text-embedding-3-large' }, enrichModel: withTag.enrichModel });
      expect(res.skillsQueued).toBe(1);
    });

    it('never a private row (a user\'s import is mapped by exact alias only), an archived row, another market or an older version; newest postings first', async () => {
      const rows = [
        unmapped('import', { visibility: 'private', sourceBoard: 'user_import' }),
        unmapped('gone', { archivedAt: NOW }),
        unmapped('cn', { market: 'cn' }),
        unmapped('older', { postedAt: new Date(NOW.getTime() - 20 * DAY) }),
        unmapped('newer', { postedAt: new Date(NOW.getTime() - 2 * DAY) }),
      ];
      const q = queue();
      const res = await runEnrichCatchUp(tableDb(rows, { skillVectorModels: [TAG] }).db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withTag });
      expect(res.skillsQueued).toBe(2);
      expect(q.ids()).toEqual(['newer', 'older']);
    });

    it('it takes what is left of the cap after the stale and the rules-only rows; a failing probe queues nothing and fails nothing', async () => {
      const rows = [
        ...Array.from({ length: 3 }, (_, i) => row({ id: `stale${i}`, enrichVersion: ENRICH_VERSION - 1 })),
        ...Array.from({ length: 2 }, (_, i) => row({ id: `rules${i}`, enrichModel: RULES_ONLY_MODEL })),
        ...Array.from({ length: 4 }, (_, i) => unmapped(`skills${i}`)),
      ];
      const q = queue();
      const res = await runEnrichCatchUp(tableDb(rows, { skillVectorModels: [TAG] }).db, 'intl', { brand: robo, enqueueMany: q.enqueueMany, env: {}, limit: 7, ...withTag });
      expect(res).toEqual({ staleQueued: 3, rulesQueued: 2, modelAvailable: true, skillsQueued: 2 });
      expect(q.ids()).toEqual(['stale0', 'stale1', 'stale2', 'rules0', 'rules1', 'skills0', 'skills1']);
      // The cap is spent before the skills pass: nothing more.
      const tight = queue();
      expect((await runEnrichCatchUp(tableDb(rows, { skillVectorModels: [TAG] }).db, 'intl', { brand: robo, enqueueMany: tight.enqueueMany, env: {}, limit: 5, ...withTag })).skillsQueued).toBe(0);
      // No RASkill table (a database before the M0 push): the two other kinds are still queued.
      const broken = tableDb(rows, { skillVectorModels: [TAG] });
      const realQuery = broken.db.$queryRaw.bind(broken.db) as unknown as (sql: { text: string; values: unknown[] }) => Promise<unknown[]>;
      (broken.db as unknown as { $queryRaw: unknown }).$queryRaw = async (stmt: { text: string; values: unknown[] }) => (stmt.text.includes('"RASkill"') ? Promise.reject(new Error('relation "RASkill" does not exist')) : realQuery(stmt));
      const safe = queue();
      expect(await runEnrichCatchUp(broken.db, 'intl', { brand: robo, enqueueMany: safe.enqueueMany, env: {}, ...withTag })).toEqual({ staleQueued: 3, rulesQueued: 2, modelAvailable: true, skillsQueued: 0 });
    });

    it('runMaintenance counts the pass in enrichQueued', async () => {
      const q = queue();
      const res = await runMaintenance(tableDb([unmapped('a'), row({ id: 'stale', enrichVersion: 0 })], { skillVectorModels: [TAG] }).db, 'intl', [], {
        perQueryTracking: false,
        enrich: { brand: robo, enqueueMany: q.enqueueMany, env: {}, ...withTag },
      });
      expect(res.enrichQueued).toBe(2);
    });

    it('the two statements: a one-row probe of the label vectors, and the bounded, market-scoped select of public rows', () => {
      const probe = buildSkillVectorProbeSql(TAG);
      expect(normalizeSql(probe.text)).toBe('SELECT 1 AS "one" FROM "RASkill" WHERE "embedding" IS NOT NULL AND "embeddingModel" = $1 LIMIT 1');
      expect(probe.values).toEqual([TAG]);
      const remap = buildSkillRemapSql('cn', 3, 40);
      expect(normalizeSql(remap.text)).toBe(
        `SELECT "id" FROM "RAJob" WHERE "market" = $1 AND "archivedAt" IS NULL AND "visibility" = 'public' AND "enrichVersion" = $2::int AND "skillsDetail" @> '[{"via":"none"}]'::jsonb ` +
          `ORDER BY "postedAt" DESC NULLS LAST, "id" ASC LIMIT $3::int`,
      );
      expect(remap.values).toEqual(['cn', 3, 40]);
    });
  });

  it('the two reads are bounded, market-scoped and skip archived rows', () => {
    const stale = buildStaleEnrichSql('intl', 3, 50);
    expect(normalizeSql(stale.text)).toBe(
      'SELECT "id" FROM "RAJob" WHERE "market" = $1 AND "archivedAt" IS NULL AND "enrichVersion" < $2::int ORDER BY "postedAt" DESC NULLS LAST, "id" ASC LIMIT $3::int',
    );
    expect(stale.values).toEqual(['intl', 3, 50]);
    const rules = buildRulesOnlySql('cn', 3, RULES_ONLY_MODEL, 20);
    expect(normalizeSql(rules.text)).toBe(
      'SELECT "id" FROM "RAJob" WHERE "market" = $1 AND "archivedAt" IS NULL AND "enrichVersion" = $2::int AND "enrichModel" = $3 ORDER BY "enrichedAt" ASC NULLS FIRST, "id" ASC LIMIT $4::int',
    );
    expect(rules.values).toEqual(['cn', 3, 'rules', 20]);
  });
});
