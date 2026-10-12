// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runWithBrand } from '../../lib/requestContext.js';
import { setUserBrandLookup } from '../brand/userBrand.js';
import { GoHireResumeParseService } from '../../services/GoHireResumeParseService.js';

const PRC_ID = '11010519491231002X';
const PDF = { buffer: Buffer.from('%PDF-1.4 scanned'), fileName: 'cv.pdf', mimeType: 'application/pdf' };

const GOHIRE_PAYLOAD = {
  success: true,
  data: {
    rawText: `张三\n身份证号：${PRC_ID}\n电话：138 0013 8000\n健康状况：良好\n2019-2023 某公司 后端工程师，负责支付系统与推荐系统的设计与实现。`,
    name: '张三',
    phone: '138 0013 8000',
    email: 'zhangsan@example.com',
    photo: 'data:image/jpeg;base64,AAAA',
    experience: [{ company: '某公司', role: '后端工程师', description: '负责支付系统' }],
    education: [{ school: '某大学', degree: '本科' }],
    otherPersonalInformation: { 身份证号: PRC_ID, 健康状况: '良好' },
  },
};

const ENV_KEYS = [
  'GOHIRE_API_KEY',
  'GOHIRE_API_BASE',
  'GOHIRE_PARSE_ENABLED',
  'GOHIRE_PARSE_BRANDS',
  'DEPLOY_REGION',
  'ALLOWED_BRANDS',
  'BRAND_LOCK',
  'CN_STORAGE_MODE',
  'CN_RESIDENCY_STRICT',
] as const;
let saved: Record<string, string | undefined> = {};
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GOHIRE_API_KEY = 'test-key';
  fetchMock = vi.fn(async () => new Response(JSON.stringify(GOHIRE_PAYLOAD), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  // No owner is known unless a test says so (never the database).
  setUserBrandLookup(async () => null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  setUserBrandLookup(null);
});

describe('brand routing (GOHIRE_PARSE_BRANDS, default goapply)', () => {
  it('RoboApply never calls api.gohire.top by default', async () => {
    const svc = new GoHireResumeParseService();
    expect(svc.isConfigured('roboapply')).toBe(false);
    expect(await runWithBrand('roboapply', () => svc.parseResumeFile(PDF))).toBeNull();
    expect(await svc.parseResumeFile({ ...PDF, brand: 'roboapply' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('outside a brand context it never guesses: no call unless the owner or the deployment says the brand', async () => {
    process.env.GOHIRE_PARSE_BRANDS = 'goapply,roboapply';
    const svc = new GoHireResumeParseService();
    // A deployment that serves both brands (the default), no runWithBrand(), no owner: unknown → no call.
    expect(svc.isConfigured()).toBe(false);
    expect(await svc.parseResumeFile(PDF)).toBeNull();
    expect(await svc.parseResumeFile({ ...PDF, userId: 'nobody' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // A deployment locked to GoApply implies the brand.
    process.env.BRAND_LOCK = 'goapply';
    expect(await svc.parseResumeFile(PDF)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a worker without a brand context uses the stored brand of the owning user', async () => {
    setUserBrandLookup(async (id) => ({ cn_user: 'goapply', intl_user: 'roboapply' })[id] ?? null);
    const svc = new GoHireResumeParseService();
    // A RoboApply user's file never goes to the mainland parser by default.
    expect(await svc.parseResumeFile({ ...PDF, userId: 'intl_user' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // A GoApply user's file does: GoHire is that brand's preferred parser.
    expect(await svc.parseResumeFile({ ...PDF, userId: 'cn_user' })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('RoboApply calls it only when the owner opts in', async () => {
    process.env.GOHIRE_PARSE_BRANDS = 'goapply,roboapply';
    const svc = new GoHireResumeParseService();
    const out = await svc.parseResumeFile({ ...PDF, brand: 'roboapply' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.gohire.top/api/v1/parse-resume');
    // RoboApply text is stored as parsed.
    expect(out?.rawText).toContain(PRC_ID);
  });

  it('GoApply is excluded when the brand list leaves it out', async () => {
    process.env.GOHIRE_PARSE_BRANDS = 'roboapply';
    const svc = new GoHireResumeParseService();
    expect(await svc.parseResumeFile({ ...PDF, brand: 'goapply' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the kill switch and a missing key still win', async () => {
    const svc = new GoHireResumeParseService();
    process.env.GOHIRE_PARSE_ENABLED = 'false';
    expect(svc.isConfigured('goapply')).toBe(false);
    process.env.GOHIRE_PARSE_ENABLED = 'true';
    delete process.env.GOHIRE_API_KEY;
    expect(svc.isConfigured('goapply')).toBe(false);
  });

  it('a base URL that fails the brand egress policy is never called (the strict allowlist; open by default)', async () => {
    process.env.GOHIRE_API_BASE = 'https://parse.example.com';
    process.env.CN_RESIDENCY_STRICT = 'true';
    const svc = new GoHireResumeParseService();
    expect(await svc.parseResumeFile({ ...PDF, brand: 'goapply' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // Without the strict switch GoApply may send where RoboApply may.
    delete process.env.CN_RESIDENCY_STRICT;
    expect(await svc.parseResumeFile({ ...PDF, brand: 'goapply' })).not.toBeNull();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://parse.example.com/api/v1/parse-resume');
  });
});

describe('what GoApply gets back for storage', () => {
  it('by default the parse is returned as it is, in either region: the same as RoboApply (D5)', async () => {
    const svc = new GoHireResumeParseService();
    const out = await runWithBrand('goapply', () => svc.parseResumeFile(PDF));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out!.rawText).toContain(`身份证号：${PRC_ID}`);
    expect(out!.rawText).toContain('健康状况：良好');
    expect(out!.parsed.phone).toBe('138 0013 8000');
    process.env.DEPLOY_REGION = 'cn-mainland';
    expect((await svc.parseResumeFile({ ...PDF, brand: 'goapply' }))!.rawText).toContain(PRC_ID);
  });

  it('CN_STORAGE_MODE=redact: the ID number and health details are replaced by the marker; contact details and work history stay', async () => {
    process.env.CN_STORAGE_MODE = 'redact';
    const svc = new GoHireResumeParseService();
    const out = await runWithBrand('goapply', () => svc.parseResumeFile(PDF));
    expect(out).not.toBeNull();
    const stored = JSON.stringify(out);
    expect(stored).not.toContain(PRC_ID);
    expect(stored).not.toContain('良好');
    expect(out!.rawText).toContain('身份证号：[已移除证件号]');
    expect(out!.parsed.phone).toBe('138 0013 8000');
    expect(out!.parsed.experience[0]!.description).toBe('负责支付系统');
  });

  it('CN_STORAGE_MODE=discard also drops the photo', async () => {
    process.env.CN_STORAGE_MODE = 'discard';
    const svc = new GoHireResumeParseService();
    const out = await runWithBrand('goapply', () => svc.parseResumeFile(PDF));
    const stored = JSON.stringify(out);
    expect(stored).not.toContain(PRC_ID);
    expect(stored).not.toContain('data:image');
  });
});

describe('header comment', () => {
  it('carries no personal data from the original incident', () => {
    const src = readFileSync(fileURLToPath(new URL('../../services/GoHireResumeParseService.ts', import.meta.url)), 'utf8');
    const header = src.slice(0, src.indexOf('const DEFAULT_API_BASE'));
    expect(header).not.toMatch(/\d{11}/);
    expect(header).not.toMatch(/丽萍|學院|学院/);
  });
});
