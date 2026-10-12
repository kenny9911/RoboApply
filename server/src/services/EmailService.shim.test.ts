// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/prisma.js', () => ({ default: {} }));

import emailService, { escapeHtml } from './EmailService.js';

const ORIGINAL = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };

describe('legacy EmailService shim', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.RESEND_API_KEY = 're_test';
    delete process.env.EMAIL_FROM;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL.key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = ORIGINAL.key;
    if (ORIGINAL.from === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = ORIGINAL.from;
  });

  it('keeps send(): boolean through the platform Resend transport', async () => {
    expect(emailService.isConfigured).toBe(true);
    expect(await emailService.send({ to: 'a@b.test', subject: 's', html: '<p>h</p>', text: 't' })).toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({ from: 'RoboApply <noreply@roboapply.io>', to: ['a@b.test'], subject: 's', html: '<p>h</p>', text: 't' });
  });

  it('honours EMAIL_FROM and a per-call from, as before', async () => {
    process.env.EMAIL_FROM = 'Ops <ops@example.test>';
    expect(emailService.defaultFrom).toBe('Ops <ops@example.test>');
    await emailService.send({ to: ['a@b.test'], subject: 's', html: 'h', from: 'Custom <c@example.test>' });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).from).toBe('Custom <c@example.test>');
  });

  it('never sends to reserved .invalid placeholder addresses', async () => {
    expect(await emailService.send({ to: '86138@users.goapply.invalid', subject: 's', html: 'h' })).toBe(false);
    await emailService.send({ to: ['ok@b.test', 'x@users.goapply.invalid'], subject: 's', html: 'h' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).to).toEqual(['ok@b.test']);
  });

  it('returns false (no throw) when unconfigured or when Resend fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 500 }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await emailService.send({ to: 'a@b.test', subject: 's', html: 'h' })).toBe(false);
    delete process.env.RESEND_API_KEY;
    expect(emailService.isConfigured).toBe(false);
    expect(await emailService.send({ to: 'a@b.test', subject: 's', html: 'h' })).toBe(false);
    spy.mockRestore();
    expect(escapeHtml('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
  });
});
