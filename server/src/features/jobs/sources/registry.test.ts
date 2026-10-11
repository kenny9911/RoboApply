// @vitest-environment node
// The per-brand job source registry (GOAPPLY_PARITY_PLAN §3.9; MARKET_STRATEGY
// M-3, M-4, M-6, JI-2): which sources a brand has, what a call to each costs,
// how each is reached, whether it is on for the brand's market, and that the
// LinkedIn feed is a source of no brand. Pure: adapters are built or faked and
// never fetched from; no network, no database.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({
  default: {},
  prisma: {},
  createPrismaClientForUrl: vi.fn(() => ({ job: { findMany: vi.fn() } })),
  activeRuntimeUrl: () => 'postgresql://active.example/db',
  cleanConnectionString: (u: string | undefined) => u,
}));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand, type ProductBrand } from '../../../platform/brand/index.js';
import { logger } from '../../../services/LoggerService.js';
import { adaptersForBrand, listEnabledAdaptersFor, resetBuiltinAdaptersForTests, sourcesForBrand } from '../ingest/providers.js';
import { ensureAtsPublicAdapter } from './atsPublic/register.js';
import {
  adapterCostModel,
  jobSourceKind,
  jobSourceTransport,
  jobSourcesForBrand,
  registerSourceAdapter,
  resetJobSourceWarningsForTests,
  resetSourceAdaptersForTests,
  sourceProvidersForBrand,
} from './index.js';
import type { IngestProvider, JobSourceAdapter, SourceCostModel } from './index.js';

const robo = getBrand('roboapply');
const go = getBrand('goapply');

function fake(provider: IngestProvider, over: Partial<JobSourceAdapter> = {}): JobSourceAdapter {
  return {
    provider,
    kind: 'search',
    markets: ['intl'],
    sourceBoards: [provider],
    isEnabled: () => true,
    supportsCountry: () => true,
    dailyCallLimit: () => null,
    fetch: vi.fn(async () => ({ jobs: [], calls: 0 })),
    ...over,
  };
}

afterEach(() => {
  resetSourceAdaptersForTests();
  resetBuiltinAdaptersForTests();
  resetJobSourceWarningsForTests();
});

describe('cost model per source (JI-2)', () => {
  it('is reported for every registered source of both brands: JSearch per request, Active Jobs DB per job, the rest free', () => {
    ensureAtsPublicAdapter();
    const roboSources = sourcesForBrand(robo, {});
    expect(roboSources.map((s) => [s.provider, s.costModel])).toEqual([
      ['activejobs', 'per_job'],
      ['bank_robohire', 'free'],
      ['jsearch', 'per_request'],
      ['ats_public', 'free'],
      ['user_import', 'free'],
    ]);
    const goSources = sourcesForBrand(go, {});
    expect(goSources.map((s) => [s.provider, s.costModel])).toEqual([
      ['bank_gohire', 'free'],
      ['ats_public', 'free'],
      ['user_import', 'free'],
    ]);
    const models: readonly SourceCostModel[] = ['free', 'per_job', 'per_request'];
    for (const s of [...roboSources, ...goSources]) {
      expect(models, s.provider).toContain(s.costModel);
      // The registry and the planner read one rule: the description agrees with the adapter.
      if (s.adapter) expect(s.costModel, s.provider).toBe(adapterCostModel(s.adapter));
    }
    // The only source billed per request is the one that must never get an SEO seed query.
    expect(roboSources.filter((s) => s.costModel === 'per_request').map((s) => s.provider)).toEqual(['jsearch']);
    expect(goSources.filter((s) => s.costModel !== 'free')).toEqual([]);
  });

  it('is known for a source whose adapter is not registered (the provider id decides)', () => {
    const sources = jobSourcesForBrand(robo, {});
    expect(sources.every((s) => s.provider === 'user_import' || s.status().reason === 'not_registered')).toBe(true);
    expect(sources.map((s) => [s.provider, s.costModel])).toEqual([
      ['activejobs', 'per_job'],
      ['bank_robohire', 'free'],
      ['jsearch', 'per_request'],
      ['user_import', 'free'],
    ]);
  });

  it('the model an adapter declares wins over the default for its provider id', () => {
    registerSourceAdapter(fake('jsearch', { costModel: 'per_job' }));
    registerSourceAdapter(fake('usajobs', { costModel: 'per_request' }));
    registerSourceAdapter(fake('tw_open_data'));
    const byProvider = new Map(jobSourcesForBrand(robo, {}).map((s) => [s.provider, s.costModel]));
    expect(byProvider.get('jsearch')).toBe('per_job');
    expect(byProvider.get('usajobs')).toBe('per_request');
    expect(byProvider.get('tw_open_data')).toBe('free');
  });
});

describe('kind and transport of every provider id', () => {
  it('each provider ingest knows has a kind', () => {
    const kinds: Array<[IngestProvider, string]> = [
      ['activejobs', 'search'],
      ['activejobs_feed', 'search'],
      ['jsearch', 'search'],
      ['usajobs', 'search'],
      ['tw_open_data', 'search'],
      ['tw_gov_jobs', 'search'],
      ['bank_robohire', 'bank'],
      ['bank_gohire', 'bank'],
      ['ats_public', 'ats'],
      ['user_import', 'import'],
    ];
    for (const [provider, kind] of kinds) expect(jobSourceKind(provider), provider).toBe(kind);
  });

  it('the default transport: boards for the employer boards, the bank database for a bank, the marketplace for a search service, their own API for the government sources', () => {
    const transports: Array<[IngestProvider, string]> = [
      ['activejobs', 'rapidapi'],
      ['activejobs_feed', 'rapidapi'],
      ['jsearch', 'rapidapi'],
      ['usajobs', 'api'],
      ['tw_open_data', 'api'],
      ['tw_gov_jobs', 'api'],
      ['bank_robohire', 'db'],
      ['bank_gohire', 'db'],
      ['ats_public', 'board_api'],
      ['user_import', 'off'],
    ];
    for (const [provider, transport] of transports) expect(jobSourceTransport(provider), provider).toBe(transport);
  });

  it('a registered government source is described as reached on its own API, never through the search marketplace', () => {
    registerSourceAdapter(fake('tw_open_data', { kind: 'cursor' }));
    registerSourceAdapter(fake('usajobs', { kind: 'cursor', isEnabled: () => false }));
    const sources = jobSourcesForBrand(robo, {});
    expect(sources.find((s) => s.provider === 'tw_open_data')!.status()).toEqual({ enabled: true, transport: 'api', reason: null });
    expect(sources.find((s) => s.provider === 'tw_open_data')!.kind).toBe('search');
    expect(sources.find((s) => s.provider === 'usajobs')!.status()).toEqual({ enabled: false, transport: 'api', reason: 'disabled' });
    // What the adapter itself says wins.
    resetSourceAdaptersForTests();
    registerSourceAdapter(fake('tw_open_data', { transport: () => 'off', isEnabled: () => false, disabledReason: () => 'kill_switch' }));
    expect(jobSourcesForBrand(robo, {}).find((s) => s.provider === 'tw_open_data')!.status()).toEqual({ enabled: false, transport: 'off', reason: 'kill_switch' });
  });
});

describe('a source is on for a brand when its adapter is on for the brand\'s market', () => {
  it('an adapter that serves two markets and is on for one', () => {
    const boards = fake('ats_public', { kind: 'cursor', markets: ['intl', 'cn'], isEnabled: () => true, isEnabledFor: (market) => market === 'cn' });
    registerSourceAdapter(boards);
    const forRobo = jobSourcesForBrand(robo, {}).find((s) => s.provider === 'ats_public')!;
    const forGo = jobSourcesForBrand(go, {}).find((s) => s.provider === 'ats_public')!;
    expect(forRobo.enabled()).toBe(false);
    expect(forRobo.status()).toEqual({ enabled: false, transport: 'board_api', reason: 'disabled' });
    expect(forGo.enabled()).toBe(true);
    expect(forGo.status()).toEqual({ enabled: true, transport: 'board_api', reason: null });
  });

  it('an adapter that throws while answering is off, and the description never throws', () => {
    registerSourceAdapter(
      fake('jsearch', {
        isEnabled: () => {
          throw new Error('env not readable');
        },
        transport: () => {
          throw new Error('no transport');
        },
      }),
    );
    const source = jobSourcesForBrand(robo, {}).find((s) => s.provider === 'jsearch')!;
    expect(source.enabled()).toBe(false);
    expect(source.status()).toEqual({ enabled: false, transport: 'off', reason: 'disabled' });
    expect(source.transport).toBe('off');
  });

  it('listEnabledAdaptersFor: the brand\'s adapters that are on for its market, in registry order', () => {
    registerSourceAdapter(fake('activejobs', { isEnabled: () => false }));
    registerSourceAdapter(fake('jsearch'));
    registerSourceAdapter(fake('bank_robohire', { kind: 'cursor' }));
    registerSourceAdapter(fake('bank_gohire', { kind: 'cursor', markets: ['cn'], isEnabled: () => false }));
    registerSourceAdapter(fake('ats_public', { kind: 'cursor', markets: ['intl', 'cn'], isEnabledFor: (market) => market === 'cn' }));
    expect(adaptersForBrand(robo, {}).map((a) => a.provider)).toEqual(['activejobs', 'bank_robohire', 'jsearch', 'ats_public']);
    expect(listEnabledAdaptersFor(robo, {}).map((a) => a.provider)).toEqual(['bank_robohire', 'jsearch']);
    expect(adaptersForBrand(go, {}).map((a) => a.provider)).toEqual(['bank_gohire', 'ats_public']);
    expect(listEnabledAdaptersFor(go, {}).map((a) => a.provider)).toEqual(['ats_public']);
    // The narrowing variable applies to both lists.
    expect(listEnabledAdaptersFor(robo, { JOB_PROVIDERS_ROBOAPPLY: 'activejobs,bank_robohire' }).map((a) => a.provider)).toEqual(['bank_robohire']);
  });

  it('GoApply never has JSearch, on either list, whatever is registered or set', () => {
    registerSourceAdapter(fake('jsearch'));
    registerSourceAdapter(fake('activejobs'));
    registerSourceAdapter(fake('bank_gohire', { kind: 'cursor', markets: ['cn'] }));
    for (const env of [{}, { CN_EXTERNAL_PROVIDERS: 'jsearch' }, { JOB_PROVIDERS_GOAPPLY: 'jsearch,bank_gohire' }]) {
      expect(adaptersForBrand(go, env).map((a) => a.provider)).not.toContain('jsearch');
      expect(listEnabledAdaptersFor(go, env).map((a) => a.provider)).toEqual(['bank_gohire']);
      expect(sourceProvidersForBrand(go, env)).not.toContain('jsearch');
    }
  });
});

describe('the LinkedIn feed is a source of no brand (MARKET_STRATEGY M-4)', () => {
  const linkedin = 'linkedin' as IngestProvider;

  it('is in no brand\'s list', () => {
    for (const brand of [robo, go]) {
      expect(sourceProvidersForBrand(brand, {})).not.toContain(linkedin);
      expect(jobSourcesForBrand(brand, {}).map((s) => s.provider)).not.toContain(linkedin);
    }
  });

  it('an adapter registered under that id joins no brand through its market, and the narrowing variable cannot add it', () => {
    registerSourceAdapter(fake(linkedin, { markets: ['intl', 'cn'] }));
    for (const brand of [robo, go]) {
      expect(sourceProvidersForBrand(brand, {})).not.toContain(linkedin);
      expect(adaptersForBrand(brand, {}).map((a) => a.provider)).not.toContain(linkedin);
      expect(listEnabledAdaptersFor(brand, {}).map((a) => a.provider)).not.toContain(linkedin);
    }
    vi.mocked(logger.warn).mockClear();
    expect(sourceProvidersForBrand(robo, { JOB_PROVIDERS_ROBOAPPLY: 'linkedin,jsearch' })).toEqual(['jsearch', 'user_import']);
    // It is reported like any other name the brand does not have.
    expect(vi.mocked(logger.warn).mock.calls.some((c) => JSON.stringify(c).includes('linkedin'))).toBe(true);
  });

  it('a brand list that still names it does not make it a source', () => {
    const stale = { ...robo, jobProviders: ['activejobs', linkedin, 'jsearch', 'user_import'] } as unknown as ProductBrand;
    expect(sourceProvidersForBrand(stale, {})).toEqual(['activejobs', 'jsearch', 'user_import']);
    expect(jobSourcesForBrand(stale, {}).map((s) => s.provider)).toEqual(['activejobs', 'jsearch', 'user_import']);
  });
});
