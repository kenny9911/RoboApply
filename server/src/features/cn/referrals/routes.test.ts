// @vitest-environment node
//
// WP-54 route tests for the 内推码 hub: 401 without a session, 404
// feature_disabled with `cn.referralCodes` off, share → 201 pending,
// moderation through the admin router (403 for a non-admin chain), report,
// delete; sharing and reporting need a bound phone (403 phone_binding_required
// for a WeChat-only GoApply account, through WP-11's real gate).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { requirePhoneBound } from '../../auth-cn/index.js';
import { flagEnvName, setFlagOverrideLoader } from '../../../platform/flags.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { normalizeCompanyName } from '../../jobs/normalize/index.js';
import { createCnReferralsAdminRouter, createCnReferralsRouter } from './routes.js';
import { CnReferralService } from './service.js';
import { createMemoryReferralStore } from './store.js';

const BASE = '/api/v1/roboapply/cn/referrals';
const ADMIN = '/api/v1/roboapply/admin/cn/referrals';
const GO = 'goapply.localhost:3621';
type Env<T> = { success: boolean; data: T; code?: string };

const service = new CnReferralService({ store: createMemoryReferralStore(), brandId: () => 'goapply', normalizeCompany: normalizeCompanyName, now: () => new Date('2026-10-10T12:30:00Z') });
const seeker = fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: String(req.headers['x-user'] ?? 'u_a') }));
const adminOnly: RequestHandler = (req, res, next) => {
  if (req.headers['x-admin'] !== '1') {
    res.status(403).json({ success: false, code: 'forbidden' });
    return;
  }
  next();
};

// u_wx signed in with WeChat and has no verified phone; everyone else has one.
const authCnDb = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === 'u_wx' ? { brand: 'goapply', phoneE164: null, phoneVerifiedAt: null } : { brand: 'goapply', phoneE164: '+8613800000000', phoneVerifiedAt: new Date() },
  },
  rAAuthIdentity: { findFirst: async ({ where }: { where: { userId: string } }) => (where.userId === 'u_wx' ? { id: 'idn_1' } : null) },
};
const phoneGate = requirePhoneBound(authCnDb as never);

const ENV_ON = { [flagEnvName('goapply', 'cn.referralCodes')]: 'true' };
const ENV_OFF = { [flagEnvName('goapply', 'cn.referralCodes')]: 'false' };

let on: RouteHarness;
let off: RouteHarness;

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  on = await startRouteHarness({
    env: ENV_ON,
    mounts: [
      [BASE, createCnReferralsRouter({ seekerAuth: [seeker], env: ENV_ON }, { service, phoneGate })],
      [ADMIN, createCnReferralsAdminRouter({ adminAuth: [fakeAuth({ id: 'admin_1', role: 'admin' }), adminOnly] }, { service })],
    ],
  });
  off = await startRouteHarness({ env: ENV_OFF, mounts: [[BASE, createCnReferralsRouter({ seekerAuth: [seeker], env: ENV_OFF }, { service, phoneGate })]] });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([on.close(), off.close()]);
});

describe('cn referral routes', () => {
  let id = '';

  it('401 without a session', async () => {
    const res = await on.request('GET', BASE, { host: GO, headers: { 'x-test-anon': '1' } });
    expect(res.status).toBe(401);
  });

  it('404 feature_disabled with the capability off', async () => {
    const res = await off.request<Env<unknown>>('GET', BASE, { host: GO });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
  });

  it('POST / → 201 pending; 422 on a bad body', async () => {
    const res = await on.request<Env<{ id: string; status: string }>>('POST', BASE, { host: GO, body: { company: '示例科技', code: 'NT2027', programme: '2027届校园招聘' } });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
    id = res.body.data.id;
    const bad = await on.request<Env<unknown>>('POST', BASE, { host: GO, body: { company: '示例科技', code: 'x', phone: '1' } });
    expect(bad.status).toBe(422);
  });

  it('403 phone_binding_required: a WeChat-only account cannot share or report (and nothing is stored)', async () => {
    const share = await on.request<Env<unknown>>('POST', BASE, { host: GO, headers: { 'x-user': 'u_wx' }, body: { company: '示例科技', code: 'NT2099' } });
    expect(share.status).toBe(403);
    expect(share.body.code).toBe('phone_binding_required');
    const report = await on.request<Env<unknown>>('POST', `${BASE}/${id}/report`, { host: GO, headers: { 'x-user': 'u_wx' }, body: { reason: 'spam' } });
    expect(report.status).toBe(403);
    expect(report.body.code).toBe('phone_binding_required');
    const mine = await on.request<Env<{ mine: unknown[] }>>('GET', BASE, { host: GO, headers: { 'x-user': 'u_wx' } });
    expect(mine.status).toBe(200);
    expect(mine.body.data.mine).toEqual([]);
  });

  it('admin queue: 403 for a non-admin, then approve', async () => {
    const forbidden = await on.request('GET', `${ADMIN}/queue`, { host: GO });
    expect(forbidden.status).toBe(403);
    const queue = await on.request<Env<{ items: Array<{ id: string }> }>>('GET', `${ADMIN}/queue`, { host: GO, headers: { 'x-admin': '1' } });
    expect(queue.body.data.items.map((i) => i.id)).toEqual([id]);
    const noReason = await on.request<Env<unknown>>('POST', `${ADMIN}/${id}/moderate`, { host: GO, headers: { 'x-admin': '1' }, body: { decision: 'reject' } });
    expect(noReason.status).toBe(422);
    const ok = await on.request<Env<{ status: string }>>('POST', `${ADMIN}/${id}/moderate`, { host: GO, headers: { 'x-admin': '1' }, body: { decision: 'approve' } });
    expect(ok.body.data.status).toBe('approved');
  });

  it('GET / lists the approved code for another user; report; delete by the sharer', async () => {
    const list = await on.request<Env<{ items: Array<{ id: string; mine: boolean }> }>>('GET', BASE, { host: GO, headers: { 'x-user': 'u_b' } });
    expect(list.body.data.items).toEqual([expect.objectContaining({ id, mine: false })]);
    const report = await on.request<Env<unknown>>('POST', `${BASE}/${id}/report`, { host: GO, headers: { 'x-user': 'u_b' }, body: { reason: 'expired' } });
    expect(report.status).toBe(200);
    const notMine = await on.request<Env<unknown>>('DELETE', `${BASE}/${id}`, { host: GO, headers: { 'x-user': 'u_b' } });
    expect(notMine.status).toBe(404);
    const del = await on.request<Env<unknown>>('DELETE', `${BASE}/${id}`, { host: GO });
    expect(del.status).toBe(200);
  });
});
