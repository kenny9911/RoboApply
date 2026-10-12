// @vitest-environment node
// MKT-1C: the provider quota snapshot contract (MARKET_STRATEGY §1.2 tier 0 and
// JI-1; MARKET_TASK_PLAN "Quota snapshot"). Pure: no network, no database.
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_QUOTA_CONFIG_KEY,
  PROVIDER_QUOTA_STATES,
  PROVIDER_QUOTA_VERSION,
  daysToReset,
  parseProviderQuota,
  serializeProviderQuota,
  usageKey,
  type ProviderQuotaSnapshot,
} from './quotaContract.js';

const NOW = new Date('2026-10-11T00:00:00.000Z');
const DAY = 86_400_000;

// SYNTHETIC snapshots (the shape a 429 from a RapidAPI plan would be recorded in).
const ACTIVE_JOBS: ProviderQuotaSnapshot = {
  provider: 'activejobs',
  plan: 'BASIC',
  requestsLimit: 25,
  requestsRemaining: 0,
  jobsLimit: 250,
  jobsRemaining: 0,
  resetAt: '2026-10-28T00:00:00.000Z',
  observedAt: '2026-10-11T00:00:00.000Z',
  lastStatus: 429,
  lastCallCost: 1,
  state: 'exhausted',
};
const JSEARCH: ProviderQuotaSnapshot = {
  provider: 'jsearch',
  plan: null,
  requestsLimit: 10_000,
  requestsRemaining: 9_770,
  jobsLimit: null,
  jobsRemaining: null,
  resetAt: null,
  observedAt: '2026-10-10T12:30:00.000Z',
  lastStatus: 200,
  lastCallCost: 1,
  state: 'ok',
};

describe('the AppConfig row', () => {
  it('has one key and one version', () => {
    expect(PROVIDER_QUOTA_CONFIG_KEY).toBe('jobs.providerQuota.v1');
    expect(PROVIDER_QUOTA_VERSION).toBe(1);
    expect([...PROVIDER_QUOTA_STATES]).toEqual(['ok', 'exhausted', 'not_subscribed', 'unauthorized', 'unknown']);
  });
});

describe('serializeProviderQuota / parseProviderQuota', () => {
  it('round-trips snapshots, from a list or a map', () => {
    const text = serializeProviderQuota([ACTIVE_JOBS, JSEARCH]);
    expect(JSON.parse(text)).toEqual({ version: 1, providers: { activejobs: ACTIVE_JOBS, jsearch: JSEARCH } });
    const parsed = parseProviderQuota(text);
    expect(parsed).toBeInstanceOf(Map);
    expect([...parsed.keys()]).toEqual(['activejobs', 'jsearch']);
    expect(parsed.get('activejobs')).toEqual(ACTIVE_JOBS);
    expect(parsed.get('jsearch')).toEqual(JSEARCH);
    // A map (what parse returns) serialises to the same text: read, change one provider, write back.
    expect(serializeProviderQuota(parsed)).toBe(text);
    expect(serializeProviderQuota(new Map([...parsed].reverse()))).toBe(text);
  });

  it('writes providers in a stable order and nothing but the contract fields', () => {
    const noisy = { ...JSEARCH, apiKey: 'never-stored', headers: { 'x-rapidapi-key': 'never-stored' } } as ProviderQuotaSnapshot;
    const text = serializeProviderQuota([noisy, ACTIVE_JOBS]);
    expect(text).not.toContain('never-stored');
    expect(Object.keys(JSON.parse(text).providers)).toEqual(['activejobs', 'jsearch']);
    expect(Object.keys(JSON.parse(text).providers.jsearch)).toEqual([
      'provider',
      'plan',
      'requestsLimit',
      'requestsRemaining',
      'jobsLimit',
      'jobsRemaining',
      'resetAt',
      'observedAt',
      'lastStatus',
      'lastCallCost',
      'state',
    ]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['blank', '   '],
    ['not JSON', 'x'],
    ['cut-off JSON', '{"version":1,"providers":{'],
    ['a wrong version (text)', '{"version":2,"providers":{"jsearch":{}}}'],
    ['a wrong version (object)', { version: 2 }],
    ['no version', '{"providers":{}}'],
    ['a JSON array', '[]'],
    ['a JSON string', '"jobs"'],
    ['a JSON number', '1'],
    ['JSON null', 'null'],
    ['providers is a list', '{"version":1,"providers":[]}'],
    ['providers missing', '{"version":1}'],
  ])('%s gives an empty map', (_label, raw) => {
    const parsed = parseProviderQuota(raw as string | null | undefined);
    expect(parsed).toBeInstanceOf(Map);
    expect(parsed.size).toBe(0);
  });

  it('is tolerant per entry: a bad snapshot is dropped, a bad field becomes null or unknown', () => {
    const text = JSON.stringify({
      version: 1,
      providers: {
        jsearch: { ...JSEARCH, provider: 'something_else', requestsRemaining: '9770', jobsLimit: -1, lastStatus: 'ok', state: 'healthy', plan: '  ', resetAt: 'soon', lastCallCost: 1.5 },
        no_time: { ...ACTIVE_JOBS, provider: 'no_time', observedAt: 'yesterday' },
        not_an_object: 'BASIC',
        '': { ...ACTIVE_JOBS, provider: '' },
      },
    });
    const parsed = parseProviderQuota(text);
    expect([...parsed.keys()]).toEqual(['jsearch']);
    expect(parsed.get('jsearch')).toEqual({
      ...JSEARCH,
      // The key of the map is the provider.
      provider: 'jsearch',
      // A count is a number, never a string someone has to parse again.
      requestsRemaining: null,
      jobsLimit: null,
      lastStatus: null,
      state: 'unknown',
      plan: null,
      resetAt: null,
      lastCallCost: 1.5,
    });
  });

  it('accepts the already-parsed object too, and normalises dates to ISO', () => {
    const parsed = parseProviderQuota({ version: 1, providers: { usajobs: { ...JSEARCH, provider: 'usajobs', observedAt: '2026-10-10T12:30:00Z', resetAt: '2026-11-01' } } });
    expect(parsed.get('usajobs')).toMatchObject({ provider: 'usajobs', observedAt: '2026-10-10T12:30:00.000Z', resetAt: '2026-11-01T00:00:00.000Z' });
  });

  it('never states a plan the provider did not name, and keeps a mainland usage key apart', () => {
    const cn: ProviderQuotaSnapshot = { ...JSEARCH, provider: 'activejobs:cn', plan: null, state: 'not_subscribed', lastStatus: 403 };
    const parsed = parseProviderQuota(serializeProviderQuota([cn, ACTIVE_JOBS]));
    expect(parsed.get('activejobs:cn')).toEqual(cn);
    expect(parsed.get('activejobs')?.plan).toBe('BASIC');
    expect(parsed.get('activejobs:cn')?.plan).toBeNull();
  });

  // Review finding: for a map the key is the provider, as it is on the way back in. Keyed by the snapshot's
  // own `provider` field, a mainland reading stored under 'activejobs:cn' overwrote the international one.
  it('a map is written by its keys: two keys with the same provider field stay two entries', () => {
    const intl: ProviderQuotaSnapshot = { ...ACTIVE_JOBS };
    const cn: ProviderQuotaSnapshot = { ...ACTIVE_JOBS, plan: null, requestsRemaining: 7, state: 'ok', lastStatus: 200 };
    const map = new Map<string, ProviderQuotaSnapshot>([
      ['activejobs', intl],
      ['activejobs:cn', cn],
    ]);
    const text = serializeProviderQuota(map);
    const doc = JSON.parse(text) as { providers: Record<string, ProviderQuotaSnapshot> };
    expect(Object.keys(doc.providers)).toEqual(['activejobs', 'activejobs:cn']);
    // Each entry says the key it is stored under (the same rule parse applies).
    expect(doc.providers['activejobs']).toEqual(intl);
    expect(doc.providers['activejobs:cn']).toEqual({ ...cn, provider: 'activejobs:cn' });
    const parsed = parseProviderQuota(text);
    expect(parsed.size).toBe(2);
    expect(parsed.get('activejobs')).toEqual(intl);
    expect(parsed.get('activejobs:cn')).toMatchObject({ provider: 'activejobs:cn', requestsRemaining: 7, state: 'ok' });
    // Read, write back, read: nothing merges and nothing moves.
    expect(serializeProviderQuota(parsed)).toBe(text);
    // A blank key is not a provider; a list is still keyed by each snapshot's own field, last one wins.
    expect(JSON.parse(serializeProviderQuota(new Map([['  ', intl]])))).toEqual({ version: 1, providers: {} });
    expect(Object.keys((JSON.parse(serializeProviderQuota([intl, cn])) as { providers: object }).providers)).toEqual(['activejobs']);
    expect(parseProviderQuota(serializeProviderQuota([intl, cn])).get('activejobs')?.requestsRemaining).toBe(7);
  });

  it('serialising nothing is a valid empty document', () => {
    expect(serializeProviderQuota([])).toBe('{"version":1,"providers":{}}');
    expect(parseProviderQuota(serializeProviderQuota([])).size).toBe(0);
  });
});

describe('daysToReset', () => {
  const at = (ms: number): ProviderQuotaSnapshot => ({ ...ACTIVE_JOBS, resetAt: new Date(NOW.getTime() + ms).toISOString() });

  it('rounds up: a reset 16.9 days ahead is 17 days', () => {
    expect(daysToReset(at(16.9 * DAY), NOW)).toBe(17);
    expect(daysToReset(ACTIVE_JOBS, NOW)).toBe(17);
    expect(daysToReset(at(DAY), NOW)).toBe(1);
    expect(daysToReset(at(DAY + 1), NOW)).toBe(2);
    expect(daysToReset(at(60_000), NOW)).toBe(1);
  });

  it('is 0 for a reset that has passed, or is now', () => {
    expect(daysToReset(at(-1), NOW)).toBe(0);
    expect(daysToReset(at(-40 * DAY), NOW)).toBe(0);
    expect(daysToReset(at(0), NOW)).toBe(0);
  });

  it('is null without a reset time (never a guess)', () => {
    expect(daysToReset(JSEARCH, NOW)).toBeNull();
    expect(daysToReset({ ...JSEARCH, resetAt: 'soon' }, NOW)).toBeNull();
    expect(daysToReset(null, NOW)).toBeNull();
    expect(daysToReset(undefined, NOW)).toBeNull();
    expect(daysToReset(ACTIVE_JOBS, new Date(Number.NaN))).toBeNull();
  });
});

describe('usageKey', () => {
  it('counts mainland calls under <provider>:cn and everything else under the provider', () => {
    expect(usageKey('activejobs', 'cn')).toBe('activejobs:cn');
    expect(usageKey('activejobs', 'intl')).toBe('activejobs');
    expect(usageKey('jsearch', 'intl')).toBe('jsearch');
    expect(usageKey('activejobs_feed', 'cn')).toBe('activejobs_feed:cn');
  });
});
