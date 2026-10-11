// @vitest-environment node
//
// MKT-3D (JI-3, JT-5, JC-4; D3): the three seed files and their loader. The
// files hold only boards a research note or the parity handoff confirms; this
// test pins their shape, fails on an entry without where and when it was
// confirmed, and pins the Taiwan list to the note's 14 boards. The loader is
// run against the in-memory fake: no network, no database.

import { describe, expect, it, vi } from 'vitest';

import { createFakePrisma } from '../../../../test/fakePrisma.js';
import { BOARD_TOKEN_PATTERN, PUBLIC_ATS } from './contract.js';
import {
  CAREER_SEEDS_CONFIG_KEY,
  LEGACY_SEED_STATE_KEY,
  SEED_FILE_NAMES,
  careerSeedBoards,
  ensureSeedCareerSources,
  loadCareerSeeds,
  mergeSeedFiles,
  parseSeedFile,
  seedFile,
  seedHash,
  seedKey,
  type MergedSeedBoard,
  type SeedDb,
} from './seeds.js';
import { rememberRemovedBoard } from './removed.js';
import { sourceCoversCountry, sourceFeedsMarket } from './shared.js';

/** JOB_SOURCES_TW.md 3.5 and MARKET_STRATEGY 1.3: the 14 boards confirmed live with postings in Taiwan. */
const TAIWAN_BOARDS = [
  'ashby:kraken.com',
  'greenhouse:appier',
  'greenhouse:asteralabs',
  'greenhouse:canonical',
  'greenhouse:coupang',
  'greenhouse:dcard',
  'greenhouse:okx',
  'greenhouse:stripe',
  'greenhouse:ubiquiti',
  'lever:binance',
  'lever:crypto',
  'lever:piccollage',
  'lever:shopback-2',
  'smartrecruiters:BoschGroup',
];

const entry = (over: Record<string, unknown> = {}) => ({
  ats: 'greenhouse',
  boardToken: 'acme',
  companyName: 'Acme',
  countries: [],
  note: 'SYNTHETIC: a test entry, not a real confirmation',
  confirmedOn: '2026-10-11',
  ...over,
});
const file = (...boards: unknown[]) => ({ about: 'SYNTHETIC test list', boards });

describe('the seed files', () => {
  it('each file parses: known job-board systems, board ids inside the pattern, ISO countries, where and when each board was confirmed', () => {
    for (const name of SEED_FILE_NAMES) {
      const parsed = seedFile(name);
      expect(parsed.about.length, name).toBeGreaterThan(40);
      expect(parsed.boards.length, name).toBeGreaterThan(0);
      for (const b of parsed.boards) {
        const at = `${name}: ${b.ats}/${b.boardToken}`;
        expect(PUBLIC_ATS as readonly string[], at).toContain(b.ats);
        expect(b.boardToken, at).toMatch(BOARD_TOKEN_PATTERN);
        expect(b.companyName.trim().length, at).toBeGreaterThan(0);
        for (const c of b.countries) expect(c, at).toMatch(/^[A-Z]{2}$/);
        // Where: a document of this repository. When: a real day.
        expect(b.note, at).toMatch(/docs\/jobright-clone\/(market\/[A-Z_]+\.md|orch\/handoffs-par\/PAR-7\.md)/);
        expect(b.confirmedOn, at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(b.confirmedOn)), at).toBe(false);
      }
      // Each board once per file.
      expect(new Set(parsed.boards.map((b) => seedKey(b).toLowerCase())).size, name).toBe(parsed.boards.length);
    }
  });

  it('parseSeedFile refuses an entry without a note, a duplicate, an unknown system, a board id outside the pattern and a non-ISO country', () => {
    expect(parseSeedFile(file(entry()))).toMatchObject({ boards: [{ ats: 'greenhouse', boardToken: 'acme', countries: [] }] });
    expect(() => parseSeedFile(file(entry({ note: undefined })))).toThrow(/where it was confirmed/);
    expect(() => parseSeedFile(file(entry({ note: 'memory' })))).toThrow(/where it was confirmed/);
    expect(() => parseSeedFile(file(entry({ confirmedOn: undefined })))).toThrow(/when it was confirmed/);
    expect(() => parseSeedFile(file(entry({ confirmedOn: 'October 2026' })))).toThrow(/when it was confirmed/);
    expect(() => parseSeedFile(file(entry(), entry()))).toThrow(/listed twice/);
    expect(() => parseSeedFile(file(entry(), entry({ boardToken: 'ACME' })))).toThrow(/listed twice/);
    expect(() => parseSeedFile(file(entry({ ats: 'workday' })))).toThrow(/unknown job-board system/);
    expect(() => parseSeedFile(file(entry({ boardToken: 'acme corp' })))).toThrow(/invalid board id/);
    expect(() => parseSeedFile(file(entry({ boardToken: '../etc' })))).toThrow(/invalid board id/);
    expect(() => parseSeedFile(file(entry({ countries: ['tw'] })))).toThrow(/ISO alpha-2/);
    expect(() => parseSeedFile(file(entry({ countries: ['TWN'] })))).toThrow(/ISO alpha-2/);
    expect(() => parseSeedFile(file(entry({ countries: 'TW' })))).toThrow(/ISO alpha-2/);
    expect(() => parseSeedFile(file(entry({ countries: ['TW', 'TW'] })))).toThrow(/twice/);
    expect(() => parseSeedFile(file(entry({ companyName: ' ' })))).toThrow(/company name/);
    expect(() => parseSeedFile({ boards: [entry()] })).toThrow(/about/);
    expect(() => parseSeedFile({ about: 'x', boards: 'none' })).toThrow(/must be a list/);
    expect(() => parseSeedFile(null)).toThrow();
  });

  it('Taiwan: exactly the 14 boards the note confirmed, no more and no fewer', () => {
    expect(seedFile('tw').boards.map(seedKey).sort()).toEqual(TAIWAN_BOARDS);
  });

  it('mainland: BoschGroup and Ubisoft2 read for CN, and every board the parity engineer verified; international: stripe and ramp only', () => {
    const cn = seedFile('cn').boards;
    expect(cn.find((b) => b.boardToken === 'BoschGroup')).toMatchObject({ ats: 'smartrecruiters', countries: ['CN'] });
    expect(cn.find((b) => b.boardToken === 'Ubisoft2')).toMatchObject({ ats: 'smartrecruiters', countries: ['CN'] });
    // PAR-7 item 4: 26 boards passed the connector check.
    expect(cn).toHaveLength(26);
    expect(seedFile('intl').boards.map(seedKey).sort()).toEqual(['ashby:ramp', 'greenhouse:stripe']);
  });

  it('single-call boards are read whole (no countries); a SmartRecruiters board names the countries it is listed for', () => {
    for (const b of careerSeedBoards()) {
      if (b.ats === 'smartrecruiters') expect(b.countries.length, b.boardToken).toBeGreaterThan(0);
      else expect(b.countries, `${b.ats}/${b.boardToken}`).toEqual([]);
    }
  });

  it('merged by (ats, boardToken): one entry per board; BoschGroup is ONE source read for exactly TW and CN', () => {
    const merged = careerSeedBoards();
    expect(new Set(merged.map(seedKey)).size).toBe(merged.length);
    const total = SEED_FILE_NAMES.reduce((n, name) => n + seedFile(name).boards.length, 0);
    // coupang, appier and BoschGroup are in the mainland and the Taiwan file; stripe in the Taiwan and the international one.
    expect(merged).toHaveLength(total - 4);
    const bosch = merged.filter((b) => b.boardToken === 'BoschGroup');
    expect(bosch).toHaveLength(1);
    expect(bosch[0]).toMatchObject({ ats: 'smartrecruiters', countries: ['CN', 'TW'], files: ['cn', 'tw'] });
    expect(bosch[0]!.note).toContain('PAR-7');
    expect(bosch[0]!.note).toContain('JOB_SOURCES_TW.md');
    expect(merged.find((b) => seedKey(b) === 'greenhouse:stripe')).toMatchObject({ countries: [], files: ['intl', 'tw'] });
    // Every Taiwan board covers TW; every mainland board feeds GoApply.
    for (const key of TAIWAN_BOARDS) expect(sourceCoversCountry(merged.find((b) => seedKey(b) === key)!, 'TW'), key).toBe(true);
    for (const b of seedFile('cn').boards) expect(sourceFeedsMarket(merged.find((m) => seedKey(m) === seedKey(b))!, 'cn'), seedKey(b)).toBe(true);
  });

  it('mergeSeedFiles: countries are united and an empty list wins; a real name replaces a board id standing in for one', () => {
    const merged = mergeSeedFiles({
      cn: parseSeedFile(file(entry({ ats: 'smartrecruiters', boardToken: 'Harbor', companyName: 'Harbor', countries: ['CN'] }), entry({ boardToken: 'acme', countries: ['CN'] }))),
      tw: parseSeedFile(file(entry({ ats: 'smartrecruiters', boardToken: 'Harbor', companyName: 'Harbor Foods', countries: ['TW'], confirmedOn: '2026-10-12' }), entry({ boardToken: 'acme', countries: [] }))),
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ boardToken: 'Harbor', companyName: 'Harbor Foods', countries: ['CN', 'TW'], files: ['cn', 'tw'], confirmedOn: '2026-10-12' });
    expect(merged[1]).toMatchObject({ boardToken: 'acme', countries: [], files: ['cn', 'tw'] });
  });

  it('seedHash changes with a board, a name or a country, and not with the order', () => {
    const a = entry();
    const b = entry({ boardToken: 'other' });
    const hash = seedHash([a, b] as never);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(seedHash([b, a] as never)).toBe(hash);
    expect(seedHash([a] as never)).not.toBe(hash);
    expect(seedHash([a, { ...b, companyName: 'Other' }] as never)).not.toBe(hash);
    expect(seedHash([a, { ...b, countries: ['TW'] }] as never)).not.toBe(hash);
  });
});

// ── The loader ───────────────────────────────────────────────────────────

const board = (over: Partial<MergedSeedBoard> = {}): MergedSeedBoard => ({ ats: 'greenhouse', boardToken: 'acme', companyName: 'Acme', countries: [], note: 'SYNTHETIC', confirmedOn: '2026-10-11', files: ['intl'], ...over });
const asDb = (fake: ReturnType<typeof createFakePrisma>) => fake as unknown as SeedDb;
const sources = (fake: ReturnType<typeof createFakePrisma>) => fake.$rows('rACareerSiteSource');
const find = (fake: ReturnType<typeof createFakePrisma>, token: string) => sources(fake).find((r) => r.boardToken === token)!;

describe('loadCareerSeeds', () => {
  it('after the loader ran, the 14 Taiwan boards exist as sources that cover TW, and BoschGroup is one row with exactly TW and CN', async () => {
    const fake = createFakePrisma();
    const res = await loadCareerSeeds(asDb(fake));
    const merged = careerSeedBoards();
    expect(res).toMatchObject({ status: 'loaded', boards: merged.length, added: merged.length, updated: 0, alreadyPresent: 0, removedByAdmin: 0 });
    const rows = sources(fake);
    expect(rows).toHaveLength(merged.length);
    expect(rows.every((r) => r.origin === 'seed' && r.enabled === true && r.createdBy === 'seed')).toBe(true);
    for (const key of TAIWAN_BOARDS) {
      const row = rows.find((r) => `${r.ats}:${r.boardToken}` === key);
      expect(row, key).toBeTruthy();
      expect(sourceCoversCountry(row as { countries: string[] }, 'TW'), key).toBe(true);
    }
    const bosch = rows.filter((r) => r.boardToken === 'BoschGroup');
    expect(bosch).toHaveLength(1);
    expect(bosch[0]!.countries).toEqual(['CN', 'TW']);
    expect(find(fake, 'Ubisoft2').countries).toEqual(['CN']);
    // Due at once: never read, no next time set, no country tag standing in for a market.
    expect(rows.every((r) => r.nextSyncAt == null && r.lastSyncedAt == null && r.countryCode == null)).toBe(true);
    // The console a board is shown under is display only: GoApply's when only the mainland file names it.
    expect(find(fake, 'AbbVie').market).toBe('cn');
    expect(find(fake, 'BoschGroup').market).toBe('intl');
    expect(find(fake, 'ramp').market).toBe('intl');
  });

  it('running it twice writes nothing the second time', async () => {
    const fake = createFakePrisma();
    await loadCareerSeeds(asDb(fake));
    const before = JSON.stringify([sources(fake), fake.$rows('appConfig')]);
    const writes = [
      vi.spyOn(fake.rACareerSiteSource!, 'createMany'),
      vi.spyOn(fake.rACareerSiteSource!, 'update'),
      vi.spyOn(fake.rACareerSiteSource!, 'findMany'),
      vi.spyOn(fake.appConfig!, 'upsert'),
    ];
    const again = await loadCareerSeeds(asDb(fake));
    expect(again).toMatchObject({ status: 'up_to_date', added: 0, updated: 0 });
    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify([sources(fake), fake.$rows('appConfig')])).toBe(before);
    expect(JSON.parse(String(fake.$rows('appConfig')[0]!.value))).toMatchObject({ hash: again.hash });
    expect(fake.$rows('appConfig')[0]!.key).toBe(CAREER_SEEDS_CONFIG_KEY);
  });

  it('an admin who switched a seeded board off, or renamed it, finds it unchanged after a deploy with a new seed list', async () => {
    const fake = createFakePrisma();
    const v1 = [board(), board({ boardToken: 'pinecloud', ats: 'lever', companyName: 'pinecloud' })];
    await loadCareerSeeds(asDb(fake), { boards: v1 });
    Object.assign(find(fake, 'acme'), { enabled: false, disabledAt: new Date('2026-10-12T00:00:00Z') });
    Object.assign(find(fake, 'pinecloud'), { companyName: 'Pine Cloud' });
    // The deploy: one more board, and acme's countries changed in the list.
    const v2 = [board({ countries: ['TW'] }), v1[1]!, board({ boardToken: 'newco', companyName: 'New Co' })];
    const res = await loadCareerSeeds(asDb(fake), { boards: v2 });
    expect(res).toMatchObject({ status: 'loaded', added: 1, updated: 1 });
    expect(find(fake, 'acme')).toMatchObject({ enabled: false, countries: ['TW'], origin: 'seed' });
    expect(find(fake, 'pinecloud')).toMatchObject({ companyName: 'Pine Cloud', enabled: true });
    expect(find(fake, 'newco')).toMatchObject({ origin: 'seed', enabled: true });
  });

  it('a seeded board an admin removed is not added again, whatever the list becomes; a board added by hand is left exactly as it is', async () => {
    const fake = createFakePrisma({
      seed: { rACareerSiteSource: [{ id: 'hand', market: 'intl', ats: 'greenhouse', boardToken: 'handmade', companyName: 'By Hand', enabled: false, origin: 'admin', countries: ['US'], countryCode: 'US', createdBy: 'admin1' }] },
    });
    const v1 = [board(), board({ boardToken: 'handmade', companyName: 'Handmade Inc', countries: [] })];
    expect(await loadCareerSeeds(asDb(fake), { boards: v1 })).toMatchObject({ added: 1, alreadyPresent: 1 });
    expect(find(fake, 'handmade')).toMatchObject({ companyName: 'By Hand', enabled: false, origin: 'admin', countries: ['US'], countryCode: 'US' });
    // The admin removes the seeded board; a later list still names it.
    const rows = sources(fake);
    rows.splice(rows.findIndex((r) => r.boardToken === 'acme'), 1);
    const res = await loadCareerSeeds(asDb(fake), { boards: [...v1, board({ boardToken: 'newco' })] });
    expect(res).toMatchObject({ status: 'loaded', added: 1, removedByAdmin: 1, alreadyPresent: 1 });
    expect(sources(fake).map((r) => r.boardToken).sort()).toEqual(['handmade', 'newco']);
  });

  it('a board an admin removed before any seed file named it is not added by a later list either (the removed list)', async () => {
    const fake = createFakePrisma();
    // Added by hand or found by discovery, then removed on request: only the removal is left.
    await rememberRemovedBoard(asDb(fake) as never, { ats: 'greenhouse', boardToken: 'TakenDown' }, 'admin1');
    const res = await loadCareerSeeds(asDb(fake), { boards: [board(), board({ boardToken: 'takendown', companyName: 'Taken Down' })] });
    expect(res).toMatchObject({ status: 'loaded', added: 1, removedByAdmin: 1 });
    expect(sources(fake).map((r) => r.boardToken)).toEqual(['acme']);
  });

  it('rows of the parity wave\'s loader are brought to this model once: origin seed, the merged countries, no country tag; on/off and name untouched', async () => {
    const fake = createFakePrisma({
      seed: {
        rACareerSiteSource: [
          { id: 'p1', market: 'cn', ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch Group', countryCode: 'CN', enabled: true, origin: 'admin', countries: [], createdBy: 'seed:2026-10-11' },
          { id: 'p2', market: 'cn', ats: 'greenhouse', boardToken: 'riotgames', companyName: 'Riot (renamed by ops)', countryCode: 'CN', enabled: false, origin: 'admin', countries: [], createdBy: 'seed:2026-10-11' },
        ],
        // That loader remembered what it had offered: `veeva` was offered and an admin removed it since.
        appConfig: [{ key: LEGACY_SEED_STATE_KEY, value: JSON.stringify({ version: '2026-10-11', offered: ['smartrecruiters:BoschGroup', 'greenhouse:riotgames', 'lever:veeva'] }) }],
      },
    });
    const res = await loadCareerSeeds(asDb(fake));
    expect(res).toMatchObject({ status: 'loaded', updated: 2, removedByAdmin: 1 });
    // One row, now read for both countries the files name, without the market marker of the old loader.
    expect(sources(fake).filter((r) => r.boardToken === 'BoschGroup')).toHaveLength(1);
    expect(find(fake, 'BoschGroup')).toMatchObject({ id: 'p1', origin: 'seed', countries: ['CN', 'TW'], countryCode: null, enabled: true });
    expect(find(fake, 'riotgames')).toMatchObject({ id: 'p2', origin: 'seed', countries: [], countryCode: null, enabled: false, companyName: 'Riot (renamed by ops)' });
    expect(sources(fake).some((r) => r.boardToken === 'veeva')).toBe(false);
    expect(await loadCareerSeeds(asDb(fake))).toMatchObject({ status: 'up_to_date' });
  });

  it('the first load keeps a mainland SmartRecruiters board an admin had added reading country=cn; later loads and other boards are left alone', async () => {
    const fake = createFakePrisma({
      seed: {
        rACareerSiteSource: [
          { id: 'a1', market: 'cn', ats: 'smartrecruiters', boardToken: 'HarborFoods', companyName: 'Harbor Foods', countryCode: 'CN', enabled: true, origin: 'admin', countries: [], createdBy: 'admin1' },
          // Already says what it is read for; a single-call board; an international one: untouched.
          { id: 'a2', market: 'cn', ats: 'smartrecruiters', boardToken: 'TwoSides', companyName: 'Two Sides', enabled: true, origin: 'admin', countries: ['CN', 'SG'], createdBy: 'admin1' },
          { id: 'a3', market: 'cn', ats: 'greenhouse', boardToken: 'globalco', companyName: 'Global Co', enabled: true, origin: 'admin', countries: [], createdBy: 'admin1' },
          { id: 'a4', market: 'intl', ats: 'smartrecruiters', boardToken: 'IntlCo', companyName: 'Intl Co', enabled: true, origin: 'admin', countries: [], createdBy: 'admin1' },
        ],
      },
    });
    expect(await loadCareerSeeds(asDb(fake), { boards: [board()] })).toMatchObject({ status: 'loaded', carriedOver: 1 });
    expect(find(fake, 'HarborFoods').countries).toEqual(['CN']);
    expect(find(fake, 'TwoSides').countries).toEqual(['CN', 'SG']);
    expect(find(fake, 'globalco').countries).toEqual([]);
    expect(find(fake, 'IntlCo').countries).toEqual([]);
    // An admin later widens it to every country: a new seed list does not narrow it again.
    find(fake, 'HarborFoods').countries = [];
    expect(await loadCareerSeeds(asDb(fake), { boards: [board(), board({ boardToken: 'newco' })] })).toMatchObject({ status: 'loaded', carriedOver: 0 });
    expect(find(fake, 'HarborFoods').countries).toEqual([]);
  });

  it('a board that discovery or an import had only proposed is taken over: the seed is its confirmation', async () => {
    const fake = createFakePrisma({
      seed: {
        rACareerSiteSource: [
          { id: 'd1', market: 'intl', ats: 'greenhouse', boardToken: 'acme', companyName: 'ACME CORP', enabled: false, origin: 'discovered', discoveredFrom: 'jsearch:1', countries: [], lastSyncedAt: new Date('2026-10-10T00:00:00Z'), lastError: 'validation:name_mismatch', failCount: 0, disabledAt: null },
          // Switched on and off again by hand: an admin's decision, not a proposal.
          { id: 'd2', market: 'intl', ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud', enabled: false, origin: 'import', countries: ['US'], disabledAt: new Date('2026-10-09T00:00:00Z') },
        ],
      },
    });
    const res = await loadCareerSeeds(asDb(fake), { boards: [board({ countries: [] }), board({ ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud' })] });
    expect(res).toMatchObject({ added: 0, updated: 1, alreadyPresent: 1 });
    expect(find(fake, 'acme')).toMatchObject({ origin: 'seed', enabled: true, companyName: 'Acme', lastError: null, nextSyncAt: null });
    expect(find(fake, 'pinecloud')).toMatchObject({ origin: 'import', enabled: false, countries: ['US'] });
  });

  it('ensureSeedCareerSources (the entry jobs-plan calls) loads the same merged list, whatever market it is given', async () => {
    const fake = createFakePrisma();
    const first = await ensureSeedCareerSources(asDb(fake), 'cn');
    expect(first).toMatchObject({ status: 'registered', added: careerSeedBoards().length, alreadyPresent: 0 });
    expect(first.version).toBe(seedHash(careerSeedBoards()));
    expect(await ensureSeedCareerSources(asDb(fake), 'intl')).toMatchObject({ status: 'up_to_date', added: 0 });
    expect(sources(fake)).toHaveLength(careerSeedBoards().length);
  });
});
