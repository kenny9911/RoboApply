// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { runWithBrand } from '../../lib/requestContext.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { BRANDS } from '../brand/registry.js';
import {
  button,
  classifyAddress,
  createResendTransport,
  createUnsubscribeToken,
  defineEmailTemplate,
  emailOrigin,
  fromFor,
  hashEmail,
  heading,
  legalFooter,
  paragraph,
  registerEmailTransport,
  resetEmailTransportsForTests,
  sendEmail,
  setEmailPreferenceGate,
  transportFor,
  verifyUnsubscribeToken,
  type EmailDb,
  type EmailMessage,
  type EmailTransport,
} from './index.js';

const ENV = { RESEND_API_KEY: 're_test', JWT_SECRET: 'jwt-test-secret', NODE_ENV: 'test' };

function fakeTransport(result: { ok: true; providerId?: string } | { ok: false; error: string } = { ok: true, providerId: 'msg_1' }) {
  const sent: EmailMessage[] = [];
  const t: EmailTransport = {
    name: 'resend',
    isConfigured: () => true,
    send: async (m) => {
      sent.push(m);
      return result;
    },
  };
  return { t, sent };
}

defineEmailTemplate<{ url: string; name?: string }>({
  key: 'test.reset',
  category: 'transactional',
  render: ({ t, params }) => ({
    subject: t('billing.renewal.headingAuto'),
    bodyHtml: heading(`Hi ${params.name ?? ''}`) + paragraph('<script>x</script>') + button('Go', params.url),
    bodyText: `Go: ${params.url}`,
  }),
});

defineEmailTemplate<{ count: number }>({
  key: 'test.alert',
  category: 'alert',
  render: ({ t, params }) => ({
    subject: `${params.count} new jobs`,
    bodyHtml: paragraph(t('shell.reasonAlert')),
    bodyText: 'jobs',
  }),
});

let db: ReturnType<typeof createFakePrisma>;
const deps = () => ({ db: db as unknown as EmailDb, env: ENV });

beforeEach(() => {
  db = createFakePrisma();
  resetEmailTransportsForTests();
});
afterEach(() => resetEmailTransportsForTests());

describe('sendEmail', () => {
  it('sends a transactional email with the brand From, shell and a hashed log row', async () => {
    const { t, sent } = fakeTransport();
    registerEmailTransport('resend', t);
    const result = await runWithBrand('roboapply', () =>
      sendEmail({ template: 'test.reset', to: 'Ana@Example.com', userId: 'u1', locale: 'en', params: { url: 'https://x.test/r', name: 'Ana' } }, deps()),
    );
    expect(result).toEqual({ status: 'sent', provider: 'resend', providerId: 'msg_1', logId: expect.any(String) });
    // The id is the RAEmailLog row of this email (what RAAlertDelivery.emailLogId stores).
    expect(result.logId).toBe(db.$rows('rAEmailLog')[0]!.id);
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.from).toBe('RoboApply <noreply@roboapply.io>');
    expect(m.to).toEqual(['Ana@Example.com']);
    expect(m.subject).toBe('Your plan renews soon');
    expect(m.html).toContain('RoboApply');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('List-Unsubscribe');
    expect(m.headers).toEqual({});
    expect(m.text).toContain('Go: https://x.test/r');
    expect(m.html).toContain('You received this email because it is about your RoboApply account.');
    const log = db.$rows('rAEmailLog');
    expect(log).toEqual([
      expect.objectContaining({
        brand: 'roboapply',
        userId: 'u1',
        template: 'test.reset',
        toHash: hashEmail('ana@example.com'),
        provider: 'resend',
        providerId: 'msg_1',
        status: 'sent',
        error: null,
      }),
    ]);
    expect(JSON.stringify(log)).not.toContain('Example.com');
  });

  it('a per-message replyTo (a valid address) replaces the brand support inbox; an invalid one is ignored', async () => {
    const { t, sent } = fakeTransport();
    registerEmailTransport('resend', t);
    const env = { ...ENV, SUPPORT_EMAIL: 'support@roboapply.io' };
    const send = (replyTo?: string) =>
      runWithBrand('roboapply', () => sendEmail({ template: 'test.reset', to: 'staff@roboapply.io', replyTo, params: { url: 'https://x.test/r' } }, { db: db as unknown as EmailDb, env }));
    await send('visitor@example.test');
    await send('not an address');
    await send();
    expect(sent.map((m) => m.replyTo)).toEqual(['visitor@example.test', 'support@roboapply.io', 'support@roboapply.io']);
  });

  it('refuses .invalid placeholder and malformed addresses without calling the transport', async () => {
    const { t, sent } = fakeTransport();
    registerEmailTransport('resend', t);
    const placeholder = await sendEmail(
      { template: 'test.reset', to: '8613800000000@users.goapply.invalid', brand: 'goapply', params: { url: 'https://x' } },
      deps(),
    );
    const malformed = await sendEmail({ template: 'test.reset', to: 'not-an-email', brand: 'roboapply', params: { url: 'https://x' } }, deps());
    expect(placeholder).toEqual({ status: 'suppressed', reason: 'placeholder_address', logId: null });
    expect(malformed).toEqual({ status: 'suppressed', reason: 'invalid_address', logId: null });
    expect(sent).toHaveLength(0);
    expect(db.$rows('rAEmailLog').map((r) => r.status)).toEqual(['suppressed', 'suppressed']);
    expect(classifyAddress('a@b.INVALID')).toBe('placeholder_address');
  });

  it('suppresses non-transactional mail until a preference gate exists, then signs the unsubscribe link', async () => {
    const { t, sent } = fakeTransport();
    registerEmailTransport('resend', t);
    const input = { template: 'test.alert', to: 'a@b.test', userId: 'u9', brand: 'roboapply' as const, params: { count: 3 } };
    expect(await sendEmail(input, deps())).toEqual({ status: 'suppressed', reason: 'no_preference_gate', logId: null });

    setEmailPreferenceGate(async ({ list, category }) => list === 'alerts' && category === 'alert');
    const ok = await sendEmail(input, deps());
    expect(ok.status).toBe('sent');
    const m = sent[0]!;
    expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const header = m.headers?.['List-Unsubscribe'] ?? '';
    expect(header).toMatch(/^<https:\/\/www\.roboapply\.io\/api\/v1\/public\/email\/unsubscribe\?token=u1\.[^>]+>$/);
    const token = decodeURIComponent(header.split('token=')[1]!.replace(/>$/, ''));
    expect(verifyUnsubscribeToken(token, { env: ENV, expectedBrand: 'roboapply' })).toMatchObject({
      ok: true,
      payload: { brand: 'roboapply', list: 'alerts', userId: 'u9', template: 'test.alert' },
    });
    expect(m.html).toContain('https://www.roboapply.io/unsubscribe/');
    expect(m.html).toContain('Unsubscribe');

    setEmailPreferenceGate(async () => false);
    expect(await sendEmail(input, deps())).toEqual({ status: 'suppressed', reason: 'preference_off', logId: null });
    setEmailPreferenceGate(async () => {
      throw new Error('db down');
    });
    expect(await sendEmail(input, deps())).toEqual({ status: 'suppressed', reason: 'preference_off', logId: null });
  });

  it('GoApply sends only through its own configured transport and sender', async () => {
    const { t, sent } = fakeTransport();
    registerEmailTransport('resend', t);
    const base = { template: 'test.reset', to: 'li@example.cn', brand: 'goapply' as const, params: { url: 'https://x' } };
    // No CN_EMAIL_TRANSPORT → no email (matches the notify.email capability).
    expect(await sendEmail(base, deps())).toEqual({ status: 'suppressed', reason: 'transport_not_configured', logId: null });
    // Resend without CN_EMAIL_FROM is still not configured (no fallback to the intl sender).
    expect(await sendEmail(base, { ...deps(), env: { ...ENV, CN_EMAIL_TRANSPORT: 'resend', EMAIL_FROM: 'X <x@roboapply.io>' } })).toEqual({
      status: 'suppressed',
      reason: 'transport_not_configured',
      logId: null,
    });
    const env = { ...ENV, CN_EMAIL_TRANSPORT: 'resend', CN_EMAIL_FROM: 'Whatever <noreply@mail.goapply.top>' };
    expect((await sendEmail(base, { ...deps(), env })).status).toBe('sent');
    expect(sent[0]!.from).toBe('GoApply <noreply@mail.goapply.top>');
    expect(sent[0]!.html).toContain('lang="zh"');
    // aliyun_dm is registered statically (WP-15 fills the stub in place): with it
    // selected, GoApply never falls back to Resend; until it reports configured,
    // sends are suppressed rather than faked.
    const dm = transportFor(BRANDS.goapply, { ...env, CN_EMAIL_TRANSPORT: 'aliyun_dm', ALIYUN_DM_ACCESS_KEY_ID: 'a', ALIYUN_DM_ACCESS_KEY_SECRET: 'b', ALIYUN_DM_ACCOUNT_NAME: 'c' });
    expect(dm === null || dm.name === 'aliyun_dm').toBe(true);
  });

  it('records transport failures and render failures as failed, never throwing', async () => {
    registerEmailTransport('resend', fakeTransport({ ok: false, error: 'resend_422: bad from' }).t);
    expect(await sendEmail({ template: 'test.reset', to: 'a@b.test', brand: 'roboapply', params: { url: 'u' } }, deps())).toEqual({
      status: 'failed',
      provider: 'resend',
      reason: 'resend_422: bad from',
      logId: expect.any(String),
    });
    defineEmailTemplate({
      key: 'test.missing_key',
      category: 'transactional',
      render: ({ t }) => ({ subject: t('nope.missing'), bodyHtml: '', bodyText: '' }),
    });
    const r = await sendEmail({ template: 'test.missing_key', to: 'a@b.test', brand: 'roboapply', params: {} }, deps());
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/render_failed: Missing email string "nope.missing"/);
  });

  it('a failing log write never blocks the send', async () => {
    const { t } = fakeTransport();
    registerEmailTransport('resend', t);
    db = createFakePrisma({ failOn: { 'rAEmailLog.create': new Error('relation "RAEmailLog" does not exist') } });
    const r = await sendEmail({ template: 'test.reset', to: 'a@b.test', brand: 'roboapply', params: { url: 'u' } }, deps());
    expect(r.status).toBe('sent');
    // No log row, so no id to link to.
    expect(r.logId).toBeNull();
  });

  it('returns the log row id only for an email that reached the transport (WP-93: RAAlertDelivery.emailLogId)', async () => {
    // sent: the id of its row
    const ok = fakeTransport();
    registerEmailTransport('resend', ok.t);
    const sentResult = await sendEmail({ template: 'test.reset', to: 'a@b.test', brand: 'roboapply', params: { url: 'u' } }, deps());
    expect(sentResult.status).toBe('sent');
    // failed at the provider: still "the email" of this send
    const bad = fakeTransport({ ok: false, error: 'provider 500' });
    registerEmailTransport('resend', bad.t);
    const failedResult = await sendEmail({ template: 'test.reset', to: 'a@b.test', brand: 'roboapply', params: { url: 'u' } }, deps());
    expect(failedResult).toMatchObject({ status: 'failed', reason: 'provider 500' });
    // gated (alert with the preference gate closed) and skipped (bad address, no transport): a row is logged, no id is returned
    setEmailPreferenceGate(async () => false);
    const gated = await sendEmail({ template: 'test.alert', to: 'a@b.test', userId: 'u1', brand: 'roboapply', params: { count: 2 } }, deps());
    const skipped = await sendEmail({ template: 'test.reset', to: 'nobody', brand: 'roboapply', params: { url: 'u' } }, deps());
    const noTransport = await sendEmail({ template: 'test.reset', to: 'a@b.test', brand: 'goapply', params: { url: 'u' } }, { db: db as unknown as EmailDb, env: { JWT_SECRET: 'jwt-test-secret' } });
    const rows = db.$rows('rAEmailLog');
    expect(rows.map((r) => r.status)).toEqual(['sent', 'failed', 'suppressed', 'suppressed', 'suppressed']);
    expect(sentResult.logId).toBe(rows[0]!.id);
    expect(failedResult.logId).toBe(rows[1]!.id);
    expect(gated).toEqual({ status: 'suppressed', reason: 'preference_off', logId: null });
    expect(skipped).toEqual({ status: 'suppressed', reason: 'invalid_address', logId: null });
    expect(noTransport).toEqual({ status: 'suppressed', reason: 'transport_not_configured', logId: null });
  });

  it('needs a brand: explicit or from context', async () => {
    await expect(sendEmail({ template: 'test.reset', to: 'a@b.test', params: { url: 'u' } }, deps())).rejects.toThrow(/brand/i);
    await expect(sendEmail({ template: 'nope.none', to: 'a@b.test', brand: 'roboapply', params: {} }, deps())).rejects.toThrow(/unknown template/);
  });
});

describe('sender, origin and legal footer config', () => {
  it('keeps the brand display name and takes only the address from env', () => {
    expect(fromFor(BRANDS.roboapply, {})).toBe('RoboApply <noreply@roboapply.io>');
    expect(fromFor(BRANDS.roboapply, { EMAIL_FROM: 'RoboHire <noreply@updates.robohire.io>' })).toBe('RoboApply <noreply@updates.robohire.io>');
    expect(fromFor(BRANDS.roboapply, { ROBOAPPLY_EMAIL_FROM: 'RA <hi@mail.roboapply.io>', EMAIL_FROM: 'x <y@z.io>' })).toBe(
      'RoboApply <hi@mail.roboapply.io>',
    );
    expect(fromFor(BRANDS.goapply, { EMAIL_FROM: 'x <y@roboapply.io>' })).toBe('GoApply <noreply@goapply.top>');
    expect(emailOrigin(BRANDS.goapply, { CN_CANONICAL_ORIGIN: 'https://staging.goapply.top/' })).toBe('https://staging.goapply.top');
    expect(emailOrigin(BRANDS.goapply, { CANONICAL_ORIGIN: 'https://intl.example' })).toBe('https://www.goapply.top');
  });

  it('shows the legal entity and address only when configured (never invented)', async () => {
    expect(legalFooter(BRANDS.roboapply, {})).toEqual({ entity: undefined, address: undefined });
    expect(legalFooter(BRANDS.goapply, { LEGAL_ENTITY_NAME: 'Intl Co', LEGAL_POSTAL_ADDRESS: '1 Main St' })).toEqual({
      entity: undefined,
      address: undefined,
    });
    expect(legalFooter(BRANDS.goapply, { CN_LEGAL_ENTITY_NAME: '某某科技有限公司', CN_LEGAL_POSTAL_ADDRESS: '上海市' })).toEqual({
      entity: '某某科技有限公司',
      address: '上海市',
    });
    const { t, sent } = fakeTransport();
    registerEmailTransport('resend', t);
    await sendEmail({ template: 'test.reset', to: 'a@b.test', brand: 'roboapply', params: { url: 'u' } }, deps());
    expect(sent[0]!.html).not.toContain('Sent by');
    await sendEmail(
      { template: 'test.reset', to: 'a@b.test', brand: 'roboapply', params: { url: 'u' } },
      { ...deps(), env: { ...ENV, LEGAL_ENTITY_NAME: 'RoboApply Inc.', LEGAL_POSTAL_ADDRESS: '100 Example Ave' } },
    );
    expect(sent[1]!.html).toContain('Sent by RoboApply Inc.');
    expect(sent[1]!.html).toContain('100 Example Ave');
  });
});

describe('unsubscribe tokens', () => {
  it('round-trips, never contains the address, and rejects tampering and the other brand', () => {
    const token = createUnsubscribeToken({ brand: 'goapply', list: 'tips', email: 'Li@Example.cn', env: ENV });
    expect(token).not.toContain('Example');
    const ok = verifyUnsubscribeToken(token, { env: ENV, expectedBrand: 'goapply' });
    expect(ok).toMatchObject({ ok: true, payload: { list: 'tips', emailHash: hashEmail('li@example.cn') } });
    expect(verifyUnsubscribeToken(token, { env: ENV, expectedBrand: 'roboapply' })).toEqual({ ok: false, reason: 'wrong_brand' });
    const [p, body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), list: 'marketing' })).toString('base64url');
    expect(verifyUnsubscribeToken(`${p}.${forged}.${sig}`, { env: ENV })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyUnsubscribeToken('garbage', { env: ENV })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyUnsubscribeToken(token, { env: { JWT_SECRET: 'other' } })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(
      verifyUnsubscribeToken(createUnsubscribeToken({ brand: 'roboapply', list: 'alerts', userId: 'u', env: ENV, now: new Date('2025-01-01') }), {
        env: ENV,
        maxAgeDays: 30,
        now: new Date('2026-01-01'),
      }),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('a dedicated secret wins over the JWT-derived key; no secret at all refuses to sign', () => {
    const t1 = createUnsubscribeToken({ brand: 'roboapply', list: 'alerts', userId: 'u', env: { EMAIL_UNSUBSCRIBE_SECRET: 's1', JWT_SECRET: 'j' } });
    expect(verifyUnsubscribeToken(t1, { env: { EMAIL_UNSUBSCRIBE_SECRET: 's1' } }).ok).toBe(true);
    expect(verifyUnsubscribeToken(t1, { env: { JWT_SECRET: 'j' } }).ok).toBe(false);
    expect(() => createUnsubscribeToken({ brand: 'roboapply', list: 'alerts', userId: 'u', env: {} })).toThrow(/EMAIL_UNSUBSCRIBE_SECRET/);
  });
});

describe('Resend transport', () => {
  it('posts the message with reply_to and headers and returns the provider id', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 're_123' }), { status: 200 }));
    const t = createResendTransport({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await t.send({
      from: 'RoboApply <a@roboapply.io>',
      to: ['x@y.test'],
      subject: 's',
      html: '<p>h</p>',
      text: 't',
      replyTo: 'support@roboapply.io',
      headers: { 'List-Unsubscribe': '<https://u>' },
    });
    expect(r).toEqual({ ok: true, providerId: 're_123' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(JSON.parse(String(init.body))).toEqual({
      from: 'RoboApply <a@roboapply.io>',
      to: ['x@y.test'],
      subject: 's',
      html: '<p>h</p>',
      text: 't',
      reply_to: 'support@roboapply.io',
      headers: { 'List-Unsubscribe': '<https://u>' },
    });
  });

  it('reports HTTP and network errors instead of throwing', async () => {
    const bad = createResendTransport({ apiKey: 'k', fetchImpl: (async () => new Response('nope', { status: 422 })) as unknown as typeof fetch });
    expect(await bad.send({ from: 'a', to: ['b'], subject: 's', html: 'h' })).toEqual({ ok: false, status: 422, error: 'resend_422: nope' });
    const down = createResendTransport({ apiKey: 'k', fetchImpl: (async () => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch });
    expect(await down.send({ from: 'a', to: ['b'], subject: 's', html: 'h' })).toEqual({ ok: false, error: 'ECONNRESET' });
    expect(createResendTransport({ apiKey: '' }).isConfigured()).toBe(false);
  });
});
