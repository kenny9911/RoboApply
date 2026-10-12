// @vitest-environment node
//
// WP-54 acceptance for the GoApply 内推码 hub: a shared code needs moderation
// before anyone else sees it; it carries its share date; reports hide it
// after 3; contact details are refused; the sharer can delete it; the admin
// queue lists new and reported codes. Prisma-backed storage waits on SR-54-1.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { HttpError } from '../../../platform/http.js';
import { normalizeCompanyName } from '../../jobs/normalize/index.js';
import { REFERRAL_REPORTS_TO_HIDE, REFERRAL_SHARES_PER_DAY } from './contract.js';
import { CnReferralService, hasContactDetails } from './service.js';
import { createMemoryReferralStore, createPrismaReferralStore } from './store.js';

const NOW = new Date('2026-10-10T12:30:00Z');

function setup(brand = 'goapply') {
  const store = createMemoryReferralStore();
  const service = new CnReferralService({ store, brandId: () => brand, normalizeCompany: normalizeCompanyName, now: () => NOW });
  return { store, service };
}

async function err(p: Promise<unknown>): Promise<{ code: string; reason?: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return { code: e.code, reason: (e.details as { reason?: unknown } | undefined)?.reason };
    throw e;
  }
  throw new Error('expected an HttpError');
}

const SHARE = { company: '示例科技有限公司', code: 'NT2027ABC', programme: '2027届校园招聘', expiresAt: '2026-12-31' };

describe('CnReferralService', () => {
  it('a new code is pending: the sharer sees it, nobody else does', async () => {
    const { service } = setup();
    const mine = await service.create('u_a', SHARE);
    expect(mine).toMatchObject({ status: 'pending', mine: true, company: '示例科技有限公司', expiresAt: '2026-12-31' });
    expect((await service.list('u_b', {})).items).toEqual([]);
    expect((await service.list('u_a', {})).mine.map((c) => c.id)).toEqual([mine.id]);
  });

  it('approved by a moderator → listed with its share date; filters by company and class year', async () => {
    const { service } = setup();
    const c = await service.create('u_a', SHARE);
    await service.moderate('admin_1', c.id, { decision: 'approve' });
    const list = await service.list('u_b', {});
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: 'approved', mine: false, sharedAt: expect.stringMatching(/^2026-10-10T/), reportedByMe: false });
    expect((await service.list('u_b', { company: '示例科技' })).items).toHaveLength(1);
    expect((await service.list('u_b', { company: '别的公司' })).items).toHaveLength(0);
    expect((await service.list('u_b', { classYear: 2027 })).items).toHaveLength(1);
    expect((await service.list('u_b', { classYear: 2026 })).items).toHaveLength(0);
  });

  it('rejected codes stay off the list; the sharer sees the reason', async () => {
    const { service } = setup();
    const c = await service.create('u_a', SHARE);
    await service.moderate('admin_1', c.id, { decision: 'reject', reason: 'paid_or_traded' });
    expect((await service.list('u_b', {})).items).toEqual([]);
    expect((await service.list('u_a', {})).mine[0]).toMatchObject({ status: 'rejected', rejectReason: 'paid_or_traded' });
  });

  it('expired codes drop off the list', async () => {
    const { service, store } = setup();
    const c = await service.create('u_a', SHARE);
    await service.moderate('admin_1', c.id, { decision: 'approve' });
    store.codes[0]!.expiresAt = new Date('2026-10-09T00:00:00Z');
    expect((await service.list('u_b', {})).items).toEqual([]);
    expect((await service.list('u_a', {})).mine[0]!.status).toBe('expired');
  });

  it('refuses a past expiry, a duplicate, contact details and a 11th share in a day', async () => {
    const { service } = setup();
    expect(await err(service.create('u_a', { ...SHARE, expiresAt: '2026-10-01' }))).toMatchObject({ reason: 'expiry_past' });
    await service.create('u_a', SHARE);
    expect(await err(service.create('u_b', { ...SHARE, company: '示例科技' }))).toMatchObject({ code: 'conflict', reason: 'referral_code_duplicate' });
    expect(await err(service.create('u_a', { ...SHARE, code: 'X1', note: '加我微信 abc_12345' }))).toMatchObject({ reason: 'referral_contact_details' });
    expect(await err(service.create('u_a', { ...SHARE, code: 'X2', note: '电话 138 1234 5678' }))).toMatchObject({ reason: 'referral_contact_details' });
    for (let i = 1; i < REFERRAL_SHARES_PER_DAY; i++) await service.create('u_a', { ...SHARE, code: `CODE${i}` });
    expect(await err(service.create('u_a', { ...SHARE, code: 'ONEMORE' }))).toMatchObject({ code: 'rate_limited', reason: 'referral_share_limit' });
  });

  it(`${REFERRAL_REPORTS_TO_HIDE} reports hide a code until a moderator approves it again; one report per user`, async () => {
    const { service } = setup();
    const c = await service.create('u_a', SHARE);
    await service.moderate('admin_1', c.id, { decision: 'approve' });
    await service.report('u_b', c.id, { reason: 'expired' });
    expect(await err(service.report('u_b', c.id, { reason: 'invalid' }))).toMatchObject({ reason: 'referral_already_reported' });
    expect((await service.list('u_b', {})).items[0]!.reportedByMe).toBe(true);
    expect(await err(service.report('u_a', c.id, { reason: 'spam' }))).toMatchObject({ reason: 'own_code' });
    await service.report('u_c', c.id, { reason: 'invalid' });
    await service.report('u_d', c.id, { reason: 'paid' });
    expect((await service.list('u_e', {})).items).toEqual([]);
    const queue = await service.queue({});
    expect(queue.items).toEqual([expect.objectContaining({ id: c.id, queue: 'reported', reportCount: 3, reports: expect.arrayContaining([expect.objectContaining({ reason: 'paid' })]) })]);
    await service.moderate('admin_1', c.id, { decision: 'approve' });
    expect((await service.list('u_e', {})).items).toHaveLength(1);
  });

  it('a pending code cannot be reported by others (it is not public)', async () => {
    const { service } = setup();
    const c = await service.create('u_a', SHARE);
    expect(await err(service.report('u_b', c.id, { reason: 'spam' }))).toMatchObject({ code: 'not_found' });
  });

  it('only the sharer can delete; another brand’s code is not found', async () => {
    const { service, store } = setup();
    const c = await service.create('u_a', SHARE);
    expect(await err(service.remove('u_b', c.id))).toMatchObject({ code: 'not_found' });
    const other = new CnReferralService({ store, brandId: () => 'roboapply', normalizeCompany: normalizeCompanyName, now: () => NOW });
    expect(await err(other.remove('u_a', c.id))).toMatchObject({ code: 'not_found' });
    await expect(service.remove('u_a', c.id)).resolves.toEqual({ deleted: true });
    // Soft delete: gone from every list, never reported, moderated or deleted again.
    expect(store.codes[0]).toMatchObject({ status: 'deleted', note: null });
    expect((await service.list('u_a', {})).mine).toEqual([]);
    expect((await service.queue({})).items).toEqual([]);
    expect(await err(service.remove('u_a', c.id))).toMatchObject({ code: 'not_found' });
    expect(await err(service.moderate('admin_1', c.id, { decision: 'approve' }))).toMatchObject({ code: 'not_found' });
  });

  it('delete-and-reshare cannot get past the daily cap (deleted codes still count)', async () => {
    const { service } = setup();
    for (let i = 0; i < REFERRAL_SHARES_PER_DAY; i++) {
      const c = await service.create('u_a', SHARE);
      await service.remove('u_a', c.id);
    }
    expect(await err(service.create('u_a', SHARE))).toMatchObject({ code: 'rate_limited', reason: 'referral_share_limit' });
  });

  it(`concurrent reports all count: ${REFERRAL_REPORTS_TO_HIDE} at once hide the code`, async () => {
    const { service, store } = setup();
    const c = await service.create('u_a', SHARE);
    await service.moderate('admin_1', c.id, { decision: 'approve' });
    await Promise.all(['u_b', 'u_c', 'u_d'].map((u) => service.report(u, c.id, { reason: 'invalid' })));
    expect(store.codes[0]!.reportCount).toBe(REFERRAL_REPORTS_TO_HIDE);
    expect(store.codes[0]!.hiddenAt).not.toBeNull();
    expect((await service.list('u_e', {})).items).toEqual([]);
  });

  it('Prisma adapter: the report count is an atomic increment; delete is a soft delete', async () => {
    const update = vi.fn(async (args: { where: { id: string } }) => ({ id: args.where.id, reportCount: 1 }));
    const delegate = { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update, count: vi.fn() };
    const store = createPrismaReferralStore({ rACnReferralCode: delegate, rACnReferralReport: delegate });
    await store.incrementReportCount('rc_1');
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'rc_1' }, data: { reportCount: { increment: 1 } } }));
    await store.remove('rc_1');
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'rc_1' }, data: { status: 'deleted', note: null, hiddenAt: null } }));
    await store.listMine('u_a', 'goapply', 5);
    expect(delegate.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { userId: 'u_a', brand: 'goapply', status: { not: 'deleted' } } }));
  });

  it('the queue lists new codes first-come', async () => {
    const { service } = setup();
    const a = await service.create('u_a', SHARE);
    const b = await service.create('u_b', { ...SHARE, code: 'OTHER1' });
    expect((await service.queue({})).items.map((i) => [i.id, i.queue, i.userId])).toEqual([
      [a.id, 'new', 'u_a'],
      [b.id, 'new', 'u_b'],
    ]);
  });

  it('503 storage_unavailable until SR-54-1 is in the database client', async () => {
    const service = new CnReferralService({ store: createPrismaReferralStore({}), brandId: () => 'goapply', normalizeCompany: normalizeCompanyName, now: () => NOW });
    expect(await err(service.list('u_a', {}))).toMatchObject({ code: 'storage_unavailable' });
    expect(await err(service.create('u_a', SHARE))).toMatchObject({ code: 'storage_unavailable' });
  });

  it.todo('SR-54-1: the Prisma store round-trips RACnReferralCode / RACnReferralReport rows (after SCHEMA-4)');
});

describe('hasContactDetails', () => {
  it.each([
    ['加我vx: wxid_abcdef', true],
    ['call 13812345678', true],
    ['mail me hr@example.com', true],
    ['see www.example.cn', true],
    ['2027届秋招 技术岗', false],
    ['', false],
  ])('%s → %s', (text, expected) => {
    expect(hasContactDetails(text)).toBe(expected);
  });

  it('a code may be a long run of digits', () => {
    expect(hasContactDetails('NT20271234567', 'code')).toBe(false);
    expect(hasContactDetails('NT20271234567')).toBe(true);
  });
});
