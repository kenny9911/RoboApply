// @vitest-environment node
//
// INT-10 (wave3 WP-93 #2, privacy): POST /v2/resumes/upload
//   - never uses the GoHire parse service for a RoboApply user who declined,
//     or never answered, `intl_cross_border_cn_parse` (and only when the owner
//     opted RoboApply in at all);
//   - reads the file locally when the form carries `localParser=1` (RoboApply
//     only: GoApply ignores the flag and keeps the file on its in-country parser);
//   - keeps a persisted cap of 10 uploads a day per user (429 + Retry-After),
//     shared with the LinkedIn PDF import;
//   - GoApply: reads no file at all without the user's AI consent
//     (`ai_resume_parsing`): 503 ai_unavailable, zero parse-service and model calls.
// The route, RAResumeService and the candidate ingest are real; only the
// network (fetch), the local text extractors, the model helpers, Prisma and
// file storage are faked. Nothing leaves 127.0.0.1; nothing touches a database
// or the disk.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  variants: [] as Row[],
  counters: new Map<string, number>(),
  counterDown: false,
  userId: 'user1',
  brand: 'roboapply' as 'roboapply' | 'goapply',
}));

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return (cond.in as unknown[]).includes(v);
      if ('not' in cond) return v !== cond.not;
    }
    if (cond === null) return v === null || v === undefined;
    return v === cond;
  });
}

vi.mock('../../../lib/prisma.js', () => {
  const rows = () => mocks.variants;
  const rAResumeVariant = {
    findFirst: async ({ where }: Row = {}) => rows().find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: Row) => rows().find((r) => r.id === where.id) ?? null,
    findMany: async ({ where }: Row = {}) => rows().filter((r) => matches(r, where)),
    count: async ({ where }: Row = {}) => rows().filter((r) => matches(r, where)).length,
    create: async ({ data }: Row) => {
      const row = { id: `v${rows().length + 1}`, createdAt: new Date(), deletedAt: null, isPrimary: false, ...data };
      rows().push(row);
      return row;
    },
    update: async ({ where, data }: Row) => Object.assign(rows().find((r) => r.id === where.id)!, data),
    updateMany: async ({ where, data }: Row) => {
      const hit = rows().filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
  const client: Row = {
    rAResumeVariant,
    rAJob: { findMany: async () => [] },
    // RARateCounter upsert (platform/ratelimit): key, windowStart, cost, expiresAt.
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      if (mocks.counterDown) throw new Error('counter table unavailable');
      const key = `${String(values[0])}|${(values[1] as Date).toISOString()}`;
      const count = (mocks.counters.get(key) ?? 0) + Number(values[2]);
      mocks.counters.set(key, count);
      return [{ count }];
    },
  };
  client.$transaction = async (arg: any) => (typeof arg === 'function' ? arg(client) : Promise.all(arg));
  return { default: client };
});

vi.mock('../lib/raAuth.js', () => ({
  requireAuth: (req: Row, res: { status(n: number): { json(b: unknown): void } }, next: () => void) => {
    if (req.headers['x-test-anon']) return res.status(401).json({ error: 'unauthorized' });
    req.user = { id: mocks.userId, subscriptionTier: 'free' };
    next();
  },
}));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../services/PDFService.js', () => ({ pdfService: { extractText: vi.fn(async () => ''), extractImage: vi.fn(async () => '') } }));
vi.mock('../../../services/DocumentParsingService.js', () => ({
  documentParsingService: { extractText: vi.fn(async () => '') },
  DocumentParsingService: { isAcceptedUpload: () => true },
}));
vi.mock('../../../agents/ResumeParseAgent.js', () => ({ resumeParseAgent: { parse: vi.fn() } }));
vi.mock('../../../services/ResumeSummaryService.js', () => ({
  generateResumeSummaryHighlight: vi.fn(async () => ({ summary: 'Engineer', highlight: 'Payments' })),
}));
vi.mock('../../../services/ResumeParserService.js', () => ({ normalizeExtractedText: (s: string) => s }));
vi.mock('../../../features/compliance/index.js', () => ({ registerArtifactStorageDeleter: vi.fn() }));
vi.mock('../../services/SeekerAccountPurgeService.js', () => ({ setArtifactStorageDeleter: vi.fn() }));
vi.mock('../services/RAResumeAIService.js', () => ({
  raResumeAIService: {},
  AiUnavailableError: class extends Error {},
  ResumeNotFoundError: class extends Error {},
  RewriteValidationError: class extends Error {},
}));

import { runWithBrand } from '../../../lib/requestContext.js';
import { setConsentLookup } from '../../../platform/consent/index.js';
import { pdfService } from '../../../services/PDFService.js';
import { documentParsingService } from '../../../services/DocumentParsingService.js';
import { resumeParseAgent } from '../../../agents/ResumeParseAgent.js';
import { resumeOriginalFileStorageService } from '../../../services/ResumeOriginalFileStorageService.js';
import type { ParsedResume } from '../../../types/index.js';

const LOCAL_TEXT = 'Ada Lovelace\nada@example.com\n2019-2023 Analytical Engines, Engineer. Built the payments and reporting systems.';
const LOCAL_PARSED = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '',
  summary: '',
  skills: [],
  experience: [{ company: 'Analytical Engines', role: 'Engineer', description: 'Built the payments system' }],
  education: [],
  certifications: [],
  languages: [],
  projects: [],
  rawText: LOCAL_TEXT,
} as unknown as ParsedResume;
const GOHIRE_PAYLOAD = {
  success: true,
  data: {
    rawText: `${LOCAL_TEXT}\nRead by the parse service.`,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    experience: [{ company: 'Analytical Engines', role: 'Engineer', description: 'Built the payments system' }],
    education: [],
  },
};
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const ENV_KEYS = ['GOHIRE_API_KEY', 'GOHIRE_PARSE_BRANDS', 'GOHIRE_API_BASE', 'GOHIRE_PARSE_ENABLED', 'DEPLOY_REGION', 'ALLOWED_BRANDS', 'BRAND_LOCK'];
const savedEnv: Record<string, string | undefined> = {};

/** The user's newest answer to `intl_cross_border_cn_parse`: granted, declined, or never asked (null). */
let consent: boolean | null = null;
/** GoApply: the user's newest answer to `ai_resume_parsing` (the AI consent). */
let aiConsent: boolean | null = true;
let consentDown = false;
const consentAsked = vi.fn();

let server: Server;
let base: string;
/** The upstream (GoHire) fetch; requests to this test's own server pass through. */
const upstream = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(GOHIRE_PAYLOAD), { status: 200 }));
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const express = (await import('express')).default;
  const router = ((await import('./resumes.js')) as { default: import('express').Router }).default;
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runWithBrand(mocks.brand, next));
  app.use('/resumes', router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resumes`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mocks.variants = [];
  mocks.counters = new Map();
  mocks.counterDown = false;
  mocks.userId = 'user1';
  mocks.brand = 'roboapply';
  consent = null;
  aiConsent = true;
  consentDown = false;
  consentAsked.mockClear();
  upstream.mockClear();
  upstream.mockImplementation(async () => new Response(JSON.stringify(GOHIRE_PAYLOAD), { status: 200 }));
  vi.mocked(pdfService.extractText).mockReset().mockResolvedValue(LOCAL_TEXT);
  vi.mocked(documentParsingService.extractText).mockReset().mockResolvedValue(LOCAL_TEXT);
  vi.mocked(resumeParseAgent.parse).mockReset().mockResolvedValue(LOCAL_PARSED);
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GOHIRE_API_KEY = 'test-key';
  // The owner opted RoboApply in to GoHire parsing (OD-3); the user's consent then decides.
  process.env.GOHIRE_PARSE_BRANDS = 'goapply,roboapply';
  setConsentLookup(async (userId, types) => {
    consentAsked(userId, types);
    if (consentDown) throw new Error('consent table unavailable');
    const answer = (types as string[]).includes('intl_cross_border_cn_parse') ? consent : (types as string[]).includes('ai_resume_parsing') ? aiConsent : null;
    return answer === null ? null : { consentType: types[0]!, granted: answer, createdAt: new Date('2026-10-01T00:00:00Z') };
  });
  // No file is kept in these tests: nothing is written to disk or a bucket.
  vi.spyOn(resumeOriginalFileStorageService, 'assertAvailable').mockImplementation(() => undefined);
  vi.spyOn(resumeOriginalFileStorageService, 'isConfigured').mockReturnValue(false);
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => (String(input).startsWith('http://127.0.0.1') ? realFetch(input as string, init) : upstream(input, init)));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setConsentLookup(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface UploadOptions {
  path?: string;
  fileName?: string;
  type?: string;
  bytes?: Uint8Array | string;
  fields?: Record<string, string>;
}

async function upload(options: UploadOptions = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(options.fields ?? {})) fd.append(k, v);
  fd.append('file', new Blob([options.bytes ?? '%PDF-1.4 resume'], { type: options.type ?? 'application/pdf' }), options.fileName ?? 'cv.pdf');
  const res = await realFetch(`${base}${options.path ?? '/upload'}`, { method: 'POST', body: fd });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Row) : null };
}

describe('POST /upload — who may read the file (RoboApply)', () => {
  it('needs no AI consent on RoboApply (aiAllowed is always true there)', async () => {
    aiConsent = false;
    const res = await upload();
    expect(res.status).toBe(201);
    expect(consentAsked.mock.calls.every((c) => !(c[1] as string[]).includes('ai_resume_parsing'))).toBe(true);
  });

  it('declined: zero GoHire calls, the local parser reads the PDF', async () => {
    consent = false;
    const res = await upload();
    expect(res.status).toBe(201);
    expect(upstream).not.toHaveBeenCalled();
    expect(pdfService.extractText).toHaveBeenCalledTimes(1);
    expect(resumeParseAgent.parse).toHaveBeenCalledTimes(1);
    expect(mocks.variants[0]!.rawText).not.toContain('Read by the parse service.');
    expect(consentAsked).toHaveBeenCalledWith('user1', expect.arrayContaining(['intl_cross_border_cn_parse']));
  });

  it('never answered: zero GoHire calls, the local parser reads the PDF', async () => {
    consent = null;
    const res = await upload();
    expect(res.status).toBe(201);
    expect(upstream).not.toHaveBeenCalled();
    expect(pdfService.extractText).toHaveBeenCalledTimes(1);
  });

  it('granted: the GoHire parse service reads the PDF, the local parser does not', async () => {
    consent = true;
    const res = await upload();
    expect(res.status).toBe(201);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(String(upstream.mock.calls[0]![0])).toMatch(/\/api\/v1\/parse-resume$/);
    expect(pdfService.extractText).not.toHaveBeenCalled();
    expect(resumeParseAgent.parse).not.toHaveBeenCalled();
    expect(mocks.variants[0]!.rawText).toContain('Read by the parse service.');
  });

  it('granted, but the form asks for the local parser (localParser=1): zero GoHire calls', async () => {
    consent = true;
    for (const flag of ['1', 'true']) {
      vi.mocked(pdfService.extractText).mockClear();
      const res = await upload({ fields: { localParser: flag } });
      expect(res.status).toBe(201);
      expect(pdfService.extractText).toHaveBeenCalledTimes(1);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('a withdrawn consent (newest answer is no) stops GoHire again', async () => {
    consent = true;
    await upload({ fields: { idempotencyKey: 'a' } });
    expect(upstream).toHaveBeenCalledTimes(1);
    consent = false;
    await upload({ fields: { idempotencyKey: 'b' } });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('a consent answer that cannot be read counts as no', async () => {
    consentDown = true;
    const res = await upload();
    expect(res.status).toBe(201);
    expect(upstream).not.toHaveBeenCalled();
    expect(pdfService.extractText).toHaveBeenCalledTimes(1);
  });

  it('with RoboApply not opted in (the default), a grant alone never sends the file to GoHire', async () => {
    delete process.env.GOHIRE_PARSE_BRANDS;
    consent = true;
    const res = await upload();
    expect(res.status).toBe(201);
    expect(upstream).not.toHaveBeenCalled();
    // No transfer is possible, so the consent is not even looked up.
    expect(consentAsked).not.toHaveBeenCalled();
  });

  it('Word files are read locally whatever the answer', async () => {
    consent = true;
    const res = await upload({ fileName: 'cv.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: 'PK docx' });
    expect(res.status).toBe(201);
    expect(upstream).not.toHaveBeenCalled();
    expect(documentParsingService.extractText).toHaveBeenCalledTimes(1);
  });
});

describe('POST /upload — GoApply', () => {
  beforeEach(() => {
    mocks.brand = 'goapply';
  });

  it('with the AI consent: uses GoHire; the RoboApply cross-border consent is not asked (the brand rule decides)', async () => {
    const res = await upload();
    expect(res.status).toBe(201);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(consentAsked).toHaveBeenCalledTimes(1);
    expect(consentAsked.mock.calls[0]![1]).toEqual(expect.arrayContaining(['ai_resume_parsing']));
    expect(consentAsked.mock.calls[0]![1]).not.toContain('intl_cross_border_cn_parse');
  });

  it.each([
    ['declined', false],
    ['never answered', null],
  ] as const)('AI consent %s: 503 ai_unavailable, the file is never read — no parse service, no model, nothing saved or counted', async (_label, answer) => {
    aiConsent = answer;
    for (const path of ['/upload', '/import-linkedin']) {
      const res = await upload({ path });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'ai_unavailable', code: 'ai_unavailable', details: { reason: 'ai_consent_required' } });
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(pdfService.extractText).not.toHaveBeenCalled();
    expect(documentParsingService.extractText).not.toHaveBeenCalled();
    expect(resumeParseAgent.parse).not.toHaveBeenCalled();
    expect(mocks.variants).toHaveLength(0);
    expect(mocks.counters.size).toBe(0);
  });

  it('a consent answer that cannot be read counts as no', async () => {
    consentDown = true;
    expect((await upload()).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
    expect(pdfService.extractText).not.toHaveBeenCalled();
  });

  it('an image with GoHire down fails closed: 422 image_parse_unavailable, no local OCR, nothing saved', async () => {
    upstream.mockImplementation(async () => new Response('upstream error', { status: 500 }));
    const res = await upload({ fileName: 'cv.png', type: 'image/png', bytes: PNG_1X1 });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'image_parse_unavailable', code: 'image_parse_unavailable' });
    expect(documentParsingService.extractText).not.toHaveBeenCalled();
    expect(pdfService.extractText).not.toHaveBeenCalled();
    expect(pdfService.extractImage).not.toHaveBeenCalled();
    expect(resumeParseAgent.parse).not.toHaveBeenCalled();
    expect(mocks.variants).toHaveLength(0);
  });

  it('a PDF with localParser=1 still goes to GoHire: the flag never opens the local pipeline (and its OCR) on GoApply', async () => {
    for (const flag of ['1', 'true']) {
      upstream.mockClear();
      const res = await upload({ fields: { localParser: flag } });
      expect(res.status).toBe(201);
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(String(upstream.mock.calls[0]![0])).toMatch(/\/api\/v1\/parse-resume$/);
    }
    expect(pdfService.extractText).not.toHaveBeenCalled();
    expect(pdfService.extractImage).not.toHaveBeenCalled();
    expect(documentParsingService.extractText).not.toHaveBeenCalled();
    expect(resumeParseAgent.parse).not.toHaveBeenCalled();
    expect(mocks.variants.every((v) => String(v.rawText).includes('Read by the parse service.'))).toBe(true);
  });

  it('localParser=1 does not open local OCR for an image', async () => {
    const res = await upload({ fileName: 'cv.webp', type: 'image/webp', bytes: 'RIFF....WEBP', fields: { localParser: '1' } });
    expect(res.status).toBe(422);
    expect(res.body!.code).toBe('image_parse_unavailable');
    expect(documentParsingService.extractText).not.toHaveBeenCalled();
  });
});

describe('daily upload cap (10 a day per user, persisted)', () => {
  it('the 11th upload in a day → 429 rate_limited with Retry-After; the file is not parsed', async () => {
    for (let i = 0; i < 10; i += 1) {
      const ok = await upload();
      expect(ok.status).toBe(201);
    }
    expect(pdfService.extractText).toHaveBeenCalledTimes(10);
    const res = await upload();
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      success: false,
      code: 'rate_limited',
      details: { reason: 'resume_upload_daily_limit', limit: 10 },
    });
    const retry = Number(res.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(24 * 60 * 60);
    expect(res.body!.details.retryAfterSec).toBe(retry);
    // Refused before the parse: the 11th file was never read.
    expect(pdfService.extractText).toHaveBeenCalledTimes(10);
    // The count lives in RARateCounter, one day window, keyed by brand and user.
    expect([...mocks.counters.keys()].every((k) => k.startsWith('rl:roboapply:resumeUploadPerUser:user:user1:86400|'))).toBe(true);
  });

  it('is per user: another account uploads freely', async () => {
    for (let i = 0; i < 10; i += 1) await upload();
    expect((await upload()).status).toBe(429);
    mocks.userId = 'user2';
    expect((await upload()).status).toBe(201);
  });

  it('LinkedIn PDF imports count toward the same 10', async () => {
    for (let i = 0; i < 6; i += 1) expect((await upload()).status).toBe(201);
    for (let i = 0; i < 4; i += 1) expect((await upload({ path: '/import-linkedin', fileName: 'Profile.pdf' })).status).toBe(201);
    const blockedImport = await upload({ path: '/import-linkedin', fileName: 'Profile.pdf' });
    expect(blockedImport.status).toBe(429);
    expect(blockedImport.body!.details.reason).toBe('resume_upload_daily_limit');
    expect((await upload()).status).toBe(429);
  });

  it('a replay of a file that already landed (same idempotency key) costs nothing', async () => {
    expect((await upload({ fields: { idempotencyKey: 'same-file' } })).status).toBe(201);
    for (let i = 0; i < 12; i += 1) expect((await upload({ fields: { idempotencyKey: 'same-file' } })).status).toBe(201);
    expect(pdfService.extractText).toHaveBeenCalledTimes(1);
    expect([...mocks.counters.values()]).toEqual([1]);
  });

  it('an upload refused for the 5-resume limit is not counted', async () => {
    for (let i = 0; i < 5; i += 1) mocks.variants.push({ id: `b${i}`, userId: 'user1', kind: 'base', deletedAt: null, resumeContentHash: `h${i}` });
    expect((await upload()).status).toBe(409);
    expect(mocks.counters.size).toBe(0);
  });

  it('a counter that cannot be read never blocks an upload', async () => {
    mocks.counterDown = true;
    expect((await upload()).status).toBe(201);
  });

  it('401 when signed out: nothing is counted or parsed', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'cv.pdf');
    const res = await realFetch(`${base}/upload`, { method: 'POST', body: fd, headers: { 'x-test-anon': '1' } });
    expect(res.status).toBe(401);
    expect(mocks.counters.size).toBe(0);
    expect(pdfService.extractText).not.toHaveBeenCalled();
  });
});
