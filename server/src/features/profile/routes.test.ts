// @vitest-environment node
//
// Profile API (WP-19): every endpoint through the route harness, against the
// in-memory fake Prisma. No network, no database.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type HarnessResponse, type RouteHarness } from '../../test/routeHarness.js';
import { createProfileRouter, createProfileService, type ProfileView, type SensitiveAnswersView, type SyncFromResumeResponse } from './index.js';
import type { ProfileDb, ProfileServiceDeps } from './service.js';
import { createTwFieldsStore, twFieldsColumnPresent } from './twFieldsStore.js';

const RA = 'localhost:3621';
const GO = 'goapply.localhost:3621';
const KEY = { SENSITIVE_DATA_KEY: 'b'.repeat(64) };

type Body<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

let fake: ReturnType<typeof createFakePrisma>;
let deps: ProfileServiceDeps;
let h: RouteHarness | undefined;
let userId: string | null = 'u1';
let eeo = true;
let consent = false;

function service(over: Partial<ProfileServiceDeps> = {}) {
  return createProfileService({ ...deps, ...over });
}

async function start(over: Partial<ProfileServiceDeps> = {}) {
  h = await startRouteHarness({
    mounts: [['/profile', createProfileRouter({ seekerAuth: [fakeAuth(() => (userId ? { id: userId } : null))], service: service(over) })]],
  });
}

const call = <T>(method: string, path: string, body?: unknown, host = RA) =>
  h!.request<Body<T>>(method, `/profile${path}`, { host, body: method === 'GET' ? undefined : body }) as Promise<HarnessResponse<Body<T>>>;

beforeEach(() => {
  userId = 'u1';
  eeo = true;
  consent = false;
  fake = createFakePrisma();
  deps = {
    getDb: async () => fake as unknown as ProfileDb,
    env: { ...KEY },
    twFields: createTwFieldsStore(false),
    eeoEnabled: async () => eeo,
    hasConsent: async () => consent,
  };
});

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('auth', () => {
  beforeEach(() => start());
  it.each([
    ['GET', '/'],
    ['PATCH', '/'],
    ['POST', '/education'],
    ['PATCH', '/education/e1'],
    ['DELETE', '/education/e1'],
    ['POST', '/experience'],
    ['PATCH', '/experience/x1'],
    ['DELETE', '/experience/x1'],
    ['PUT', '/skills'],
    ['GET', '/sensitive'],
    ['PUT', '/sensitive'],
    ['POST', '/sync-from-resume'],
    ['POST', '/sync-from-resume/apply'],
  ])('%s %s → 401 without a session', async (method, path) => {
    userId = null;
    const res = await call(method, path, {});
    expect(res.status).toBe(401);
  });
});

describe('GET / PATCH /profile', () => {
  beforeEach(() => start());

  it('returns an empty profile (no write) for a new user, with every required field missing', async () => {
    const res = await call<ProfileView>('GET', '/');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ userId: 'u1', firstName: null, completeness: 0, updatedAt: null, twFields: null });
    expect(res.body.data.missing.map((m) => m.key)).toContain('workAuth');
    expect(res.body.data.availability).toEqual({ market: 'intl', twFields: false, eeo: true, cnSensitive: false, cnPhoto: false });
    expect(fake.$rows('rAProfile')).toHaveLength(0);
  });

  it('saves fields, trims blanks to null, and recomputes completeness', async () => {
    const res = await call<ProfileView>('PATCH', '/', {
      firstName: ' Ada ',
      lastName: 'Lovelace',
      headline: '',
      contactEmail: 'ADA@Example.test',
      phoneE164: '+14155550100',
      city: 'Austin',
      country: 'US',
      links: { linkedin: 'https://www.linkedin.com/in/ada' },
      workAuth: [
        { country: 'US', authorized: true, sponsorship: 'no', permit: 'gold_card' },
        { country: 'TW', authorized: false, sponsorship: 'now', permit: 'work_permit_needed' },
      ],
    });
    expect(res.status).toBe(200);
    const v = res.body.data;
    expect(v).toMatchObject({ firstName: 'Ada', headline: null, contactEmail: 'ada@example.test', links: { linkedin: 'https://www.linkedin.com/in/ada' } });
    // The permit answer is kept for Taiwan only.
    expect(v.workAuth).toEqual([
      { country: 'US', authorized: true, sponsorship: 'no' },
      { country: 'TW', authorized: false, sponsorship: 'now', permit: 'work_permit_needed' },
    ]);
    expect(v.missing.map((m) => m.key)).toEqual(['education', 'experience', 'skills']);
    expect(fake.$rows('rAProfile')[0]!.completeness).toBe(v.completeness);
    expect(v.updatedAt).not.toBeNull();
  });

  it('422 on an invalid LinkedIn link, a bad phone or an unknown field', async () => {
    for (const body of [{ links: { linkedin: 'https://example.com/ada' } }, { phoneE164: '555-0100' }, { nickname: 'x' }]) {
      const res = await call('PATCH', '/', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it('RoboApply refuses GoApply fields; GoApply refuses work authorization, Taiwan fields and LinkedIn', async () => {
    expect((await call('PATCH', '/', { cnFields: { identity: 'yingjie' } })).body).toMatchObject({ code: 'invalid_request', details: { reason: 'profile_field_not_available' } });
    expect((await call('PATCH', '/', { workAuth: [] }, GO)).status).toBe(422);
    expect((await call('PATCH', '/', { twFields: null }, GO)).status).toBe(422);
    expect((await call('PATCH', '/', { links: { linkedin: 'https://www.linkedin.com/in/x' } }, GO)).status).toBe(422);
  });

  it('GoApply cnFields merge with what onboarding stored and are validated', async () => {
    fake.$rows('rAProfile').push({ userId: 'u1', cnFields: { identity: 'yingjie', schoolTags: ['985'] }, links: {}, skills: [], languages: [], workAuth: [], updatedAt: new Date() });
    const ok = await call<ProfileView>('PATCH', '/', { cnFields: { graduationClass: 2026, major: 'CS' } }, GO);
    expect(ok.status).toBe(200);
    expect(ok.body.data.cnFields).toEqual({ identity: 'yingjie', schoolTags: ['985'], graduationClass: 2026, major: 'CS' });
    // The photo is offered wherever GoApply can keep a file: here local disk, as on RoboApply in development (D5).
    expect(ok.body.data.availability).toMatchObject({ market: 'cn', eeo: false, cnSensitive: true, cnPhoto: true, twFields: false });
    const bad = await call('PATCH', '/', { cnFields: { identity: 'astronaut' } }, GO);
    expect(bad.status).toBe(422);
  });

  it('GoApply cnFields refuse sensitive keys (they belong in the encrypted answers) and unknown keys; stored strays are dropped', async () => {
    fake.$rows('rAProfile').push({ userId: 'u1', cnFields: { identity: 'yingjie', legacyNote: 'x' }, links: {}, skills: [], languages: [], workAuth: [], updatedAt: new Date() });
    for (const key of ['nativePlace', 'politicalStatus', 'familyMembers', 'photoAssetId', 'gender', 'birthDate']) {
      const res = await call('PATCH', '/', { cnFields: { [key]: key === 'familyMembers' ? [{ relation: '母亲', name: '李某' }] : '湖南' } }, GO);
      expect(res.status, key).toBe(422);
      expect(res.body.details, key).toMatchObject({ reason: 'profile_field_not_available', field: `cnFields.${key}` });
    }
    const unknown = await call('PATCH', '/', { cnFields: { hobby: 'chess' } }, GO);
    expect(unknown.status).toBe(422);
    const tooMany = await call('PATCH', '/', { cnFields: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, null])) }, GO);
    expect(tooMany.status).toBe(422);
    const tooLong = await call('PATCH', '/', { cnFields: { major: 'x'.repeat(121) } }, GO);
    expect(tooLong.status).toBe(422);
    // Nothing sensitive reached the plaintext column.
    expect(JSON.stringify(fake.$rows('rAProfile')[0]!.cnFields)).not.toMatch(/湖南|李某/);

    const ok = await call<ProfileView>('PATCH', '/', { cnFields: { major: 'CS' } }, GO);
    expect(ok.status).toBe(200);
    expect(ok.body.data.cnFields).toEqual({ identity: 'yingjie', major: 'CS' });
  });

  it('Taiwan fields answer 501 until the column exists (SR-WP19-1)', async () => {
    const res = await call('PATCH', '/', { twFields: { desiredPay: { kind: 'negotiable' } } });
    expect(res.status).toBe(501);
    expect(res.body.details).toEqual({ schemaRequest: 'SR-WP19-1' });
  });

  it('SR-WP19-1 landed (SCHEMA-2): the default store finds RAProfile.twFields in the generated client', () => {
    expect(twFieldsColumnPresent()).toBe(true);
    expect(createTwFieldsStore().available).toBe(true);
  });
});

describe('Taiwan fields with the column present (adapter path)', () => {
  it('persists through the adapter and reads back; empty answers clear them', async () => {
    await start({ twFields: createTwFieldsStore(true) });
    const res = await call<ProfileView>('PATCH', '/', { twFields: { desiredTitles: ['PM'], desiredPay: { kind: 'company_policy' } } });
    expect(res.status).toBe(200);
    expect(res.body.data.twFields).toEqual({ desiredTitles: ['PM'], desiredPay: { kind: 'company_policy' } });
    expect(res.body.data.availability.twFields).toBe(true);
    const cleared = await call<ProfileView>('PATCH', '/', { twFields: { desiredTitles: [] } });
    expect(cleared.body.data.twFields).toBeNull();
  });
});

describe('education and experience rows', () => {
  beforeEach(() => start());

  it('create, update and delete own rows; current clears the end date', async () => {
    const add = await call<{ id: string }>('POST', '/education', { school: 'UT Austin', degree: 'BS', startDate: '2014-09', endDate: '2018-05-20' });
    expect(add.status).toBe(201);
    expect(add.body.data).toMatchObject({ school: 'UT Austin', startDate: '2014-09', endDate: '2018-05', current: false });
    const id = add.body.data.id;
    const upd = await call('PATCH', `/education/${id}`, { current: true, major: '' });
    expect(upd.body.data).toMatchObject({ current: true, endDate: null, major: null });

    const x = await call<{ id: string }>('POST', '/experience', { company: 'Acme', title: 'Intern', kind: 'internship', bullets: ['Built a thing'], startDate: '2017' });
    expect(x.status).toBe(201);
    expect(x.body.data).toMatchObject({ kind: 'internship', bullets: ['Built a thing'], startDate: '2017' });
    const xu = await call('PATCH', `/experience/${x.body.data.id}`, { title: 'Analyst', description: 'Dashboards' });
    expect(xu.body.data).toMatchObject({ title: 'Analyst', description: 'Dashboards' });

    const profile = await call<ProfileView>('GET', '/');
    expect(profile.body.data.education).toHaveLength(1);
    expect(profile.body.data.experience).toHaveLength(1);
    expect(profile.body.data.missing.map((m) => m.key)).not.toContain('education');

    expect((await call('DELETE', `/education/${id}`)).status).toBe(200);
    expect((await call('DELETE', `/experience/${x.body.data.id}`)).status).toBe(200);
    expect(fake.$rows('rAProfileEducation')).toHaveLength(0);
    const after = await call<ProfileView>('GET', '/');
    expect(after.body.data.missing.map((m) => m.key)).toContain('education');
  });

  it('another user’s row is not found', async () => {
    fake.$rows('rAProfileEducation').push({ id: 'theirs', userId: 'u2', school: 'X', current: false, sortOrder: 0 });
    fake.$rows('rAProfileExperience').push({ id: 'theirs-x', userId: 'u2', company: 'X', title: 'Y', current: false, bullets: [], kind: 'work', sortOrder: 0 });
    for (const [m, p] of [['PATCH', '/education/theirs'], ['DELETE', '/education/theirs'], ['PATCH', '/experience/theirs-x'], ['DELETE', '/experience/theirs-x']]) {
      const res = await call(m!, p!, {});
      expect(res.status, `${m} ${p}`).toBe(404);
      expect(res.body.details).toEqual({ reason: 'profile_row_not_found' });
    }
    expect(fake.$rows('rAProfileEducation')).toHaveLength(1);
  });

  it('422 on a missing school or a malformed date', async () => {
    expect((await call('POST', '/education', { degree: 'BS' })).status).toBe(422);
    expect((await call('POST', '/experience', { company: 'A', title: 'B', startDate: '2020-13' })).status).toBe(422);
  });
});

describe('PUT /skills', () => {
  beforeEach(() => start());
  it('replaces the list and drops case-insensitive duplicates', async () => {
    const res = await call<ProfileView>('PUT', '/skills', { skills: [{ name: 'SQL', confirmed: true }, { name: 'sql', confirmed: false }, { name: 'Python', confirmed: true }] });
    expect(res.status).toBe(200);
    expect(res.body.data.skills.map((s) => s.name)).toEqual(['SQL', 'Python']);
  });
});

describe('sensitive answers', () => {
  it('stores EEO answers encrypted, returns them only to the owner, and deletes them on {}', async () => {
    await start();
    const put = await call<SensitiveAnswersView>('PUT', '/sensitive', { eeo: { gender: 'decline', veteranStatus: 'not_veteran' } });
    expect(put.status).toBe(200);
    expect(put.headers.get('cache-control')).toBe('no-store');
    const stored = fake.$rows('rASensitiveAnswers')[0]!;
    expect(String(stored.ciphertext)).not.toContain('decline');
    expect(stored.keyVersion).toBe(1);

    const get = await call<SensitiveAnswersView>('GET', '/sensitive');
    expect(get.body.data).toMatchObject({ answers: { eeo: { gender: 'decline', veteranStatus: 'not_veteran' } }, configured: true });

    userId = 'u2';
    expect((await call<SensitiveAnswersView>('GET', '/sensitive')).body.data.answers).toEqual({});
    userId = 'u1';

    const del = await call<SensitiveAnswersView>('PUT', '/sensitive', {});
    expect(del.body.data).toMatchObject({ answers: {}, updatedAt: null });
    expect(fake.$rows('rASensitiveAnswers')).toHaveLength(0);
  });

  it('EEO answers are limited to the offered answer codes (422 otherwise)', async () => {
    await start();
    for (const eeoBody of [{ gender: 'Woman' }, { raceEthnicity: 'asian, white' }, { veteranStatus: '' }, { disabilityStatus: 'maybe' }]) {
      expect((await call('PUT', '/sensitive', { eeo: eeoBody })).status, JSON.stringify(eeoBody)).toBe(422);
    }
    expect(fake.$rows('rASensitiveAnswers')).toHaveLength(0);
    expect((await call('PUT', '/sensitive', { eeo: { raceEthnicity: 'two_or_more', disabilityStatus: 'decline' } })).status).toBe(200);
  });

  it('a row that can no longer be decrypted reads as unreadable (not 500), can be deleted, and is never sent to autofill', async () => {
    const warnings: string[] = [];
    await start({ warn: (m) => warnings.push(m) });
    expect((await call('PUT', '/sensitive', { eeo: { gender: 'female' } })).status).toBe(200);
    // The deployment's key was rotated twice: the stored row is sealed with a key it no longer has.
    await h!.close();
    await start({ env: { SENSITIVE_DATA_KEY: 'c'.repeat(64), SENSITIVE_DATA_KEY_VERSION: '3' }, warn: (m) => warnings.push(m) });
    const get = await call<SensitiveAnswersView>('GET', '/sensitive');
    expect(get.status).toBe(200);
    expect(get.body.data).toMatchObject({ answers: {}, unreadable: true, configured: true });
    expect(get.body.data.updatedAt).not.toBeNull();
    expect(warnings).toEqual(['sensitive answers could not be decrypted']);

    consent = true;
    const svc = service({ env: { SENSITIVE_DATA_KEY: 'c'.repeat(64), SENSITIVE_DATA_KEY_VERSION: '3' }, warn: () => undefined });
    expect(await svc.sensitiveForAutofill('u1')).toBeNull();

    const del = await call<SensitiveAnswersView>('PUT', '/sensitive', {});
    expect(del.body.data).toMatchObject({ answers: {}, updatedAt: null, unreadable: false });
    expect(fake.$rows('rASensitiveAnswers')).toHaveLength(0);
  });

  it('EEO answers need the eeoAnswers flag (404 feature_disabled) and are absent on GoApply', async () => {
    eeo = false;
    await start();
    expect((await call('PUT', '/sensitive', { eeo: { gender: 'female' } })).body).toMatchObject({ code: 'feature_disabled' });
    const go = await call('PUT', '/sensitive', { eeo: { gender: 'female' } }, GO);
    expect(go.status).toBe(404);
    expect((await call<SensitiveAnswersView>('GET', '/sensitive', undefined, GO)).body.data.availability.eeo).toBe(false);
  });

  it('GoApply 籍贯 / 政治面貌 / 家庭成员 are accepted; RoboApply refuses the cn block', async () => {
    await start();
    const ok = await call<SensitiveAnswersView>('PUT', '/sensitive', { cn: { nativePlace: '湖南', politicalStatus: '群众', familyMembers: [{ relation: '母亲', name: '李某' }] } }, GO);
    expect(ok.status).toBe(200);
    expect((await call('PUT', '/sensitive', { cn: { nativePlace: 'x' } })).status).toBe(422);
  });

  const SHARED_BUCKET = { NODE_ENV: 'production', S3_BUCKET: 'shared', S3_ACCESS_KEY_ID: 'i', S3_SECRET_ACCESS_KEY: 's' };
  const CN_BUCKET = { CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com', CN_S3_BUCKET: 'cn', CN_S3_ACCESS_KEY_ID: 'i', CN_S3_SECRET_ACCESS_KEY: 's' };

  it.each([
    ['only the shared bucket, offshore', { ...SHARED_BUCKET }],
    ['only the shared bucket, on a mainland deployment', { ...SHARED_BUCKET, DEPLOY_REGION: 'cn-mainland' }],
    ['its own bucket', { NODE_ENV: 'production', ...CN_BUCKET }],
    ['its own mainland bucket under CN_RESIDENCY_STRICT', { NODE_ENV: 'production', ...CN_BUCKET, CN_RESIDENCY_STRICT: 'true', DEPLOY_REGION: 'cn-mainland' }],
  ])('the GoApply photo is offered wherever a file can be kept: %s', async (_label, env) => {
    await start({ env: { ...KEY, ...env } });
    const res = await call<SensitiveAnswersView>('PUT', '/sensitive', { cn: { photoAssetId: 'asset1' } }, GO);
    expect(res.status).toBe(200);
    expect(res.body.data.availability.cnPhoto).toBe(true);
  });

  it.each([
    ['production with no store at all', { NODE_ENV: 'production' }],
    ['CN_STORAGE_MODE=discard (nothing is kept)', { ...SHARED_BUCKET, CN_STORAGE_MODE: 'discard' }],
    ['CN_RESIDENCY_STRICT without a mainland bucket', { ...SHARED_BUCKET, CN_RESIDENCY_STRICT: 'true' }],
  ])('the GoApply photo is refused where nothing can be kept: %s', async (_label, env) => {
    await start({ env: { ...KEY, ...env } });
    const photo = await call('PUT', '/sensitive', { cn: { photoAssetId: 'asset1' } }, GO);
    expect(photo.status).toBe(422);
    expect(photo.body.details).toMatchObject({ field: 'cn.photoAssetId' });
    expect((await call<SensitiveAnswersView>('GET', '/sensitive', undefined, GO)).body.data.availability.cnPhoto).toBe(false);
  });

  it('RoboApply never has the GoApply photo, whatever the storage', async () => {
    await start({ env: { ...KEY, ...SHARED_BUCKET } });
    expect((await call<SensitiveAnswersView>('GET', '/sensitive')).body.data.availability.cnPhoto).toBe(false);
  });

  it('without SENSITIVE_DATA_KEY nothing is saved (501) and GET says so', async () => {
    await start({ env: {} });
    const put = await call('PUT', '/sensitive', { eeo: { gender: 'female' } });
    expect(put.status).toBe(501);
    expect(put.body).toMatchObject({ code: 'provider_not_configured', details: { reason: 'profile_sensitive_not_configured' } });
    expect((await call<SensitiveAnswersView>('GET', '/sensitive')).body.data.configured).toBe(false);
    expect(fake.$rows('rASensitiveAnswers')).toHaveLength(0);
  });
});

describe('sync from resume', () => {
  const parsedData = {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    skills: ['SQL', 'Python'],
    education: [{ institution: 'Rice University', degree: 'MS', year: '2020' }],
    experience: [{ company: 'Acme', role: 'Analyst', startDate: '2020-06', endDate: 'Present' }],
  };

  beforeEach(async () => {
    fake.$rows('rAResumeVariant').push(
      { id: 'v1', userId: 'u1', parsedData, deletedAt: null, isPrimary: true, resumeContentHash: 'h1' },
      { id: 'v-other', userId: 'u2', parsedData, deletedAt: null },
      { id: 'v-scratch', userId: 'u1', parsedData: null, deletedAt: null },
    );
    await start();
  });

  it('previews a diff and changes nothing', async () => {
    const res = await call<SyncFromResumeResponse>('POST', '/sync-from-resume', { variantId: 'v1' });
    expect(res.status).toBe(200);
    expect(res.body.data.parsed).toBe(true);
    expect(res.body.data.diff.map((d) => d.path)).toEqual(expect.arrayContaining(['firstName', 'lastName', 'contactEmail', 'skills']));
    expect(fake.$rows('rAProfile')).toHaveLength(0);
    expect(fake.$rows('rAProfileEducation')).toHaveLength(0);
  });

  it('applies only the accepted changes and records the resume', async () => {
    const preview = await call<SyncFromResumeResponse>('POST', '/sync-from-resume', { variantId: 'v1' });
    const edu = preview.body.data.diff.find((d) => d.path.startsWith('education['))!.path;
    const res = await call<ProfileView>('POST', '/sync-from-resume/apply', { variantId: 'v1', accept: ['firstName', 'skills', edu] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ firstName: 'Ada', lastName: null, contactEmail: null, syncedFromVariantId: 'v1' });
    expect(res.body.data.skills.map((s) => s.name)).toEqual(['SQL', 'Python']);
    expect(res.body.data.education.map((e) => e.school)).toEqual(['Rice University']);
    expect(res.body.data.experience).toHaveLength(0);
  });

  it('409 when an accepted change is no longer offered', async () => {
    const res = await call('POST', '/sync-from-resume/apply', { variantId: 'v1', accept: ['experience[00000000]'] });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'profile_sync_stale', paths: ['experience[00000000]'] });
  });

  it('another user’s resume is not found; an unread resume has nothing to offer', async () => {
    expect((await call('POST', '/sync-from-resume', { variantId: 'v-other' })).status).toBe(404);
    expect((await call<SyncFromResumeResponse>('POST', '/sync-from-resume', { variantId: 'v-scratch' })).body.data).toEqual({ variantId: 'v-scratch', parsed: false, diff: [] });
    expect((await call('POST', '/sync-from-resume/apply', { variantId: 'v1', accept: [] })).status).toBe(422);
  });
});

// Verification finding: after onboarding with a full resume the profile was
// still 0% complete (nine details "missing") although the resume had them.
describe('prefill from the onboarding resume (fills what is empty, never changes)', () => {
  const RA_BRAND = { id: 'roboapply', market: 'intl' } as never;
  const parsedData = {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    phone: '+1 415 555 0142',
    linkedin: 'linkedin.com/in/ada-lovelace',
    skills: ['SQL', 'Python'],
    education: [{ institution: 'Rice University', degree: 'MS', year: '2020' }],
    experience: [
      { company: 'Acme', role: 'Analyst', startDate: '2020-06', endDate: 'Present' },
      { company: 'Initech', role: 'Intern', startDate: '2019-06', endDate: '2019-09' },
    ],
  };

  beforeEach(() => {
    fake.$rows('rAResumeVariant').push(
      { id: 'v1', userId: 'u1', parsedData, deletedAt: null, isPrimary: true, resumeContentHash: 'h1' },
      { id: 'v-other', userId: 'u2', parsedData, deletedAt: null },
      { id: 'v-scratch', userId: 'u1', parsedData: null, deletedAt: null },
    );
  });

  it('an empty profile gets the name, contact details, link, skills, education and work from the resume', async () => {
    const svc = service();
    const before = await svc.get('u1', { brand: RA_BRAND });
    expect(before.completeness).toBe(0);
    const res = await svc.prefillFromResume('u1', 'v1', { brand: RA_BRAND });
    expect(res.filled).toEqual(expect.arrayContaining(['firstName', 'lastName', 'contactEmail', 'phoneE164', 'links.linkedin', 'skills']));
    expect(res.displayName).toBe('Ada Lovelace');
    const after = await svc.get('u1', { brand: RA_BRAND });
    expect(after).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', contactEmail: 'ada@example.test', phoneE164: '+14155550142', syncedFromVariantId: 'v1' });
    expect(after.links.linkedin).toBe('https://linkedin.com/in/ada-lovelace');
    expect(after.skills.map((s) => s.name)).toEqual(['SQL', 'Python']);
    expect(after.education.map((e) => e.school)).toEqual(['Rice University']);
    expect(after.experience.map((x) => x.company).sort()).toEqual(['Acme', 'Initech']);
    expect(after.completeness).toBeGreaterThan(before.completeness);
    const missing = after.missing.map((m) => m.key);
    for (const key of ['firstName', 'lastName']) expect(missing).not.toContain(key);
  });

  it('never changes what the user already has, and adds no rows next to existing ones', async () => {
    const svc = service();
    await svc.patch('u1', { firstName: 'Augusta', contactEmail: 'me@example.test' }, { brand: RA_BRAND });
    await svc.putSkills('u1', { skills: [{ name: 'Rust', confirmed: true }] }, { brand: RA_BRAND });
    await svc.addExperience('u1', { company: 'Own Co', title: 'Founder', current: true } as never, { brand: RA_BRAND });
    const res = await svc.prefillFromResume('u1', 'v1', { brand: RA_BRAND });
    expect(res.filled).not.toContain('firstName');
    // Only the family name came from the resume: the line is the profile's name as it now stands.
    expect(res.displayName).toBe('Augusta Lovelace');
    expect(res.filled).not.toContain('contactEmail');
    expect(res.filled).not.toContain('skills');
    expect(res.filled.some((p) => p.startsWith('experience['))).toBe(false);
    const after = await svc.get('u1', { brand: RA_BRAND });
    expect(after).toMatchObject({ firstName: 'Augusta', lastName: 'Lovelace', contactEmail: 'me@example.test' });
    expect(after.skills.map((s) => s.name)).toEqual(['Rust']);
    expect(after.experience.map((x) => x.company)).toEqual(['Own Co']);
    // Education was empty, so the resume's row is filled in.
    expect(after.education.map((e) => e.school)).toEqual(['Rice University']);
  });

  it('is idempotent, and does nothing for an unread, missing or foreign resume', async () => {
    const svc = service();
    await svc.prefillFromResume('u1', 'v1', { brand: RA_BRAND });
    expect(await svc.prefillFromResume('u1', 'v1', { brand: RA_BRAND })).toEqual({ filled: [], displayName: null });
    expect(fake.$rows('rAProfileExperience')).toHaveLength(2);
    userId = 'u1';
    const nothing = { filled: [], displayName: null };
    expect(await svc.prefillFromResume('u1', 'v-scratch', { brand: RA_BRAND })).toEqual(nothing);
    expect(await svc.prefillFromResume('u1', 'v-other', { brand: RA_BRAND })).toEqual(nothing);
    expect(await svc.prefillFromResume('u1', 'nope', { brand: RA_BRAND })).toEqual(nothing);
  });

  it('does not guess: a local phone number with no country stays empty', async () => {
    fake.$rows('rAResumeVariant').push({ id: 'v-local', userId: 'u1', parsedData: { name: 'Ada Lovelace', phone: '(415) 555-0142' }, deletedAt: null });
    const svc = service();
    const res = await svc.prefillFromResume('u1', 'v-local', { brand: RA_BRAND });
    expect(res.filled).toEqual(['firstName', 'lastName']);
    expect((await svc.get('u1', { brand: RA_BRAND })).phoneE164).toBeNull();
  });

  it('displayNameOf: Latin names are spaced, Chinese names are family name first with no space', async () => {
    const { displayNameOf } = await import('./service.js');
    expect(displayNameOf('Ada', 'King', 'Lovelace')).toBe('Ada King Lovelace');
    expect(displayNameOf('Ada', null, null)).toBe('Ada');
    expect(displayNameOf('小明', null, '王')).toBe('王小明');
    expect(displayNameOf(null, null, null)).toBeNull();
    expect(displayNameOf(' ', '', undefined)).toBeNull();
  });
});

// ── public surface used by other areas ──────────────────────────────────

describe('profileSnapshotForLlm (service)', () => {
  it('never touches sensitive answers and keys the cache on profile + primary resume', async () => {
    const touched: string[] = [];
    const spying = new Proxy(fake, {
      get(target, prop) {
        if (typeof prop === 'string') touched.push(prop);
        return Reflect.get(target, prop);
      },
    });
    fake.$rows('rAProfile').push({ userId: 'u1', headline: 'Analyst', links: {}, skills: [{ name: 'SQL', confirmed: true }], languages: [], workAuth: [], cnFields: null, updatedAt: new Date('2026-10-10T00:00:00Z') });
    fake.$rows('rASensitiveAnswers').push({ userId: 'u1', ciphertext: 'x', keyVersion: 1, updatedAt: new Date() });
    fake.$rows('rAResumeVariant').push({ id: 'v1', userId: 'u1', isPrimary: true, deletedAt: null, resumeContentHash: 'h1' });
    const svc = createProfileService({ ...deps, getDb: async () => spying as unknown as ProfileDb });
    const { getBrand } = await import('../../platform/brand/index.js');
    const snap = await svc.snapshotForLlm('u1', { brand: getBrand('roboapply') });
    expect(snap.text).toContain('Headline: Analyst');
    expect(snap.cacheKey).toHaveLength(32);
    expect(touched).not.toContain('rASensitiveAnswers');
  });

  it('autofill gets sensitive answers only with a live autofill_sensitive consent', async () => {
    const svc = service();
    const { getBrand } = await import('../../platform/brand/index.js');
    await svc.putSensitive('u1', { eeo: { gender: 'female' } }, { brand: getBrand('roboapply') });
    expect(await svc.sensitiveForAutofill('u1')).toBeNull();
    consent = true;
    expect(await svc.sensitiveForAutofill('u1')).toEqual({ eeo: { gender: 'female' } });
    expect(await svc.sensitiveForAutofill('u-none')).toBeNull();
  });
});

