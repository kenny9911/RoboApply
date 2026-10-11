// @vitest-environment node
//
// Market wave M5 gate: the contracts between bundles that no single bundle
// could test, on the merged tree. Each bundle was built in its own worktree
// against the other's handoff; here the real producer meets the real consumer.
//
//   1. A source's own tags (MKT-5D's two adapters write them; MKT-5F's
//      normalizer stores them): the tag an adapter hands over is one the
//      normalizer keeps, with the source's own words.
//   2. The mainland "45 days unseen" rule (MKT-5C) and the GoHire bank's
//      re-read (MKT-5E): the bank whose market has the unseen rule is re-seen
//      well inside the window, and a row the rule closed comes back when the
//      bank lists it again.
//   3. The dedupe repair after a closure (MKT-5C's liveness check reads it from
//      the ingest area's public surface at run time).
//   4. Run tallies (MKT-5B's board sync, MKT-5E's bank sync write them; the
//      status document keeps only the listed ones; the admin console has a
//      sentence for each listed one).
//   5. The provider's sponsorship reading (the upsert writes its source; the
//      feed's badge rule reads it; MKT-5A's feed is such a provider).
//   6. Every board system the connectors read has a posting-key rule
//      (MKT-5B's nine systems; normalize/ats.ts).
//
// No database, no network: fixtures and pure functions only.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/prisma.js', () => ({ default: {}, prisma: {}, createPrismaClientForUrl: vi.fn(), activeRuntimeUrl: () => 'postgresql://active.example/db', cleanConnectionString: (u: string | undefined) => u }));
vi.mock('../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { bankMarket } from '../roboapply/v2/lib/raCrossBankMatch.js';
import { PROVIDER_SPONSORSHIP_PREFIX as FEED_PREFIX, sponsorshipProviderName, sponsorshipSignalOf } from './feed/contract.js';
import { BANK_RESYNC_DAYS, BANK_RESYNC_MAX_DAYS, bankRereads } from './jobs/ingest/adapters/bank.js';
import { CN_UNSEEN_DAYS, UNSEEN_MARKET } from './jobs/ingest/maintain.js';
import { SOURCE_STATUS_NOTES } from './jobs/ingest/status.js';
import { PROVIDER_SPONSORSHIP_PREFIX as UPSERT_PREFIX, revivesOnRelist } from './jobs/ingest/upsert.js';
import { ingestDedupeRepair } from './jobs/liveness/index.js';
import { atsPostingKeyFromBoardRow } from './jobs/normalize/ats.js';
import { PROVIDER_META, normalizeProviderJob } from './jobs/normalize/index.js';
import { PUBLIC_ATS } from './jobs/sources/atsPublic/contract.js';
import { TW_GOV_PERSON_KIND_TAG } from './jobs/sources/twGovJobs.js';
import { USAJOBS_HIRING_PATH_TAG, parseUsaJobsPage, usaJobsItemToInput } from './jobs/sources/usaJobs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-10-12T02:00:00.000Z');

describe('M5 seam 1: a source\'s own tags reach RAJob.marketTags (MKT-5D adapters → MKT-5F normalizer)', () => {
  it('the USAJOBS hiring path of a fixture item is stored with the item\'s own words', () => {
    const page = parseUsaJobsPage(readFileSync(join(HERE, 'jobs', 'sources', '__fixtures__', 'usajobs', 'search.json'), 'utf8'));
    if (!page.ok) throw new Error(page.error);
    const mapped = page.items.map((item) => usaJobsItemToInput(item, NOW)).filter((m) => 'input' in m && (m.input.marketTags?.length ?? 0) > 0);
    expect(mapped.length).toBeGreaterThan(0);
    for (const m of mapped) {
      if (!('input' in m)) continue;
      const handed = m.input.marketTags![0]!;
      expect(handed.tag).toBe(USAJOBS_HIRING_PATH_TAG);
      const job = normalizeProviderJob(m.input, 'usajobs', { market: 'intl', now: NOW });
      expect(job?.marketTags).toEqual([expect.objectContaining({ tag: USAJOBS_HIRING_PATH_TAG, evidenceQuote: handed.evidenceQuote })]);
    }
  });

  it('the 事求人 staff-category tag is one the normalizer keeps; a tag it does not know is dropped', () => {
    const base = {
      externalId: 'dgpa:seam-1',
      title: '約僱人員',
      company: '範例機關',
      description: '人員區分：一般人員\n工作項目：行政業務',
      applyUrl: 'https://web3.dgpa.gov.tw/want03front/AP/WANTF00003.aspx?work_id=1',
      sourceUrl: 'https://web3.dgpa.gov.tw/want03front/AP/WANTF00003.aspx?work_id=1',
      location: '臺北市',
      locationCountry: 'TW',
    };
    const kept = normalizeProviderJob({ ...base, marketTags: [{ tag: TW_GOV_PERSON_KIND_TAG, evidenceQuote: '一般人員', evidenceUrl: base.sourceUrl }] } as never, 'tw_gov_jobs', { market: 'intl', now: NOW });
    expect(kept?.marketTags).toEqual([expect.objectContaining({ tag: TW_GOV_PERSON_KIND_TAG, evidenceQuote: '一般人員' })]);
    const other = normalizeProviderJob({ ...base, marketTags: [{ tag: 'cn_hire:campus', evidenceQuote: 'x' }] } as never, 'tw_gov_jobs', { market: 'intl', now: NOW });
    expect(other?.marketTags ?? []).toEqual([]);
  });
});

describe('M5 seam 2: the mainland unseen rule (MKT-5C) cannot close a job the GoHire bank still lists (MKT-5E)', () => {
  it('the bank of the market with the unseen rule is the one that is re-read, inside the window', () => {
    expect(UNSEEN_MARKET).toBe('cn');
    expect(bankMarket('gohire')).toBe(UNSEEN_MARKET);
    expect(bankRereads('gohire')).toBe(true);
    // RoboHire's sync is the parity wave's: never re-read for its age, and its market has no unseen rule.
    expect(bankRereads('robohire')).toBe(false);
    expect(bankMarket('robohire')).not.toBe(UNSEEN_MARKET);
    // A row is seen again at least every BANK_RESYNC_MAX_DAYS; the rule waits longer than that.
    expect(BANK_RESYNC_DAYS).toBeLessThanOrEqual(BANK_RESYNC_MAX_DAYS);
    expect(CN_UNSEEN_DAYS).toBeGreaterThan(BANK_RESYNC_MAX_DAYS);
  });

  it('a GoHire row the rule closed as expired is reopened when the bank lists it again with no deadline', () => {
    expect(revivesOnRelist('expired', { sourceBoard: PROVIDER_META.bank_gohire.sourceBoard, expiresAt: null }, NOW)).toBe(true);
    // What the ATS itself said is gone is not reopened by a listing (MKT-5C review finding 1).
    expect(revivesOnRelist('ats_removed', { sourceBoard: 'jsearch', expiresAt: null }, NOW)).toBe(false);
  });
});

describe('M5 seam 3: the liveness check finds the dedupe repair on the ingest area\'s surface', () => {
  it('ingestDedupeRepair resolves a repair from the real jobs/ingest index', async () => {
    const repair = await ingestDedupeRepair({} as never);
    expect(typeof repair).toBe('function');
  });
});

describe('M5 seam 4: the tallies the M5 sources write are tallies the status document keeps', () => {
  it('lists the board sync\'s and the bank sync\'s new reasons', () => {
    for (const note of ['country_not_selected', 'bank_validity_ended', 'bank_time_without_zone', 'bank_reread_started', 'bank_pass_cut_short', 'bank_closed']) {
      expect(SOURCE_STATUS_NOTES as readonly string[], note).toContain(note);
    }
  });
});

describe('M5 seam 5: a provider\'s sponsorship reading, from the upsert to the badge', () => {
  it('the prefix the upsert writes is the prefix the feed reads, and the licensed feed has a display name', () => {
    expect(UPSERT_PREFIX).toBe(FEED_PREFIX);
    for (const provider of ['activejobs', 'activejobs_feed'] as const) {
      const source = `${UPSERT_PREFIX}${provider}`;
      expect(sponsorshipProviderName(source), provider).toBe('Active Jobs DB');
      expect(sponsorshipSignalOf({ sponsorship: 'offered', sponsorshipEvidence: null, sponsorshipSource: source })).toEqual({ basis: 'provider', status: 'offered', provider: 'Active Jobs DB' });
    }
    // A provider's "not offered" alone is never a label (D3).
    expect(sponsorshipSignalOf({ sponsorship: 'not_offered', sponsorshipEvidence: null, sponsorshipSource: `${UPSERT_PREFIX}activejobs_feed` })).toBeNull();
  });
});

describe('M5 seam 6: every board system has a posting-key rule', () => {
  it('a row of each of the nine systems gets `<ats>:<board>:<posting>`', () => {
    expect(PUBLIC_ATS).toHaveLength(9);
    for (const ats of PUBLIC_ATS) expect(atsPostingKeyFromBoardRow(ats, 'acme:1'), ats).toBe(`${ats}:acme:1`);
  });
});
