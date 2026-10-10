// @vitest-environment node
// PAR-7: the feed proof report. Its queries are SELECT-only and scoped to the
// brand's market; the assembly counts by provider, checks the GoApply
// acceptance and prints only ids, source names, apply hosts and dates.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { toRecordedSql } from '../../../test/sqlSnapshot.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { sourceStatusKey, type SourceStatusDoc } from './status.js';
import {
  ACCEPTANCE,
  applyHost,
  assembleFeedReport,
  buildBoardHostsSql,
  buildBoardsSql,
  buildCountsSql,
  buildSamplesSql,
  formatFeedReport,
  isAtsHost,
  providerOfBoard,
  readFeedReport,
  reportBrand,
  type BoardHostRow,
  type BoardRow,
  type CountRow,
  type SampleRow,
  type VerifyFeedDb,
} from './verifyFeed.js';

const NOW = new Date('2026-10-11T08:00:00.000Z');
const rec = (sql: ReturnType<typeof buildCountsSql>) => toRecordedSql('$queryRaw', sql, []);

describe('report queries (read-only, one market)', () => {
  it.each([
    ['counts', buildCountsSql('cn')],
    ['boards', buildBoardsSql('cn')],
    ['board hosts', buildBoardHostsSql('cn')],
    ['samples', buildSamplesSql('cn')],
  ])('%s: a single SELECT over RAJob, scoped to the market, that writes nothing', (_name, sql) => {
    const r = rec(sql);
    expect(r.text.trimStart().startsWith('SELECT')).toBe(true);
    expect(r.text).toContain('FROM "RAJob"');
    expect(r.text).toContain('"market" = $1');
    expect(r.values[0]).toBe('cn');
    expect(r.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
  });

  it('counts by source board, visibility, state and last-seen bucket, with the apply-URL and provider-id counters', () => {
    const { text } = rec(buildCountsSql('cn'));
    for (const part of ['"sourceBoard"', '"visibility"', `COALESCE("closeReason", 'archived')`, `interval '1 day'`, `interval '7 days'`, `interval '30 days'`, 'GROUP BY 1, 2, 3, 4']) expect(text).toContain(part);
    expect(text).toContain(`FILTER (WHERE COALESCE(btrim("applyUrl"), '') = '')`);
    expect(text).toContain(`FILTER (WHERE COALESCE(btrim("externalId"), '') = '')`);
    expect(text).toContain(`FILTER (WHERE COALESCE(btrim("sourceName"), '') = '')`);
  });

  it('board hosts: open public rows of the four job-board systems by board and apply HOST; the path and query of a link are never selected', () => {
    const r = rec(buildBoardHostsSql('cn'));
    expect(r.text).toContain(`"visibility" = 'public' AND "archivedAt" IS NULL`);
    expect(r.text).toContain('GROUP BY 1, 2, 3');
    expect(r.values[1]).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters']);
    // "applyUrl" appears once, inside the host extraction.
    expect(r.text.match(/"applyUrl"/g)).toHaveLength(1);
    expect(r.text).toContain('substring(btrim("applyUrl") from');
    for (const banned of ['description', 'ownerUserId', 'companyName', 'location']) expect(r.text).not.toContain(`"${banned}"`);
    expect(isAtsHost('jobs.smartrecruiters.com')).toBe(true);
    expect(isAtsHost('boards.greenhouse.io')).toBe(true);
    expect(isAtsHost('job-boards.eu.greenhouse.io')).toBe(true);
    expect(isAtsHost('jobs.lever.co')).toBe(true);
    expect(isAtsHost('jobs.ashbyhq.com')).toBe(true);
    expect(isAtsHost('careers.example.com')).toBe(false);
    expect(isAtsHost('notgreenhouse.io')).toBe(false);
  });

  it('boards: open public rows of the four job-board systems, by board token', () => {
    const r = rec(buildBoardsSql('cn'));
    expect(r.text).toContain(`"visibility" = 'public' AND "archivedAt" IS NULL`);
    expect(r.text).toContain(`split_part("externalId", ':', 1)`);
    expect(r.values[1]).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters']);
  });

  it('samples: five open public rows per source, and only ids, the source, the apply link and dates', () => {
    const r = rec(buildSamplesSql('cn'));
    expect(r.text).toContain('PARTITION BY "sourceBoard"');
    expect(r.values).toEqual(['cn', 5]);
    const selected = r.text.match(/^SELECT (.*?) FROM/s)![1]!.split(',').map((c) => c.trim().replace(/"/g, ''));
    expect(selected).toEqual(['id', 'sourceBoard', 'sourceName', 'applyUrl', 'postedAt', 'lastSeenAt']);
    // No personal data and no recruiter-internal field is ever selected.
    for (const banned of ['description', 'ownerUserId', 'seedTags', 'companyName', 'location']) expect(r.text).not.toContain(`"${banned}"`);
  });
});

const count = (sourceBoard: string, n: number, over: Partial<CountRow> = {}): CountRow => ({ sourceBoard, visibility: 'public', state: 'open', seen: '24h', n, noApplyUrl: 0, noProviderId: 0, ...over });
const status = (notes: Record<string, number>, over: Record<string, unknown> = {}): SourceStatusDoc => {
  const run = { at: '2026-10-11T07:50:00.000Z', ok: true, error: null, transport: 'api', queries: 1, calls: 4, received: 0, written: 0, inserted: 0, closed: 0, skipped: 0, notes, ...over };
  return { last: run, counted: run } as SourceStatusDoc;
};

describe('assembleFeedReport', () => {
  const boards: BoardRow[] = [
    { sourceBoard: 'smartrecruiters', boardToken: 'BoschGroup', n: 100 },
    { sourceBoard: 'smartrecruiters', boardToken: 'AbbVie', n: 100 },
    ...Array.from({ length: 9 }, (_, i) => ({ sourceBoard: 'greenhouse', boardToken: `b${i}`, n: 20 })),
  ];
  const counts: CountRow[] = [
    count('smartrecruiters', 200),
    count('greenhouse', 180),
    count('greenhouse', 12, { state: 'source_removed', seen: '7d' }),
    count('user_import', 3, { visibility: 'private' }),
    count('gohire', 6, { state: 'no_apply_target', seen: '30d' }),
    count('seed', 2, { seen: 'older' }),
  ];
  const samples: SampleRow[] = [
    { id: 'c1', sourceBoard: 'smartrecruiters', sourceName: 'Bosch Group · SmartRecruiters', applyUrl: 'https://jobs.smartrecruiters.com/BoschGroup/744?token=abc', postedAt: new Date('2026-10-09T00:00:00Z'), lastSeenAt: new Date('2026-10-11T07:00:00Z') },
    { id: 'c2', sourceBoard: 'greenhouse', sourceName: 'Riot Games · Greenhouse', applyUrl: 'not a url', postedAt: null, lastSeenAt: null },
  ];
  const statuses = new Map([
    ['bank_gohire', status({ bank_synced: 181, bank_no_public_page: 181, bank_unpublished: 1092 })],
    ['ats_public', status({ boards_read: 26, wrong_market: 9 }, { transport: 'board_api', written: 380 })],
  ]);
  const report = assembleFeedReport({ brand: 'goapply', market: 'cn', now: NOW, counts, boards, samples, statuses });

  it('maps boards to providers and totals rows, open public rows and held rows', () => {
    expect(providerOfBoard('gohire')).toBe('bank_gohire');
    expect(providerOfBoard('lever')).toBe('ats_public');
    expect(providerOfBoard('jsearch')).toBe('jsearch');
    expect(providerOfBoard('seed')).toBe('other');
    expect(report.totals).toEqual({ rows: 403, openPublic: 382, noProviderId: 0, openPublicNoApplyUrl: 0, withApplyUrl: 403, withoutApplyUrl: 0 });
    expect(report.byProvider.find((p) => p.provider === 'ats_public')).toEqual({ provider: 'ats_public', rows: 392, openPublic: 380, held: 0 });
    // The GoHire rows are held (no public job page): counted, never among the open rows.
    expect(report.byProvider.find((p) => p.provider === 'bank_gohire')).toEqual({ provider: 'bank_gohire', rows: 6, openPublic: 0, held: 6 });
    expect(report.employerBoards).toMatchObject({ boards: 11, rows: 380 });
  });

  it('review fix: a board row with no source name or no apply host fails the acceptance; a link on the employer\'s own host is printed, not failed', () => {
    const hosts: BoardHostRow[] = [
      { sourceBoard: 'smartrecruiters', boardToken: 'BoschGroup', host: 'jobs.smartrecruiters.com', n: 97 },
      { sourceBoard: 'smartrecruiters', boardToken: 'BoschGroup', host: 'careers.example.com', n: 3 },
      { sourceBoard: 'smartrecruiters', boardToken: 'AbbVie', host: 'JOBS.SmartRecruiters.com', n: 100 },
    ];
    const ok = assembleFeedReport({ brand: 'goapply', market: 'cn', now: NOW, counts, boards, hosts, samples, statuses });
    expect(ok.acceptance!.pass).toBe(true);
    expect(ok.employerBoards).toMatchObject({ noSourceName: 0, noApplyHost: 0, offAtsHost: 3 });
    expect(ok.employerBoards.perBoard[0]).toMatchObject({
      boardToken: 'BoschGroup',
      hosts: [{ host: 'jobs.smartrecruiters.com', rows: 97, ats: true }, { host: 'careers.example.com', rows: 3, ats: false }],
    });
    const text = formatFeedReport(ok);
    expect(text).toContain('smartrecruiters BoschGroup: 100 · apply hosts: jobs.smartrecruiters.com 97, careers.example.com 3 (not a job-board host)');
    expect(text).toContain("3 rows link to a host that is not the job-board system's own: check each is the employer's own site.");

    // No source name on 4 open public board rows, and 2 links with no host: both fail --check.
    const bad = assembleFeedReport({
      brand: 'goapply', market: 'cn', now: NOW,
      counts: [count('smartrecruiters', 200, { noSourceName: 4 }), count('greenhouse', 180), count('greenhouse', 9, { state: 'source_removed', noSourceName: 9 }), count('gohire', 5, { noSourceName: 5 })],
      boards,
      hosts: [...hosts, { sourceBoard: 'greenhouse', boardToken: 'b0', host: '', n: 2 }],
      samples: [], statuses: new Map(),
    });
    expect(bad.acceptance!.pass).toBe(false);
    const failed = bad.acceptance!.checks.filter((c) => !c.pass).map((c) => [c.check, c.value]);
    // Archived rows and rows of other sources are not counted by the board checks.
    expect(failed).toEqual([
      ['open public employer-board rows without a source name', 4],
      ['open public employer-board rows without an apply host', 2],
    ]);
    expect(formatFeedReport(bad)).toContain('greenhouse b0: 20 · apply hosts: (no host) 2');
  });

  it('an unknown --brand is an error, never a silent default; no flag means goapply', () => {
    expect(reportBrand(null)).toEqual({ brand: 'goapply' });
    expect(reportBrand('goapply')).toEqual({ brand: 'goapply' });
    expect(reportBrand('RoboApply')).toEqual({ brand: 'roboapply' });
    expect(reportBrand('gohire')).toEqual({ error: 'Unknown --brand "gohire". Use goapply or roboapply.' });
    expect(reportBrand('')).toHaveProperty('error');
  });

  it('shows each source\'s synced, skipped and held counts from its stored status, and its error when it failed', () => {
    expect(report.sources.find((s) => s.provider === 'bank_gohire')).toMatchObject({ ok: true, transport: 'api', notes: { bank_synced: 181, bank_no_public_page: 181, bank_unpublished: 1092 } });
    const failed = assembleFeedReport({ brand: 'goapply', market: 'cn', now: NOW, counts, boards, samples, statuses: new Map([['bank_gohire', status({}, { ok: false, error: 'GoHire bank read failed: http_502' })]]) });
    expect(failed.sources.find((s) => s.provider === 'bank_gohire')).toMatchObject({ ok: false, error: 'GoHire bank read failed: http_502' });
    expect(formatFeedReport(failed)).toContain('bank_gohire (api): ERROR at 2026-10-11T07:50:00.000Z: GoHire bank read failed: http_502');
    // A source that never ran says so.
    expect(formatFeedReport(assembleFeedReport({ brand: 'goapply', market: 'cn', now: NOW, counts, boards, samples, statuses: new Map() }))).toContain('ats_public: never ran');
  });

  it('samples carry the apply HOST only (never the path or query), the provider and the dates', () => {
    expect(report.samples).toEqual([
      { id: 'c1', provider: 'ats_public', sourceBoard: 'smartrecruiters', sourceName: 'Bosch Group · SmartRecruiters', applyHost: 'jobs.smartrecruiters.com', postedAt: '2026-10-09T00:00:00.000Z', lastSeenAt: '2026-10-11T07:00:00.000Z' },
      { id: 'c2', provider: 'ats_public', sourceBoard: 'greenhouse', sourceName: 'Riot Games · Greenhouse', applyHost: null, postedAt: null, lastSeenAt: null },
    ]);
    expect(applyHost('https://example.test/p/1?x=secret')).toBe('example.test');
    expect(applyHost(null)).toBeNull();
    expect(JSON.stringify(report)).not.toContain('token=abc');
  });

  it('GoApply acceptance: at least 300 open public board rows across at least 10 boards, no row without a provider id or apply URL, no JSearch row', () => {
    expect(report.acceptance).toMatchObject({ pass: true });
    expect(formatFeedReport(report)).toContain('Acceptance: PASS');
    // A shortfall is reported with its numbers, never padded.
    const few = assembleFeedReport({ brand: 'goapply', market: 'cn', now: NOW, counts: [count('greenhouse', 40), count('jsearch', 3), count('greenhouse', 2, { noApplyUrl: 2 }), count('lever', 1, { noProviderId: 1 })], boards: boards.slice(0, 3), samples: [], statuses: new Map() });
    expect(few.acceptance!.pass).toBe(false);
    expect(few.acceptance!.checks.map((c) => [c.check, c.pass, c.value])).toEqual([
      ['open public employer-board rows', false, 220],
      ['employer boards with open public rows', false, 3],
      ['rows without a provider id', false, 1],
      ['open public rows without an apply URL', false, 2],
      ['open public employer-board rows without a source name', true, 0],
      ['open public employer-board rows without an apply host', true, 0],
      ['rows from jsearch', false, 3],
    ]);
    expect(formatFeedReport(few)).toMatch(/FAIL open public employer-board rows: 220 \(need >= 300\)/);
    expect(ACCEPTANCE).toEqual({ minBoardRows: 300, minBoards: 10 });
    // The numeric acceptance is GoApply's; RoboApply gets the same report without it.
    expect(assembleFeedReport({ brand: 'roboapply', market: 'intl', now: NOW, counts, boards, samples, statuses }).acceptance).toBeNull();
  });
});

describe('readFeedReport', () => {
  it('runs four SELECTs and reads the stored statuses; it never writes', async () => {
    const fake = createFakePrisma({
      seed: { appConfig: [{ id: 'a1', key: sourceStatusKey('cn', 'ats_public'), value: JSON.stringify(status({ boards_read: 26 }, { transport: 'board_api' })) }] },
      sql: {
        respond(call) {
          if (call.text.includes('GROUP BY 1, 2, 3, 4')) return [count('greenhouse', 5)];
          if (call.text.includes('GROUP BY 1, 2, 3')) return [{ sourceBoard: 'greenhouse', boardToken: 'riotgames', host: 'job-boards.greenhouse.io', n: 5 }];
          if (call.text.includes('split_part')) return [{ sourceBoard: 'greenhouse', boardToken: 'riotgames', n: 5 }];
          return [];
        },
      },
    });
    const report = await readFeedReport(fake as unknown as VerifyFeedDb, 'goapply', 'cn', NOW);
    expect(report.totals.rows).toBe(5);
    expect(report.employerBoards).toMatchObject({ boards: 1, rows: 5, noApplyHost: 0, offAtsHost: 0 });
    expect(report.employerBoards.perBoard[0]!.hosts).toEqual([{ host: 'job-boards.greenhouse.io', rows: 5, ats: true }]);
    expect(report.sources.find((s) => s.provider === 'ats_public')).toMatchObject({ transport: 'board_api', notes: { boards_read: 26 } });
    expect(fake.$sql.calls).toHaveLength(4);
    expect(fake.$sql.calls.every((c) => c.method === '$queryRaw' && c.text.trimStart().startsWith('SELECT'))).toBe(true);
    expect(fake.$rows('appConfig')).toHaveLength(1);
  });
});
