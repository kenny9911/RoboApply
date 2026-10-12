// @vitest-environment node
//
// BYOK per brand (D5): personal API keys follow RoboApply on GoApply, for
// reads and writes. They are off for GoApply only behind the domestic-only
// wall (CN_LLM_DOMESTIC_ONLY=true, or CN_RESIDENCY_STRICT=true).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  userLLMKey: { findUnique: vi.fn(async () => ({ id: 'r1', encryptedKey: 'enc', baseUrl: null, isActive: true })), upsert: vi.fn(async () => ({})) },
}));
vi.mock('../prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../crypto.js', () => ({ encryptField: (s: string) => `enc:${s}`, decryptField: () => 'plain-key' }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const byok = await import('../byokService.js');
const { runWithBrand } = await import('../requestContext.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CN_LLM_DOMESTIC_ONLY', '');
  vi.stubEnv('CN_RESIDENCY_STRICT', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('BYOK per brand', () => {
  it('is allowed for both brands by default; the wall turns it off for GoApply only', () => {
    expect(byok.isByokAllowedForBrand('roboapply')).toBe(true);
    expect(byok.isByokAllowedForBrand('goapply')).toBe(true);
    expect(byok.isByokAllowedForBrand(undefined)).toBe(true);
    expect(byok.isByokAllowedForBrand('goapply', {})).toBe(true);
    expect(byok.isByokAllowedForBrand('goapply', { CN_LLM_DOMESTIC_ONLY: 'true' })).toBe(false);
    expect(byok.isByokAllowedForBrand('goapply', { CN_RESIDENCY_STRICT: 'true' })).toBe(false);
    expect(byok.isByokAllowedForBrand('goapply', { CN_LLM_DOMESTIC_ONLY: 'false' })).toBe(true);
    expect(byok.isByokAllowedForBrand('roboapply', { CN_LLM_DOMESTIC_ONLY: 'true', CN_RESIDENCY_STRICT: 'true' })).toBe(true);
    expect(byok.isByokAllowedForBrand('not-a-brand', { CN_LLM_DOMESTIC_ONLY: 'true' })).toBe(true);
  });

  it('resolves a personal key on GoApply by default', async () => {
    expect(await runWithBrand('goapply', () => byok.resolveByok('u1', 'deepseek'))).toMatchObject({ apiKey: 'plain-key' });
    expect(await runWithBrand('goapply', () => byok.resolveByok('u1', 'openai'))).toMatchObject({ apiKey: 'plain-key' });
    expect(await runWithBrand('roboapply', () => byok.resolveByok('u1', 'openai'))).toMatchObject({ apiKey: 'plain-key' });
  });

  it('stores a personal key on GoApply by default', async () => {
    await runWithBrand('goapply', () => byok.upsertByok({ userId: 'u1', provider: 'openai', plaintextKey: 'sk-x' }));
    expect(prismaMock.userLLMKey.upsert).toHaveBeenCalledTimes(1);
  });

  it('behind the wall: never resolves and refuses to store a personal key on GoApply (ByokNotAllowedError)', async () => {
    vi.stubEnv('CN_LLM_DOMESTIC_ONLY', 'true');
    expect(await runWithBrand('goapply', () => byok.resolveByok('u1', 'deepseek'))).toBeNull();
    expect(prismaMock.userLLMKey.findUnique).not.toHaveBeenCalled();
    const stored = runWithBrand('goapply', () => byok.upsertByok({ userId: 'u1', provider: 'deepseek', plaintextKey: 'sk-x' }));
    await expect(stored).rejects.toBeInstanceOf(byok.ByokNotAllowedError);
    await expect(stored).rejects.toMatchObject({ code: 'feature_disabled' });
    expect(prismaMock.userLLMKey.upsert).not.toHaveBeenCalled();
    // RoboApply is unaffected by GoApply's wall.
    expect(await runWithBrand('roboapply', () => byok.resolveByok('u1', 'openai'))).toMatchObject({ apiKey: 'plain-key' });
    await runWithBrand('roboapply', () => byok.upsertByok({ userId: 'u1', provider: 'openai', plaintextKey: 'sk-x' }));
    expect(prismaMock.userLLMKey.upsert).toHaveBeenCalledTimes(1);
  });
});
