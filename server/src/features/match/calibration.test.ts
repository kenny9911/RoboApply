// @vitest-environment node
// Calibration of the estimate to the AI scale (MARKET_STRATEGY 2.4): isotonic regression, the map as a function,
// priors from data, the stored document and when it is refreshed. No database: the store is a fake.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  CALIBRATION_CONFIG_KEY,
  CALIBRATION_MAX_KNOTS,
  NO_CALIBRATION,
  activeCalibration,
  applyMap,
  createCalibration,
  DATA_PRIOR_KEYS,
  estimatePriors,
  fitIsotonic,
  parseCalibrationDoc,
  parseCalibrationMap,
  withCalibratedPriors,
  type CalibrationStore,
} from './calibration.js';
import { DEFAULT_MATCH_PRIORS } from './contract.js';
import { toCalibrationPair, type CalibrationPair } from './repo.js';
import { createMemoryRepo, jobRecord } from './testkit.js';

const NOW = new Date('2026-10-10T08:00:00Z');
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

/** Deterministic noise in [-1, 1] (no Math.random: the same pairs every run). */
function noise(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** `n` synthetic pairs where the AI score is about `slope` × the estimate. SYNTHETIC. */
function syntheticPairs(n: number, slope = 0.6, components: CalibrationPair['components'] = {}): CalibrationPair[] {
  return Array.from({ length: n }, (_, i) => {
    const estimate = 20 + ((i * 37) % 76); // 20..95
    return { estimate, ai: Math.max(0, Math.min(100, Math.round(estimate * slope + noise(i) * 4))), components };
  });
}

function fakeStore(seed: { value?: string | null; pairs?: CalibrationPair[]; pairsSince?: (since: Date) => CalibrationPair[] } = {}) {
  const state = { value: seed.value ?? null, reads: 0, writes: 0, pairReads: [] as Date[] };
  const store: CalibrationStore = {
    async getConfigValue(key) {
      expect(key).toBe(CALIBRATION_CONFIG_KEY);
      state.reads += 1;
      return state.value;
    },
    async setConfigValue(key, value) {
      expect(key).toBe(CALIBRATION_CONFIG_KEY);
      state.writes += 1;
      state.value = value;
    },
    async listCalibrationPairs({ since, limit }) {
      state.pairReads.push(since);
      return (seed.pairsSince ? seed.pairsSince(since) : (seed.pairs ?? [])).slice(0, limit);
    },
  };
  return { store, state };
}

describe('fitIsotonic (pool adjacent violators)', () => {
  it('an already monotone input comes back as it is', () => {
    const pairs = [
      { estimate: 20, ai: 10 },
      { estimate: 40, ai: 25 },
      { estimate: 60, ai: 25 },
      { estimate: 80, ai: 50 },
    ];
    expect(fitIsotonic(pairs)).toEqual({ knots: [[20, 10], [40, 25], [60, 25], [80, 50]] });
    // The order of the input does not matter.
    expect(fitIsotonic([...pairs].reverse())).toEqual(fitIsotonic(pairs));
  });

  it('a violating pair is pooled into one block at its mean', () => {
    // 40 → 30 then 60 → 20 goes down: the two are pooled to (50, 25).
    expect(fitIsotonic([{ estimate: 20, ai: 10 }, { estimate: 40, ai: 30 }, { estimate: 60, ai: 20 }, { estimate: 80, ai: 50 }])).toEqual({ knots: [[20, 10], [50, 25], [80, 50]] });
    // A late low value pulls every block above it back (the cascade): 10, 40, 50, 15 → 10 and one block of three.
    expect(fitIsotonic([{ estimate: 10, ai: 10 }, { estimate: 20, ai: 40 }, { estimate: 30, ai: 50 }, { estimate: 40, ai: 15 }])).toEqual({ knots: [[10, 10], [30, 35]] });
    // Everything decreasing: one block, the overall mean.
    expect(fitIsotonic([{ estimate: 10, ai: 90 }, { estimate: 50, ai: 50 }, { estimate: 90, ai: 10 }])).toEqual({ knots: [[50, 50]] });
  });

  it('equal estimates are one point at their mean AI score', () => {
    expect(fitIsotonic([{ estimate: 50, ai: 40 }, { estimate: 50, ai: 60 }, { estimate: 70, ai: 80 }])).toEqual({ knots: [[50, 50], [70, 80]] });
  });

  it('keeps at most 21 knots, still monotone; unusable pairs are ignored; nothing gives null', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ estimate: i + 10, ai: i / 2 + 5 }));
    const map = fitIsotonic(many)!;
    expect(map.knots.length).toBeLessThanOrEqual(CALIBRATION_MAX_KNOTS);
    for (let i = 1; i < map.knots.length; i++) {
      expect(map.knots[i]![0]).toBeGreaterThan(map.knots[i - 1]![0]);
      expect(map.knots[i]![1]).toBeGreaterThanOrEqual(map.knots[i - 1]![1]);
    }
    expect(parseCalibrationMap(map)).toEqual(map);
    expect(fitIsotonic([{ estimate: Number.NaN, ai: 3 }, { estimate: 40, ai: Number.POSITIVE_INFINITY }])).toBeNull();
    expect(fitIsotonic([])).toBeNull();
  });

  it('500 synthetic pairs where the AI is about 0.6 × the estimate: the map sends 80 to about 48 and is monotone', () => {
    const map = fitIsotonic(syntheticPairs(500))!;
    expect(map.knots.length).toBeLessThanOrEqual(CALIBRATION_MAX_KNOTS);
    expect(applyMap(map, 80)).toBeGreaterThan(44);
    expect(applyMap(map, 80)).toBeLessThan(52);
    let prev = -1;
    for (let x = 0; x <= 100; x++) {
      const y = applyMap(map, x);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
});

describe('applyMap', () => {
  const map = { knots: [[20, 10], [60, 30], [80, 70]] as Array<[number, number]> };

  it('is linear between knots and flat beyond the first and the last (never extrapolated)', () => {
    expect(applyMap(map, 20)).toBe(10);
    expect(applyMap(map, 40)).toBe(20);
    expect(applyMap(map, 60)).toBe(30);
    expect(applyMap(map, 70)).toBe(50);
    expect(applyMap(map, 80)).toBe(70);
    expect(applyMap(map, 0)).toBe(10);
    expect(applyMap(map, 100)).toBe(70);
    expect(applyMap(map, -50)).toBe(10);
    expect(applyMap(map, 1000)).toBe(70);
  });

  it('stays within 0–100 and a one-knot map is a constant', () => {
    expect(applyMap({ knots: [[50, 42]] }, 3)).toBe(42);
    expect(applyMap({ knots: [[50, 42]] }, 97)).toBe(42);
    for (const x of [0, 13, 50, 99, 100]) {
      const y = applyMap(map, x);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });

  it('parseCalibrationMap accepts only a well-formed monotone knot list', () => {
    expect(parseCalibrationMap(map)).toEqual(map);
    for (const bad of [null, {}, { knots: [] }, { knots: [[20, 10], [20, 30]] }, { knots: [[20, 30], [40, 10]] }, { knots: [[20, 'x']] }, { knots: [[20, 10, 5]] }, { knots: [[120, 10]] }, { knots: 'no' }]) {
      expect(parseCalibrationMap(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('priors from data', () => {
  const component = (n: number, components: CalibrationPair['components']) => Array.from({ length: n }, () => ({ components }));

  it('the mean of each AI component, only for components scored at least 200 times', () => {
    const pairs = [...component(200, { title_level: 60, skills: 40 }), ...component(50, { title_level: 20, industry: 30 })];
    const priors = estimatePriors(pairs);
    // title_level: 250 values, (200 × 60 + 50 × 20) / 250 = 52; skills: exactly 200 values; industry: only 50 → left out.
    expect(priors).toEqual({ title_level: 52, skills: 40 });
    expect(estimatePriors(component(199, { skills: 40 }))).toEqual({});
    expect(estimatePriors([])).toEqual({});
  });

  it('logistics never gets a prior from data: 250 AI rows whose logistics is 100 leave it unset', () => {
    // The logistics part of an AI row is 100 × met / stated, and it is mostly 100 because the person's own filters
    // removed the jobs that fail. Its mean would give back the free logistics points the estimate's rule removes.
    const pairs = [...component(225, { title_level: 60, skills: 40, logistics: 100 }), ...component(25, { title_level: 60, skills: 40, logistics: 50 })];
    const priors = estimatePriors(pairs);
    expect(priors).toEqual({ title_level: 60, skills: 40 });
    expect(priors.logistics).toBeUndefined();
    expect(DATA_PRIOR_KEYS).toEqual(['title_level', 'skills', 'industry', 'career_path']);
  });

  it('data-derived priors go over the starting ones, component by component', () => {
    expect(withCalibratedPriors({ ...DEFAULT_MATCH_PRIORS }, { skills: 31.5 })).toEqual({ ...DEFAULT_MATCH_PRIORS, skills: 31.5 });
    expect(withCalibratedPriors({ ...DEFAULT_MATCH_PRIORS }, null)).toEqual(DEFAULT_MATCH_PRIORS);
    // A stored document that carries a logistics value is not read for it: the configured prior stays.
    expect(withCalibratedPriors({ ...DEFAULT_MATCH_PRIORS, logistics: 40 }, { skills: 31.5, logistics: 95 })).toEqual({ ...DEFAULT_MATCH_PRIORS, skills: 31.5, logistics: 40 });
  });
});

describe('the stored document', () => {
  it('a missing or malformed value means no map and the starting priors, without throwing', async () => {
    for (const value of [null, '', 'not json', '[]', '"text"', '{"intl":"x"}', '{"intl":{"map":{"knots":[[20,10]]},"pairs":900}}', '{"intl":{"computedAt":"not a date","pairs":900}}']) {
      expect(parseCalibrationDoc(value), String(value)).toEqual({});
      const { store } = fakeStore({ value });
      expect(await createCalibration({ store, env: {}, now: () => NOW }).forMarket('intl'), String(value)).toEqual(NO_CALIBRATION);
    }
    // A malformed map inside an otherwise good entry: no map, the priors still read.
    const doc = parseCalibrationDoc(JSON.stringify({ intl: { map: { knots: [[50, 60], [40, 70]] }, priors: { skills: 31 }, pairs: 900, computedAt: NOW.toISOString(), priorsPairs: 300, priorsComputedAt: NOW.toISOString() } }));
    expect(doc.intl).toMatchObject({ map: null, priors: { skills: 31 }, pairs: 900 });
    // Malformed priors are dropped whole.
    expect(parseCalibrationDoc(JSON.stringify({ cn: { map: null, priors: { skills: 'x' }, pairs: 0, computedAt: NOW.toISOString() } })).cn).toMatchObject({ priors: null });
  });

  it('an unreadable store is "no calibration", and it is not asked again on every fit', async () => {
    const getConfigValue = vi.fn(async () => {
      throw new Error('db down');
    });
    const c = createCalibration({ store: { getConfigValue, setConfigValue: async () => undefined, listCalibrationPairs: async () => [] }, env: {}, now: () => NOW });
    expect(await c.forMarket('intl')).toEqual(NO_CALIBRATION);
    expect(await c.forMarket('cn')).toEqual(NO_CALIBRATION);
    expect(getConfigValue).toHaveBeenCalledTimes(1);
  });

  it('the map is used only from MATCH_CALIBRATION_MIN_PAIRS pairs (500); markets are read separately', () => {
    const entry = { map: { knots: [[20, 12], [80, 48]] as Array<[number, number]> }, priors: { skills: 31 }, pairs: 499, computedAt: NOW.toISOString(), priorsPairs: 300, priorsComputedAt: NOW.toISOString() };
    expect(activeCalibration(entry, 500)).toEqual({ map: null, priors: { skills: 31 } });
    expect(activeCalibration({ ...entry, pairs: 500 }, 500).map).toEqual(entry.map);
    expect(activeCalibration({ ...entry, pairs: 120 }, 100).map).toEqual(entry.map);
    expect(activeCalibration(null, 500)).toEqual(NO_CALIBRATION);
  });

  it('reads through the store once per 10 minutes', async () => {
    let now = NOW;
    const { store, state } = fakeStore({ value: JSON.stringify({ intl: { map: { knots: [[20, 12], [80, 48]] }, priors: null, pairs: 800, computedAt: NOW.toISOString(), priorsPairs: 0, priorsComputedAt: NOW.toISOString() } }) });
    const c = createCalibration({ store, env: {}, now: () => now });
    expect((await c.forMarket('intl')).map).toEqual({ knots: [[20, 12], [80, 48]] });
    expect(await c.forMarket('cn')).toEqual(NO_CALIBRATION);
    await c.forMarket('intl');
    expect(state.reads).toBe(1);
    now = new Date(NOW.getTime() + 9 * 60_000);
    await c.forMarket('intl');
    expect(state.reads).toBe(1);
    now = new Date(NOW.getTime() + 11 * 60_000);
    await c.forMarket('intl');
    expect(state.reads).toBe(2);
    // The env minimum is read at use: a higher bar hides the same stored map.
    expect((await createCalibration({ store, env: { MATCH_CALIBRATION_MIN_PAIRS: '1000' }, now: () => now }).forMarket('intl')).map).toBeNull();
  });
});

describe('refreshIfDue', () => {
  it('with fewer than 500 pairs no map is stored (ranking keeps the blend); the run is recorded so it is not repeated', async () => {
    const { store, state } = fakeStore({ pairs: syntheticPairs(499) });
    const c = createCalibration({ store, env: {}, now: () => NOW });
    const r = await c.refreshIfDue('intl', NOW);
    expect(r).toMatchObject({ map: 'too_few_pairs', pairs: 499 });
    const doc = parseCalibrationDoc(state.value);
    expect(doc.intl).toMatchObject({ map: null, pairs: 499, computedAt: NOW.toISOString() });
    expect(await c.forMarket('intl')).toEqual(NO_CALIBRATION);
    // The next run, minutes later, does nothing.
    expect(await c.refreshIfDue('intl', new Date(NOW.getTime() + 15 * 60_000))).toEqual({ skipped: 'not_due' });
    expect(state.writes).toBe(1);
  });

  it('with 500 pairs the map is stored and used: 80 maps to about 48', async () => {
    const { store, state } = fakeStore({ pairs: syntheticPairs(500) });
    const c = createCalibration({ store, env: {}, now: () => NOW });
    expect(await c.refreshIfDue('intl', NOW)).toMatchObject({ map: 'stored', pairs: 500 });
    const active = await c.forMarket('intl');
    expect(active.map).not.toBeNull();
    expect(applyMap(active.map!, 80)).toBeGreaterThan(44);
    expect(applyMap(active.map!, 80)).toBeLessThan(52);
    // The other market is untouched.
    expect(parseCalibrationDoc(state.value).cn).toBeUndefined();
    expect(await c.forMarket('cn')).toEqual(NO_CALIBRATION);
  });

  it('priors computed from fewer than 200 values are not stored or used; from 200 they are', async () => {
    const few = fakeStore({ pairs: syntheticPairs(199, 0.6, { skills: 30, title_level: 50 }) });
    const a = createCalibration({ store: few.store, env: {}, now: () => NOW });
    expect(await a.refreshIfDue('intl', NOW)).toMatchObject({ priors: 'too_few_pairs', priorsPairs: 199 });
    expect((await a.forMarket('intl')).priors).toBeNull();

    const enough = fakeStore({ pairs: syntheticPairs(200, 0.6, { skills: 30, title_level: 50 }) });
    const b = createCalibration({ store: enough.store, env: {}, now: () => NOW });
    expect(await b.refreshIfDue('intl', NOW)).toMatchObject({ priors: 'stored', priorsPairs: 200, map: 'too_few_pairs' });
    expect((await b.forMarket('intl')).priors).toEqual({ skills: 30, title_level: 50 });
    // Priors read the last 90 days; the map reads everything.
    expect(enough.state.pairReads.map((d) => d.getTime())).toEqual([0, NOW.getTime() - 90 * DAY]);
  });

  it('due logic: a map 6 days old is left alone, one 8 days old is recomputed; priors after 30 days', async () => {
    const entry = (mapAge: number, priorsAge: number) =>
      JSON.stringify({ intl: { map: { knots: [[20, 99], [80, 99]] }, priors: { skills: 77 }, pairs: 900, computedAt: daysAgo(mapAge).toISOString(), priorsPairs: 900, priorsComputedAt: daysAgo(priorsAge).toISOString() } });

    const young = fakeStore({ value: entry(6, 6), pairs: syntheticPairs(600) });
    expect(await createCalibration({ store: young.store, env: {}, now: () => NOW }).refreshIfDue('intl', NOW)).toEqual({ skipped: 'not_due' });
    expect(young.state.writes).toBe(0);
    expect(young.state.pairReads).toEqual([]);

    // The map is due (8 days); the priors (8 days) are not: only the map changes.
    const mapDue = fakeStore({ value: entry(8, 8), pairs: syntheticPairs(600) });
    const r = await createCalibration({ store: mapDue.store, env: {}, now: () => NOW }).refreshIfDue('intl', NOW);
    expect(r).toEqual({ map: 'stored', pairs: 600 });
    const after = parseCalibrationDoc(mapDue.state.value).intl!;
    expect(after.computedAt).toBe(NOW.toISOString());
    expect(after.map!.knots[0]![1]).toBeLessThan(99);
    expect(after.priors).toEqual({ skills: 77 });
    expect(after.priorsComputedAt).toBe(daysAgo(8).toISOString());

    // The priors are due after 30 days, the map (6 days) is not.
    const priorsDue = fakeStore({ value: entry(6, 31), pairs: syntheticPairs(300, 0.6, { skills: 20 }) });
    const p = await createCalibration({ store: priorsDue.store, env: {}, now: () => NOW }).refreshIfDue('intl', NOW);
    expect(p).toEqual({ priors: 'stored', priorsPairs: 300 });
    const afterPriors = parseCalibrationDoc(priorsDue.state.value).intl!;
    expect(afterPriors.priors).toEqual({ skills: 20 });
    expect(afterPriors.map).toEqual({ knots: [[20, 99], [80, 99]] });
    expect(afterPriors.computedAt).toBe(daysAgo(6).toISOString());
  });

  it('writes its market next to what the other market stored meanwhile', async () => {
    const { store, state } = fakeStore({ pairs: syntheticPairs(500) });
    const c = createCalibration({ store, env: {}, now: () => NOW });
    // GoApply's run stores its entry between this run's first read and its write.
    const original = store.listCalibrationPairs;
    store.listCalibrationPairs = async (input) => {
      state.value = JSON.stringify({ cn: { map: null, priors: null, pairs: 3, computedAt: NOW.toISOString(), priorsPairs: 3, priorsComputedAt: NOW.toISOString() } });
      return original(input);
    };
    await c.refreshIfDue('intl', NOW);
    const doc = parseCalibrationDoc(state.value);
    expect(doc.cn).toMatchObject({ pairs: 3 });
    expect(doc.intl).toMatchObject({ pairs: 500 });
  });
});

describe('pairs come from stored AI rows of primary resumes, numbers only', () => {
  it('toCalibrationPair reads the estimate stored at score time and the scored components', () => {
    const dimensions = [
      { key: 'title_level', weight: 35, score: 80, status: 'scored', evidence: [{ text: 'a quote', source: 'resume' }] },
      { key: 'skills', weight: 30, score: null, status: 'not_stated', evidence: [] },
      { key: 'logistics', weight: 10, score: 100, status: 'scored', evidence: [] },
    ];
    expect(toCalibrationPair({ ai: 71, estimateAtScore: { score: 64, coverage: 0.65 }, dimensions })).toEqual({ estimate: 64, ai: 71, components: { title_level: 80, logistics: 100 } });
    // No stored estimate (a row from before this version, or an estimate that had no score): not a pair.
    expect(toCalibrationPair({ ai: 71, estimateAtScore: null, dimensions })).toBeNull();
    expect(toCalibrationPair({ ai: 71, estimateAtScore: { score: null }, dimensions })).toBeNull();
    expect(toCalibrationPair({ ai: 'x', estimateAtScore: { score: 64 }, dimensions })).toBeNull();
  });

  it('pairsFor: this market, since the date, primary resumes, newest first', async () => {
    const row = (jobId: string, at: Date, over: Record<string, unknown> = {}) => ({
      userId: 'u1',
      jobId,
      resumeVariantId: 'v1',
      score: 70,
      explanation: { strengths: ['prose that is never read here'], estimateAtScore: { score: 60, coverage: 0.8 } },
      resumeContentHashAtScore: 'hash-1',
      modelUsed: 'm',
      generatedAt: at,
      scoreKind: 'ai',
      tier: 'good',
      dimensions: [{ key: 'skills', weight: 30, score: 55, status: 'scored', evidence: [] }],
      promptVersion: 'scorer_v3',
      locale: 'en',
      searchProfileVersion: 1,
      ...over,
    });
    const repo = createMemoryRepo({
      jobs: [jobRecord({ id: 'a' }), jobRecord({ id: 'b' }), jobRecord({ id: 'cn1', market: 'cn' }), jobRecord({ id: 'old' }), jobRecord({ id: 'tailored' }), jobRecord({ id: 'legacy' })],
      scores: [
        row('a', daysAgo(2)),
        row('b', daysAgo(1), { score: 40, explanation: { estimateAtScore: { score: 50, coverage: 0.5 } } }),
        row('cn1', daysAgo(1)),
        row('old', daysAgo(200)),
        row('tailored', daysAgo(1), { resumeVariantId: 'v-tailored' }),
        row('legacy', daysAgo(1), { explanation: { strengths: [] } }),
      ],
      nonPrimary: ['v-tailored'],
    });
    const c = createCalibration({ store: repo, env: {}, now: () => NOW });
    const pairs = await c.pairsFor('intl', daysAgo(90));
    expect(pairs).toEqual([
      { estimate: 50, ai: 40, components: { skills: 55 } },
      { estimate: 60, ai: 70, components: { skills: 55 } },
    ]);
    expect(JSON.stringify(pairs)).not.toContain('prose');
    expect(await c.pairsFor('cn', daysAgo(90))).toHaveLength(1);
  });
});
