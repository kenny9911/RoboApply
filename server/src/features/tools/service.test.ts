// @vitest-environment node
//
// WP-57 service tests: file and field validation, the GoApply processing
// notice, the persisted 3-a-day allowance per tool (fail closed; an
// unreadable file uses no check), the attempts guard, the 24 h hash cache
// (does not count), the short report (top issues only, labelled 'rules', no
// score), the requirement rows (no score), GoApply open on every stack with
// the notice ticked (and the outside-the-mainland line where it applies), results
// bound to the browser that ran them (visitor cookie), the signup claim
// (idempotent, other users 404, expiry 404, resume limit 409 that
// un-claims), result reads and the purge.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand, type BrandId } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { DAY, rateLimitKey, windowStartFor } from '../../platform/ratelimit/index.js';
import { runChecklist, runRequirementRows } from './checks.js';
import { TOOLS_CONSENT_VERSION, TOOLS_LIMITS, type ResumeCheckReport, type ResumeJobMatchReport } from './contract.js';
import { CN_RESUME_MD, FILES, POSTING, WEAK_RESUME_MD } from './fixtures.js';
import { createMemoryRateReader, createMemoryToolsStore, type MemoryToolsStore } from './memoryStore.js';
import {
  ResumeLimitReachedError,
  createToolsRate,
  createToolsService,
  fileProblem,
  hashVisitor,
  isVisitorId,
  looksLike,
  newVisitorId,
  processedOutsideMainland,
  toolsOpen,
  type ToolsRate,
  type ToolsService,
  type UploadedFile,
} from './service.js';
import { hashResultId } from './store.js';
import { crossBorderConsentApplies } from '../compliance/disclosures.js';

const T0 = new Date('2026-10-10T12:00:00.000Z');
/** The visitor cookie of "this browser", and of another one. */
const V = 'v'.repeat(43);
const OTHER_BROWSER = 'w'.repeat(43);
/** GoApply on the mainland stack. The tools are open there and offshore alike. */
const MAINLAND = { DEPLOY_REGION: 'cn-mainland' };
/** GoApply on a mainland deployment with every China-specific provider set: nothing resolves to the shared stack. */
const MAINLAND_OWN_STACK = {
  ...MAINLAND,
  CN_LLM_PROVIDER: 'deepseek',
  CN_LLM_MODEL: 'deepseek-chat',
  CN_LIVEKIT_URL: 'wss://cn.livekit.example',
  CN_INTERVIEW_ENGINE_STT_MODEL: 'paraformer',
  CN_INTERVIEW_ENGINE_TTS_MODEL: 'cosyvoice',
  CN_S3_BUCKET: 'goapply-cn',
  // A bucket of its own counts as mainland storage only on a mainland endpoint (compliance `ownStackLeavesMainland`).
  CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
  CN_VAPID_PUBLIC_KEY: 'pk',
  CN_EMAIL_TRANSPORT: 'aliyun_dm',
};

function file(buffer: Buffer, name = 'resume.txt', mimetype = 'text/plain'): UploadedFile {
  return { buffer, originalname: name, mimetype, size: buffer.byteLength };
}

/** Counts by `brand|ip|kind`; attempts by `brand|ip`. */
function fakeRate(limit: number = TOOLS_LIMITS.perIpPerDay, attemptLimit: number = TOOLS_LIMITS.attemptsPerIpPerDay) {
  const used = new Map<string, number>();
  const attempts = new Map<string, number>();
  const rate: ToolsRate & { used: Map<string, number>; attempts: Map<string, number>; fail: boolean; failRead: boolean } = {
    used,
    attempts,
    fail: false,
    failRead: false,
    async consume(ip, brandId, _now, kind) {
      if (rate.fail) throw new Error('db down');
      const k = `${brandId}|${ip}|${kind}`;
      const n = (used.get(k) ?? 0) + 1;
      used.set(k, n);
      return { allowed: n <= limit, retryAfterSec: n <= limit ? 0 : 3600, limit };
    },
    async remaining(ip, brandId, _now, kind) {
      if (rate.failRead) throw new Error('db down');
      return { remaining: Math.max(0, limit - (used.get(`${brandId}|${ip}|${kind}`) ?? 0)), resetsAt: new Date('2026-10-11T00:00:00.000Z'), limit };
    },
    async attempt(ip, brandId) {
      if (rate.fail) throw new Error('db down');
      const k = `${brandId}|${ip}`;
      const n = (attempts.get(k) ?? 0) + 1;
      attempts.set(k, n);
      return { allowed: n <= attemptLimit, retryAfterSec: n <= attemptLimit ? 0 : 7200 };
    },
  };
  return rate;
}

interface Setup {
  service: ToolsService;
  store: MemoryToolsStore;
  rate: ReturnType<typeof fakeRate>;
  parse: ReturnType<typeof vi.fn>;
  createResume: ReturnType<typeof vi.fn>;
  clock: { now: Date };
}

function setup(
  brandId: BrandId = 'roboapply',
  opts: { env?: Record<string, string | undefined>; markdown?: string; attemptLimit?: number } = {},
): Setup {
  const store = createMemoryToolsStore();
  const rate = fakeRate(TOOLS_LIMITS.perIpPerDay, opts.attemptLimit);
  const clock = { now: T0 };
  const parse = vi.fn(async (input: { buffer: Buffer; fileName: string }) => ({
    markdown: opts.markdown ?? (input.fileName.endsWith('.txt') ? input.buffer.toString('utf8') : WEAK_RESUME_MD),
    name: 'resume',
    via: 'local_text' as const,
  }));
  const createResume = vi.fn(async (_userId: string, _input: { name: string; markdown: string }) => ({ id: `rv_${createResume.mock.calls.length}` }));
  let seq = 0;
  const service = createToolsService({
    store,
    rate,
    parse,
    checklist: (md, profile) => runChecklist(md, profile, () => clock.now),
    requirementRows: (md, posting, profile) => runRequirementRows(md, posting, profile, () => clock.now),
    createResume,
    brand: () => getBrand(brandId),
    env: opts.env ?? {},
    now: () => clock.now,
    newResultId: () => `result_${String(++seq).padStart(40, '0')}`,
  });
  return { service, store, rate, parse, createResume, clock };
}

async function rejection(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

const reason = (e: HttpError) => (e.details as { reason?: string } | undefined)?.reason;

let s: Setup;
beforeEach(() => {
  s = setup();
});
afterEach(() => vi.clearAllMocks());

describe('file and field checks (free, before the allowance)', () => {
  it('refuses a missing, empty, oversized, renamed or unsupported file', () => {
    expect(reason(fileProblem(null)!)).toBe('file_missing');
    expect(reason(fileProblem(file(Buffer.alloc(0)))!)).toBe('file_missing');
    const big = file(FILES.pdf(), 'cv.pdf', 'application/pdf');
    expect(reason(fileProblem({ ...big, size: TOOLS_LIMITS.maxFileBytes + 1 })!)).toBe('file_too_large');
    expect(reason(fileProblem(file(FILES.png(), 'cv.pdf', 'application/pdf'))!)).toBe('file_wrong_type');
    expect(reason(fileProblem(file(FILES.png(), 'cv.png', 'image/png'))!)).toBe('file_wrong_type');
    expect(fileProblem(file(FILES.pdf(), 'cv.pdf', 'application/pdf'))).toBeNull();
    expect(fileProblem(file(FILES.docx(), 'cv.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toBeNull();
    expect(fileProblem(file(FILES.doc(), 'cv.doc', 'application/msword'))).toBeNull();
    expect(fileProblem(file(FILES.txt()))).toBeNull();
  });

  it('checks the first bytes against the declared kind', () => {
    expect(looksLike(FILES.pdf(), '.pdf', '')).toBe(true);
    expect(looksLike(FILES.docx(), '.pdf', '')).toBe(false);
    expect(looksLike(Buffer.from([0x41, 0x00, 0x42]), '.txt', 'text/plain')).toBe(false);
    expect(looksLike(FILES.txt(), '.rtf', 'application/rtf')).toBe(false);
  });

  it('a refused file costs nothing: no allowance used, no attempt, no parse', async () => {
    const e = await rejection(s.service.run('resume_check', { visitor: V, ip: '1.1.1.1', file: file(FILES.png(), 'cv.png', 'image/png'), fields: {} }));
    expect(e.status).toBe(422);
    expect(s.rate.used.size).toBe(0);
    expect(s.rate.attempts.size).toBe(0);
    expect(s.parse).not.toHaveBeenCalled();
  });

  it('an unreadable file does not use one of the day’s checks', async () => {
    s.parse.mockRejectedValueOnce(new HttpError('invalid_request', 'unreadable', { reason: 'file_unreadable' }));
    const e = await rejection(s.service.run('resume_check', { visitor: V, ip: 'u', file: file(FILES.txt()), fields: {} }));
    expect(reason(e)).toBe('file_unreadable');
    expect((await s.service.config('u')).remainingByTool.resume_check).toBe(3);
    expect(s.rate.used.size).toBe(0);
    // It still counts as an attempt (the guard that bounds parses).
    expect(s.rate.attempts.get('roboapply|u')).toBe(1);
    await expect(s.service.run('resume_check', { visitor: V, ip: 'u', file: file(FILES.txt()), fields: {} })).resolves.toBeTruthy();
    expect((await s.service.config('u')).remainingByTool.resume_check).toBe(2);
  });

  it('the job check needs a title and the posting text', async () => {
    const f = file(FILES.txt());
    expect(reason(await rejection(s.service.run('resume_job_match', { visitor: V, ip: 'i', file: f, fields: { postingText: POSTING.text } })))).toBe('posting_title_missing');
    expect(reason(await rejection(s.service.run('resume_job_match', { visitor: V, ip: 'i', file: f, fields: { postingTitle: 'X', postingText: 'too short' } })))).toBe(
      'posting_too_short',
    );
    expect(
      reason(await rejection(s.service.run('resume_job_match', { visitor: V, ip: 'i', file: f, fields: { postingTitle: 'X', postingText: 'a'.repeat(TOOLS_LIMITS.postingMaxChars + 1) } }))),
    ).toBe('posting_too_long');
    expect(s.rate.used.size).toBe(0);
  });
});

describe('resume check', () => {
  it('answers a short, automated checklist: label, counts over everything, the top issues most severe first', async () => {
    const r = (await s.service.run('resume_check', { visitor: V, ip: '1.1.1.1', file: file(FILES.txt()), fields: {} })) as ResumeCheckReport;
    expect(r.kind).toBe('resume_check');
    expect(r.method).toBe('rules');
    expect(r.full).toBe(false);
    expect(r.cached).toBe(false);
    expect(['excellent', 'good', 'fair', 'needs_work']).toContain(r.label);
    expect(r).not.toHaveProperty('score');
    const total = r.counts.urgent + r.counts.critical + r.counts.optional;
    expect(total).toBeGreaterThan(TOOLS_LIMITS.shortReportIssues);
    expect(r.issues).toHaveLength(TOOLS_LIMITS.shortReportIssues);
    expect(r.hiddenIssueCount).toBe(total - TOOLS_LIMITS.shortReportIssues);
    const order = { urgent: 0, critical: 1, optional: 2 } as const;
    const sev = r.issues.map((i) => order[i.severity]);
    expect([...sev].sort()).toEqual(sev);
    for (const i of r.issues) {
      expect(i).not.toHaveProperty('target');
      expect(i).not.toHaveProperty('fixable');
    }
    expect(r.expiresAt).toBe(new Date(T0.getTime() + 24 * 3600_000).toISOString());
    expect(r.rulesChecked).toBeGreaterThan(0);
  });

  it('stores one cache row per run with the full report and the resume text, never the file', async () => {
    const r = await s.service.run('resume_check', { visitor: V, ip: '1.1.1.1', file: file(FILES.txt()), fields: {} });
    expect(s.store.rows).toHaveLength(1);
    const row = s.store.rows[0]!;
    expect(row.tokenHash).toBe(hashResultId(r.resultId));
    expect(row.tokenHash).not.toContain(r.resultId);
    expect(row.payload.resume?.markdown).toContain('Sam Rivera');
    expect((row.payload.report as { issues: unknown[] }).issues.length).toBeGreaterThan(TOOLS_LIMITS.shortReportIssues);
    expect(JSON.stringify(row.payload)).not.toContain('base64');
  });
});

describe('allowance: 3 a day per IP and tool, persisted, cache hits and unreadable files are free', () => {
  it('the fourth new run from one IP is 429 with Retry-After; another IP is unaffected', async () => {
    for (let i = 0; i < 3; i += 1) {
      await s.service.run('resume_check', { visitor: V, ip: '9.9.9.9', file: file(FILES.txt(`${WEAK_RESUME_MD}\n- Variant ${i}`)), fields: {} });
    }
    const e = await rejection(s.service.run('resume_check', { visitor: V, ip: '9.9.9.9', file: file(FILES.txt(`${WEAK_RESUME_MD}\n- Variant 4`)), fields: {} }));
    expect(e.status).toBe(429);
    expect(e.code).toBe('rate_limited');
    // Refused before the parse; retry when the day's window resets.
    expect(e.headers?.['Retry-After']).toBe(String(12 * 3600));
    expect(s.parse).toHaveBeenCalledTimes(3);
    await expect(s.service.run('resume_check', { visitor: V, ip: '8.8.8.8', file: file(FILES.txt()), fields: {} })).resolves.toBeTruthy();
  });

  it('each tool has its own 3 a day: three resume checks leave the job check untouched', async () => {
    for (let i = 0; i < 3; i += 1) {
      await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt(`${WEAK_RESUME_MD}\n- Variant ${i}`)), fields: {} });
    }
    await expect(s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt(`${WEAK_RESUME_MD}\n- Variant 9`)), fields: {} })).rejects.toMatchObject({
      code: 'rate_limited',
    });
    const job = await s.service.run('resume_job_match', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: { postingTitle: POSTING.title, postingText: POSTING.text } });
    expect(job.kind).toBe('resume_job_match');
    expect(s.rate.used.get('roboapply|x|resume_check')).toBe(3);
    expect(s.rate.used.get('roboapply|x|resume_job_match')).toBe(1);
    expect((await s.service.config('x')).remainingByTool).toEqual({ resume_check: 0, resume_job_match: 2 });
  });

  it('with none left, the run is refused before any parse', async () => {
    s.rate.used.set('roboapply|p|resume_check', 3);
    const e = await rejection(s.service.run('resume_check', { visitor: V, ip: 'p', file: file(FILES.txt()), fields: {} }));
    expect(e.status).toBe(429);
    expect(e.details).toMatchObject({ limit: 3 });
    expect(Number(e.headers?.['Retry-After'])).toBe(12 * 3600);
    expect(s.parse).not.toHaveBeenCalled();
  });

  it('a run that loses the race for the last check is 429 after the parse, and nothing is stored', async () => {
    const consume = vi.spyOn(s.rate, 'consume').mockResolvedValueOnce({ allowed: false, retryAfterSec: 500, limit: 3 });
    const e = await rejection(s.service.run('resume_check', { visitor: V, ip: 'r', file: file(FILES.txt()), fields: {} }));
    expect(e.status).toBe(429);
    expect(e.details).toMatchObject({ limit: 3 });
    expect(e.headers?.['Retry-After']).toBe('500');
    expect(s.parse).toHaveBeenCalledTimes(1);
    expect(s.store.rows).toHaveLength(0);
    consume.mockRestore();
  });

  it('the attempts guard bounds what one IP can cause, cache hits included', async () => {
    const tight = setup('roboapply', { attemptLimit: 2 });
    await tight.service.run('resume_check', { visitor: V, ip: 'a', file: file(FILES.txt()), fields: {} });
    await tight.service.run('resume_check', { visitor: V, ip: 'a', file: file(FILES.txt()), fields: {} });
    const e = await rejection(tight.service.run('resume_check', { visitor: V, ip: 'a', file: file(FILES.txt()), fields: {} }));
    expect(e.status).toBe(429);
    expect(reason(e)).toBe('too_many_attempts');
    expect(tight.parse).toHaveBeenCalledTimes(1);
  });

  it('one run per visitor and tool at a time: a second upload while the first parses is 429', async () => {
    let release!: () => void;
    s.parse.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ markdown: WEAK_RESUME_MD, name: 'resume', via: 'local_text' });
        }),
    );
    const first = s.service.run('resume_check', { visitor: V, ip: 'c', file: file(FILES.txt()), fields: {} });
    await vi.waitFor(() => expect(s.parse).toHaveBeenCalledTimes(1));
    const e = await rejection(s.service.run('resume_check', { visitor: V, ip: 'c', file: file(FILES.txt(`${WEAK_RESUME_MD}\n- other`)), fields: {} }));
    expect(reason(e)).toBe('run_in_progress');
    release();
    await expect(first).resolves.toMatchObject({ kind: 'resume_check' });
    await expect(s.service.run('resume_check', { visitor: V, ip: 'c', file: file(FILES.txt(`${WEAK_RESUME_MD}\n- other`)), fields: {} })).resolves.toBeTruthy();
  });

  it('the same file again from the same visitor answers from the cache with a new id and does not count', async () => {
    const a = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    const b = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    expect(b.cached).toBe(true);
    expect(b.resultId).not.toBe(a.resultId);
    expect(s.rate.used.get('roboapply|x|resume_check')).toBe(1);
    expect(s.parse).toHaveBeenCalledTimes(1);
    expect(s.store.rows).toHaveLength(1);
    // The new id is its own (alias) row, found by its hash — not a list inside the payload.
    expect(s.store.aliases).toEqual([expect.objectContaining({ tokenHash: hashResultId(b.resultId), of: s.store.rows[0]!.id, brand: 'roboapply' })]);
    // Both ids open the same result (an id remembered earlier in this tab still works).
    await expect(s.service.getResult(a.resultId, V)).resolves.toMatchObject({ kind: 'resume_check', resultId: a.resultId });
    await expect(s.service.getResult(b.resultId, V)).resolves.toMatchObject({ kind: 'resume_check', resultId: b.resultId });
  });

  it('a result reached by an earlier id can be claimed once; the later id then answers alreadyClaimed', async () => {
    const a = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    const b = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    await expect(s.service.claim({ id: 'user_1' }, a.resultId, V)).resolves.toMatchObject({ alreadyClaimed: false });
    await expect(s.service.claim({ id: 'user_1' }, b.resultId, V)).resolves.toMatchObject({ alreadyClaimed: true, resumeId: 'rv_1' });
    expect(s.createResume).toHaveBeenCalledTimes(1);
  });

  it('the 429 names the effective allowance, not the default', async () => {
    const five = setup();
    const rate = fakeRate(5);
    Object.assign(five.rate, { consume: rate.consume, remaining: rate.remaining });
    for (let i = 0; i < 5; i += 1) {
      await five.service.run('resume_check', { visitor: V, ip: 'z', file: file(FILES.txt(`Sam Rivera ${i}\n${WEAK_RESUME_MD}`)), fields: {} });
    }
    const e = await rejection(five.service.run('resume_check', { visitor: V, ip: 'z', file: file(FILES.txt(`Sam Rivera 6\n${WEAK_RESUME_MD}`)), fields: {} }));
    expect(e.status).toBe(429);
    expect(e.details).toMatchObject({ limit: 5 });
    expect(e.message).toContain('5 free checks');
  });

  it('the cache is per visitor (IP and browser) and per tool, and ends after 24 h', async () => {
    await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    const other = await s.service.run('resume_check', { visitor: V, ip: 'y', file: file(FILES.txt()), fields: {} });
    expect(other.cached).toBe(false);
    const otherBrowser = await s.service.run('resume_check', { visitor: OTHER_BROWSER, ip: 'x', file: file(FILES.txt()), fields: {} });
    expect(otherBrowser.cached).toBe(false);
    const job = await s.service.run('resume_job_match', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: { postingTitle: POSTING.title, postingText: POSTING.text } });
    expect(job.cached).toBe(false);
    s.clock.now = new Date(T0.getTime() + 24 * 3600_000 + 1);
    const later = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    expect(later.cached).toBe(false);
  });

  it('fails closed when the counters cannot be written or read', async () => {
    s.rate.fail = true;
    const e = await rejection(s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} }));
    expect(e.status).toBe(429);
    expect(s.parse).not.toHaveBeenCalled();
    s.rate.fail = false;
    s.rate.failRead = true;
    expect((await rejection(s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} }))).status).toBe(429);
    expect(s.parse).not.toHaveBeenCalled();
  });

  it('config reports what is left today for each tool', async () => {
    await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    const c = await s.service.config('x');
    expect(c).toMatchObject({
      available: true,
      perIpPerDay: 3,
      remainingByTool: { resume_check: 2, resume_job_match: 3 },
      consentRequired: false,
      consentVersion: null,
      processedOutsideMainland: false,
      parserName: null,
    });
    expect(c.acceptedExtensions).toContain('.pdf');
    s.rate.failRead = true;
    expect((await s.service.config('x')).remainingByTool).toEqual({ resume_check: null, resume_job_match: null });
  });
});

describe('resume and job check', () => {
  it('answers requirement rows and keyword lists, no score', async () => {
    const r = (await s.service.run('resume_job_match', {
      visitor: V,
      ip: 'x',
      file: file(FILES.txt()),
      fields: { postingTitle: POSTING.title, postingText: POSTING.text },
    })) as ResumeJobMatchReport;
    expect(r.kind).toBe('resume_job_match');
    expect(r.postingTitle).toBe('Backend Engineer');
    expect(r.rows.map((row) => row.key)).toEqual(expect.arrayContaining(['title', 'years', 'education', 'skills', 'keywords']));
    // Skills are spelled as the posting spells them, like the signed-in keyword check.
    expect(r.hardSkills.missing).toEqual(expect.arrayContaining(['Python', 'Kubernetes']));
    expect(r).not.toHaveProperty('score10');
    expect(r).not.toHaveProperty('fit');
  });
});

describe('GoApply', () => {
  it('open on every stack with no CN_ switch set: config says available, and a run with the notice ticked answers', async () => {
    const g = setup('goapply', { markdown: CN_RESUME_MD });
    const c = await g.service.config('x');
    expect(c).toMatchObject({ available: true, consentRequired: true, consentVersion: TOOLS_CONSENT_VERSION });
    expect(c.remainingByTool).toEqual({ resume_check: 3, resume_job_match: 3 });
    const r = (await g.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt(CN_RESUME_MD)), fields: { consent: TOOLS_CONSENT_VERSION } })) as ResumeCheckReport;
    expect(r.kind).toBe('resume_check');
    expect(r.profile).toBe('cn');
    expect(g.parse).toHaveBeenCalledTimes(1);
    expect(g.store.rows).toHaveLength(1);
    // The same browser reads its result again; nothing answers feature_disabled.
    await expect(g.service.getResult(r.resultId, V)).resolves.toMatchObject({ kind: 'resume_check' });
    await expect(g.service.getResult('a'.repeat(43), V)).rejects.toMatchObject({ code: 'not_found' });
    // The resume and job check answers too.
    const m = await g.service.run('resume_job_match', {
      visitor: V,
      ip: 'x',
      file: file(FILES.txt(CN_RESUME_MD)),
      fields: { consent: TOOLS_CONSENT_VERSION, postingTitle: POSTING.title, postingText: POSTING.text },
    });
    expect(m.kind).toBe('resume_job_match');
    // RoboApply on the same deployment is open as before, with no notice.
    expect(await setup('roboapply').service.config('x')).toMatchObject({ available: true, consentRequired: false, processedOutsideMainland: false });
  });

  it('the run tells the parser the notice was ticked on GoApply (so the AI read may run); RoboApply needs no notice', async () => {
    const g = setup('goapply', { markdown: CN_RESUME_MD });
    await g.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt(CN_RESUME_MD)), fields: { consent: TOOLS_CONSENT_VERSION } });
    expect(g.parse).toHaveBeenCalledWith(expect.objectContaining({ consented: true, brand: expect.objectContaining({ id: 'goapply' }) }));
    await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    expect(s.parse).toHaveBeenCalledWith(expect.objectContaining({ consented: false, brand: expect.objectContaining({ id: 'roboapply' }) }));
  });

  it('needs the processing notice ticked before anything is read', async () => {
    const g = setup('goapply', { markdown: CN_RESUME_MD });
    const e = await rejection(g.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt(CN_RESUME_MD)), fields: {} }));
    expect(e.status).toBe(422);
    expect(reason(e)).toBe('consent_required');
    expect(g.parse).not.toHaveBeenCalled();
    expect(g.rate.used.size).toBe(0);
    const wrong = await rejection(g.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt(CN_RESUME_MD)), fields: { consent: 'yes' } }));
    expect(reason(wrong)).toBe('consent_required');
    // An earlier version of the notice did not name the AI read: it is not accepted.
    const old = await rejection(g.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt(CN_RESUME_MD)), fields: { consent: 'tools-processing.2026-10-10.v2' } }));
    expect(reason(old)).toBe('consent_required');
    expect(g.parse).not.toHaveBeenCalled();
    expect(g.store.rows).toHaveLength(0);
  });

  it('the cn checklist runs, and the stored result records the notice version and when it was ticked', async () => {
    const g = setup('goapply', { markdown: CN_RESUME_MD, env: MAINLAND });
    const r = (await g.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt(CN_RESUME_MD)), fields: { consent: TOOLS_CONSENT_VERSION } })) as ResumeCheckReport;
    expect(r.profile).toBe('cn');
    expect(g.store.rows[0]!.brand).toBe('goapply');
    expect(g.store.rows[0]!.payload.consent).toEqual({ version: TOOLS_CONSENT_VERSION, at: T0.toISOString() });
    // RoboApply asks for no notice and records none.
    await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    expect(s.store.rows[0]!.payload.consent).toBeUndefined();
  });

  it('the notice says "processed outside the mainland" when the deployment is offshore or GoApply runs on the shared stack', async () => {
    // Offshore deployment, shared stack: the state of a deployment with only shared credentials.
    expect((await setup('goapply').service.config('x')).processedOutsideMainland).toBe(true);
    // Mainland deployment, but no China-specific provider: the shared processors are offshore.
    expect((await setup('goapply', { env: MAINLAND }).service.config('x')).processedOutsideMainland).toBe(true);
    // Offshore deployment with GoApply's own providers: the deployment itself is outside the mainland.
    const { DEPLOY_REGION: _region, ...ownOffshore } = MAINLAND_OWN_STACK;
    expect((await setup('goapply', { env: ownOffshore }).service.config('x')).processedOutsideMainland).toBe(true);
    // Mainland deployment on GoApply's own stack: nothing leaves, so the line is not shown.
    const own = await setup('goapply', { env: MAINLAND_OWN_STACK }).service.config('x');
    expect(own).toMatchObject({ available: true, consentRequired: true, consentVersion: TOOLS_CONSENT_VERSION, processedOutsideMainland: false });
    expect(processedOutsideMainland(getBrand('goapply'), MAINLAND_OWN_STACK)).toBe(false);
    // The catalog's rule, not the environment's alone: a model provider of GoApply's own that is itself abroad
    // sends the visitor's resume abroad although every stack is "its own" (the case sign-up and the disclosures already cover).
    const ownModelAbroad = { ...MAINLAND_OWN_STACK, CN_LLM_PROVIDER: 'openrouter', CN_LLM_MODEL: 'openai/gpt-5' };
    expect((await setup('goapply', { env: ownModelAbroad }).service.config('x')).processedOutsideMainland).toBe(true);
    expect(processedOutsideMainland(getBrand('goapply'), ownModelAbroad)).toBe(crossBorderConsentApplies(getBrand('goapply'), ownModelAbroad));
    // …and a bucket of its own that is not mainland storage.
    expect((await setup('goapply', { env: { ...MAINLAND_OWN_STACK, CN_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com' } }).service.config('x')).processedOutsideMainland).toBe(true);
    // Never RoboApply's line.
    expect(processedOutsideMainland(getBrand('roboapply'), {})).toBe(false);
    expect(toolsOpen(getBrand('goapply'), {})).toBe(true);
    expect(toolsOpen(getBrand('roboapply'), {})).toBe(true);
  });

  it('config names the outside resume-reading service only when it is active for the brand', async () => {
    expect((await setup('goapply', { env: MAINLAND }).service.config('x')).parserName).toBeNull();
    const withKey = await setup('goapply', { env: { ...MAINLAND, GOHIRE_API_KEY: 'test-key' } }).service.config('x');
    expect(withKey.parserName).toBe('GoHire');
    const off = await setup('goapply', { env: { ...MAINLAND, GOHIRE_API_KEY: 'test-key', GOHIRE_PARSE_ENABLED: 'false' } }).service.config('x');
    expect(off.parserName).toBeNull();
    expect((await setup('roboapply', { env: { GOHIRE_API_KEY: 'test-key' } }).service.config('x')).parserName).toBeNull();
  });

  it('a RoboApply result is not visible on GoApply', async () => {
    const r = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    const g = createToolsService({
      store: s.store,
      rate: fakeRate(),
      parse: s.parse as never,
      checklist: runChecklist,
      requirementRows: runRequirementRows,
      createResume: s.createResume as never,
      brand: () => getBrand('goapply'),
      env: MAINLAND,
      now: () => T0,
    });
    await expect(g.getResult(r.resultId, V)).rejects.toMatchObject({ code: 'not_found' });
    await expect(g.claim({ id: 'u1' }, r.resultId, V)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('a result belongs to the browser that ran it', () => {
  it('stores only the hash of the visitor cookie', async () => {
    const r = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    const row = s.store.rows[0]!;
    expect(row.payload.visitorHash).toBe(hashVisitor(V));
    expect(JSON.stringify(row.payload)).not.toContain(V);
    expect(r.resultId).toBeTruthy();
  });

  it('the id alone opens nothing: no cookie or another browser’s cookie is 404, and cannot claim', async () => {
    const r = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    await expect(s.service.getResult(r.resultId, null)).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.service.getResult(r.resultId, OTHER_BROWSER)).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.service.getResult(r.resultId, 'short')).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.service.claim({ id: 'thief' }, r.resultId, OTHER_BROWSER)).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.service.claim({ id: 'thief' }, r.resultId, null)).rejects.toMatchObject({ code: 'not_found' });
    expect(s.createResume).not.toHaveBeenCalled();
    expect(s.store.rows[0]!.consumedAt).toBeNull();
    // The owner's browser still can.
    await expect(s.service.claim({ id: 'owner' }, r.resultId, V)).resolves.toMatchObject({ alreadyClaimed: false });
  });

  it('a run needs a well-formed visitor id; fresh ones are 43 url-safe characters', async () => {
    const e = await rejection(s.service.run('resume_check', { visitor: 'x', ip: 'x', file: file(FILES.txt()), fields: {} }));
    expect(e.status).toBe(422);
    expect(s.parse).not.toHaveBeenCalled();
    const id = newVisitorId();
    expect(isVisitorId(id)).toBe(true);
    expect(newVisitorId()).not.toBe(id);
  });
});

describe('results and the signup claim', () => {
  it('GET result answers the short view; unknown and expired ids are 404', async () => {
    const r = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    const again = (await s.service.getResult(r.resultId, V)) as ResumeCheckReport;
    expect(again.full).toBe(false);
    expect(again.issues).toHaveLength(TOOLS_LIMITS.shortReportIssues);
    await expect(s.service.getResult('nope'.repeat(10), V)).rejects.toMatchObject({ code: 'not_found' });
    s.clock.now = new Date(T0.getTime() + 24 * 3600_000);
    const e = await rejection(s.service.getResult(r.resultId, V));
    expect(reason(e)).toBe('result_expired');
  });

  it('claim creates the resume in the account, answers the full report and drops the stored text', async () => {
    const r = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    const c = await s.service.claim({ id: 'user_1', brand: 'roboapply' }, r.resultId, V);
    expect(c.alreadyClaimed).toBe(false);
    expect(c.resumeId).toBe('rv_1');
    expect(s.createResume).toHaveBeenCalledWith('user_1', { name: 'resume', markdown: expect.stringContaining('Sam Rivera') });
    const full = c.report as ResumeCheckReport;
    expect(full.full).toBe(true);
    expect(full.hiddenIssueCount).toBe(0);
    expect(full.issues.length).toBe(full.counts.urgent + full.counts.critical + full.counts.optional);
    const row = s.store.rows[0]!;
    expect(row.payload.resume).toBeNull();
    expect(row.userId).toBe('user_1');
    expect(row.consumedAt).not.toBeNull();
  });

  it('claim is idempotent for the same user and 404 for anyone else; a claimed result is no longer public', async () => {
    const r = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    await s.service.claim({ id: 'user_1' }, r.resultId, V);
    const again = await s.service.claim({ id: 'user_1' }, r.resultId, V);
    expect(again).toMatchObject({ resumeId: 'rv_1', alreadyClaimed: true });
    expect(s.createResume).toHaveBeenCalledTimes(1);
    await expect(s.service.claim({ id: 'user_2' }, r.resultId, V)).rejects.toMatchObject({ code: 'not_found' });
    const e = await rejection(s.service.getResult(r.resultId, V));
    expect(e.code).toBe('not_found');
    // Says it was kept, not that it was deleted.
    expect(reason(e)).toBe('result_claimed');
  });

  it('a full resume list answers 409 resume_limit and leaves the result claimable', async () => {
    const r = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    s.createResume.mockRejectedValueOnce(new ResumeLimitReachedError('full'));
    const e = await rejection(s.service.claim({ id: 'user_1' }, r.resultId, V));
    expect(e.status).toBe(409);
    expect(reason(e)).toBe('resume_limit');
    expect(s.store.rows[0]!.consumedAt).toBeNull();
    await expect(s.service.claim({ id: 'user_1' }, r.resultId, V)).resolves.toMatchObject({ alreadyClaimed: false });
  });

  it('an account of the other brand cannot claim; an expired result cannot be claimed', async () => {
    const r = await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    await expect(s.service.claim({ id: 'u', brand: 'goapply' }, r.resultId, V)).rejects.toMatchObject({ code: 'not_found' });
    s.clock.now = new Date(T0.getTime() + 25 * 3600_000);
    await expect(s.service.claim({ id: 'u' }, r.resultId, V)).rejects.toMatchObject({ code: 'not_found' });
    expect(s.createResume).not.toHaveBeenCalled();
  });
});

describe('purge', () => {
  it('deletes the brand’s results once their 24 h are over (claimed or not), on request and by the cron', async () => {
    await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    const b = await s.service.run('resume_check', { visitor: V, ip: 'y', file: file(FILES.txt()), fields: {} });
    await s.service.claim({ id: 'u' }, b.resultId, V);
    expect(await s.service.purge('roboapply', new Date(T0.getTime() + 3600_000))).toBe(0);
    expect(await s.service.purge('goapply', new Date(T0.getTime() + 25 * 3600_000))).toBe(0);
    expect(await s.service.purge('roboapply', new Date(T0.getTime() + 24 * 3600_000))).toBe(2);
    expect(s.store.rows).toHaveLength(0);
  });

  it('every new run purges expired rows of the brand', async () => {
    await s.service.run('resume_check', { visitor: V, ip: 'x', file: file(FILES.txt()), fields: {} });
    s.clock.now = new Date(T0.getTime() + 30 * 3600_000);
    await s.service.run('resume_check', { visitor: V, ip: 'z', file: file(FILES.txt()), fields: {} });
    expect(s.store.rows).toHaveLength(1);
  });
});

describe('createToolsRate (platform limiter keys)', () => {
  it('consumes the publicToolsPerIp counter per IP and tool, and reads what is left from the same keys', async () => {
    const consume = vi.fn(async () => ({ allowed: true, retryAfterSec: 0, remaining: 2, windows: [] }));
    const reader = createMemoryRateReader();
    const rate = createToolsRate({ reader, consume, env: {} });
    await rate.consume('1.2.3.4', 'roboapply', T0, 'resume_check');
    const key = rateLimitKey('publicToolsPerIp', 'ip', '1.2.3.4|resume_check', 'roboapply');
    expect(consume).toHaveBeenCalledWith({ key, windows: [{ limit: 3, windowSec: DAY }], now: T0 });
    expect(key).not.toContain('1.2.3.4');
    expect(rateLimitKey('publicToolsPerIp', 'ip', '1.2.3.4|resume_job_match', 'roboapply')).not.toBe(key);

    reader.counts_.set(`${key}:${DAY}|${windowStartFor(T0, DAY).toISOString()}`, 2);
    const left = await rate.remaining('1.2.3.4', 'roboapply', T0, 'resume_check');
    expect(left.remaining).toBe(1);
    expect(left.resetsAt.toISOString()).toBe('2026-10-11T00:00:00.000Z');
    expect((await rate.remaining('1.2.3.4', 'roboapply', T0, 'resume_job_match')).remaining).toBe(3);
    reader.counts_.set(`${key}:${DAY}|${windowStartFor(T0, DAY).toISOString()}`, 7);
    expect((await rate.remaining('1.2.3.4', 'roboapply', T0, 'resume_check')).remaining).toBe(0);
  });

  it('the attempts guard is its own per-IP counter', async () => {
    const consume = vi.fn(async () => ({ allowed: false, retryAfterSec: 99, remaining: 0, windows: [] }));
    const rate = createToolsRate({ reader: createMemoryRateReader(), consume, env: {} });
    expect(await rate.attempt('1.2.3.4', 'goapply', T0)).toEqual({ allowed: false, retryAfterSec: 99 });
    expect(consume).toHaveBeenCalledWith({
      key: rateLimitKey('publicToolsAttemptsPerIp', 'ip', '1.2.3.4', 'goapply'),
      windows: [{ limit: TOOLS_LIMITS.attemptsPerIpPerDay, windowSec: DAY }],
      now: T0,
    });
  });

  it('honours RATE_LIMITS_JSON overrides', async () => {
    const consume = vi.fn(async () => ({ allowed: true, retryAfterSec: 0, remaining: 9, windows: [] }));
    const rate = createToolsRate({ reader: createMemoryRateReader(), consume, env: { RATE_LIMITS_JSON: '{"publicToolsPerIp":[{"limit":10,"windowSec":86400}]}' } });
    expect(await rate.consume('ip', 'goapply', T0, 'resume_check')).toMatchObject({ allowed: true, limit: 10 });
    expect(consume.mock.calls[0]![0]).toMatchObject({ windows: [{ limit: 10, windowSec: 86400 }] });
    expect(await rate.remaining('ip', 'goapply', T0, 'resume_check')).toMatchObject({ remaining: 10, limit: 10 });
  });
});
