// @vitest-environment node
//
// WP-55a service tests over an in-memory repository and stubbed area seams
// (no database, no network, no model):
//   - a protected question type never gets `source: 'ai'` (table test) and
//     never reaches the model;
//   - zero model calls with AI consent off (GoApply) or no text model;
//   - page-job fit never calls a model;
//   - saved jobs go through the private import path;
//   - autofill credit: reserved on start, committed only when a field was
//     filled, released otherwise;
//   - D1: the tracker moves to Applied only when the user says they submitted.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getBrand } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { CreditReplayError } from '../../platform/credits/index.js';
import { PROTECTED_QUESTION_TYPES } from './contract.js';
import type { DeviceRow, DeviceWithUser, ExtJobRow, ExtensionRepo, RunRow } from './repository.js';
import { createExtensionService, type ExtProfileView, type ExtensionDeps } from './service.js';
import { hashDeviceToken, hashPairCode } from './tokens.js';
import { ADVERSARIAL_PROTECTED, PROTECTED_SAMPLES, UNSUPPORTED_LANGUAGE_FREE_TEXT } from './questionSamples.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const ENV = { JWT_SECRET: 'test-secret' };

// ── In-memory repository ─────────────────────────────────────────────────

function memoryRepo() {
  const devices = new Map<string, DeviceRow & { tokenHash: string }>();
  const pairCodes = new Map<string, { userId: string; brand: string; expiresAt: Date; consumedAt: Date | null }>();
  const runs = new Map<string, RunRow>();
  const jobs = new Map<string, ExtJobRow & { urls: string[] }>();
  const users = new Map<string, { id: string; email: string; brand: string; isActive: boolean }>();
  const resumes = new Map<string, { tailored: { id: string; name: string } | null; primary: { id: string; name: string } | null }>();
  const tracker = new Map<string, string>();
  const siteRequests: unknown[] = [];
  const surveys: unknown[] = [];
  const artifactsLinked: Array<[string, string]> = [];
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;

  const repo: ExtensionRepo = {
    async createDevice(input) {
      const row = { id: id('dev'), ...input, lastSeenAt: null, revokedAt: null, createdAt: NOW };
      devices.set(row.id, row);
      return row;
    },
    async listDevices(userId, brand) {
      return [...devices.values()].filter((d) => d.userId === userId && d.brand === brand && !d.revokedAt);
    },
    async revokeDevice(userId, brand, devId, now) {
      const d = devices.get(devId);
      if (!d || d.userId !== userId || d.brand !== brand || d.revokedAt) return false;
      d.revokedAt = now;
      return true;
    },
    async findDeviceByTokenHash(hash) {
      const d = [...devices.values()].find((x) => x.tokenHash === hash);
      if (!d) return null;
      const u = users.get(d.userId)!;
      return { ...d, user: { ...u, role: 'user' } } as DeviceWithUser;
    },
    async touchDevice() {},
    async createPairCode(input) {
      pairCodes.set(input.tokenHash, { userId: input.userId, brand: input.brand, expiresAt: input.expiresAt, consumedAt: null });
    },
    async consumePairCode(hash, brand, now) {
      const c = pairCodes.get(hash);
      if (!c || c.brand !== brand || c.consumedAt || c.expiresAt <= now) return null;
      c.consumedAt = now;
      return { userId: c.userId };
    },
    async userBrand(userId) {
      return users.get(userId) ?? null;
    },
    async findJobByUrls({ market, userId, urls }) {
      return [...jobs.values()].find((j) => j.market === market && !j.archivedAt && j.urls.some((u) => urls.includes(u)) && (j.visibility === 'public' || j.ownerUserId === userId)) ?? null;
    },
    async loadJob(jobId) {
      return jobs.get(jobId) ?? null;
    },
    async createRun(input) {
      const row: RunRow = { id: id('run'), ...input, fieldsFilled: 0, aiAnswers: 0, outcome: 'started', userMarkedSubmitted: false };
      runs.set(row.id, row);
      return row;
    },
    async getRun(userId, runId) {
      const r = runs.get(runId);
      return r && r.userId === userId ? { ...r } : null;
    },
    async findRunByLedger(userId, ledger) {
      return [...runs.values()].find((r) => r.userId === userId && r.creditLedgerId === ledger) ?? null;
    },
    async updateRun(runId, data) {
      const r = runs.get(runId)!;
      Object.assign(r, data);
      return { ...r };
    },
    async incrementAiAnswers(runId) {
      runs.get(runId)!.aiAnswers += 1;
    },
    async trackerEntryFor(userId, jobId) {
      return tracker.get(`${userId}:${jobId}`) ?? null;
    },
    async resumesFor(userId, jobId) {
      return resumes.get(`${userId}:${jobId}`) ?? resumes.get(userId) ?? { tailored: null, primary: null };
    },
    async linkArtifactToRun(artifactId, runId) {
      artifactsLinked.push([artifactId, runId]);
    },
    async createSiteRequest(input) {
      siteRequests.push(input);
    },
    async createUninstallSurvey(input) {
      surveys.push(input);
    },
  };
  return { repo, devices, pairCodes, runs, jobs, users, resumes, tracker, siteRequests, surveys, artifactsLinked };
}

// ── Seams ────────────────────────────────────────────────────────────────

const profile: ExtProfileView = {
  firstName: 'Ada',
  middleName: null,
  lastName: 'Lovelace',
  headline: 'Engineer',
  contactEmail: null,
  phoneE164: '+15550100',
  phoneType: 'mobile',
  addressLine1: null,
  city: 'London',
  region: null,
  postalCode: null,
  country: 'GB',
  links: { linkedin: 'https://www.linkedin.com/in/ada', github: undefined },
  summary: null,
  skills: [{ name: 'Python' }],
  languages: [],
  workAuth: [{ country: 'GB', authorized: true, sponsorship: 'no' }],
  cnFields: null,
  twFields: null,
  education: [],
  experience: [{ company: 'Analytical Engines', title: 'Engineer' }],
  completeness: 72.4,
};

function setup(overrides: Partial<ExtensionDeps> = {}, brandId: 'roboapply' | 'goapply' = 'roboapply') {
  const mem = memoryRepo();
  // A small ledger with the real state rules: commit of a committed row is a
  // no-op, commit of a released row throws, a key is reusable once released.
  const ledger = { reserved: [] as string[], committed: [] as string[], released: [] as string[] };
  const rows = new Map<string, { id: string; key: string; bucket: string; status: 'reserved' | 'committed' | 'released' }>();
  const view = (r: { id: string; key: string; bucket: string; status: 'reserved' | 'committed' | 'released' }, replayed: boolean) => ({
    id: r.id,
    userId: 'u1',
    bucket: r.bucket,
    units: 1,
    status: r.status,
    fromSource: 'window',
    windowKey: 'd',
    idempotencyKey: r.key,
    replayed,
  });
  const credits = {
    reserve: vi.fn(async (opts: { idempotencyKey: string; bucket: string }) => {
      const existing = [...rows.values()].find((r) => r.key === `${opts.bucket}:${opts.idempotencyKey}` && r.status !== 'released');
      if (existing) return view(existing, true);
      const row = { id: `led_${rows.size + 1}`, key: `${opts.bucket}:${opts.idempotencyKey}`, bucket: opts.bucket, status: 'reserved' as const };
      rows.set(row.id, row);
      ledger.reserved.push(`${opts.bucket}:${row.id}`);
      return view(row, false);
    }),
    commit: vi.fn(async (rid: string) => {
      const row = rows.get(rid)!;
      if (row.status === 'released') throw new Error(`reservation ${rid} is released`);
      if (row.status === 'reserved') {
        row.status = 'committed';
        ledger.committed.push(rid);
      }
      return view(row, false) as never;
    }),
    release: vi.fn(async (rid: string) => {
      const row = rows.get(rid)!;
      if (row.status === 'committed') throw new Error(`reservation ${rid} is committed`);
      if (row.status === 'reserved') {
        row.status = 'released';
        ledger.released.push(rid);
      }
      return view(row, false) as never;
    }),
    withCredit: vi.fn(async (_opts: { bucket: string }, fn: (r: never) => Promise<unknown>) => fn({} as never)),
  };
  const draftAnswer = vi.fn(async () => 'I like building careful systems.');
  const deps: ExtensionDeps = {
    repo: mem.repo,
    now: () => NOW,
    env: { ...ENV, MIN_EXT_VERSION: '1.2.0', CN_MIN_EXT_VERSION: '2.0.0' },
    brand: () => getBrand(brandId),
    credits: credits as unknown as ExtensionDeps['credits'],
    profile: {
      get: vi.fn(async () => profile),
      snapshotText: vi.fn(async () => 'Engineer. Python.'),
      sensitiveForAutofill: vi.fn(async () => null),
      sensitiveConsent: vi.fn(async () => false),
    },
    answerBank: vi.fn(async () => []),
    markAgentSubmitted: vi.fn(async () => {}),
    entitlements: vi.fn(async () => ({ planKey: 'free' })),
    flags: vi.fn(async () => ({ extension: true })),
    match: {
      cached: vi.fn(async (_u: string, jobId: string) => ({ score: 81, tier: 'great', kind: 'ai' as const, topOverlap: jobId, topGap: null })),
      page: vi.fn(async () => ({ score: 55, tier: 'possible', kind: 'pre' as const, topOverlap: null, topGap: null })),
    },
    saveImportedJob: vi.fn(async () => ({ jobId: 'job_saved', matched: null })),
    tracker: {
      saveForJob: vi.fn(async (_u: string, jobId: string) => `te_${jobId}`),
      markApplied: vi.fn(async (_u: string, jobId: string) => ({ entryId: `te_${jobId}`, changed: true })),
    },
    recordInteraction: vi.fn(async () => {}),
    aiAvailability: vi.fn(async () => 'ok' as const),
    assertPhoneBound: vi.fn(async () => {}),
    draftAnswer,
    logAiLabel: vi.fn(async () => {}),
    unverifiedClaims: vi.fn(async () => 0),
    exportResume: vi.fn(async () => ({ buffer: Buffer.from('%PDF'), fileName: 'Ada.pdf', contentType: 'application/pdf', artifactId: 'art_1' })),
    cnPostingVisible: () => true,
    cnWhere: () => ({ OR: [{ visibility: 'public' }] }),
    ...overrides,
  };
  mem.users.set('u1', { id: 'u1', email: 'ada@example.test', brand: brandId, isActive: true });
  mem.users.set('u2', { id: 'u2', email: 'bob@example.test', brand: brandId, isActive: true });
  const market = brandId === 'goapply' ? 'cn' : 'intl';
  mem.jobs.set('j1', { id: 'j1', market, visibility: 'public', ownerUserId: null, sourceBoard: 'greenhouse', title: 'Engineer', companyName: 'Acme', archivedAt: null, urls: ['https://boards.greenhouse.io/acme/jobs/1'] });
  mem.jobs.set('jPriv', { id: 'jPriv', market, visibility: 'private', ownerUserId: 'u2', sourceBoard: 'user_import', title: 'Secret', companyName: 'Other', archivedAt: null, urls: ['https://other.example/1'] });
  const svc = createExtensionService(deps);
  return { svc, deps, mem, credits, ledger, draftAnswer };
}

async function newRun(t: ReturnType<typeof setup>, jobId?: string) {
  return t.svc.createRun('u1', 'dev_x', { host: 'boards.greenhouse.io', atsType: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', fieldsTotal: 10, ...(jobId ? { jobId } : {}) }, 'idem-1');
}

// ── Pairing and devices ──────────────────────────────────────────────────

describe('devices and pairing', () => {
  it('stores only the token hash and lists devices of this brand', async () => {
    const t = setup();
    const out = await t.svc.createDevice('u1', { name: 'Chrome on Mac', browser: 'chrome', extVersion: '1.0.0' });
    expect(out.token.startsWith('rax_')).toBe(true);
    const stored = t.mem.devices.get(out.deviceId)!;
    expect(stored.tokenHash).toBe(hashDeviceToken(out.token));
    expect(JSON.stringify(stored)).not.toContain(out.token);
    const status = await t.svc.status('u1');
    expect(status.minExtVersion).toBe('1.2.0');
    expect(status.devices.map((d) => d.id)).toEqual([out.deviceId]);
  });

  it('revokes only the user’s own device', async () => {
    const t = setup();
    const { deviceId } = await t.svc.createDevice('u1', { name: 'Edge' });
    await expect(t.svc.revokeDevice('u2', deviceId)).rejects.toMatchObject({ code: 'not_found' });
    await t.svc.revokeDevice('u1', deviceId);
    expect(t.mem.devices.get(deviceId)!.revokedAt).toEqual(NOW);
    expect(await t.svc.listDevices('u1')).toEqual([]);
  });

  it('pair codes are single use and per brand', async () => {
    const t = setup();
    const { code, expiresAt } = await t.svc.createPairCode('u1');
    expect(new Date(expiresAt).getTime() - NOW.getTime()).toBe(10 * 60_000);
    expect(t.mem.pairCodes.has(hashPairCode('roboapply', code))).toBe(true);
    const out = await t.svc.redeemPairCode({ code, name: 'Edge' });
    expect(t.mem.devices.get(out.deviceId)!.userId).toBe('u1');
    await expect(t.svc.redeemPairCode({ code, name: 'Edge' })).rejects.toMatchObject({ code: 'not_found', details: { reason: 'pair_code_invalid' } });
  });

  it('GoApply uses CN_MIN_EXT_VERSION', async () => {
    const t = setup({}, 'goapply');
    expect((await t.svc.status('u1')).minExtVersion).toBe('2.0.0');
  });
});

// ── Device reads ─────────────────────────────────────────────────────────

describe('me and autofill profile', () => {
  it('me reports the brand, the profile completeness and the min version', async () => {
    const t = setup();
    const me = await t.svc.me('u1');
    expect(me).toMatchObject({ user: { id: 'u1', email: 'ada@example.test', firstName: 'Ada' }, brand: { id: 'roboapply' }, profileCompleteness: 72, minExtVersion: '1.2.0' });
  });

  it('sensitive answers are null without the autofill_sensitive consent; bank answers are included', async () => {
    const t = setup({ answerBank: vi.fn(async () => [{ questionKey: 'notice_period', questionText: 'Notice period?', answer: 'Two weeks' }]) });
    const p = await t.svc.autofillProfile('u1');
    expect(p.sensitive).toBeNull();
    expect(p.profile.email).toBe('ada@example.test');
    expect(p.links).toEqual({ linkedin: 'https://www.linkedin.com/in/ada' });
    expect(p.answers).toEqual([{ questionKey: 'notice_period', questionText: 'Notice period?', answer: 'Two weeks' }]);
    expect(p.workAuth).toEqual([{ country: 'GB', authorized: true, sponsorship: 'no' }]);
  });

  const sensitiveBank = [
    { questionKey: 'notice_period', questionText: 'Notice period?', answer: 'Two weeks' },
    { questionKey: 'custom:gender', questionText: 'What is your gender?', answer: 'Woman' },
    { questionKey: 'politicalStatus', questionText: '政治面貌', answer: '群众' },
    { questionKey: 'familyMembers', questionText: '家庭成员', answer: '父母' },
    { questionKey: 'custom:veteran', questionText: 'Are you a protected veteran?', answer: 'No' },
  ];

  it('withholds sensitive answer-bank entries without the autofill_sensitive consent', async () => {
    const t = setup({ answerBank: vi.fn(async () => sensitiveBank) });
    const p = await t.svc.autofillProfile('u1');
    expect(p.answers.map((a) => a.questionKey)).toEqual(['notice_period']);
  });

  it('returns sensitive answer-bank entries with the consent', async () => {
    const t = setup({ answerBank: vi.fn(async () => sensitiveBank) });
    vi.mocked(t.deps.profile.sensitiveConsent).mockResolvedValue(true);
    const p = await t.svc.autofillProfile('u1');
    expect(p.answers.map((a) => a.questionKey)).toEqual(['notice_period', 'custom:gender', 'politicalStatus', 'familyMembers', 'custom:veteran']);
  });

  it('passes sensitive answers through only when the profile area releases them', async () => {
    const t = setup({ profile: { get: async () => profile, snapshotText: async () => '', sensitiveForAutofill: async () => ({ eeo: { gender: 'decline' } }), sensitiveConsent: async () => true } });
    expect((await t.svc.autofillProfile('u1')).sensitive).toEqual({ eeo: { gender: 'decline' } });
  });
});

// ── Page-job fit and save ────────────────────────────────────────────────

describe('page-job fit (user click only)', () => {
  it('uses the cached score for a known job and never drafts anything', async () => {
    const t = setup();
    const out = await t.svc.pageJob('u1', { url: 'https://boards.greenhouse.io/acme/jobs/1?utm_source=x', title: 'Engineer', company: 'Acme', descriptionText: 'Build.' });
    expect(out.jobId).toBe('j1');
    expect(out.fit).toMatchObject({ score: 81, kind: 'ai' });
    expect(t.deps.match.page).not.toHaveBeenCalled();
    expect(t.draftAnswer).not.toHaveBeenCalled();
  });

  it('estimates an unknown page and never links another user’s private job', async () => {
    const t = setup();
    const out = await t.svc.pageJob('u1', { url: 'https://other.example/1', title: 'Secret', company: 'Other', descriptionText: 'x' });
    expect(out).toEqual({ jobId: null, fit: { score: 55, tier: 'possible', kind: 'pre', topOverlap: null, topGap: null } });
    expect(t.deps.match.cached).not.toHaveBeenCalled();
  });

  it('GoApply in mode off: a third-party posting is not matched', async () => {
    const t = setup({ cnPostingVisible: (job) => job.visibility === 'private' }, 'goapply');
    const out = await t.svc.pageJob('u1', { url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'Engineer', company: 'Acme', descriptionText: 'x' });
    expect(out.jobId).toBeNull();
  });
});

describe('save job', () => {
  const body = { url: 'https://jobs.example.test/1?ref=abc', title: 'Engineer', company: 'Acme', descriptionText: 'Build reliable systems for our customers across many teams and time zones.' };

  it('saves through the private import path and adds a Saved tracker entry', async () => {
    const t = setup();
    const out = await t.svc.saveJob('u1', body, 'idem-save');
    expect(t.deps.saveImportedJob).toHaveBeenCalledWith(
      'u1',
      { title: 'Engineer', company: 'Acme', description: body.descriptionText, applyUrl: body.url },
      { idempotencyKey: 'idem-save' },
    );
    expect(t.deps.tracker.saveForJob).toHaveBeenCalledWith('u1', 'job_saved');
    expect(t.deps.recordInteraction).toHaveBeenCalledWith('u1', 'job_saved', 'save');
    expect(out).toEqual({ jobId: 'job_saved', trackerEntryId: 'te_job_saved', matched: null });
    expect(t.deps.tracker.markApplied).not.toHaveBeenCalled();
  });

  it('refuses page text too short to be a job post (contract)', async () => {
    const { SaveJobBodySchema } = await import('./contract.js');
    expect(SaveJobBodySchema.safeParse({ ...body, descriptionText: 'Short.' }).success).toBe(false);
    expect(SaveJobBodySchema.safeParse(body).success).toBe(true);
  });

  it('a failed affinity write never blocks the save', async () => {
    const t = setup({ recordInteraction: vi.fn(async () => Promise.reject(new Error('down'))) });
    await expect(t.svc.saveJob('u1', body, null)).resolves.toMatchObject({ jobId: 'job_saved' });
  });
});

// ── Autofill runs ────────────────────────────────────────────────────────

describe('autofill runs', () => {
  it('reserves one autofill credit and links the job found by URL', async () => {
    const t = setup();
    const out = await newRun(t);
    expect(out.jobId).toBe('j1');
    expect(t.credits.reserve).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'autofill', idempotencyKey: 'idem-1', userId: 'u1' }));
    expect(t.mem.runs.get(out.runId)!.creditLedgerId).toBe('led_1');
  });

  it('ignores a jobId the user may not see', async () => {
    const t = setup();
    const out = await t.svc.createRun('u1', 'dev_x', { host: 'x.example', atsType: 'other', url: 'https://x.example/apply', fieldsTotal: 3, jobId: 'jPriv' }, null);
    expect(out.jobId).toBeNull();
  });

  it('commits the credit only when a field was filled', async () => {
    const t = setup();
    const { runId } = await newRun(t);
    const out = await t.svc.patchRun('u1', runId, { fieldsFilled: 7, outcome: 'partial' });
    expect(out.charged).toBe(true);
    expect(t.ledger.committed).toEqual(['led_1']);
    expect(t.ledger.released).toEqual([]);
  });

  it('releases the credit when nothing was filled', async () => {
    const t = setup();
    const { runId } = await newRun(t);
    const out = await t.svc.patchRun('u1', runId, { fieldsFilled: 0, outcome: 'failed' });
    expect(out.charged).toBe(false);
    expect(t.ledger.released).toEqual(['led_1']);
    expect(t.ledger.committed).toEqual([]);
  });

  it('a run released on "nothing filled" that later fills is charged once, and `charged` stays true', async () => {
    const t = setup();
    const { runId } = await newRun(t);
    expect((await t.svc.patchRun('u1', runId, { fieldsFilled: 0, outcome: 'failed' })).charged).toBe(false);
    expect(t.ledger.released).toEqual(['led_1']);
    const second = await t.svc.patchRun('u1', runId, { fieldsFilled: 3, outcome: 'partial' });
    expect(second.charged).toBe(true);
    expect(t.ledger.committed).toEqual(['led_2']);
    expect(t.credits.reserve).toHaveBeenLastCalledWith(expect.objectContaining({ bucket: 'autofill', idempotencyKey: `ext-run-late:${runId}` }));
    const third = await t.svc.patchRun('u1', runId, { fieldsFilled: 3, outcome: 'filled' });
    expect(third.charged).toBe(true);
    expect(t.ledger.committed).toEqual(['led_2']);
    expect(t.ledger.reserved).toHaveLength(2);
  });

  it('`charged` is false after a release with nothing filled, on every later report', async () => {
    const t = setup();
    const { runId } = await newRun(t);
    await t.svc.patchRun('u1', runId, { fieldsFilled: 0, outcome: 'failed' });
    expect((await t.svc.patchRun('u1', runId, { fieldsFilled: 0, outcome: 'failed' })).charged).toBe(false);
    expect(t.ledger.committed).toEqual([]);
  });

  it('a late charge that fails (out of credits) reports not charged and still records the run', async () => {
    const t = setup();
    const { runId } = await newRun(t);
    await t.svc.patchRun('u1', runId, { fieldsFilled: 0, outcome: 'failed' });
    t.credits.reserve.mockRejectedValueOnce(new Error('quota'));
    const out = await t.svc.patchRun('u1', runId, { fieldsFilled: 2, outcome: 'partial' });
    expect(out).toMatchObject({ charged: false, fieldsFilled: 2 });
  });

  it('D1: no tracker move without the user saying they submitted', async () => {
    const t = setup();
    const { runId } = await newRun(t);
    const out = await t.svc.patchRun('u1', runId, { fieldsFilled: 10, outcome: 'filled' });
    expect(out.userMarkedSubmitted).toBe(false);
    expect(t.deps.tracker.markApplied).not.toHaveBeenCalled();
  });

  it('D1: "I submitted" moves the tracker to Applied once, via the extension', async () => {
    const t = setup();
    const { runId } = await newRun(t);
    const out = await t.svc.patchRun('u1', runId, { fieldsFilled: 10, outcome: 'filled', userMarkedSubmitted: true });
    expect(t.deps.tracker.markApplied).toHaveBeenCalledWith('u1', 'j1');
    expect(t.deps.recordInteraction).toHaveBeenCalledWith('u1', 'j1', 'applied');
    expect(t.deps.markAgentSubmitted).toHaveBeenCalledWith('u1', 'j1');
    expect(out).toMatchObject({ userMarkedSubmitted: true, trackerEntryId: 'te_j1', alreadyApplied: false });
    // Repeating the answer changes nothing and charges nothing more.
    const again = await t.svc.patchRun('u1', runId, { fieldsFilled: 10, outcome: 'filled', userMarkedSubmitted: true });
    expect(t.deps.tracker.markApplied).toHaveBeenCalledTimes(1);
    expect(t.ledger.committed).toEqual(['led_1']);
    expect(again.alreadyApplied).toBe(true);
  });

  it('reports alreadyApplied when the entry was already at Applied', async () => {
    const t = setup({ tracker: { saveForJob: async () => 'te', markApplied: async () => ({ entryId: 'te_old', changed: false }) } });
    const { runId } = await newRun(t);
    expect(await t.svc.patchRun('u1', runId, { fieldsFilled: 1, outcome: 'filled', userMarkedSubmitted: true })).toMatchObject({ alreadyApplied: true, trackerEntryId: 'te_old' });
  });

  it('404 for another user’s run', async () => {
    const t = setup();
    const { runId } = await newRun(t);
    await expect(t.svc.patchRun('u2', runId, { fieldsFilled: 1, outcome: 'filled' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ── Answers ──────────────────────────────────────────────────────────────

describe('answers: a protected question type never gets source "ai"', () => {
  const rows = PROTECTED_QUESTION_TYPES.flatMap((type) => PROTECTED_SAMPLES[type].map((q) => [type, q] as const));

  it.each(rows)('%s — %s', async (type, question) => {
    const t = setup();
    const { runId } = await newRun(t);
    for (const fieldType of ['text', 'textarea', 'select'] as const) {
      const out = await t.svc.answer('u1', { runId, question, fieldType }, null);
      expect(out.source).not.toBe('ai');
      expect(out).toMatchObject({ source: 'none', reason: 'protected', questionType: type, answer: null });
    }
    expect(t.draftAnswer).not.toHaveBeenCalled();
    expect(t.credits.withCredit).not.toHaveBeenCalled();
  });

  it('a protected question is answered from the bank when the user saved one', async () => {
    const t = setup({ answerBank: vi.fn(async () => [{ questionKey: 'notice_period', questionText: 'What is your notice period?', answer: 'Two weeks' }]) });
    const { runId } = await newRun(t);
    const out = await t.svc.answer('u1', { runId, question: 'What is your notice period?', fieldType: 'text' }, null);
    expect(out).toEqual({ answer: 'Two weeks', source: 'bank', saveable: false, questionType: 'notice_period', reason: null });
    expect(t.credits.withCredit).not.toHaveBeenCalled();
  });
});

describe('answers: the bank never crosses countries or the sensitive consent', () => {
  it('a work-authorization answer saved for the UK is not offered for a US question', async () => {
    const t = setup({ answerBank: vi.fn(async () => [{ questionKey: 'custom:wa', questionText: 'Are you authorized to work in the UK?', answer: 'Yes' }]) });
    const { runId } = await newRun(t);
    const out = await t.svc.answer('u1', { runId, question: 'Are you authorized to work in the US?', fieldType: 'select', options: ['Yes', 'No'] }, null);
    expect(out).toMatchObject({ source: 'none', reason: 'protected', questionType: 'work_authorization' });
  });

  it('a `work_authorization:us` key is not offered for a UK question, but is for a US one', async () => {
    const t = setup({ answerBank: vi.fn(async () => [{ questionKey: 'work_authorization:us', questionText: 'US work authorization', answer: 'Yes' }]) });
    const { runId } = await newRun(t);
    expect((await t.svc.answer('u1', { runId, question: 'Do you have the right to work in the United Kingdom?', fieldType: 'text' }, null)).source).toBe('none');
    expect((await t.svc.answer('u1', { runId, question: 'Are you legally authorized to work in the United States?', fieldType: 'text' }, null)).answer).toBe('Yes');
  });

  it('a sensitive saved answer needs the autofill_sensitive consent', async () => {
    const bank = [{ questionKey: 'custom:gender', questionText: 'What is your gender?', answer: 'Woman' }];
    const t = setup({ answerBank: vi.fn(async () => bank) });
    const { runId } = await newRun(t);
    const q = { runId, question: 'What is your gender?', fieldType: 'select' as const, options: ['Woman', 'Man', 'Decline'] };
    expect(await t.svc.answer('u1', q, null)).toMatchObject({ source: 'none', answer: null, reason: 'protected' });
    vi.mocked(t.deps.profile.sensitiveConsent).mockResolvedValue(true);
    expect(await t.svc.answer('u1', q, null)).toMatchObject({ source: 'bank', answer: 'Woman' });
    expect(t.draftAnswer).not.toHaveBeenCalled();
  });

  it('a non-sensitive bank hit does not ask for the consent', async () => {
    const t = setup({ answerBank: vi.fn(async () => [{ questionKey: 'notice_period', questionText: 'What is your notice period?', answer: 'Two weeks' }]) });
    const { runId } = await newRun(t);
    await t.svc.answer('u1', { runId, question: 'What is your notice period?', fieldType: 'text' }, null);
    expect(t.deps.profile.sensitiveConsent).not.toHaveBeenCalled();
  });
});

describe('answers: everyday protected phrasings are never drafted (adversarial table)', () => {
  it.each(ADVERSARIAL_PROTECTED)('%s', async (question) => {
    const t = setup();
    const { runId } = await newRun(t);
    for (const fieldType of ['text', 'textarea'] as const) {
      const out = await t.svc.answer('u1', { runId, question, fieldType }, null);
      expect(out.source).not.toBe('ai');
      expect(out.questionType).not.toBe('free_text');
    }
    expect(t.draftAnswer).not.toHaveBeenCalled();
    expect(t.credits.withCredit).not.toHaveBeenCalled();
  });
});

describe('answers: a question in another language is never drafted (fails closed)', () => {
  it.each(UNSUPPORTED_LANGUAGE_FREE_TEXT)('%s', async (question) => {
    const t = setup();
    const { runId } = await newRun(t);
    const out = await t.svc.answer('u1', { runId, question, fieldType: 'textarea' }, null);
    expect(out.source).toBe('none');
    expect(['protected', 'unsupported_language']).toContain(out.reason);
    expect(t.draftAnswer).not.toHaveBeenCalled();
    expect(t.credits.withCredit).not.toHaveBeenCalled();
  });

  it('a saved answer is still offered for it', async () => {
    const t = setup({ answerBank: vi.fn(async () => [{ questionKey: 'custom:warum', questionText: 'Warum möchten Sie bei uns arbeiten?', answer: 'Wegen der Mission.' }]) });
    const { runId } = await newRun(t);
    expect(await t.svc.answer('u1', { runId, question: 'Warum möchten Sie bei uns arbeiten?', fieldType: 'textarea' }, null)).toMatchObject({ source: 'bank', answer: 'Wegen der Mission.' });
  });
});

describe('answers: free text', () => {
  const q = { question: 'Why do you want to work at Acme?', fieldType: 'textarea' as const };

  it('a bank hit is free', async () => {
    const t = setup({ answerBank: vi.fn(async () => [{ questionKey: 'custom:1', questionText: 'Why do you want to work at Acme?', answer: 'The mission.' }]) });
    const { runId } = await newRun(t);
    expect((await t.svc.answer('u1', { runId, ...q }, null)).source).toBe('bank');
    expect(t.credits.withCredit).not.toHaveBeenCalled();
    expect(t.draftAnswer).not.toHaveBeenCalled();
  });

  it('an AI draft spends one ai_answer credit and uses only the profile snapshot', async () => {
    const t = setup();
    const { runId } = await newRun(t, 'j1');
    const out = await t.svc.answer('u1', { runId, ...q, maxLength: 20 }, 'idem-ans');
    expect(out).toMatchObject({ source: 'ai', saveable: true, questionType: 'free_text' });
    expect(out.answer!.length).toBeLessThanOrEqual(20);
    expect(t.credits.withCredit).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'ai_answer', idempotencyKey: 'idem-ans' }), expect.any(Function));
    expect(t.draftAnswer).toHaveBeenCalledWith(expect.objectContaining({ profileText: 'Engineer. Python.', job: { title: 'Engineer', company: 'Acme' } }));
    expect(t.deps.profile.sensitiveForAutofill).not.toHaveBeenCalled();
    expect(t.mem.runs.get(runId)!.aiAnswers).toBe(1);
  });

  it('an empty draft is not charged: the ai_answer reservation is released', async () => {
    const t = setup({ draftAnswer: vi.fn(async () => '   ') });
    // Real withCredit semantics: reserve → fn → commit on success / release on throw.
    t.credits.withCredit.mockImplementation(async (opts: { bucket: string; idempotencyKey?: string }, fn: (r: never) => Promise<unknown>) => {
      const r = await t.credits.reserve({ bucket: opts.bucket, idempotencyKey: opts.idempotencyKey ?? 'k' });
      try {
        const out = await fn(r as never);
        await t.credits.commit(r.id);
        return out;
      } catch (err) {
        await t.credits.release(r.id);
        throw err;
      }
    });
    const { runId } = await newRun(t, 'j1');
    const reservedBefore = t.ledger.reserved.length;
    const out = await t.svc.answer('u1', { runId, ...q }, 'idem-empty');
    expect(out).toMatchObject({ source: 'none', reason: 'empty', answer: null });
    expect(t.ledger.reserved.length).toBe(reservedBefore + 1);
    const rid = t.ledger.reserved.at(-1)!.split(':')[1]!;
    expect(t.ledger.released).toContain(rid);
    expect(t.ledger.committed).not.toContain(rid);
    expect(t.mem.runs.get(runId)!.aiAnswers ?? 0).toBe(0);
  });

  it('zero model calls with AI consent off', async () => {
    const t = setup({ aiAvailability: vi.fn(async () => 'ai_off' as const) }, 'goapply');
    const { runId } = await newRun(t);
    expect(await t.svc.answer('u1', { runId, ...q }, null)).toMatchObject({ source: 'none', reason: 'ai_off' });
    expect(t.draftAnswer).not.toHaveBeenCalled();
    expect(t.credits.withCredit).not.toHaveBeenCalled();
  });

  it('zero model calls when the brand has no text model', async () => {
    const t = setup({ aiAvailability: vi.fn(async () => 'ai_unavailable' as const) });
    const { runId } = await newRun(t);
    expect((await t.svc.answer('u1', { runId, ...q }, null)).reason).toBe('ai_unavailable');
    expect(t.draftAnswer).not.toHaveBeenCalled();
  });

  it('choice fields are never drafted', async () => {
    const t = setup();
    const { runId } = await newRun(t);
    expect((await t.svc.answer('u1', { runId, question: 'How did you hear about us?', fieldType: 'select', options: ['LinkedIn', 'Friend'] }, null)).reason).toBe('choice_field');
    expect(t.draftAnswer).not.toHaveBeenCalled();
  });

  it('GoApply checks the bound phone before drafting', async () => {
    const assertPhoneBound = vi.fn(async () => {
      throw new HttpError('forbidden', 'Bind a phone first.', { reason: 'phone_binding_required' });
    });
    const t = setup({ assertPhoneBound }, 'goapply');
    const { runId } = await newRun(t);
    await expect(t.svc.answer('u1', { runId, ...q }, null)).rejects.toMatchObject({ code: 'forbidden' });
    expect(t.draftAnswer).not.toHaveBeenCalled();
  });

  it('a replayed idempotency key is a 409, not a second charge', async () => {
    const t = setup();
    t.credits.withCredit.mockRejectedValueOnce(new CreditReplayError('committed'));
    const { runId } = await newRun(t);
    await expect(t.svc.answer('u1', { runId, ...q }, 'same')).rejects.toMatchObject({ code: 'conflict' });
  });
});

// ── Resume files ─────────────────────────────────────────────────────────

describe('resume for job and the signed file', () => {
  it('prefers a verified tailored copy and signs a 5-minute link', async () => {
    const t = setup();
    t.mem.resumes.set('u1:j1', { tailored: { id: 'rv_t', name: 'Ada - Acme' }, primary: { id: 'rv_p', name: 'Ada' } });
    const { runId } = await newRun(t, 'j1');
    const out = await t.svc.resumeForJob('u1', { jobId: 'j1', runId }, 'https://www.roboapply.io');
    expect(out).toMatchObject({ variantId: 'rv_t', isTailored: true, fileName: 'Ada - Acme.pdf', tailoredNeedsReview: false });
    expect(out.downloadUrl).toMatch(/^https:\/\/www\.roboapply\.io\/api\/v1\/roboapply\/ext\/files\/.+\..+$/);
  });

  it('falls back to the main resume while the tailored copy has details to verify', async () => {
    const t = setup({ unverifiedClaims: vi.fn(async () => 2) });
    t.mem.resumes.set('u1:j1', { tailored: { id: 'rv_t', name: 'T' }, primary: { id: 'rv_p', name: 'Main' } });
    const { runId } = await newRun(t, 'j1');
    expect(await t.svc.resumeForJob('u1', { jobId: 'j1', runId }, 'https://x')).toMatchObject({ variantId: 'rv_p', isTailored: false, tailoredNeedsReview: true });
  });

  it('a form outside the user’s listings gets the main resume (runId only), not recorded on an application', async () => {
    const t = setup();
    t.mem.resumes.set('u1', { tailored: null, primary: { id: 'rv_p', name: 'Main' } });
    const { runId, jobId } = await t.svc.createRun('u1', 'dev_x', { host: 'jobs.lever.co', atsType: 'lever', url: 'https://jobs.lever.co/elsewhere/42', fieldsTotal: 8 }, null);
    expect(jobId).toBeNull();
    const out = await t.svc.resumeForJob('u1', { runId }, 'https://x');
    expect(out).toMatchObject({ variantId: 'rv_p', isTailored: false, tailoredNeedsReview: false });
    t.deps.exportResume = vi.fn(async () => ({ buffer: Buffer.from('%PDF'), fileName: 'Main.pdf', contentType: 'application/pdf', artifactId: null }));
    const file = await t.svc.file('u1', out.downloadUrl.split('/files/')[1]!);
    expect(file.fileName).toBe('Main.pdf');
    expect(t.deps.exportResume).toHaveBeenCalledWith('u1', 'rv_p', expect.objectContaining({ trackerEntryId: null }));
    expect(t.deps.tracker.saveForJob).not.toHaveBeenCalled();
    expect(t.mem.artifactsLinked).toEqual([]);
  });

  it('a jobId other than the run’s job is refused (one run, one application)', async () => {
    const t = setup();
    t.mem.jobs.set('j2', { ...t.mem.jobs.get('j1')!, id: 'j2' });
    const { runId } = await newRun(t, 'j1');
    await expect(t.svc.resumeForJob('u1', { jobId: 'j2', runId }, 'https://x')).rejects.toMatchObject({ code: 'conflict', details: { reason: 'run_job_mismatch' } });
    expect(t.deps.tracker.saveForJob).not.toHaveBeenCalled();
  });

  it('runId only uses the run’s job when it has one', async () => {
    const t = setup();
    t.mem.resumes.set('u1:j1', { tailored: { id: 'rv_t', name: 'T' }, primary: { id: 'rv_p', name: 'Main' } });
    const { runId } = await newRun(t);
    expect(await t.svc.resumeForJob('u1', { runId }, 'https://x')).toMatchObject({ variantId: 'rv_t', isTailored: true });
  });

  it('an explicit jobId the user may not see is a 404', async () => {
    const t = setup();
    const { runId } = await newRun(t);
    await expect(t.svc.resumeForJob('u1', { runId, jobId: 'jPriv' }, 'https://x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('404 no_resume when the user has none', async () => {
    const t = setup();
    const { runId } = await newRun(t, 'j1');
    await expect(t.svc.resumeForJob('u1', { jobId: 'j1', runId }, 'https://x')).rejects.toMatchObject({ details: { reason: 'no_resume' } });
  });

  it('the file records the artifact on the application, for the link owner only', async () => {
    const t = setup();
    t.mem.resumes.set('u1:j1', { tailored: null, primary: { id: 'rv_p', name: 'Main' } });
    const { runId } = await newRun(t, 'j1');
    const { downloadUrl } = await t.svc.resumeForJob('u1', { jobId: 'j1', runId }, 'https://x');
    const token = downloadUrl.split('/files/')[1]!;
    await expect(t.svc.file('u2', token)).rejects.toMatchObject({ code: 'not_found' });
    const file = await t.svc.file('u1', token);
    expect(file.contentType).toBe('application/pdf');
    expect(t.deps.tracker.saveForJob).toHaveBeenCalledWith('u1', 'j1');
    expect(t.deps.exportResume).toHaveBeenCalledWith('u1', 'rv_p', expect.objectContaining({ trackerEntryId: 'te_j1' }));
    expect(t.mem.artifactsLinked).toEqual([['art_1', runId]]);
    expect(t.mem.runs.get(runId)!.trackerEntryId).toBe('te_j1');
  });

  it('an expired link says so', async () => {
    let now = NOW;
    const t = setup({ now: () => now });
    t.mem.resumes.set('u1:j1', { tailored: null, primary: { id: 'rv_p', name: 'Main' } });
    const { runId } = await newRun(t, 'j1');
    const { downloadUrl } = await t.svc.resumeForJob('u1', { jobId: 'j1', runId }, 'https://x');
    now = new Date(NOW.getTime() + 6 * 60_000);
    await expect(t.svc.file('u1', downloadUrl.split('/files/')[1]!)).rejects.toMatchObject({ details: { reason: 'file_link_expired' } });
  });
});

// ── Site requests and the survey ─────────────────────────────────────────

describe('site requests and uninstall survey', () => {
  it('keeps only origin + path of a requested page', async () => {
    const t = setup();
    await t.svc.siteRequest('u1', { host: 'Careers.Example.COM', url: 'https://careers.example.com/apply/1?email=a@b.c#x', note: ' please ' });
    expect(t.mem.siteRequests).toEqual([{ userId: 'u1', host: 'careers.example.com', url: 'https://careers.example.com/apply/1', note: 'please' }]);
    // The host is the URL's own: a claimed host that does not match is ignored.
    await t.svc.siteRequest('u1', { host: 'greenhouse.io', url: 'https://jobs.other.example/apply' });
    expect(t.mem.siteRequests.at(-1)).toMatchObject({ host: 'jobs.other.example', url: 'https://jobs.other.example/apply' });
  });

  it('stores the survey without a user id', async () => {
    const t = setup();
    await t.svc.uninstallSurvey({ reasons: ['privacy', 'privacy', 'other'], note: '  too many fields ' });
    expect(t.mem.surveys).toEqual([{ brand: 'roboapply', userId: null, answers: { reasons: ['privacy', 'other'], note: 'too many fields' } }]);
  });
});
