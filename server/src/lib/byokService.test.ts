import { afterEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('./prisma.js', () => ({ prisma: { userLLMKey: { findUnique: db.findUnique } } }));
vi.mock('./crypto.js', () => ({
  encryptField: (v: string) => `enc:${v}`,
  decryptField: (v: string) => {
    if (!v.startsWith('enc:')) throw new Error('bad auth tag');
    return v.slice(4);
  },
}));
vi.mock('../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveByok, validateByok } from './byokService.js';
import { runWithBrand, withRequestContext } from './requestContext.js';

function response(status: number, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : 'Not Found',
    text: async () => body,
  };
}

describe('Anthropic BYOK validation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the model-list credential probe when the endpoint supports it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200));
    vi.stubGlobal('fetch', fetchMock);

    await expect(validateByok({
      provider: 'anthropic',
      plaintextKey: 'test-key',
      baseUrl: 'https://api.anthropic.com',
    })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=1');
  });

  it('falls back to a model-free Messages validation for compatible proxies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(400, '{"error":{"type":"invalid_request_error"}}'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(validateByok({
      provider: 'anthropic',
      plaintextKey: 'test-key',
      baseUrl: 'https://anthropic-proxy.example.com',
    })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://anthropic-proxy.example.com/v1/messages');
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body).not.toHaveProperty('model');
  });

  it('does not accept an authentication failure from the proxy fallback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(405))
      .mockResolvedValueOnce(response(401, 'invalid key'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await validateByok({
      provider: 'anthropic',
      plaintextKey: 'bad-key',
      baseUrl: 'https://anthropic-proxy.example.com',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('401 Unauthorized');
  });
});

describe('resolveByok', () => {
  afterEach(() => db.findUnique.mockReset());

  it('returns the decrypted key for an active row', async () => {
    db.findUnique.mockResolvedValue({ id: 'k1', encryptedKey: 'enc:sk-user', baseUrl: null, isActive: true });
    await expect(resolveByok('u1', 'openai')).resolves.toEqual({ rowId: 'k1', apiKey: 'sk-user', baseUrl: null });
  });

  it('returns null without a row, for an inactive row and without a user', async () => {
    db.findUnique.mockResolvedValue(null);
    await expect(resolveByok('u1', 'openai')).resolves.toBeNull();
    db.findUnique.mockResolvedValue({ id: 'k1', encryptedKey: 'enc:sk-user', baseUrl: null, isActive: false });
    await expect(resolveByok('u1', 'openai')).resolves.toBeNull();
    await expect(resolveByok(null, 'openai')).resolves.toBeNull();
  });

  it('a failing lookup (DB down, pool timeout) falls back to the platform route instead of failing the call', async () => {
    db.findUnique.mockRejectedValue(new Error('Timed out fetching a new connection from the connection pool'));
    await expect(withRequestContext({ requestId: 'r1', brandId: 'roboapply', userId: 'u1' }, () => resolveByok('u1', 'openai'))).resolves.toBeNull();
  });

  it('still throws when a stored key cannot be decrypted (no silent platform billing)', async () => {
    db.findUnique.mockResolvedValue({ id: 'k1', encryptedKey: 'corrupt', baseUrl: null, isActive: true });
    await expect(resolveByok('u1', 'openai')).rejects.toThrow(/could not be decrypted/);
  });

  it('never applies on GoApply (R-13), even when the user has a key', async () => {
    db.findUnique.mockResolvedValue({ id: 'k1', encryptedKey: 'enc:sk-user', baseUrl: null, isActive: true });
    await expect(runWithBrand('goapply', () => resolveByok('u1', 'openai'))).resolves.toBeNull();
    expect(db.findUnique).not.toHaveBeenCalled();
    await expect(runWithBrand('roboapply', () => resolveByok('u1', 'openai'))).resolves.toMatchObject({ apiKey: 'sk-user' });
  });
});
