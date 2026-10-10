// @vitest-environment node
//
// WP-54 service tests: People at {company} buckets and gates, the
// connections import (3/day, dedupe, delete all, no email kept), outreach
// drafts (credit `outreach`, zero model calls with AI off, LinkedIn length,
// recipient name placed after the model, saved on the tracker entry, no send
// path), and H15: a recruiter without an opt-in record is never returned.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { BRANDS } from '../../platform/brand/registry.js';
import { createCreditTestKit } from '../../platform/credits/testkit.js';
import { HttpError } from '../../platform/http.js';
import { LINKEDIN_NOTE_MAX_CHARS } from './contract.js';
import { NetworkService, hasOptInRecord, optedInAtOf } from './service.js';
import { createNetworkFixture, jobRow } from './testkit.js';

const U = 'user_1';
const CSV = [
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Ada,Lovelace,https://www.linkedin.com/in/ada,ada@analytical.example,"Acme Analytics, Inc.",Staff Engineer,15 Mar 2021',
  'Grace,Hopper,https://www.linkedin.com/in/grace,grace@navy.example,Globex,Admiral,02 Jan 2019',
].join('\n');

function setup(opts: Parameters<typeof createNetworkFixture>[0] extends infer O ? Partial<O> : never = {}) {
  const kit = createCreditTestKit({ now: new Date('2026-10-10T12:00:00Z') });
  const f = createNetworkFixture({ credits: kit.credits, ...opts });
  f.store.jobs.set('job_1', jobRow());
  f.store.resumes.set(U, '# Sam Lee\nsam@example.test\n\n## Experience\n- Built payment services in Go at Initech');
  return { ...f, kit };
}

async function code(p: Promise<unknown>): Promise<{ code: string; reason?: unknown }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return { code: err.code, reason: (err.details as { reason?: unknown } | undefined)?.reason };
    throw err;
  }
  throw new Error('expected an HttpError');
}

function recruiter(over: Record<string, unknown> = {}) {
  return {
    id: 'rec_1',
    market: 'intl',
    ownerUserId: null,
    source: 'bank_recruiter',
    sourceRef: 'robohire:u_9|optin:opt_1@2026-09-01T00:00:00.000Z',
    consentBasis: 'recruiter_opt_in:opt_1',
    consented: true,
    companyNameNormalized: 'acme analytics',
    companyId: null,
    fullName: 'Rita Recruiter',
    firstName: 'Rita',
    title: 'Talent Partner',
    linkedinUrl: null,
    connectedOn: null,
    schoolsNormalized: [],
    pastCompaniesNormalized: [],
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

describe('connectionsForJob', () => {
  it('mode deeplinks_only: only the LinkedIn search links, no people', async () => {
    const f = setup({ mode: 'deeplinks_only' });
    await f.service.importConnections(U, { text: CSV, fileName: 'Connections.csv' }).catch(() => undefined);
    f.store.contacts.push(recruiter());
    const res = await f.service.connectionsForJob(U, 'job_1');
    expect(res.mode).toBe('deeplinks_only');
    expect(res.fromYourCompanies).toEqual([]);
    expect(res.recruiters).toEqual([]);
    expect(res.searchLinks).toEqual([{ label: 'People in this role at Acme Analytics, Inc.', url: expect.stringContaining('linkedin.com') }]);
  });

  it('mode off: no links and no people', async () => {
    const f = setup({ mode: 'off' });
    const res = await f.service.connectionsForJob(U, 'job_1');
    expect(res.searchLinks).toEqual([]);
  });

  it('mode on: the user’s own connections at the company, matched by normalized name', async () => {
    const f = setup();
    await f.service.importConnections(U, { text: CSV, fileName: 'Connections.csv' });
    const res = await f.service.connectionsForJob(U, 'job_1');
    expect(res.fromYourCompanies.map((c) => c.fullName)).toEqual(['Ada Lovelace']);
    expect(res.fromYourCompanies[0]).toMatchObject({ source: 'user_connections_import', title: 'Staff Engineer', connectedOn: '2021-03-15T00:00:00.000Z', companyName: 'Acme Analytics, Inc.' });
    expect(res.importedCount).toBe(2);
  });

  it('never returns another user’s private contacts', async () => {
    const f = setup();
    await f.service.importConnections('user_2', { text: CSV, fileName: 'Connections.csv' });
    const res = await f.service.connectionsForJob(U, 'job_1');
    expect(res.fromYourCompanies).toEqual([]);
  });

  it('H15: an opted-in recruiter is returned with its source; one without an opt-in record never is', async () => {
    const f = setup();
    f.store.contacts.push(recruiter());
    f.store.contacts.push(recruiter({ id: 'rec_2', fullName: 'No Consent', consentBasis: null, consented: false }));
    f.store.contacts.push(recruiter({ id: 'rec_3', fullName: 'No Record', sourceRef: 'robohire:u_7' }));
    const res = await f.service.connectionsForJob(U, 'job_1');
    expect(res.recruiters.map((r) => r.fullName)).toEqual(['Rita Recruiter']);
    expect(res.recruiters[0]).toMatchObject({ source: 'bank_recruiter', sourceName: 'RoboHire', optedInAt: '2026-09-01T00:00:00.000Z' });
  });

  it('recruiters only on recruiter-bank jobs', async () => {
    const f = setup();
    f.store.jobs.set('job_1', jobRow({ fromRecruiterBank: false }));
    f.store.contacts.push(recruiter());
    expect((await f.service.connectionsForJob(U, 'job_1')).recruiters).toEqual([]);
  });

  it('F-NET-02: the hiring contact is the recruiter who posted THIS job, never an opted-in colleague at the same company', async () => {
    const f = setup();
    // u_10 opted in and works at Acme too, but did not post bank_job_1 (u_9 did, and has no opt-in).
    f.store.contacts.push(recruiter({ id: 'rec_colleague', fullName: 'Cole League', sourceRef: 'robohire:u_10|optin:opt_9@2026-09-02T00:00:00.000Z', consentBasis: 'recruiter_opt_in:opt_9' }));
    expect((await f.service.connectionsForJob(U, 'job_1')).recruiters).toEqual([]);

    // A second Acme job that u_10 posted shows u_10 — and only on that job.
    f.store.jobs.set('job_2', jobRow({ id: 'job_2', externalId: 'bank_job_2' }));
    f.posters.set('robohire:bank_job_2', 'u_10');
    expect((await f.service.connectionsForJob(U, 'job_2')).recruiters.map((r) => r.id)).toEqual(['rec_colleague']);
    expect((await f.service.connectionsForJob(U, 'job_1')).recruiters).toEqual([]);

    // Once the poster opts in, job_1 shows the poster, not the colleague.
    f.store.contacts.push(recruiter());
    expect((await f.service.connectionsForJob(U, 'job_1')).recruiters.map((r) => r.id)).toEqual(['rec_1']);
  });

  it('no hiring contact when the bank job cannot be read or its poster is unknown', async () => {
    const f = setup({ overrides: { jobPoster: async () => { throw new Error('bank down'); } } });
    f.store.contacts.push(recruiter());
    expect((await f.service.connectionsForJob(U, 'job_1')).recruiters).toEqual([]);

    const g = setup();
    g.store.contacts.push(recruiter());
    g.posters.clear();
    expect((await g.service.connectionsForJob(U, 'job_1')).recruiters).toEqual([]);
  });

  it('404 for a job in another market, another user’s private job, or a hidden GoApply posting', async () => {
    const f = setup();
    f.store.jobs.set('job_cn', jobRow({ id: 'job_cn', market: 'cn' }));
    f.store.jobs.set('job_priv', jobRow({ id: 'job_priv', visibility: 'private', ownerUserId: 'user_2' }));
    expect(await code(f.service.connectionsForJob(U, 'job_cn'))).toMatchObject({ code: 'not_found' });
    expect(await code(f.service.connectionsForJob(U, 'job_priv'))).toMatchObject({ code: 'not_found' });
    const hidden = setup({ overrides: { postingVisible: () => false } });
    hidden.store.jobs.set('job_1', jobRow());
    expect(await code(hidden.service.connectionsForJob(U, 'job_1'))).toMatchObject({ code: 'not_found' });
  });
});

describe('connections import', () => {
  it('imports name, company, position and date; no email is stored', async () => {
    const f = setup();
    const res = await f.service.importConnections(U, { text: CSV, fileName: 'Connections.csv' });
    expect(res).toEqual({ rowCount: 2, importedCount: 2 });
    const stored = JSON.stringify(f.store.contacts);
    expect(stored).not.toContain('@');
    expect(stored).not.toContain('linkedin.com/in');
    expect(f.store.contacts.every((c) => c.linkedinUrl === null && c.source === 'user_connections_import' && c.ownerUserId === U)).toBe(true);
  });

  it('dedupes against what the user already imported', async () => {
    const f = setup();
    await f.service.importConnections(U, { text: CSV, fileName: 'Connections.csv' });
    const again = await f.service.importConnections(U, { text: CSV, fileName: 'Connections.csv' });
    expect(again).toEqual({ rowCount: 2, importedCount: 0 });
    expect(f.store.contacts).toHaveLength(2);
  });

  it('allows 3 imports a day; the 4th is 429 connections_import_limit; the next day works', async () => {
    const f = setup();
    for (let i = 0; i < 3; i++) await f.service.importConnections(U, { text: CSV, fileName: 'Connections.csv' });
    expect(await code(f.service.importConnections(U, { text: CSV, fileName: 'Connections.csv' }))).toEqual({ code: 'rate_limited', reason: 'connections_import_limit' });
    expect((await f.service.importStatus(U)).importsToday).toBe(3);
    f.state.now = new Date('2026-10-11T12:30:00Z');
    await expect(f.service.importConnections(U, { text: CSV, fileName: 'Connections.csv' })).resolves.toMatchObject({ importedCount: 0 });
  });

  it('422 connections_csv_unreadable for another file', async () => {
    const f = setup();
    expect(await code(f.service.importConnections(U, { text: 'hello,world\n1,2', fileName: 'x.csv' }))).toEqual({ code: 'invalid_request', reason: 'connections_csv_unreadable' });
  });

  it('delete all imported connections removes only the user’s imported rows', async () => {
    const f = setup();
    await f.service.importConnections(U, { text: CSV, fileName: 'Connections.csv' });
    await f.service.importConnections('user_2', { text: CSV, fileName: 'Connections.csv' });
    await f.service.createContact(U, { fullName: 'Added Person', companyName: 'Acme' });
    expect(await f.service.deleteImported(U)).toEqual({ deleted: 2 });
    expect(f.store.contacts.filter((c) => c.ownerUserId === U).map((c) => c.source)).toEqual(['user_added']);
    expect(f.store.contacts.filter((c) => c.ownerUserId === 'user_2')).toHaveLength(2);
    expect((await f.service.importStatus(U)).importedCount).toBe(0);
  });
});

describe('contacts', () => {
  it('add, list, delete own; cannot delete a recruiter or another user’s contact', async () => {
    const f = setup();
    const c = await f.service.createContact(U, { fullName: 'Jo Bloggs', companyName: 'Acme Analytics', title: 'PM', linkedinUrl: 'https://www.linkedin.com/in/jo' });
    expect(c).toMatchObject({ source: 'user_added', linkedinUrl: 'https://www.linkedin.com/in/jo' });
    expect((await f.service.listContacts(U, {})).items).toHaveLength(1);
    f.store.contacts.push(recruiter());
    expect(await code(f.service.deleteContact(U, 'rec_1'))).toMatchObject({ code: 'not_found' });
    expect(await code(f.service.deleteContact('user_2', c.id))).toMatchObject({ code: 'not_found' });
    await expect(f.service.deleteContact(U, c.id)).resolves.toEqual({ deleted: true });
  });

  it('a non-LinkedIn profile link is not stored', async () => {
    const f = setup();
    const c = await f.service.createContact(U, { fullName: 'Jo', companyName: 'Acme', linkedinUrl: 'https://evil.example/in/jo' });
    expect(c.linkedinUrl).toBeNull();
  });

  it('email lookup is 501 provider_not_configured (no email finder)', async () => {
    const f = setup();
    expect(await code(f.service.lookupEmail())).toMatchObject({ code: 'provider_not_configured' });
  });
});

describe('outreach drafts', () => {
  it('AI off: 503 ai_unavailable with zero model calls and no credit spent', async () => {
    const f = setup({ ai: false });
    expect(await code(f.service.createDraft(U, { jobId: 'job_1', channel: 'linkedin_note' }, { idempotencyKey: 'k1' }))).toMatchObject({ code: 'ai_unavailable' });
    expect(f.calls).toHaveLength(0);
    const usage = await f.kit.credits.usage(U, { brand: 'roboapply' });
    expect(usage.find((u) => u.bucket === 'outreach')?.used ?? 0).toBe(0);
  });

  it('writes a draft: credit outreach, grounded input, name placed after the model, PII redacted', async () => {
    const f = setup();
    f.store.contacts.push(recruiter());
    f.store.tracker.push({ id: 'te_1', userId: U, jobId: 'job_1' });
    const d = await f.service.createDraft(U, { jobId: 'job_1', channel: 'email', contactId: 'rec_1' }, { idempotencyKey: 'k2' });
    expect(d).toMatchObject({ channel: 'email', contactId: 'rec_1', trackerEntryId: 'te_1', aiWritten: true, subject: 'Backend Engineer at Acme' });
    expect(d.body.startsWith('Hi Rita,')).toBe(true);
    const input = f.calls[0]!;
    expect(JSON.stringify(input)).not.toContain('Rita');
    expect(input.job.text).not.toContain('jobs@acme.test');
    expect(input.resumeText).not.toContain('Sam Lee');
    expect(input.recipient).toEqual({ kind: 'recruiter', title: 'Talent Partner' });
    const usage = await f.kit.credits.usage(U, { brand: 'roboapply' });
    expect(usage.find((u) => u.bucket === 'outreach')?.used).toBe(1);
  });

  it('drops the name token when there is no contact', async () => {
    const f = setup();
    const d = await f.service.createDraft(U, { jobId: 'job_1', channel: 'referral_ask' }, { idempotencyKey: 'k3' });
    expect(d.body.startsWith('Hi,')).toBe(true);
    expect(d.body).not.toContain('[[NAME]]');
  });

  it(`a LinkedIn note always fits ${LINKEDIN_NOTE_MAX_CHARS} characters and has no subject`, async () => {
    const long = 'I build payment services in Go. '.repeat(40);
    const f = setup({ write: async () => ({ subject: 'ignored', body: `Hi [[NAME]], ${long}` }) });
    const d = await f.service.createDraft(U, { jobId: 'job_1', channel: 'linkedin_note' }, { idempotencyKey: 'k4' });
    expect(Array.from(d.body).length).toBeLessThanOrEqual(LINKEDIN_NOTE_MAX_CHARS);
    expect(d.subject).toBeNull();
    expect(f.calls[0]!.maxChars).toBe(LINKEDIN_NOTE_MAX_CHARS);
  });

  it('an empty model answer releases the credit', async () => {
    const f = setup({ write: async () => ({ subject: null, body: '   ' }) });
    expect(await code(f.service.createDraft(U, { jobId: 'job_1', channel: 'email' }, { idempotencyKey: 'k5' }))).toMatchObject({ reason: 'outreach_draft_empty' });
    const usage = await f.kit.credits.usage(U, { brand: 'roboapply' });
    expect(usage.find((u) => u.bucket === 'outreach')?.used ?? 0).toBe(0);
  });

  it('a replayed Idempotency-Key returns the first draft and charges once', async () => {
    const f = setup();
    const a = await f.service.createDraft(U, { jobId: 'job_1', channel: 'email' }, { idempotencyKey: 'same' });
    const b = await f.service.createDraft(U, { jobId: 'job_1', channel: 'email' }, { idempotencyKey: 'same' });
    expect(b.id).toBe(a.id);
    expect(f.calls).toHaveLength(1);
  });

  it('channels per market: no WeChat on RoboApply, no LinkedIn note on GoApply', async () => {
    const f = setup();
    expect(await code(f.service.createDraft(U, { jobId: 'job_1', channel: 'wechat' }))).toMatchObject({ reason: 'outreach_channel_not_available' });
    const cn = setup({ brand: BRANDS.goapply });
    cn.store.jobs.set('job_1', jobRow({ market: 'cn' }));
    expect(await code(cn.service.createDraft(U, { jobId: 'job_1', channel: 'linkedin_note' }))).toMatchObject({ reason: 'outreach_channel_not_available' });
    const logAiLabel = vi.fn(async () => undefined);
    const cn2 = setup({ brand: BRANDS.goapply, overrides: { logAiLabel } });
    cn2.store.jobs.set('job_1', jobRow({ market: 'cn' }));
    const d = await cn2.service.createDraft(U, { jobId: 'job_1', channel: 'wechat' }, { idempotencyKey: 'cn1' });
    expect(d.channel).toBe('wechat');
    expect(logAiLabel).toHaveBeenCalledWith(expect.objectContaining({ draftId: d.id }));
  });

  it('a contact is usable only in mode on, and only an own contact or an opted-in recruiter', async () => {
    const f = setup();
    f.store.contacts.push(recruiter({ id: 'rec_x', consentBasis: null, consented: false }));
    expect(await code(f.service.createDraft(U, { jobId: 'job_1', channel: 'email', contactId: 'rec_x' }))).toMatchObject({ reason: 'contact_not_found' });
    f.store.contacts.push(recruiter());
    f.state.mode = 'deeplinks_only';
    expect(await code(f.service.createDraft(U, { jobId: 'job_1', channel: 'email', contactId: 'rec_1' }))).toMatchObject({ reason: 'contact_not_found' });
    expect(f.calls).toHaveLength(0);
  });

  it('a tracker entry of another job or user is 404', async () => {
    const f = setup();
    f.store.tracker.push({ id: 'te_other', userId: U, jobId: 'job_9' }, { id: 'te_u2', userId: 'user_2', jobId: 'job_1' });
    expect(await code(f.service.createDraft(U, { jobId: 'job_1', channel: 'email', trackerEntryId: 'te_other' }))).toMatchObject({ reason: 'tracker_entry_not_found' });
    expect(await code(f.service.createDraft(U, { jobId: 'job_1', channel: 'email', trackerEntryId: 'te_u2' }))).toMatchObject({ reason: 'tracker_entry_not_found' });
  });

  it('edit, copied, marked sent; listed by job and by tracker entry; other users get 404', async () => {
    const f = setup();
    f.store.tracker.push({ id: 'te_1', userId: U, jobId: 'job_1' });
    const d = await f.service.createDraft(U, { jobId: 'job_1', channel: 'follow_up' }, { idempotencyKey: 'k6' });
    const edited = await f.service.patchDraft(U, d.id, { body: 'My own words.', subject: '  ' });
    expect(edited).toMatchObject({ body: 'My own words.', subject: null });
    expect((await f.service.markCopied(U, d.id)).copiedAt).toBe('2026-10-10T12:00:00.000Z');
    expect((await f.service.markSent(U, d.id)).markedSentAt).toBe('2026-10-10T12:00:00.000Z');
    expect((await f.service.listDrafts(U, { trackerEntryId: 'te_1' })).items.map((x) => x.id)).toEqual([d.id]);
    expect((await f.service.listDrafts(U, { jobId: 'job_1' })).items).toHaveLength(1);
    expect(await code(f.service.patchDraft('user_2', d.id, { body: 'x' }))).toMatchObject({ code: 'not_found' });
    expect((await f.service.connectionsForJob(U, 'job_1')).drafts.map((x) => x.id)).toEqual([d.id]);
  });

  it('a LinkedIn note edit over the limit is refused', async () => {
    const f = setup();
    const d = await f.service.createDraft(U, { jobId: 'job_1', channel: 'linkedin_note' }, { idempotencyKey: 'k7' });
    expect(await code(f.service.patchDraft(U, d.id, { body: 'x'.repeat(LINKEDIN_NOTE_MAX_CHARS + 1) }))).toMatchObject({ reason: 'outreach_draft_too_long' });
  });

  it('D1: the service has no send method', () => {
    const methods = Object.getOwnPropertyNames(NetworkService.prototype);
    expect(methods.filter((m) => /send|deliver|dispatch|submit/i.test(m))).toEqual([]);
  });
});

describe('opt-in helpers', () => {
  it('reads the opt-in time from sourceRef and requires every part', () => {
    expect(optedInAtOf('robohire:u|optin:r1@2026-09-01T00:00:00.000Z')).toBe('2026-09-01T00:00:00.000Z');
    expect(optedInAtOf('robohire:u')).toBeNull();
    const base = { source: 'bank_recruiter', consented: true, sourceRef: 'robohire:u|optin:r1@2026-09-01T00:00:00.000Z', ownerUserId: null };
    expect(hasOptInRecord(base)).toBe(true);
    expect(hasOptInRecord({ ...base, consented: false })).toBe(false);
    expect(hasOptInRecord({ ...base, ownerUserId: 'u' })).toBe(false);
    expect(hasOptInRecord({ ...base, source: 'user_added' })).toBe(false);
  });
});
