// @vitest-environment node
//
// The inventory pipeline's public surface exports the provider call limit
// other areas display (WP-93: the admin "Limits" page reads it from here
// instead of a copy).

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import * as config from './config.js';
import * as ingest from './index.js';

describe('jobs/ingest/index.ts limit export', () => {
  it('dailyCallLimit is the config module’s own (no second definition)', () => {
    expect(ingest.dailyCallLimit).toBe(config.dailyCallLimit);
  });

  it('reads INGEST_<PROVIDER>_DAILY_CALLS with the default behind it; an unmetered provider has no limit', () => {
    expect(ingest.dailyCallLimit('activejobs', {})).toBe(config.DEFAULT_DAILY_CALLS.activejobs);
    expect(ingest.dailyCallLimit('jsearch', { INGEST_JSEARCH_DAILY_CALLS: '40' })).toBe(40);
    expect(ingest.dailyCallLimit('bank_gohire', {})).toBeNull();
  });
});
