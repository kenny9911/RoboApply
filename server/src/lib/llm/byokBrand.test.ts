// @vitest-environment node
//
// WP-14: BYOK is off for GoApply (R-13), for reads and writes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  userLLMKey: { findUnique: vi.fn(async () => ({ id: 'r1', encryptedKey: 'enc', baseUrl: null, isActive: true })), upsert: vi.fn(async () => ({})) },
}));
vi.mock('../prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../crypto.js', () => ({ encryptField: (s: string) => `enc:${s}`, decryptField: () => 'plain-key' }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const byok = await import('../byokService.js');
const { runWithBrand } = await import('../requestContext.js');

beforeEach(() => vi.clearAllMocks());

describe('BYOK per brand', () => {
  it('never resolves a personal key on GoApply', async () => {
    expect(await runWithBrand('goapply', () => byok.resolveByok('u1', 'deepseek'))).toBeNull();
    expect(prismaMock.userLLMKey.findUnique).not.toHaveBeenCalled();
    expect(await runWithBrand('roboapply', () => byok.resolveByok('u1', 'openai'))).toMatchObject({ apiKey: 'plain-key' });
  });

  it('refuses to store a personal key on GoApply', async () => {
    await expect(
      runWithBrand('goapply', () => byok.upsertByok({ userId: 'u1', provider: 'deepseek', plaintextKey: 'sk-x' })),
    ).rejects.toMatchObject({ code: 'feature_disabled' });
    expect(prismaMock.userLLMKey.upsert).not.toHaveBeenCalled();
    expect(byok.isByokAllowedForBrand('roboapply')).toBe(true);
    expect(byok.isByokAllowedForBrand(undefined)).toBe(true);
  });
});
