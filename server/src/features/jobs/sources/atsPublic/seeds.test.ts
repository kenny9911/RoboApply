// @vitest-environment node
//
// The three seed files of the employer boards and their loader (MKT-3D, MKT-4S;
// JI-3, JT-5, JC-4; D3). Since MKT-4S a board is in a file only because its
// live board answered scripts/board-seeds/validate.mjs: this test holds the
// files to the committed report (re-running the builder on it gives exactly
// these files), pins their shape, fails on an entry without where and when it
// was confirmed or without its measured facts, and keeps the boards the
// research notes confirmed first. It also holds the validator script to the
// server it stands beside: the same User-Agent, the same listing URLs, and a
// reading of "is this posting in mainland China / in Taiwan?" that is never
// wider than the server's own. The loader is run against the in-memory fake:
// no network, no database.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { createFakePrisma } from '../../../../test/fakePrisma.js';
import { parseLocation } from '../../geo/index.js';
import { marketOfPosting } from '../../normalize/index.js';
import { sourceUserAgent } from '../index.js';
import { connectorFor, hasPlaceholderName, smartRecruitersListUrl } from './connectors.js';
import { BOARD_TOKEN_PATTERN, PUBLIC_ATS } from './contract.js';
import { API_HOSTS, type FetchLike } from './http.js';
import {
  CAREER_SEEDS_CONFIG_KEY,
  LEGACY_SEED_STATE_KEY,
  SEED_FILE_MARKET,
  SEED_FILE_NAMES,
  careerSeedBoards,
  ensureSeedCareerSources,
  loadCareerSeeds,
  mergeSeedFiles,
  parseSeedFile,
  seedFile,
  seedFilesFor,
  seedHash,
  seedKey,
  servedSeedMarkets,
  type MergedSeedBoard,
  type SeedDb,
} from './seeds.js';
import { rememberRemovedBoard } from './removed.js';
import { MAX_RESPONSE_BYTES, sourceCoversCountry, sourceFeedsMarket } from './shared.js';
// The scripts that measured and wrote the files (plain Node, no type declarations).
import * as builder from '../../../../../../scripts/board-seeds/build-seeds.mjs';
import * as places from '../../../../../../scripts/board-seeds/places.mjs';
import * as validator from '../../../../../../scripts/board-seeds/validate.mjs';

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

/** PAR-7 item 4: the 26 boards the parity wave read through the connector with a posting in mainland China. */
const PARITY_MAINLAND_BOARDS = [
  'ashby:airwallex',
  'greenhouse:adyen',
  'greenhouse:agoda',
  'greenhouse:airbnb',
  'greenhouse:appier',
  'greenhouse:applovin',
  'greenhouse:coupang',
  'greenhouse:databricks',
  'greenhouse:epicgames',
  'greenhouse:flexport',
  'greenhouse:moloco',
  'greenhouse:mongodb',
  'greenhouse:payoneer',
  'greenhouse:riotgames',
  'greenhouse:scopely',
  'lever:veeva',
  'lever:weride',
  'smartrecruiters:AbbVie',
  'smartrecruiters:BoschGroup',
  'smartrecruiters:Canva',
  'smartrecruiters:Continental',
  'smartrecruiters:Eurofins',
  'smartrecruiters:NielsenIQ',
  'smartrecruiters:Ubisoft2',
  'smartrecruiters:Wabtec',
  'smartrecruiters:WesternDigital',
];

const SEEDS_DIR = new URL('./', import.meta.url);
const REPO = new URL('../../../../../../', import.meta.url);
const fileText = (name: string) => readFileSync(new URL(`seeds.${name}.json`, SEEDS_DIR), 'utf8');

const entry = (over: Record<string, unknown> = {}) => ({
  ats: 'greenhouse',
  boardToken: 'acme',
  companyName: 'Acme',
  countries: [],
  note: 'SYNTHETIC: a test entry, not a real confirmation',
  confirmedOn: '2026-10-11',
  ...over,
});
const facts = (over: Record<string, unknown> = {}) => ({ postings: 3, postingCountries: ['TW'], verifiedOn: '2026-10-11', verifiedBy: 'live board API', ...over });
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

  it('every entry carries what its live board answered: the day, how it was verified, a measured posting count and the countries, and a note that names the report', () => {
    for (const name of SEED_FILE_NAMES) {
      for (const b of seedFile(name).boards) {
        const at = `${name}: ${b.ats}/${b.boardToken}`;
        expect(b.verifiedBy, at).toBe('live board API');
        expect(b.verifiedOn, at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(b.confirmedOn <= b.verifiedOn!, at).toBe(true);
        expect(Number.isInteger(b.postings) && b.postings! >= 1, at).toBe(true);
        expect(Array.isArray(b.postingCountries), at).toBe(true);
        for (const c of b.postingCountries!) expect(c, at).toMatch(/^[A-Z]{2}$/);
        expect(b.note, at).toContain(`scripts/board-seeds/report-${b.verifiedOn}.json`);
        expect(b.note, at).toContain('docs/jobright-clone/market/BOARD_SEEDS.md');
        // The file's own place: a mainland entry counts mainland postings, a Taiwan entry Taiwan postings, the third neither.
        if (name === 'cn') expect(b.postingCountries, at).toEqual(['CN']);
        if (name === 'tw') expect(b.postingCountries, at).toEqual(['TW']);
        if (name === 'intl') expect(b.postingCountries!.some((c) => c === 'CN' || c === 'TW'), at).toBe(false);
      }
    }
  });

  it('nothing but a board id, a company name, counts, countries, dates and where it was confirmed is stored', () => {
    const allowed = ['ats', 'boardToken', 'companyName', 'confirmedOn', 'countries', 'note', 'postingCountries', 'postings', 'verifiedBy', 'verifiedOn'];
    for (const name of SEED_FILE_NAMES) {
      const raw = JSON.parse(fileText(name)) as { about: string; boards: Record<string, unknown>[] };
      expect(Object.keys(raw).sort(), name).toEqual(['about', 'boards']);
      for (const b of raw.boards) expect(Object.keys(b).sort(), `${name}: ${String(b.boardToken)}`).toEqual(allowed);
    }
  });

  it('every board is read on one of the four documented board APIs; no entry is a board of a source we never read', () => {
    for (const b of careerSeedBoards()) {
      const host = new URL(connectorFor(b.ats).boardUrl(b.boardToken)).hostname;
      expect(API_HOSTS as readonly string[], seedKey(b)).toContain(host);
      // MARKET_STRATEGY 1.6: the employer boards of the job boards we may not read are left out too, to leave no doubt.
      expect(`${b.boardToken} ${b.companyName}`, seedKey(b)).not.toMatch(/linkedin|indeed|glassdoor|yourator|cakeresume|zhipin|zhaopin|liepin|51job|lagou/i);
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
    expect(() => parseSeedFile(file(entry({ ats: 'lever_eu' })))).toThrow(/unknown job-board system/);
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

  it('parseSeedFile takes the measured facts together or not at all, and refuses a count that was not measured', () => {
    expect(parseSeedFile(file(entry(facts({ postingCountries: ['US', 'DE'] })))).boards[0]).toMatchObject({ postings: 3, postingCountries: ['DE', 'US'], verifiedOn: '2026-10-11', verifiedBy: 'live board API' });
    // An entry of before the validation (no facts) still parses; seeds.test.ts is what refuses it in the committed files.
    expect(parseSeedFile(file(entry())).boards[0]).not.toHaveProperty('postings');
    expect(() => parseSeedFile(file(entry({ postings: 3 })))).toThrow(/come together/);
    expect(() => parseSeedFile(file(entry(facts({ verifiedBy: undefined }))))).toThrow(/come together/);
    expect(() => parseSeedFile(file(entry(facts({ postings: 0 }))))).toThrow(/measured posting count/);
    expect(() => parseSeedFile(file(entry(facts({ postings: 2.5 }))))).toThrow(/measured posting count/);
    expect(() => parseSeedFile(file(entry(facts({ postings: '12' }))))).toThrow(/measured posting count/);
    expect(() => parseSeedFile(file(entry(facts({ postingCountries: ['tw'] }))))).toThrow(/postingCountries/);
    expect(() => parseSeedFile(file(entry(facts({ postingCountries: ['TW', 'TW'] }))))).toThrow(/postingCountries/);
    expect(() => parseSeedFile(file(entry(facts({ verifiedOn: 'yesterday' }))))).toThrow(/when the live board answered/);
    expect(() => parseSeedFile(file(entry(facts({ verifiedBy: ' ' }))))).toThrow(/how it was verified/);
  });

  it('Taiwan: the 14 boards the note confirmed are all still there, each re-read with a Taiwan posting; mainland: the 26 boards of the parity wave likewise', () => {
    const tw = seedFile('tw').boards;
    for (const key of TAIWAN_BOARDS) {
      const b = tw.find((x) => seedKey(x) === key);
      expect(b, key).toBeTruthy();
      expect(b!.note, key).toContain('JOB_SOURCES_TW.md');
      expect(b!.note, key).toContain('; re-read ');
    }
    const cn = seedFile('cn').boards;
    for (const key of PARITY_MAINLAND_BOARDS) {
      const b = cn.find((x) => seedKey(x) === key);
      expect(b, key).toBeTruthy();
      expect(b!.note, key).toContain('PAR-7');
      expect(b!.note, key).toContain('; re-read ');
    }
    expect(cn.filter((b) => b.note.includes('PAR-7'))).toHaveLength(26);
    expect(cn.find((b) => b.boardToken === 'BoschGroup')).toMatchObject({ ats: 'smartrecruiters', countries: ['CN'] });
    expect(cn.find((b) => b.boardToken === 'Ubisoft2')).toMatchObject({ ats: 'smartrecruiters', countries: ['CN'] });
    // The international backbone the first note read end to end is still in the international file.
    const intl = seedFile('intl').boards.map(seedKey);
    expect(intl).toContain('greenhouse:stripe');
    expect(intl).toContain('ashby:ramp');
  });

  it('the bars of the strategy and of MKT-4S hold on the validation date: 50 boards with a mainland posting, 30 with a Taiwan posting, 400 boards and 20,000 postings elsewhere', () => {
    // A refresh that falls under a bar has to say so in docs/jobright-clone/market/BOARD_SEEDS.md and change this line on purpose.
    const total = (name: 'cn' | 'tw' | 'intl') => seedFile(name).boards.reduce((n, b) => n + b.postings!, 0);
    expect(seedFile('cn').boards.length).toBeGreaterThanOrEqual(50); // MARKET_STRATEGY 1.4: before GoApply's production launch
    expect(seedFile('tw').boards.length).toBeGreaterThanOrEqual(30);
    expect(seedFile('intl').boards.length).toBeGreaterThanOrEqual(400);
    expect(total('intl')).toBeGreaterThanOrEqual(20_000);
    expect(total('cn')).toBeGreaterThan(0);
    expect(total('tw')).toBeGreaterThan(0);
  });

  it('single-listing boards are read whole (no countries); a SmartRecruiters board names CN in the mainland file and TW in the Taiwan file and is read whole from the international one', () => {
    for (const name of SEED_FILE_NAMES) {
      for (const b of seedFile(name).boards) {
        const at = `${name}: ${b.ats}/${b.boardToken}`;
        if (b.ats !== 'smartrecruiters' || name === 'intl') expect(b.countries, at).toEqual([]);
        else expect(b.countries, at).toEqual([name === 'cn' ? 'CN' : 'TW']);
      }
    }
    const intl = new Set(seedFile('intl').boards.map(seedKey));
    for (const b of careerSeedBoards()) {
      if (b.ats !== 'smartrecruiters') expect(b.countries, seedKey(b)).toEqual([]);
      // Named by the international file: the whole board, once, without a filter. Else exactly the countries of its files.
      else if (intl.has(seedKey(b))) expect(b.countries, seedKey(b)).toEqual([]);
      else expect(b.countries, seedKey(b)).toEqual(b.files.map((f) => (f === 'cn' ? 'CN' : 'TW')).sort());
    }
    // A SmartRecruiters board the international file reads whole is at most 1,000 postings long (ten listing requests a read).
    for (const b of seedFile('intl').boards) if (b.ats === 'smartrecruiters') expect(b.postings!, b.boardToken).toBeLessThanOrEqual(builder.DEFAULT_LIMITS.srMax);
  });

  it('merged by (ats, boardToken): one entry per board; BoschGroup is ONE source read for exactly TW and CN', () => {
    const merged = careerSeedBoards();
    expect(new Set(merged.map(seedKey)).size).toBe(merged.length);
    const named = SEED_FILE_NAMES.flatMap((name) => seedFile(name).boards.map(seedKey));
    expect(merged).toHaveLength(new Set(named).size);
    expect(merged.length).toBeLessThan(named.length); // boards with postings in more than one place are in more than one file
    const bosch = merged.filter((b) => b.boardToken === 'BoschGroup');
    expect(bosch).toHaveLength(1);
    expect(bosch[0]).toMatchObject({ ats: 'smartrecruiters', countries: ['CN', 'TW'], files: ['cn', 'tw'], postingCountries: ['CN', 'TW'] });
    expect(bosch[0]!.note).toContain('PAR-7');
    expect(bosch[0]!.note).toContain('JOB_SOURCES_TW.md');
    expect(merged.find((b) => seedKey(b) === 'greenhouse:stripe')).toMatchObject({ countries: [], files: ['intl', 'tw'] });
    // Every Taiwan board covers TW; every mainland board feeds GoApply; every board of the third file feeds RoboApply.
    for (const key of TAIWAN_BOARDS) expect(sourceCoversCountry(merged.find((b) => seedKey(b) === key)!, 'TW'), key).toBe(true);
    for (const b of seedFile('tw').boards) expect(sourceCoversCountry(merged.find((m) => seedKey(m) === seedKey(b))!, 'TW'), seedKey(b)).toBe(true);
    for (const b of seedFile('cn').boards) expect(sourceFeedsMarket(merged.find((m) => seedKey(m) === seedKey(b))!, 'cn'), seedKey(b)).toBe(true);
    for (const b of seedFile('intl').boards) expect(sourceFeedsMarket(merged.find((m) => seedKey(m) === seedKey(b))!, 'intl'), seedKey(b)).toBe(true);
    // The measured facts are put together: a board's postings are the sum over its files.
    for (const m of merged) {
      const parts = SEED_FILE_NAMES.map((name) => seedFile(name).boards.find((b) => seedKey(b) === seedKey(m))).filter((b) => !!b);
      expect(m.postings, seedKey(m)).toBe(parts.reduce((n, b) => n + b!.postings!, 0));
      expect(m.verifiedBy, seedKey(m)).toBe('live board API');
    }
  });

  it('mergeSeedFiles: countries are united and an empty list wins; a real name replaces a board id standing in for one; counts add up', () => {
    const merged = mergeSeedFiles({
      cn: parseSeedFile(file(entry({ ats: 'smartrecruiters', boardToken: 'Harbor', companyName: 'Harbor', countries: ['CN'], ...facts({ postings: 7, postingCountries: ['CN'] }) }), entry({ boardToken: 'acme', countries: ['CN'] }))),
      tw: parseSeedFile(
        file(entry({ ats: 'smartrecruiters', boardToken: 'Harbor', companyName: 'Harbor Foods', countries: ['TW'], confirmedOn: '2026-10-12', ...facts({ postings: 2, postingCountries: ['TW'], verifiedOn: '2026-10-12' }) }), entry({ boardToken: 'acme', countries: [] })),
      ),
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ boardToken: 'Harbor', companyName: 'Harbor Foods', countries: ['CN', 'TW'], files: ['cn', 'tw'], confirmedOn: '2026-10-12', postings: 9, postingCountries: ['CN', 'TW'], verifiedOn: '2026-10-12', verifiedBy: 'live board API' });
    expect(merged[1]).toMatchObject({ boardToken: 'acme', countries: [], files: ['cn', 'tw'] });
    expect(merged[1]).not.toHaveProperty('postings');
  });

  it('seedHash changes with a board, a name or a country, and not with the order or with the measured counts', () => {
    const a = entry();
    const b = entry({ boardToken: 'other' });
    const hash = seedHash([a, b] as never);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(seedHash([b, a] as never)).toBe(hash);
    expect(seedHash([a] as never)).not.toBe(hash);
    expect(seedHash([a, { ...b, companyName: 'Other' }] as never)).not.toBe(hash);
    expect(seedHash([a, { ...b, countries: ['TW'] }] as never)).not.toBe(hash);
    // A refresh that only moves the counts and the day loads nothing on a deployment.
    expect(seedHash([a, { ...b, ...facts({ postings: 99, verifiedOn: '2027-01-01' }) }] as never)).toBe(hash);
  });
});

// ── Which files a deployment loads (MKT-4S) ──────────────────────────────

describe('a deployment loads the seed files of the markets it serves', () => {
  it('the mainland market has the mainland file; the international market the international and the Taiwan file; both markets all three', () => {
    expect(SEED_FILE_MARKET).toEqual({ cn: 'cn', intl: 'intl', tw: 'intl' });
    expect(seedFilesFor(['cn'])).toEqual(['cn']);
    expect(seedFilesFor(['intl'])).toEqual(['intl', 'tw']);
    expect(seedFilesFor(['intl', 'cn'])).toEqual(['cn', 'intl', 'tw']);
    expect(seedFilesFor(['cn', 'intl'])).toEqual(['cn', 'intl', 'tw']);
    expect(seedFilesFor([])).toEqual([]);
  });

  it('the markets are those of the brands the deployment serves: BRAND_LOCK, else ALLOWED_BRANDS, else both', () => {
    expect(servedSeedMarkets({})).toEqual(['intl', 'cn']);
    // The mainland kit (deploy/cn): GoApply alone.
    expect(servedSeedMarkets({ ALLOWED_BRANDS: 'goapply' })).toEqual(['cn']);
    expect(servedSeedMarkets({ ALLOWED_BRANDS: 'roboapply' })).toEqual(['intl']);
    expect(servedSeedMarkets({ ALLOWED_BRANDS: 'goapply,roboapply' }).sort()).toEqual(['cn', 'intl']);
    expect(servedSeedMarkets({ BRAND_LOCK: 'goapply', ALLOWED_BRANDS: 'roboapply' })).toEqual(['cn']);
    // A value that names no brand closes the deployment to the default brand: never the mainland list by accident.
    expect(servedSeedMarkets({ ALLOWED_BRANDS: 'gopply' })).toEqual(['intl']);
  });

  it('a mainland-only deployment is offered exactly the boards of seeds.cn.json, each read as that file says; none it would read only to drop every posting', () => {
    const mainland = careerSeedBoards(['cn']);
    const file = seedFile('cn').boards;
    expect(mainland.map(seedKey).sort()).toEqual(file.map(seedKey).sort());
    expect(mainland.length).toBeLessThan(careerSeedBoards().length / 5);
    for (const b of mainland) {
      expect(b.files, seedKey(b)).toEqual(['cn']);
      // The file's own measure: a mainland posting on the validation date.
      expect(b.postingCountries, seedKey(b)).toEqual(['CN']);
      expect(sourceFeedsMarket(b, 'cn'), seedKey(b)).toBe(true);
      // A SmartRecruiters board is asked for CN alone, whatever the other files read it for.
      expect(b.countries, seedKey(b)).toEqual(b.ats === 'smartrecruiters' ? ['CN'] : []);
    }
    // The same board on a deployment that serves both brands: one row, read for everything its files name.
    const both = new Map(careerSeedBoards().map((b) => [seedKey(b), b]));
    expect(both.get('smartrecruiters:BoschGroup')!.countries).toEqual(['CN', 'TW']);
    expect(mainland.find((b) => seedKey(b) === 'smartrecruiters:BoschGroup')!.countries).toEqual(['CN']);
    expect(both.get('smartrecruiters:Ubisoft2')!.countries).toEqual([]);
    expect(mainland.find((b) => seedKey(b) === 'smartrecruiters:Ubisoft2')!.countries).toEqual(['CN']);
  });

  it('an international-only deployment is offered the international and the Taiwan file, and asks no SmartRecruiters board for its mainland postings', () => {
    const intl = careerSeedBoards(['intl']);
    const named = new Set([...seedFile('intl').boards, ...seedFile('tw').boards].map(seedKey));
    expect(intl.map(seedKey).sort()).toEqual([...named].sort());
    for (const b of intl) {
      expect(b.files.includes('cn'), seedKey(b)).toBe(false);
      expect(b.countries.includes('CN'), seedKey(b)).toBe(false);
      expect(sourceFeedsMarket(b, 'intl'), seedKey(b)).toBe(true);
    }
    expect(intl.find((b) => seedKey(b) === 'smartrecruiters:BoschGroup')!.countries).toEqual(['TW']);
    // Both markets: every board of every file, and the default.
    const all = new Set(SEED_FILE_NAMES.flatMap((name) => seedFile(name).boards.map(seedKey)));
    expect(careerSeedBoards(['intl', 'cn']).map(seedKey).sort()).toEqual([...all].sort());
    expect(careerSeedBoards().map(seedKey).sort()).toEqual([...all].sort());
    expect(careerSeedBoards([])).toEqual([]);
  });
});

// ── The files are what the report says (MKT-4S) ──────────────────────────

describe('the seed files and the validation report', () => {
  const report = () => JSON.parse(readFileSync(new URL(`scripts/board-seeds/report-${seedFile('intl').boards[0]!.verifiedOn}.json`, REPO), 'utf8')) as { date: string; requests: number; results: Array<Record<string, unknown>>; summary: Record<string, { open: number }> };

  it('re-running the builder on the committed report gives exactly the committed files: nothing but the report puts a board into a list', () => {
    const existing = Object.fromEntries(SEED_FILE_NAMES.map((name) => [name, JSON.parse(fileText(name))]));
    const plan = builder.planSeeds({ report: report(), existing });
    for (const name of SEED_FILE_NAMES) expect(builder.renderSeedFile(plan.files[name]), `seeds.${name}.json`).toBe(fileText(name));
    expect(plan.keptAsTheyWere).toEqual([]);
    expect(plan.takenOut).toEqual([]);
    expect(builder.SEEDABLE_ATS).toEqual([...PUBLIC_ATS]);
  });

  it('every seeded board is a board the report calls valid, under the name the report holds, and the report has no open candidate', () => {
    const r = report();
    expect(r.summary.all!.open).toBe(0);
    const valid = new Map<string, Record<string, unknown>>();
    for (const x of r.results) if (x.valid === true) valid.set(`${String(x.ats)}:${String(x.token)}`, x);
    for (const b of careerSeedBoards()) {
      const x = valid.get(seedKey(b));
      expect(x, seedKey(b)).toBeTruthy();
      // What the board stated; else the employer its board id spells or a document confirms; else the board id itself.
      expect(b.companyName, seedKey(b)).toBe(typeof x!.companyName === 'string' ? x!.companyName : x!.nameCheck === 'board_id_only' ? x!.token : x!.employer);
      expect(b.verifiedOn, seedKey(b)).toBe(r.date);
    }
  });

  it('no entry carries a name nothing confirmed: a board id listed for an employer names the document that confirms it, and a board without one is listed under its board id', () => {
    const r = report();
    const merged = new Map(careerSeedBoards().map((b) => [seedKey(b), b]));
    const sourced: string[] = [];
    const unnamed: string[] = [];
    for (const x of r.results) {
      if (x.valid !== true) continue;
      const key = `${String(x.ats)}:${String(x.token)}`;
      // Where the answer stated a company, the answer is the confirmation.
      if (typeof x.companyName === 'string') {
        expect(['stated_name', 'stated_name_alias'], key).toContain(x.nameCheck);
        continue;
      }
      expect(['board_id_is_name', 'board_id_alias', 'board_id_only'], key).toContain(x.nameCheck);
      if (x.nameCheck === 'board_id_is_name') expect(validator.normalizeToken(x.token), key).toBe(validator.normalizeName(x.employer));
      if (x.nameCheck === 'board_id_alias') {
        sourced.push(key);
        // The document exists, names this board id and this employer, and the entry's note says so.
        const file = String(x.nameSource).split(/\s/)[0]!;
        expect(file, key).toMatch(/^docs\/.+\.md$/);
        expect(existsSync(new URL(file, REPO)), `${key}: ${file}`).toBe(true);
        const text = readFileSync(new URL(file, REPO), 'utf8');
        expect(text, key).toContain(`\`${String(x.token)}\``);
        expect(text, key).toContain(String(x.employer));
        expect(merged.get(key)!.note, key).toContain(`${String(x.nameSource)} confirms this board id for this employer`);
      }
      if (x.nameCheck === 'board_id_only') {
        unnamed.push(key);
        const b = merged.get(key);
        if (!b) continue;
        // The server's own placeholder: a later list, the board or an admin can name it; the guess is stored nowhere.
        expect(hasPlaceholderName(b), key).toBe(true);
        expect(b.note, key).toContain('no document confirms whose board this is');
        for (const name of SEED_FILE_NAMES) expect(fileText(name), key).not.toContain(`"${String(x.employer)}"`);
      }
    }
    expect(sourced.sort()).toEqual(['ashby:kraken.com', 'lever:crypto', 'lever:shopback-2']);
    // One live board is listed without a name. A change here is a decision: say it in docs/jobright-clone/market/BOARD_SEEDS.md.
    expect(unnamed).toEqual(['lever:octoenergy']);
  });

  it('a SmartRecruiters board of the mainland or the Taiwan file was asked the way the server reads it for that file (the API\'s country filter), and its count is that answer\'s', () => {
    const r = report();
    for (const name of ['cn', 'tw'] as const) {
      const code = name === 'cn' ? 'CN' : 'TW';
      const entries = seedFile(name).boards.filter((b) => b.ats === 'smartrecruiters');
      expect(entries.length, name).toBeGreaterThan(0);
      for (const b of entries) {
        const answers = r.results.filter((x) => x.ats === 'smartrecruiters' && x.token === b.boardToken && JSON.stringify(x.countries) === JSON.stringify([code]));
        expect(answers, `${name}: ${b.boardToken}`).toHaveLength(1);
        expect(answers[0], `${name}: ${b.boardToken}`).toMatchObject({ valid: true, companyName: b.companyName });
        expect((answers[0]!.byCountry as Record<string, number>)[code], `${name}: ${b.boardToken}`).toBe(b.postings);
      }
    }
  });

  it('the builder\'s size caps leave a quarter of the connector\'s limit free at the density of the one answer each was calibrated on, and no seeded one-answer board is above its cap', () => {
    // A Greenhouse or an Ashby board comes in ONE answer; one over MAX_RESPONSE_BYTES is refused, and three refusals switch the source off.
    // This holds the COUNT caps at the two calibration densities only. It is not a bound on a seeded board's size:
    // `greenhouse/coupang` measured 11,048,005 characters for 673 postings (70% of the limit; M4 cross-review). The
    // assertion on recorded answer sizes that replaces this one is MKT-5B's (requests/waveM4-carryover.md, MKT-5B.1).
    const { greenhouseMax, ashbyMax } = builder.DEFAULT_LIMITS;
    expect(greenhouseMax * builder.MEASURED_CHARS_PER_POSTING.greenhouse).toBeLessThanOrEqual(0.75 * MAX_RESPONSE_BYTES);
    expect(ashbyMax * builder.MEASURED_CHARS_PER_POSTING.ashby).toBeLessThanOrEqual(0.75 * MAX_RESPONSE_BYTES);
    const listed = new Map<string, number>();
    for (const x of report().results) if (x.valid === true && !x.countries) listed.set(`${String(x.ats)}:${String(x.token)}`, Number(x.postings));
    for (const b of careerSeedBoards()) {
      if (b.ats === 'greenhouse') expect(listed.get(seedKey(b)), seedKey(b)).toBeLessThanOrEqual(greenhouseMax);
      if (b.ats === 'ashby') expect(listed.get(seedKey(b)), seedKey(b)).toBeLessThanOrEqual(ashbyMax);
    }
    // The board that answered with 90% of the limit on the validation date is in no file until the limit is raised.
    expect(careerSeedBoards().some((b) => seedKey(b) === 'ashby:openai')).toBe(false);
  });

  it('the report holds counts, never a posting: every key of every result is one of the facts it may hold', () => {
    const allowed = new Set(['ats', 'token', 'employer', 'countries', 'valid', 'reason', 'nameCheck', 'nameSource', 'companyName', 'postings', 'read', 'complete', 'byCountry', 'unplaced', 'mainland', 'taiwan', 'elsewhere', 'requests']);
    for (const x of report().results) for (const key of Object.keys(x)) expect(allowed.has(key), `${String(x.ats)}:${String(x.token)} ${key}`).toBe(true);
  });
});

// ── The validator beside the server (MKT-4S) ─────────────────────────────

describe('scripts/board-seeds/validate.mjs asks as the server does', () => {
  it('sends the same identifying User-Agent as the board sync of the international brand', () => {
    for (const env of [{}, { JOB_SOURCES_CONTACT: 'mailto:jobs@example.invalid' }, { JOB_SOURCES_CONTACT: ' https://example.invalid/bots (ops)\nsecond line' }, { JOB_SOURCES_CONTACT: 'x'.repeat(400) }, { CN_JOB_SOURCES_CONTACT: 'mailto:cn@example.invalid' }]) {
      expect(validator.userAgent(env), JSON.stringify(env)).toBe(sourceUserAgent('intl', env));
    }
  });

  it('asks only the hosts the connectors ask (plus the Lever EU host, which is reported and never seeded), with the same board-id pattern and size limit', () => {
    expect([...validator.ALLOWED_HOSTS].sort()).toEqual([...API_HOSTS, 'api.eu.lever.co'].sort());
    expect(validator.BOARD_TOKEN_PATTERN.source).toBe(BOARD_TOKEN_PATTERN.source);
    expect(validator.MAX_RESPONSE_CHARS).toBe(MAX_RESPONSE_BYTES);
    expect(validator.CANDIDATE_ATS.filter((a: string) => a !== 'lever_eu')).toEqual([...PUBLIC_ATS]);
  });

  it('reads the listing the connector reads for a list-only check: the same first request for each job-board system', async () => {
    const first = async (ats: (typeof PUBLIC_ATS)[number], token: string, countries: string[] = []) => {
      const urls: string[] = [];
      const fetch: FetchLike = async (url) => {
        urls.push(url);
        return { ok: true, status: 200, text: async () => JSON.stringify(ats === 'lever' ? [] : ats === 'smartrecruiters' ? { totalFound: 0, content: [] } : { jobs: [] }) };
      };
      await connectorFor(ats).read({ ats, boardToken: token, companyName: 'Acme', countryCode: null, countries }, { now: new Date('2026-10-11T00:00:00Z'), fetch, env: {} }, { listOnly: true, firstPage: true });
      return urls[0]!;
    };
    expect(validator.LISTING_URL.greenhouse('acme')).toBe(await first('greenhouse', 'acme'));
    expect(validator.LISTING_URL.lever('acme', 0)).toBe(await first('lever', 'acme'));
    expect(validator.LISTING_URL.smartrecruiters('Acme', 0, null)).toBe(await first('smartrecruiters', 'Acme'));
    expect(validator.LISTING_URL.smartrecruiters('Acme', 0, 'CN')).toBe(await first('smartrecruiters', 'Acme', ['CN']));
    expect(validator.LISTING_URL.smartrecruiters('Acme', 2, 'TW')).toBe(smartRecruitersListUrl('Acme', 200, 'TW'));
    // Ashby: the connector also asks for the pay summary; the validator reads no pay, so it leaves that parameter out.
    expect(`${validator.LISTING_URL.ashby('acme')}?includeCompensation=true`).toBe(await first('ashby', 'acme'));
  });
});

describe('scripts/board-seeds/places.mjs is never wider than the server about mainland China and Taiwan', () => {
  // The words job boards put into a location line, and the ways they join them. SYNTHETIC lines, built here.
  const WORDS = [
    'Shanghai', 'Beijing', 'Shenzhen', 'Canton', 'Suzhou', 'China', 'CN', 'PRC', 'Mainland China', '上海', '中国', '深圳',
    'Taipei', 'Hsinchu', 'Taiwan', 'TW', '台北', '台灣', 'New Taipei City', 'Kaohsiung', 'Xinyi District', 'Taiwan, Province of China',
    'Hong Kong', 'HK', 'Macau', '香港', 'Kowloon', 'Singapore', 'SG', 'Tokyo', 'Japan', 'Seoul', 'Korea', 'United States', 'US', 'London', 'UK',
    'CA', 'MA', 'OH', 'CT 06019', 'ON', 'TX', 'IN', 'DE', 'CH', 'Toronto', 'Paris', 'Berlin', 'Zurich', 'Michigan', 'Georgia',
    'Remote', 'Hybrid', 'APAC', 'Asia Pacific', 'Greater China', 'Asia', 'EMEA', 'Office', 'HQ', 'Home based', 'Guangdong', 'Jiangsu', 'Shaanxi',
    'Greater Shanghai Area', 'Pudong', 'R&D Center', 'Building 5', '2 locations',
  ];
  const JOINS = [', ', ' - ', '-', ' / ', '/', '; ', ' or ', ' ', ' | ', ': ', ' & ', ' and ', ' – '];
  const lines = () => {
    const out = new Set<string>();
    for (const a of WORDS) {
      out.add(a);
      for (const b of WORDS) {
        for (const j of JOINS) out.add(`${a}${j}${b}`);
        out.add(`${a} (${b})`);
      }
    }
    for (const a of ['Shanghai', 'Taipei', 'China', 'Taiwan', 'Canton', 'Hong Kong', 'CH', 'US', 'HK', 'TW', 'CN']) {
      for (const b of WORDS) for (const c of ['China', 'Taiwan', 'United States', 'Singapore', 'CA', 'Remote', 'APAC', 'Guangdong', 'Shanghai', 'Taipei', 'HQ']) out.add(`${a}, ${b}, ${c}`);
    }
    return [...out];
  };

  it('a line this file places in mainland China, the server routes to the mainland market; a line it places in Taiwan, the server places in Taiwan', () => {
    const all = lines();
    expect(all.length).toBeGreaterThan(50_000);
    const wider: string[] = [];
    let mainland = 0;
    let taiwan = 0;
    for (const line of all) {
      const mine = places.countryOfLocation(line);
      if (mine !== 'CN' && mine !== 'TW') continue;
      if (mine === 'CN') {
        mainland += 1;
        if (marketOfPosting({ location: line, locations: [line] } as never) !== 'cn') wider.push(`CN ${line}`);
      } else {
        taiwan += 1;
        if (parseLocation(line, {}).country !== 'TW') wider.push(`TW ${line}`);
      }
    }
    expect(wider).toEqual([]);
    // The rule is narrow, not empty: it does place lines.
    expect(mainland).toBeGreaterThan(300);
    expect(taiwan).toBeGreaterThan(300);
  });

  it('with a country the board states for the posting (Lever, Ashby, SmartRecruiters) it is not wider either', () => {
    // The server weighs the stated country against the line; the script names CN / TW only when they do not disagree.
    const some = lines().filter((_, i) => i % 3 === 0);
    const wider: string[] = [];
    let named = 0;
    for (const stated of ['CN', 'TW', 'US', 'HK', 'SG']) {
      for (const line of ['', ...some]) {
        const mine = places.countryOfStatedLocation(line, stated);
        if (mine !== 'CN' && mine !== 'TW') continue;
        named += 1;
        const market = marketOfPosting({ location: line || null, locations: line ? [line] : [], locationCountry: stated, locationCountryEstimated: false } as never);
        if (mine === 'CN' ? market !== 'cn' : market !== 'intl' || parseLocation(line, { country: stated }).country !== 'TW') wider.push(`${mine} stated ${stated}: ${line}`);
      }
    }
    expect(wider).toEqual([]);
    expect(named).toBeGreaterThan(1_000);
  });

  it('the plain cases agree with the server in both directions', () => {
    for (const line of ['Shanghai', 'Shanghai, China', 'Shenzhen, Guangdong, China', 'Remote - China', 'CH - Shanghai, China', 'Kunshan, China', '上海', 'Beijing; Shanghai; Shenzhen', 'China (CN)']) {
      expect(places.countryOfLocation(line), line).toBe('CN');
      expect(marketOfPosting({ location: line, locations: [line] } as never), line).toBe('cn');
    }
    for (const line of ['Taipei', 'Taipei, Taiwan', 'Hsinchu, Taiwan', 'Taiwan (Remote)', 'Home based - Asia Pacific, Taipei', '台北', 'Zhubei, Hsinchu County, Taiwan']) {
      expect(places.countryOfLocation(line), line).toBe('TW');
      expect(parseLocation(line, {}).country, line).toBe('TW');
      expect(marketOfPosting({ location: line, locations: [line] } as never), line).toBe('intl');
    }
    for (const line of ['Hong Kong', 'Hong Kong, China', 'Macau', '110 Albany Turnpike, Canton, CT 06019', 'Canton, MA', 'Singapore', 'Remote', 'San Francisco, CA']) {
      expect(places.countryOfLocation(line), line).not.toBe('CN');
      expect(marketOfPosting({ location: line, locations: [line] } as never), line).toBe('intl');
    }
  });

  it('reads the same city table as the server, from the server\'s own file', () => {
    expect(places.gazetteerInfo()).toMatchObject({ serverTable: true });
    expect(places.gazetteerInfo().serverCities).toBeGreaterThan(200);
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
    // A deployment that serves both brands (no BRAND_LOCK, no ALLOWED_BRANDS): all three files.
    const res = await loadCareerSeeds(asDb(fake), { env: {} });
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
    // A long SmartRecruiters board the mainland and the Taiwan file name is read for those two countries alone;
    // one the international file names too is read whole.
    expect(find(fake, 'AbbVie').countries).toEqual(['CN', 'TW']);
    expect(find(fake, 'Ubisoft2').countries).toEqual([]);
    // The stored row holds what the loader needs and none of the measured facts (there is no column for them).
    for (const r of rows) for (const fact of ['postings', 'postingCountries', 'verifiedOn', 'verifiedBy', 'note', 'confirmedOn', 'files']) expect(r, `${String(r.boardToken)} ${fact}`).not.toHaveProperty(fact);
    // Due at once: never read, no next time set, no country tag standing in for a market.
    expect(rows.every((r) => r.nextSyncAt == null && r.lastSyncedAt == null && r.countryCode == null)).toBe(true);
    // The console a board is shown under is display only: GoApply's when only the mainland file names it.
    for (const m of merged) expect(find(fake, m.boardToken).market, seedKey(m)).toBe(m.files.length === 1 && m.files[0] === 'cn' ? 'cn' : 'intl');
    expect(find(fake, 'BoschGroup').market).toBe('intl');
    expect(find(fake, 'ramp').market).toBe('intl');
  });

  it('a board only the mainland file names is shown under GoApply\'s console; any other under RoboApply\'s', async () => {
    const fake = createFakePrisma();
    await loadCareerSeeds(asDb(fake), {
      boards: [
        board({ ats: 'smartrecruiters', boardToken: 'OnlyMainland', companyName: 'Only Mainland', countries: ['CN'], files: ['cn'] }),
        board({ ats: 'smartrecruiters', boardToken: 'BothFiles', companyName: 'Both Files', countries: ['CN', 'TW'], files: ['cn', 'tw'] }),
        board({ boardToken: 'whole', files: ['cn', 'intl'] }),
      ],
    });
    expect(find(fake, 'OnlyMainland')).toMatchObject({ market: 'cn', countries: ['CN'] });
    expect(find(fake, 'BothFiles')).toMatchObject({ market: 'intl', countries: ['CN', 'TW'] });
    expect(find(fake, 'whole')).toMatchObject({ market: 'intl', countries: [] });
  });

  it('the mainland stack (GoApply alone, its own database) gets the boards of seeds.cn.json and no other: nothing it would read and then drop', async () => {
    const fake = createFakePrisma();
    const res = await loadCareerSeeds(asDb(fake), { env: { ALLOWED_BRANDS: 'goapply' } });
    const file = seedFile('cn').boards;
    expect(res).toMatchObject({ status: 'loaded', boards: file.length, added: file.length });
    const rows = sources(fake);
    expect(rows.map((r) => `${r.ats}:${r.boardToken}`).sort()).toEqual(file.map(seedKey).sort());
    for (const r of rows) {
      const at = `${r.ats}:${r.boardToken}`;
      expect(r, at).toMatchObject({ market: 'cn', origin: 'seed', enabled: true });
      expect(sourceFeedsMarket(r as { countries: string[] }, 'cn'), at).toBe(true);
      expect(r.countries, at).toEqual(r.ats === 'smartrecruiters' ? ['CN'] : []);
    }
    // The state is that of the list this deployment loads: its hash, and only its boards as offered.
    const state = JSON.parse(String(fake.$rows('appConfig').find((r) => r.key === CAREER_SEEDS_CONFIG_KEY)!.value)) as { hash: string; offered: string[] };
    expect(state.hash).toBe(seedHash(careerSeedBoards(['cn'])));
    expect(state.offered).toEqual(file.map(seedKey).sort());
    expect(await loadCareerSeeds(asDb(fake), { env: { ALLOWED_BRANDS: 'goapply' } })).toMatchObject({ status: 'up_to_date', added: 0 });
    expect(await loadCareerSeeds(asDb(fake), { markets: ['cn'] })).toMatchObject({ status: 'up_to_date', added: 0 });
    // Both brands on one database: every board of the three files.
    const both = createFakePrisma();
    expect(await loadCareerSeeds(asDb(both), { markets: ['intl', 'cn'] })).toMatchObject({ added: careerSeedBoards().length });
    expect(careerSeedBoards().length).toBeGreaterThan(file.length * 5);
    // RoboApply alone: the international and the Taiwan file.
    const intl = createFakePrisma();
    expect(await loadCareerSeeds(asDb(intl), { env: { ALLOWED_BRANDS: 'roboapply' } })).toMatchObject({ added: careerSeedBoards(['intl']).length });
    expect(sources(intl).every((r) => r.market === 'intl' && !(r.countries as string[]).includes('CN'))).toBe(true);
  });

  it('the day a deployment also serves the mainland, its list grows by the mainland file: the boards are read for CN as well, none is added twice', async () => {
    const fake = createFakePrisma();
    await loadCareerSeeds(asDb(fake), { markets: ['intl'] });
    const before = sources(fake).length;
    expect(find(fake, 'BoschGroup').countries).toEqual(['TW']);
    const res = await loadCareerSeeds(asDb(fake), { markets: ['intl', 'cn'] });
    expect(res.status).toBe('loaded');
    expect(sources(fake)).toHaveLength(before + res.added);
    expect(sources(fake)).toHaveLength(careerSeedBoards().length);
    expect(find(fake, 'BoschGroup').countries).toEqual(['CN', 'TW']);
    expect(new Set(sources(fake).map((r) => `${r.ats}:${r.boardToken}`)).size).toBe(sources(fake).length);
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

  it('a seeded board that still carries its board id as its name gets the name the list now knows; a name an admin gave, and a name the list does not know, stay', async () => {
    const fake = createFakePrisma();
    // An earlier list knew no name for these three boards (Lever and Ashby state none): each was seeded under its board id.
    const v1 = ['harborline', 'pinecloud', 'quietmill'].map((boardToken) => board({ ats: 'lever', boardToken, companyName: boardToken }));
    await loadCareerSeeds(asDb(fake), { boards: [...v1, board()] });
    Object.assign(find(fake, 'pinecloud'), { companyName: 'Pine Cloud (ops)' });
    Object.assign(find(fake, 'acme'), { companyName: 'Acme Robotics (ops)' });
    // The new list knows two of the names, renames acme, and still has none for quietmill.
    const v2 = [
      board({ ats: 'lever', boardToken: 'harborline', companyName: 'Harbor Line' }),
      board({ ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud' }),
      v1[2]!,
      board({ companyName: 'Acme Corp' }),
    ];
    const res = await loadCareerSeeds(asDb(fake), { boards: v2 });
    expect(res).toMatchObject({ status: 'loaded', added: 0, updated: 1, alreadyPresent: 0 });
    expect(find(fake, 'harborline')).toMatchObject({ companyName: 'Harbor Line', origin: 'seed', enabled: true });
    expect(find(fake, 'pinecloud').companyName).toBe('Pine Cloud (ops)');
    expect(find(fake, 'acme').companyName).toBe('Acme Robotics (ops)');
    expect(find(fake, 'quietmill').companyName).toBe('quietmill');
    // Switched off by an admin: still off, and the placeholder is still replaced (a name was never the admin's).
    const off = createFakePrisma();
    await loadCareerSeeds(asDb(off), { boards: [v1[0]!] });
    Object.assign(find(off, 'harborline'), { enabled: false, disabledAt: new Date('2026-10-12T00:00:00Z') });
    await loadCareerSeeds(asDb(off), { boards: [v2[0]!] });
    expect(find(off, 'harborline')).toMatchObject({ companyName: 'Harbor Line', enabled: false });
  });

  it('on a database that holds the boards an earlier list seeded under their board ids, the committed list names them (ramp, veeva, airwallex, weride)', async () => {
    const named = new Map(careerSeedBoards().map((b) => [seedKey(b), b]));
    const earlier = ['ashby:ramp', 'lever:veeva', 'ashby:airwallex', 'lever:weride'].map((key) => ({ ...named.get(key)!, companyName: named.get(key)!.boardToken }));
    const fake = createFakePrisma();
    await loadCareerSeeds(asDb(fake), { boards: earlier });
    for (const b of earlier) expect(find(fake, b.boardToken).companyName, seedKey(b)).toBe(b.boardToken);
    const res = await loadCareerSeeds(asDb(fake), { markets: ['intl', 'cn'] });
    expect(res).toMatchObject({ status: 'loaded', updated: 4, added: careerSeedBoards().length - 4 });
    for (const b of earlier) {
      const now = find(fake, b.boardToken).companyName as string;
      expect(now, seedKey(b)).toBe(named.get(seedKey(b))!.companyName);
      expect(now, seedKey(b)).not.toBe(b.boardToken);
    }
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
          // Ashby states no company, so that loader had registered this board under its board id.
          { id: 'p3', market: 'cn', ats: 'ashby', boardToken: 'airwallex', companyName: 'airwallex', countryCode: 'CN', enabled: true, origin: 'admin', countries: [], createdBy: 'seed:2026-10-11' },
        ],
        // That loader remembered what it had offered: `veeva` was offered and an admin removed it since.
        appConfig: [{ key: LEGACY_SEED_STATE_KEY, value: JSON.stringify({ version: '2026-10-11', offered: ['smartrecruiters:BoschGroup', 'greenhouse:riotgames', 'ashby:airwallex', 'lever:veeva'] }) }],
      },
    });
    const res = await loadCareerSeeds(asDb(fake), { env: {} });
    expect(res).toMatchObject({ status: 'loaded', updated: 3, removedByAdmin: 1 });
    // One row, now read for both countries the files name, without the market marker of the old loader.
    expect(sources(fake).filter((r) => r.boardToken === 'BoschGroup')).toHaveLength(1);
    expect(find(fake, 'BoschGroup')).toMatchObject({ id: 'p1', origin: 'seed', countries: ['CN', 'TW'], countryCode: null, enabled: true });
    expect(find(fake, 'riotgames')).toMatchObject({ id: 'p2', origin: 'seed', countries: [], countryCode: null, enabled: false, companyName: 'Riot (renamed by ops)' });
    // The board id that stood in for a name is replaced by the name the list knows.
    expect(find(fake, 'airwallex')).toMatchObject({ id: 'p3', origin: 'seed', countryCode: null, companyName: careerSeedBoards().find((b) => seedKey(b) === 'ashby:airwallex')!.companyName });
    expect(find(fake, 'airwallex').companyName).not.toBe('airwallex');
    expect(sources(fake).some((r) => r.boardToken === 'veeva')).toBe(false);
    expect(await loadCareerSeeds(asDb(fake), { env: {} })).toMatchObject({ status: 'up_to_date' });
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

  it('ensureSeedCareerSources (the entry jobs-plan calls) loads the list of the deployment, whatever brand\'s market the plan runs for', async () => {
    // The deployment's own scope decides (here: the environment the tests run in), never the argument.
    const list = careerSeedBoards(servedSeedMarkets());
    const fake = createFakePrisma();
    const first = await ensureSeedCareerSources(asDb(fake), 'cn');
    expect(first).toMatchObject({ status: 'registered', added: list.length, alreadyPresent: 0 });
    expect(first.version).toBe(seedHash(list));
    expect(await ensureSeedCareerSources(asDb(fake), 'intl')).toMatchObject({ status: 'up_to_date', added: 0 });
    expect(sources(fake)).toHaveLength(list.length);
  });
});
