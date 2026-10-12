// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { runWithBrand } from '../../lib/requestContext.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { BRANDS } from '../brand/registry.js';
import { isEnabledForBrand } from '../flags.js';
// The real templates (they register themselves on import).
import { AUTH_EMAIL_KEYS } from './templates/auth/index.js';
import './templates/billing/index.js';
import { NOTIFY_TEMPLATES } from './templates/notify/index.js';
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
  transportNameFor,
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
    subject: t('billing.renewalReminder.headingAuto'),
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

  // D5 (GOAPPLY_PARITY_PLAN.md §3.4): a missing China transport never turns GoApply mail off.
  it('GoApply with only the shared Resend key sends through Resend from the shared verified sender, under its own name', async () => {
    const { t, sent } = fakeTransport();
    registerEmailTransport('resend', t);
    const base = { template: 'test.reset', to: 'li@example.cn', brand: 'goapply' as const, params: { url: 'https://x' } };
    const env = { ...ENV, ROBOAPPLY_EMAIL_FROM: 'RoboApply <hello@mail.roboapply.io>', EMAIL_FROM: 'RoboHire <noreply@updates.robohire.io>' };
    expect(Object.keys(env).some((name) => name.startsWith('CN_'))).toBe(false);

    expect(await sendEmail(base, { ...deps(), env })).toEqual({ status: 'sent', provider: 'resend', providerId: 'msg_1', logId: expect.any(String) });
    const m = sent[0]!;
    // The shared address, GoApply's display name: never "RoboApply <…>".
    expect(m.from).toBe('GoApply <hello@mail.roboapply.io>');
    expect(m.html).toContain('lang="zh"');
    // Nothing of the other brand in the message itself: no name, no origin, no reply-to, no legal line.
    expect(m.html).not.toMatch(/RoboApply|roboapply\.io|RoboHire/);
    expect(m.text).not.toMatch(/RoboApply|roboapply\.io|RoboHire/);
    expect(m.replyTo).toBeUndefined();
    expect(m.html).toContain('https://www.goapply.top/settings#notifications');
    expect(db.$rows('rAEmailLog')[0]).toMatchObject({ brand: 'goapply', provider: 'resend', status: 'sent' });

    // Without ROBOAPPLY_EMAIL_FROM the shared EMAIL_FROM address; with neither, the registry address.
    await sendEmail(base, { ...deps(), env: { ...ENV, EMAIL_FROM: 'RoboHire <noreply@updates.robohire.io>' } });
    expect(sent[1]!.from).toBe('GoApply <noreply@updates.robohire.io>');
    await sendEmail(base, deps());
    expect(sent[2]!.from).toBe('GoApply <noreply@goapply.top>');
    // CN_EMAIL_FROM takes over once GoApply has a verified sender of its own; `resend` spelled out is the same transport.
    await sendEmail(base, { ...deps(), env: { ...env, CN_EMAIL_TRANSPORT: 'resend', CN_EMAIL_FROM: 'Whatever <noreply@mail.goapply.top>' } });
    expect(sent[3]!.from).toBe('GoApply <noreply@mail.goapply.top>');
  });

  it('GoApply, only RESEND_API_KEY and ROBOAPPLY_EMAIL_FROM: verification, password-reset, alert and billing mails all go out via Resend as "GoApply <shared address>"', async () => {
    const { t, sent } = fakeTransport();
    registerEmailTransport('resend', t);
    setEmailPreferenceGate(async () => true);
    const env = { RESEND_API_KEY: 're_test', JWT_SECRET: 'jwt-test-secret', ROBOAPPLY_EMAIL_FROM: 'RoboApply <hello@mail.roboapply.io>' };
    const mails: Array<[string, Record<string, unknown>]> = [
      [AUTH_EMAIL_KEYS.emailVerify, { path: '/verify-email/tok' }],
      [AUTH_EMAIL_KEYS.passwordReset, { path: '/reset-password/tok' }],
      [NOTIFY_TEMPLATES.jobAlertInstant, { search: '后端 上海', jobs: [{ id: 'job1', title: '后端工程师', company: '某科技公司', place: '上海', remote: false, pay: null, tier: 'good', gap: null, href: '/jobs/job1?from=alert' }] }],
      ['billing.cancel_confirmed', { planKey: 'pro_monthly', cancelledAt: '2026-10-10T08:00:00.000Z', accessUntil: '2026-10-30T00:00:00.000Z' }],
      ['billing.payment_failed', { planKey: 'pro_weekly', amountMinor: 1200, currency: 'CNY' }],
    ];
    for (const [template, params] of mails) {
      const res = await sendEmail({ template, to: 'li@example.cn', userId: 'g1', brand: 'goapply', params }, { ...deps(), env });
      expect(res, template).toMatchObject({ status: 'sent', provider: 'resend' });
    }
    expect(sent).toHaveLength(mails.length);
    for (const m of sent) {
      expect(m.from).toBe('GoApply <hello@mail.roboapply.io>');
      expect(m.html).toContain('lang="zh"');
      // The shared address is the only thing borrowed: no RoboApply name or origin in the message.
      expect(`${m.subject} ${m.html} ${m.text}`).not.toMatch(/RoboApply|roboapply\.io/);
      expect(m.replyTo).toBeUndefined();
    }
    // Links go to GoApply's own origin.
    expect(sent[0]!.text).toContain('https://www.goapply.top/verify-email/tok');
    expect(sent[1]!.text).toContain('https://www.goapply.top/reset-password/tok');
    expect(db.$rows('rAEmailLog').map((r) => [r.brand, r.provider, r.status])).toEqual(mails.map(() => ['goapply', 'resend', 'sent']));
  });

  it('GoApply reply-to and legal lines stay its own on the shared transport; RoboApply values never appear', async () => {
    const { t, sent } = fakeTransport();
    registerEmailTransport('resend', t);
    const base = { template: 'test.reset', to: 'li@example.cn', brand: 'goapply' as const, params: { url: 'https://x' } };
    const intl = { SUPPORT_EMAIL: 'help@roboapply.io', LEGAL_ENTITY_NAME: 'RoboApply Inc.', LEGAL_POSTAL_ADDRESS: '100 Example Ave', CANONICAL_ORIGIN: 'https://intl.example' };
    await sendEmail(base, { ...deps(), env: { ...ENV, ROBOAPPLY_EMAIL_FROM: 'hello@mail.roboapply.io', ...intl } });
    expect(sent[0]!.replyTo).toBeUndefined();
    expect(sent[0]!.html).not.toMatch(/RoboApply Inc\.|100 Example Ave|intl\.example|help@roboapply\.io/);
    await sendEmail(base, {
      ...deps(),
      env: { ...ENV, ROBOAPPLY_EMAIL_FROM: 'hello@mail.roboapply.io', ...intl, CN_SUPPORT_EMAIL: 'help@goapply.top', CN_LEGAL_ENTITY_NAME: '某某科技有限公司', CN_LEGAL_POSTAL_ADDRESS: '上海市' },
    });
    expect(sent[1]!.replyTo).toBe('help@goapply.top');
    expect(sent[1]!.html).toContain('某某科技有限公司');
    expect(sent[1]!.html).toContain('上海市');
    expect(sent[1]!.html).not.toMatch(/RoboApply Inc\.|100 Example Ave/);
  });

  it('CN_EMAIL_TRANSPORT picks the transport: aliyun_dm with its keys uses DirectMail, none suppresses, a missing key suppresses', async () => {
    const resend = fakeTransport();
    registerEmailTransport('resend', resend.t);
    const dmSent: EmailMessage[] = [];
    registerEmailTransport('aliyun_dm', {
      name: 'aliyun_dm',
      isConfigured: () => true,
      send: async (m) => {
        dmSent.push(m);
        return { ok: true, providerId: 'dm_1' };
      },
    });
    const base = { template: 'test.reset', to: 'li@example.cn', brand: 'goapply' as const, params: { url: 'https://x' } };
    const ALIYUN = { ALIYUN_DM_ACCESS_KEY_ID: 'a', ALIYUN_DM_ACCESS_KEY_SECRET: 'b', ALIYUN_DM_ACCOUNT_NAME: 'noreply@mail.goapply.top' };
    const shared = { ...ENV, ROBOAPPLY_EMAIL_FROM: 'hello@mail.roboapply.io' };

    // DirectMail, never Resend, and never the shared sender address.
    expect(await sendEmail(base, { ...deps(), env: { ...shared, ...ALIYUN, CN_EMAIL_TRANSPORT: 'aliyun_dm' } })).toMatchObject({ status: 'sent', provider: 'aliyun_dm', providerId: 'dm_1' });
    expect(resend.sent).toHaveLength(0);
    expect(dmSent[0]!.from).toBe('GoApply <noreply@goapply.top>');
    // aliyun_dm selected without its keys: suppressed, no silent fall back to Resend.
    expect(await sendEmail(base, { ...deps(), env: { ...shared, CN_EMAIL_TRANSPORT: 'aliyun_dm' } })).toEqual({ status: 'suppressed', reason: 'transport_not_configured', logId: null });
    // none: the operator's off switch.
    expect(await sendEmail(base, { ...deps(), env: { ...shared, ...ALIYUN, CN_EMAIL_TRANSPORT: 'none' } })).toEqual({ status: 'suppressed', reason: 'transport_not_configured', logId: null });
    // No Resend key at all: nothing to fall back to.
    expect(await sendEmail(base, { ...deps(), env: { JWT_SECRET: 'jwt-test-secret' } })).toEqual({ status: 'suppressed', reason: 'transport_not_configured', logId: null });
    // Each suppressed row names the transport that send would have used.
    expect(db.$rows('rAEmailLog').map((r) => [r.status, r.provider])).toEqual([
      ['sent', 'aliyun_dm'],
      ['suppressed', 'aliyun_dm'],
      ['suppressed', 'none'],
      ['suppressed', 'resend'],
    ]);
    expect(resend.sent).toHaveLength(0);
    expect(dmSent).toHaveLength(1);
    // RoboApply never reads CN_EMAIL_TRANSPORT.
    expect((await sendEmail({ ...base, brand: 'roboapply' }, { ...deps(), env: { ...shared, CN_EMAIL_TRANSPORT: 'none' } })).status).toBe('sent');
  });

  it('transportNameFor is the effective transport (the processor list reads it)', () => {
    const go = BRANDS.goapply;
    expect(transportNameFor(go, {})).toBe('resend');
    expect(transportNameFor(go, { CN_EMAIL_TRANSPORT: '' })).toBe('resend');
    expect(transportNameFor(go, { CN_EMAIL_TRANSPORT: ' Resend ' })).toBe('resend');
    expect(transportNameFor(go, { CN_EMAIL_TRANSPORT: 'something-else' })).toBe('resend');
    expect(transportNameFor(go, { CN_EMAIL_TRANSPORT: 'Aliyun_DM' })).toBe('aliyun_dm');
    expect(transportNameFor(go, { CN_EMAIL_TRANSPORT: 'NONE' })).toBe('none');
    for (const v of ['aliyun_dm', 'none', 'resend']) expect(transportNameFor(BRANDS.roboapply, { CN_EMAIL_TRANSPORT: v })).toBe('resend');
  });

  it('transportFor is non-null exactly when the notify.email capability is on (both brands, every transport setting)', () => {
    const configured = (name: string): EmailTransport => ({ name, isConfigured: () => true, send: async () => ({ ok: true }) });
    registerEmailTransport('resend', configured('resend'));
    registerEmailTransport('aliyun_dm', configured('aliyun_dm'));
    const RESEND = { RESEND_API_KEY: 're_test' };
    const ALIYUN = { ALIYUN_DM_ACCESS_KEY_ID: 'a', ALIYUN_DM_ACCESS_KEY_SECRET: 'b', ALIYUN_DM_ACCOUNT_NAME: 'c' };
    const credentials: Array<Record<string, string>> = [{}, RESEND, ALIYUN, { ...RESEND, ...ALIYUN }, { ...RESEND, ALIYUN_DM_ACCESS_KEY_ID: 'a' }];
    const settings: Array<Record<string, string>> = [{}, { CN_EMAIL_TRANSPORT: 'resend' }, { CN_EMAIL_TRANSPORT: 'aliyun_dm' }, { CN_EMAIL_TRANSPORT: 'none' }, { CN_EMAIL_TRANSPORT: 'ses' }, { CN_EMAIL_FROM: 'noreply@mail.goapply.top' }];
    let on = 0;
    for (const brand of [BRANDS.roboapply, BRANDS.goapply]) {
      for (const creds of credentials) {
        for (const setting of settings) {
          const env = { ...creds, ...setting };
          const enabled = isEnabledForBrand('notify.email', brand, env);
          const transport = transportFor(brand, env);
          expect(transport !== null, `${brand.id} ${JSON.stringify(env)}`).toBe(enabled);
          expect(isEnabledForBrand('auth.passwordReset', brand, env), `${brand.id} reset ${JSON.stringify(env)}`).toBe(enabled);
          if (transport) {
            on += 1;
            expect(transport.name).toBe(transportNameFor(brand, env));
          }
        }
      }
    }
    // The table really exercises both answers.
    expect(on).toBeGreaterThan(10);
    expect(on).toBeLessThan(2 * credentials.length * settings.length);
    // The headline case: GoApply, the shared key and nothing else.
    expect(transportFor(BRANDS.goapply, RESEND)?.name).toBe('resend');
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
    // GoApply: its own address first; on Resend the shared verified sender; the registry address last.
    expect(fromFor(BRANDS.goapply, {})).toBe('GoApply <noreply@goapply.top>');
    expect(fromFor(BRANDS.goapply, { EMAIL_FROM: 'x <y@roboapply.io>' })).toBe('GoApply <y@roboapply.io>');
    expect(fromFor(BRANDS.goapply, { ROBOAPPLY_EMAIL_FROM: 'RA <hi@mail.roboapply.io>', EMAIL_FROM: 'x <y@z.io>' })).toBe('GoApply <hi@mail.roboapply.io>');
    expect(fromFor(BRANDS.goapply, { CN_EMAIL_FROM: 'GA <noreply@mail.goapply.top>', ROBOAPPLY_EMAIL_FROM: 'hi@mail.roboapply.io' })).toBe('GoApply <noreply@mail.goapply.top>');
    // An unusable CN_EMAIL_FROM is skipped, not sent.
    expect(fromFor(BRANDS.goapply, { CN_EMAIL_FROM: 'not an address', ROBOAPPLY_EMAIL_FROM: 'hi@mail.roboapply.io' })).toBe('GoApply <hi@mail.roboapply.io>');
    // The shared sender is borrowed on Resend only: never on DirectMail, never when email is off.
    expect(fromFor(BRANDS.goapply, { CN_EMAIL_TRANSPORT: 'aliyun_dm', ROBOAPPLY_EMAIL_FROM: 'hi@mail.roboapply.io', EMAIL_FROM: 'y@z.io' })).toBe('GoApply <noreply@goapply.top>');
    expect(fromFor(BRANDS.goapply, { CN_EMAIL_TRANSPORT: 'none', ROBOAPPLY_EMAIL_FROM: 'hi@mail.roboapply.io' })).toBe('GoApply <noreply@goapply.top>');
    expect(fromFor(BRANDS.goapply, { CN_EMAIL_TRANSPORT: 'aliyun_dm', CN_EMAIL_FROM: 'noreply@mail.goapply.top' })).toBe('GoApply <noreply@mail.goapply.top>');
    // RoboApply never reads the CN sender.
    expect(fromFor(BRANDS.roboapply, { CN_EMAIL_FROM: 'noreply@mail.goapply.top' })).toBe('RoboApply <noreply@roboapply.io>');
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
