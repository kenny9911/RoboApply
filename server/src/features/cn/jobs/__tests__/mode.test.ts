// @vitest-environment node
// WP-41 / R-14: recruitment-info mode helpers.

import { describe, expect, it } from 'vitest';
import express from 'express';
import { getBrand } from '../../../../platform/brand/index.js';
import { startRouteHarness } from '../../../../test/routeHarness.js';
import {
  assertCnPostingVisible,
  cnJobCapabilities,
  cnPostingVisible,
  cnPostingsWhere,
  cnRecruitmentMode,
  filterCnPostings,
  isThirdPartyPosting,
  requireCnRecruitmentInfo,
} from '../mode.js';

const OFF = {};
const PARTNER = { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' };
const LICENSED = { CN_RECRUITMENT_INFO_MODE: 'licensed', CN_HR_LICENCE_HOLDER: 'H', CN_HR_LICENCE_NUMBER: 'N' };

const gohireJob = { market: 'cn', visibility: 'public', provider: 'bank_gohire', ownerUserId: null };
const ownImport = { market: 'cn', visibility: 'private', provider: 'user_import', ownerUserId: 'u1' };
const intlJob = { market: 'intl', visibility: 'public' };

describe('mode', () => {
  it('defaults to off; unknown values are off', () => {
    expect(cnRecruitmentMode(OFF)).toBe('off');
    expect(cnRecruitmentMode({ CN_RECRUITMENT_INFO_MODE: 'yes' })).toBe('off');
    expect(cnRecruitmentMode(PARTNER)).toBe('partner_deeplink');
  });

  it('capabilities', () => {
    expect(cnJobCapabilities(OFF)).toMatchObject({ postings: false, feed: false, recommendations: false, alerts: false, licence: null });
    expect(cnJobCapabilities(PARTNER)).toMatchObject({ postings: true, applyVia: 'partner', licence: null });
    expect(cnJobCapabilities(LICENSED)).toMatchObject({ postings: true, applyVia: 'source', licence: { holder: 'H', number: 'N' } });
    // The licence line is never shown in mode off, even when env has it.
    expect(cnJobCapabilities({ ...LICENSED, CN_RECRUITMENT_INFO_MODE: 'off' }).licence).toBeNull();
  });
});

describe('per-row visibility', () => {
  it('mode off: only the viewer’s own imports', () => {
    expect(isThirdPartyPosting(gohireJob)).toBe(true);
    expect(isThirdPartyPosting(ownImport)).toBe(false);
    expect(cnPostingVisible(gohireJob, 'u1', OFF)).toBe(false);
    expect(cnPostingVisible(ownImport, 'u1', OFF)).toBe(true);
    expect(cnPostingVisible(ownImport, 'u2', OFF)).toBe(false);
    expect(cnPostingVisible(ownImport, null, PARTNER)).toBe(false);
    expect(cnPostingVisible(intlJob, null, OFF)).toBe(true);
    expect(filterCnPostings([gohireJob, ownImport, intlJob], 'u1', OFF)).toEqual([ownImport, intlJob]);
    expect(() => assertCnPostingVisible(gohireJob, 'u1', OFF)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('partner/licensed: postings and own imports', () => {
    expect(cnPostingVisible(gohireJob, null, PARTNER)).toBe(true);
    expect(filterCnPostings([gohireJob, ownImport], 'u1', LICENSED)).toHaveLength(2);
  });

  it('list where-fragment', () => {
    expect(cnPostingsWhere('u1', OFF)).toEqual({ OR: [{ visibility: 'private', ownerUserId: 'u1' }] });
    expect(cnPostingsWhere(null, OFF)).toEqual({ OR: [{ id: { in: [] } }] });
    expect(cnPostingsWhere('u1', PARTNER)).toEqual({ OR: [{ visibility: 'public' }, { visibility: 'private', ownerUserId: 'u1' }] });
  });
});

describe('requireCnRecruitmentInfo', () => {
  it('GoApply + off → 404 feature_disabled; RoboApply and modes on pass', async () => {
    const router = (env: Record<string, string>) => {
      const r = express.Router();
      r.get('/', requireCnRecruitmentInfo({ env }), (_req, res) => res.json({ success: true, data: { items: [gohireJob] } }));
      return r;
    };
    const h = await startRouteHarness({ mounts: [['/off', router(OFF)], ['/on', router(PARTNER)]] });
    try {
      const off = await h.request<{ code?: string }>('GET', '/off', { host: 'goapply.localhost:3621' });
      expect(off.status).toBe(404);
      expect(off.body.code).toBe('feature_disabled');
      expect((await h.request('GET', '/off', { host: 'localhost:3621' })).status).toBe(200);
      expect((await h.request('GET', '/on', { host: 'goapply.localhost:3621' })).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('accepts an explicit brand source', () => {
    const mw = requireCnRecruitmentInfo({ env: OFF, brand: () => getBrand('goapply') });
    let status = 0;
    const res = { status: (s: number) => ((status = s), { json: () => undefined }) } as unknown as express.Response;
    mw({} as express.Request, res, () => undefined);
    expect(status).toBe(404);
  });
});
