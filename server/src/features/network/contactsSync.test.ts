// @vitest-environment node
//
// WP-54 / H15: the contacts-sync is the only writer of consentBasis. It sets
// it only from an opt-in record read through the bank's API (record id +
// timestamp in sourceRef), writes nothing when the API or the bank is not
// configured, and removes contacts whose opt-in was withdrawn.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { BRANDS } from '../../platform/brand/registry.js';
import { normalizeCompanyName } from '../jobs/normalize/index.js';
import { bankJobPosterReader, bankRecruiterReader, optInApiReader, recruiterIdOf, syncContacts, syncSourceRef, type ContactsSyncPorts, type OptInRecord } from './contactsSync.js';
import { runContactsSync } from './cron.js';

const NOW = new Date('2026-10-10T04:45:00Z');

function record(over: Partial<OptInRecord> = {}): OptInRecord {
  return { id: 'opt_1', recruiterUserId: 'u_1', optedIn: true, optedInAt: '2026-09-01T00:00:00Z', withdrawnAt: null, consentTextVersion: '2', ...over };
}

function ports(records: OptInRecord[] | null, existing: Array<{ id: string; sourceRef: string | null }> = []) {
  const upserts: Parameters<ContactsSyncPorts['upsert']>[0][] = [];
  const removed: string[] = [];
  const p: ContactsSyncPorts = {
    bank: 'robohire',
    fetchOptInRecords: async () => records,
    bankReader: () => ({
      readRecruiters: async (ids) =>
        [
          { id: 'u_1', name: 'Rita Recruiter', jobTitle: 'Talent Partner', company: 'Acme Analytics, Inc.' },
          { id: 'u_2', name: 'Sam Sourcer', jobTitle: null, company: 'Globex' },
          { id: 'u_3', name: '', jobTitle: null, company: 'Nameless' },
        ].filter((r) => ids.includes(r.id)),
    }),
    listSynced: async () => existing,
    upsert: async (input) => {
      upserts.push(input);
    },
    remove: async (ids) => {
      removed.push(...ids);
      return ids.length;
    },
    normalizeCompany: normalizeCompanyName,
  };
  return { p, upserts, removed };
}

describe('syncContacts', () => {
  it('writes nothing when the opt-in API is not configured', async () => {
    const { p, upserts, removed } = ports(null, [{ id: 'c1', sourceRef: 'robohire:u_1|optin:x@2026-01-01T00:00:00.000Z' }]);
    expect(await syncContacts(p, 'intl', NOW)).toEqual({ skipped: 'optin_api_not_configured', processed: 0 });
    expect(upserts).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('writes nothing when the bank is switched off', async () => {
    const { p, upserts } = ports([record()]);
    p.bankReader = () => null;
    expect((await syncContacts(p, 'intl', NOW)).skipped).toBe('bank_not_configured');
    expect(upserts).toEqual([]);
  });

  it('sets consentBasis and sourceRef only from an opt-in record', async () => {
    const { p, upserts } = ports([record()]);
    const res = await syncContacts(p, 'intl', NOW);
    expect(res).toMatchObject({ upserted: 1, removed: 0 });
    expect(upserts).toEqual([
      {
        existingId: null,
        market: 'intl',
        sourceRef: 'robohire:u_1|optin:opt_1@2026-09-01T00:00:00.000Z',
        consentBasis: 'recruiter_opt_in:opt_1:v2',
        companyNameNormalized: 'acme analytics',
        // SR-54-2: the company as the recruiter's profile writes it, for display outside a job page.
        companyName: 'Acme Analytics, Inc.',
        fullName: 'Rita Recruiter',
        firstName: 'Rita',
        title: 'Talent Partner',
      },
    ]);
  });

  it('withdrawn, not-opted-in and future records create nothing and remove existing rows', async () => {
    const { p, upserts, removed } = ports(
      [record({ withdrawnAt: '2026-10-01T00:00:00Z' }), record({ id: 'opt_2', recruiterUserId: 'u_2', optedIn: false }), record({ id: 'opt_3', recruiterUserId: 'u_2', optedInAt: '2027-01-01T00:00:00Z' })],
      [
        { id: 'c1', sourceRef: 'robohire:u_1|optin:opt_1@2026-09-01T00:00:00.000Z' },
        { id: 'c2', sourceRef: 'robohire:u_2|optin:opt_0@2026-08-01T00:00:00.000Z' },
      ],
    );
    await syncContacts(p, 'intl', NOW);
    expect(upserts).toEqual([]);
    expect(removed.sort()).toEqual(['c1', 'c2']);
  });

  it('updates the existing row for a recruiter and removes recruiters no longer listed', async () => {
    const { p, upserts, removed } = ports([record()], [
      { id: 'c1', sourceRef: 'robohire:u_1|optin:old@2026-01-01T00:00:00.000Z' },
      { id: 'c9', sourceRef: 'robohire:u_9|optin:o@2026-01-01T00:00:00.000Z' },
    ]);
    await syncContacts(p, 'intl', NOW);
    expect(upserts[0]!.existingId).toBe('c1');
    expect(removed).toEqual(['c9']);
  });

  it('the newest record per recruiter decides', async () => {
    const { p, upserts } = ports([record({ id: 'opt_new', optedInAt: '2026-09-10T00:00:00Z', withdrawnAt: '2026-09-20T00:00:00Z' }), record()]);
    await syncContacts(p, 'intl', NOW);
    expect(upserts).toEqual([]);
  });

  it('a recruiter without a name or company in the bank is not listed (never filled in)', async () => {
    const { p, upserts } = ports([record({ id: 'o3', recruiterUserId: 'u_3' }), record({ id: 'o4', recruiterUserId: 'u_missing' })]);
    const res = await syncContacts(p, 'intl', NOW);
    expect(upserts).toEqual([]);
    expect(res.skippedNoProfile).toBe(2);
  });
});

describe('ports', () => {
  it('sourceRef round-trips the recruiter id', () => {
    const ref = syncSourceRef('gohire', record({ recruiterUserId: 'abc' }));
    expect(recruiterIdOf('gohire', ref)).toBe('abc');
    expect(recruiterIdOf('robohire', ref)).toBeNull();
  });

  it('the API reader is per brand (CN_ prefix for GoApply, no fallback) and pages', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const page = new URL(url).searchParams.get('cursor');
      const body = page ? { records: [record({ id: 'opt_2', recruiterUserId: 'u_2' })], next: null } : { records: [record()], next: 'p2' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const env = { CONTACT_OPTIN_API_URL: 'https://robohire.example/api/optins', CONTACT_OPTIN_API_KEY: 'k' };
    expect(await optInApiReader(BRANDS.goapply, env, fetchImpl)()).toBeNull();
    const all = await optInApiReader(BRANDS.roboapply, env, fetchImpl)();
    expect(all?.map((r) => r.id)).toEqual(['opt_1', 'opt_2']);
    const [, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('the API reader refuses a plain-http remote URL and throws on a failed read', async () => {
    const env = { CONTACT_OPTIN_API_URL: 'http://robohire.example/optins', CONTACT_OPTIN_API_KEY: 'k' };
    expect(await optInApiReader(BRANDS.roboapply, env, vi.fn() as unknown as typeof fetch)()).toBeNull();
    const failing = vi.fn(async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await expect(optInApiReader(BRANDS.roboapply, { ...env, CONTACT_OPTIN_API_URL: 'https://x.example/o' }, failing)()).rejects.toThrow(/500/);
  });

  it('the bank reader goes through the bankClients seam and honours its switch', async () => {
    const findMany = vi.fn(async () => [{ id: 'u_1', name: 'R', jobTitle: null, company: 'C' }]);
    const seam = { isBankEnabled: vi.fn(() => true), getBankClient: vi.fn(() => ({ user: { findMany } })) };
    const reader = bankRecruiterReader(seam, 'robohire')();
    expect(await reader!.readRecruiters(['u_1'])).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true, name: true, jobTitle: true, company: true } }));
    seam.isBankEnabled.mockReturnValue(false);
    expect(bankRecruiterReader(seam, 'robohire')()).toBeNull();
  });

  it('the job-poster reader reads bank Job.userId read-only and honours the bank switch', async () => {
    const findUnique = vi.fn(async (args: { where: { id: string } }) => (args.where.id === 'bj_1' ? { userId: 'u_9' } : null));
    const seam = { isBankEnabled: vi.fn(() => true), getBankClient: vi.fn(() => ({ job: { findUnique } })) };
    const poster = bankJobPosterReader(seam);
    expect(await poster('robohire', 'bj_1')).toBe('u_9');
    expect(await poster('robohire', 'bj_missing')).toBeNull();
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'bj_1' }, select: { userId: true } });
    expect(seam.getBankClient).toHaveBeenCalledWith('robohire');
    seam.isBankEnabled.mockReturnValue(false);
    expect(await poster('robohire', 'bj_1')).toBeNull();
  });

  it('the cron returns at once when the brand has no opt-in API', async () => {
    const started = Date.now();
    const res = await runContactsSync({ name: 'contacts-sync', brand: BRANDS.roboapply, now: NOW, budget: {} as never });
    expect(res).toEqual({ skipped: 'optin_api_not_configured', processed: 0 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('prismaSyncedContacts (the stored row)', () => {
  it('writes companyName on create and refreshes it on update (SR-54-2)', async () => {
    const { createFakePrisma } = await import('../../test/fakePrisma.js');
    const { prismaSyncedContacts } = await import('./contactsSync.js');
    const db = createFakePrisma({ timestampFields: ['createdAt', 'updatedAt'] });
    const io = prismaSyncedContacts(db as never);
    const input = {
      existingId: null,
      market: 'intl',
      sourceRef: 'robohire:u_1|optin:opt_1@2026-09-01T00:00:00.000Z',
      consentBasis: 'recruiter_opt_in:opt_1',
      companyNameNormalized: 'acme analytics',
      companyName: 'Acme Analytics, Inc.',
      fullName: 'Rita Recruiter',
      firstName: 'Rita',
      title: 'Talent Partner',
    };
    await io.upsert(input);
    const [row] = db.$rows('rAContact');
    expect(row).toMatchObject({ source: 'bank_recruiter', ownerUserId: null, companyName: 'Acme Analytics, Inc.', companyNameNormalized: 'acme analytics' });
    await io.upsert({ ...input, existingId: String(row!.id), companyName: 'Acme Analytics' });
    expect(db.$rows('rAContact')[0]).toMatchObject({ companyName: 'Acme Analytics' });
    expect(db.$rows('rAContact')).toHaveLength(1);
  });
});
