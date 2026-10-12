// @vitest-environment node
//
// WP-64 service: offers live on tracker entries (written through
// tracker.updateOffer), comparisons are deterministic, the benchmark is the
// posted range or absent, and the AI paths make zero model calls without
// consent and never return a number they were not given.

import { describe, expect, it, vi } from 'vitest';
import { HttpError, MIN_SAMPLE } from '../../platform/http.js';
import type { TrackerEntryView, TrackerOffer } from '../tracker/index.js';
import type { OfferInput, PostedRange } from './contract.js';
import { createOffersService, readStoredOffer, toOfferView, type OffersServiceDeps } from './service.js';
import type { PostedPaySource, PostedPaySummary } from './postedRange.js';
import type { OfferWriterInput, OfferWriterOutput } from './OfferWriterAgent.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const U = 'user_1';

function entry(id: string, offer: unknown, over: Partial<TrackerEntryView> = {}): TrackerEntryView {
  return {
    id,
    userId: U,
    jobId: `job_${id}`,
    status: 'offer',
    excitementStars: 0,
    maxSalary: null,
    maxSalaryCurrency: null,
    notesMarkdown: 'Call Jane at 555-0100',
    dateSaved: '2026-09-01T00:00:00.000Z',
    dateApplied: null,
    deadline: null,
    followUpAt: null,
    appliedVia: null,
    linkedRunId: null,
    job: { title: 'Data Analyst', companyName: `Acme ${id}`, companyLogoUrl: null, location: null, workType: 'onsite', applyUrl: 'https://acme.example/1', closed: false },
    externalSnapshot: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    source: 'feed',
    stageDetail: null,
    outcome: null,
    interviewAt: null,
    offer: offer as TrackerOffer | null,
    tailoredVariantId: null,
    coverLetterId: null,
    ...over,
  };
}

class NotFound extends Error {}

function range(over: Partial<PostedRange> = {}): PostedRange {
  const s = (value: number) => ({ value, source: 'index', sampleSize: 24, asOf: NOW.toISOString(), method: 'computed' });
  return { low: s(110000), median: s(125000), high: s(140000), currency: 'USD', period: 'year', sampleSize: 24, source: 'index', asOf: NOW.toISOString(), ...over };
}

function setup(
  opts: { entries?: TrackerEntryView[]; ai?: boolean; summary?: PostedPaySummary | Error; write?: (i: OfferWriterInput) => OfferWriterOutput; redact?: (t: string) => string } = {},
) {
  const store = new Map((opts.entries ?? []).map((e) => [e.id, e]));
  const updateOffer = vi.fn(async (_u: string, id: string, offer: TrackerOffer | null) => {
    const e = store.get(id)!;
    store.set(id, { ...e, offer, updatedAt: NOW.toISOString() });
  });
  const summary = vi.fn(async (): Promise<PostedPaySummary> => {
    if (opts.summary instanceof Error) throw opts.summary;
    return opts.summary ?? { postedRange: range(), totalCount: 60, listedCount: 24 };
  });
  const postedPay: PostedPaySource = {
    jobScope: vi.fn(async () => ({ title: 'Data Analyst', taxonomyIds: [], primaryTaxonomyId: null, locationCountry: 'US', locationCity: null })),
    summary,
  };
  const write = vi.fn(async (i: OfferWriterInput) => (opts.write ? opts.write(i) : { text: 'Thank you for the offer.', talkingPoints: ['Ask about base'] }));
  const deps: OffersServiceDeps = {
    tracker: {
      entries: async () => [...store.values()],
      entry: async (_u, id) => {
        const e = store.get(id);
        if (!e) throw new NotFound();
        return e;
      },
      updateOffer,
    },
    postedPay,
    market: () => 'intl',
    now: () => NOW,
    aiAvailable: async () => opts.ai ?? true,
    write,
    isEntryNotFound: (err) => err instanceof NotFound,
    redact: opts.redact,
  };
  return { svc: createOffersService(deps), updateOffer, write, summary, store };
}

const USD: OfferInput = { base: 120000, currency: 'USD', period: 'year' };

async function code(p: Promise<unknown>): Promise<{ code: string; reason?: unknown }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return { code: err.code, reason: (err.details as { reason?: unknown } | undefined)?.reason };
    throw err;
  }
  throw new Error('expected an error');
}

describe('readStoredOffer / toOfferView', () => {
  it('drops unknown keys and invalid optional fields instead of the whole offer', () => {
    expect(readStoredOffer({ ...USD, legacy: 1, deadline: 'soon', cn: { salaryMonths: 99, hukou: true, other: 'x' } })).toEqual({ ...USD, cn: { hukou: true } });
    expect(readStoredOffer({ base: -1, currency: 'USD', period: 'year' })).toBeNull();
    expect(readStoredOffer(null)).toBeNull();
    expect(readStoredOffer([])).toBeNull();
  });

  it('names the application from the job or the pasted snapshot', () => {
    const ext = entry('x', USD, { job: null, jobId: null, externalSnapshot: { title: 'Ops Lead', companyName: 'Umbrella' } });
    expect(toOfferView(ext)).toMatchObject({ title: 'Ops Lead', companyName: 'Umbrella', jobId: null, status: 'offer' });
    expect(toOfferView(entry('y', null))).toBeNull();
  });
});

describe('offers service — CRUD and compare', () => {
  it('put writes through tracker.updateOffer and returns the view; list shows only entries with offers', async () => {
    const { svc, updateOffer } = setup({ entries: [entry('a', null), entry('b', USD, { updatedAt: '2026-09-01T00:00:00.000Z' })] });
    const view = await svc.put(U, 'a', { ...USD, base: 130000 });
    expect(updateOffer).toHaveBeenCalledWith(U, 'a', { ...USD, base: 130000 });
    expect(view).toMatchObject({ trackerEntryId: 'a', offer: { base: 130000 }, companyName: 'Acme a' });
    expect((await svc.list(U)).map((v) => v.trackerEntryId)).toEqual(['a', 'b']);
  });

  it('404s: unknown application, no offer to delete, compare with an entry that has no offer', async () => {
    const { svc } = setup({ entries: [entry('a', USD), entry('b', null)] });
    expect(await code(svc.put(U, 'zz', USD))).toEqual({ code: 'not_found', reason: 'tracker_entry_not_found' });
    expect(await code(svc.remove(U, 'b'))).toEqual({ code: 'not_found', reason: 'offer_not_found' });
    expect(await code(svc.compare(U, ['a', 'b']))).toEqual({ code: 'not_found', reason: 'offer_not_found' });
  });

  it('remove clears the offer', async () => {
    const { svc, updateOffer } = setup({ entries: [entry('a', USD)] });
    expect(await svc.remove(U, 'a')).toEqual({ deleted: true });
    expect(updateOffer).toHaveBeenCalledWith(U, 'a', null);
  });

  it('compare keeps the requested order and de-duplicates', async () => {
    const { svc } = setup({ entries: [entry('a', USD), entry('b', { ...USD, base: 125000 })] });
    const c = await svc.compare(U, ['b', 'a', 'b']);
    expect(c.offers.map((o) => o.trackerEntryId)).toEqual(['b', 'a']);
    expect(c.highest).toEqual({ recurringAnnual: ['b'], firstYear: ['b'] });
  });

  it('rethrows tracker errors that are not "not found"', async () => {
    const broken = createOffersService({
      tracker: { entries: async () => [], entry: async () => Promise.reject(new Error('db down')), updateOffer: async () => {} },
      postedPay: { jobScope: async () => null, summary: async () => ({ postedRange: null, totalCount: 0, listedCount: 0 }) },
      market: () => 'intl',
      aiAvailable: async () => true,
      write: async () => ({ text: '', talkingPoints: [] }),
    });
    await expect(broken.put(U, 'a', USD)).rejects.toThrow('db down');
  });
});

describe('offers service — benchmark', () => {
  it('returns the posted range with N and where the base sits', async () => {
    const { svc, summary } = setup({ entries: [entry('a', USD)] });
    const b = await svc.benchmark(U, 'a');
    expect(b).toMatchObject({ postedRange: { sampleSize: 24 }, totalCount: 60, listedCount: 24, minSample: MIN_SAMPLE, position: 'within', offerBaseInRangePeriod: 120000, reason: null });
    expect(summary).toHaveBeenCalledWith(expect.objectContaining({ market: 'intl', currency: 'USD', preferredPeriod: 'year', country: 'US' }));
  });

  it('converts the base into the range period', async () => {
    const { svc } = setup({ entries: [entry('a', { base: 9000, currency: 'USD', period: 'month' })], summary: { postedRange: range(), totalCount: 30, listedCount: 24 } });
    expect(await svc.benchmark(U, 'a')).toMatchObject({ offerBaseInRangePeriod: 108000, position: 'below' });
  });

  it('is absent (never estimated) below the sample, without a role, or when the index fails', async () => {
    expect(await setup({ entries: [entry('a', USD)], summary: { postedRange: null, totalCount: 12, listedCount: 4 } }).svc.benchmark(U, 'a')).toMatchObject({
      postedRange: null,
      reason: 'not_enough_data',
      totalCount: 12,
      listedCount: 4,
      position: null,
    });
    const noRole = setup({ entries: [entry('a', USD, { jobId: null, job: null, externalSnapshot: { title: ' ', companyName: 'X' } })] });
    expect(await noRole.svc.benchmark(U, 'a')).toMatchObject({ postedRange: null, reason: 'no_role' });
    expect(noRole.summary).not.toHaveBeenCalled();
    expect(await setup({ entries: [entry('a', USD)], summary: new Error('timeout') }).svc.benchmark(U, 'a')).toMatchObject({ postedRange: null, reason: 'unavailable' });
  });
});

describe('offers service — AI', () => {
  it('without AI consent / model: 503 ai_unavailable and zero model calls', async () => {
    const { svc, write } = setup({ entries: [entry('a', USD), entry('b', USD)], ai: false });
    expect(await code(svc.negotiationDraft(U, 'a', {}, 'en'))).toEqual({ code: 'ai_unavailable', reason: 'ai_off' });
    expect(await code(svc.explain(U, ['a', 'b'], 'en'))).toEqual({ code: 'ai_unavailable', reason: 'ai_off' });
    expect(write).not.toHaveBeenCalled();
  });

  it('the draft prompt carries only offer facts and the posted range with N (no notes, no contact details)', async () => {
    const { svc, write } = setup({ entries: [entry('a', { ...USD, notes: 'my phone 555-0100', signingBonus: 10000 }), entry('b', { ...USD, base: 125000 })] });
    const draft = await svc.negotiationDraft(U, 'a', { focus: 'base', compareWith: ['b'] }, 'en');
    expect(draft).toMatchObject({ text: 'Thank you for the offer.', talkingPoints: ['Ask about base'], aiWritten: true, position: 'within' });
    expect(draft.postedRange?.sampleSize).toBe(24);
    const input = write.mock.calls[0]![0];
    expect(input).toMatchObject({ mode: 'negotiation', focus: 'base', locale: 'en' });
    expect(input.facts).toContain('from 24 job postings');
    expect(input.facts).toContain('median: 125000');
    expect(input.facts).toContain('OTHER OFFER (OFFER 2)');
    expect(input.facts).toContain('difference from the posted median: -4%');
    expect(input.facts).not.toContain('555-0100');
    expect(input.facts).not.toContain('Jane');
  });

  it('redacts the free-text offer fields before they reach the prompt', async () => {
    const { svc, write } = setup({
      entries: [entry('a', { ...USD, equity: 'ask hr@acme.example', bonus: '10% target' })],
      redact: (t) => t.replace(/\S+@\S+/g, '[email]'),
    });
    await svc.negotiationDraft(U, 'a', {}, 'en');
    const facts = write.mock.calls[0]![0].facts;
    expect(facts).toContain('equity as written (never valued, not counted): ask [email]');
    expect(facts).toContain('bonus as written in the offer (not counted): 10% target');
    expect(facts).not.toContain('hr@acme.example');
  });

  it('below the sample the facts say there is no market data', async () => {
    const { svc, write } = setup({ entries: [entry('a', USD)], summary: { postedRange: null, totalCount: 3, listedCount: 1 } });
    const draft = await svc.negotiationDraft(U, 'a', {}, 'en');
    expect(draft.postedRange).toBeNull();
    expect(write.mock.calls[0]![0].facts).toContain('not enough data (do not mention market pay)');
  });

  it('retries once when the text adds a number, then refuses (fail closed)', async () => {
    let n = 0;
    const ok = setup({
      entries: [entry('a', USD)],
      write: () => (++n === 1 ? { text: 'Most analysts make $150,000.', talkingPoints: [] } : { text: 'Thank you for the $120,000 offer.', talkingPoints: [] }),
    });
    expect((await ok.svc.negotiationDraft(U, 'a', {}, 'en')).text).toBe('Thank you for the $120,000 offer.');
    expect(ok.write).toHaveBeenCalledTimes(2);
    expect(ok.write.mock.calls[1]![0].retryNote).toContain('150,000');

    const bad = setup({ entries: [entry('a', USD)], write: () => ({ text: 'The market pays 30% more.', talkingPoints: [] }) });
    expect(await code(bad.svc.negotiationDraft(U, 'a', {}, 'en'))).toEqual({ code: 'ai_unavailable', reason: 'ai_unsupported_numbers' });
    expect(bad.write).toHaveBeenCalledTimes(2);

    const empty = setup({ entries: [entry('a', USD)], write: () => ({ text: '', talkingPoints: [] }) });
    expect(await code(empty.svc.negotiationDraft(U, 'a', {}, 'en'))).toMatchObject({ code: 'ai_unavailable' });
  });

  it('explain compares the chosen offers with differences precomputed and no market pay', async () => {
    const { svc, write } = setup({
      entries: [entry('a', USD), entry('b', { base: 20000, currency: 'CNY', period: 'month', cn: { salaryMonths: 13, socialInsuranceBase: 20000, housingFundPercent: 12 } }), entry('c', { ...USD, base: 132000 })],
      write: () => ({ text: 'Offer 3 pays 12000 more a year (9%). Offer 2 includes 28800 of housing fund.', talkingPoints: [] }),
    });
    const out = await svc.explain(U, ['a', 'b', 'c'], 'zh');
    expect(out).toEqual({ text: expect.stringContaining('Offer 3'), aiWritten: true, trackerEntryIds: ['a', 'b', 'c'] });
    const facts = write.mock.calls[0]![0].facts;
    expect(facts).toContain('OFFER 1 vs OFFER 2: different currencies, not converted.');
    expect(facts).toContain('OFFER 1 vs OFFER 3: yearly total difference -12000 (-9%)');
    expect(facts).toContain('housing fund, company part a year: 28800');
    expect(facts).toContain('do not mention market pay');
  });
});
