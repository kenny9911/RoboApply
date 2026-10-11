// @vitest-environment node
// MKT-1C: the adapter options the source wave compiles against
// (MARKET_TASK_PLAN "Provider ids and adapter options"; MARKET_STRATEGY §1.2, JI-2).
// Pure: no network, no database. The adapters are built, never fetched from.
import { describe, expect, it } from 'vitest';
import { createBankAdapter } from '../ingest/adapters/bank.js';
import { createRapidApiAdapter } from '../ingest/adapters/rapidApi.js';
import { ensureBuiltinAdapters } from '../ingest/providers.js';
import { createAtsPublicAdapter } from './atsPublic/adapter.js';
import { ensureAtsPublicAdapter } from './atsPublic/register.js';
import { getSourceAdapter, registeredSourceAdapters } from './index.js';
import { adapterCostModel, adapterEnabledFor, type IngestProvider, type JobSourceAdapter, type SourceCostModel } from './types.js';

function fake(over: Partial<JobSourceAdapter> & { provider: IngestProvider }): JobSourceAdapter {
  return {
    kind: 'search',
    markets: ['intl'],
    sourceBoards: [over.provider],
    isEnabled: () => true,
    supportsCountry: () => true,
    dailyCallLimit: () => null,
    fetch: async () => ({ jobs: [], calls: 0 }),
    ...over,
  };
}

describe('adapterCostModel', () => {
  it('the adapters ingest registers today: JSearch is billed per request, Active Jobs DB per job, the rest are free', () => {
    expect(adapterCostModel(createRapidApiAdapter('jsearch'))).toBe('per_request');
    expect(adapterCostModel(createRapidApiAdapter('activejobs'))).toBe('per_job');
    expect(adapterCostModel(createAtsPublicAdapter())).toBe('free');
    expect(adapterCostModel(createBankAdapter('robohire'))).toBe('free');
    expect(adapterCostModel(createBankAdapter('gohire'))).toBe('free');
  });

  it('the same through the registry ingest reads: no registered adapter declares a model yet, the provider id decides', () => {
    ensureBuiltinAdapters();
    ensureAtsPublicAdapter();
    expect(adapterCostModel(getSourceAdapter('jsearch')!)).toBe('per_request');
    expect(adapterCostModel(getSourceAdapter('activejobs')!)).toBe('per_job');
    expect(adapterCostModel(getSourceAdapter('ats_public')!)).toBe('free');
    expect(adapterCostModel(getSourceAdapter('bank_robohire')!)).toBe('free');
    expect(adapterCostModel(getSourceAdapter('bank_gohire')!)).toBe('free');
    expect(registeredSourceAdapters().map((a) => a.provider).sort()).toEqual(['activejobs', 'ats_public', 'bank_gohire', 'bank_robohire', 'jsearch']);
    // JI-2: the only source billed per request is the one that must never get an SEO seed query.
    expect(registeredSourceAdapters().filter((a) => adapterCostModel(a) === 'per_request').map((a) => a.provider)).toEqual(['jsearch']);
  });

  it.each([
    ['jsearch', 'per_request'],
    ['activejobs', 'per_job'],
    ['activejobs_feed', 'per_job'],
    ['linkedin', 'per_job'],
    ['ats_public', 'free'],
    ['bank_robohire', 'free'],
    ['bank_gohire', 'free'],
    ['user_import', 'free'],
    ['tw_open_data', 'free'],
    ['tw_gov_jobs', 'free'],
    ['usajobs', 'free'],
  ] as Array<[IngestProvider, SourceCostModel]>)('default for %s is %s', (provider, expected) => {
    expect(adapterCostModel(fake({ provider }))).toBe(expected);
    expect(adapterCostModel({ provider })).toBe(expected);
  });

  it('a declared value wins over the default for the provider id', () => {
    expect(adapterCostModel(fake({ provider: 'jsearch', costModel: 'free' }))).toBe('free');
    expect(adapterCostModel(fake({ provider: 'ats_public', costModel: 'per_request' }))).toBe('per_request');
    expect(adapterCostModel(fake({ provider: 'usajobs', costModel: 'per_job' }))).toBe('per_job');
  });
});

describe('adapterEnabledFor', () => {
  it('without isEnabledFor, isEnabled answers for every market', () => {
    expect(adapterEnabledFor(fake({ provider: 'jsearch', isEnabled: () => true }), 'intl')).toBe(true);
    expect(adapterEnabledFor(fake({ provider: 'jsearch', isEnabled: () => true }), 'cn')).toBe(true);
    expect(adapterEnabledFor(fake({ provider: 'jsearch', isEnabled: () => false }), 'intl')).toBe(false);
    expect(adapterEnabledFor(fake({ provider: 'jsearch', isEnabled: () => false }), 'cn')).toBe(false);
  });

  it('isEnabledFor decides per market when the adapter has it, whatever isEnabled says', () => {
    const seen: string[] = [];
    const adapter = fake({
      provider: 'activejobs',
      markets: ['intl', 'cn'],
      isEnabled: () => true,
      isEnabledFor: (market) => {
        seen.push(market);
        return market === 'intl';
      },
    });
    expect(adapterEnabledFor(adapter, 'intl')).toBe(true);
    expect(adapterEnabledFor(adapter, 'cn')).toBe(false);
    expect(seen).toEqual(['intl', 'cn']);
    expect(adapterEnabledFor(fake({ provider: 'activejobs', isEnabled: () => false, isEnabledFor: () => true }), 'cn')).toBe(true);
  });

  it('never throws: an adapter that throws while answering is off', () => {
    const boom = () => {
      throw new Error('env not readable');
    };
    expect(adapterEnabledFor(fake({ provider: 'jsearch', isEnabled: boom }), 'intl')).toBe(false);
    expect(adapterEnabledFor(fake({ provider: 'jsearch', isEnabled: () => true, isEnabledFor: boom }), 'cn')).toBe(false);
  });

  it('only a real true is on (an adapter written in a hurry may return undefined)', () => {
    expect(adapterEnabledFor(fake({ provider: 'usajobs', isEnabled: (() => undefined) as unknown as () => boolean }), 'intl')).toBe(false);
    expect(adapterEnabledFor(fake({ provider: 'usajobs', isEnabled: (() => 'yes') as unknown as () => boolean }), 'intl')).toBe(false);
  });

  it('the adapters ingest registers today answer without throwing, for both markets', () => {
    for (const adapter of [createRapidApiAdapter('jsearch'), createRapidApiAdapter('activejobs'), createAtsPublicAdapter(), createBankAdapter('robohire'), createBankAdapter('gohire')]) {
      for (const market of ['intl', 'cn'] as const) expect(typeof adapterEnabledFor(adapter, market), `${adapter.provider}:${market}`).toBe('boolean');
    }
  });
});
