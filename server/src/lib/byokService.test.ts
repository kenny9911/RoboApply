import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateByok } from './byokService.js';

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
