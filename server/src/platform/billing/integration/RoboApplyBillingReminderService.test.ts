// @vitest-environment node
//
// Renewal reminders: 5 days before monthly/quarterly, 2 days before weekly,
// GoApply passes 3 days before they end, annual reminder after 12 months —
// sent through the platform email service and logged in RAEmailLog.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../../test/fakePrisma.js');
  fake.db = createFakePrisma({ uniqueFields: { notification: ['dedupKey'] } });
  return { default: fake.db };
});
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { registerEmailTransport, resetEmailTransportsForTests } from '../../email/index.js';
import { reminderFor, runAnnualReminderSweep, runRenewalReminderSweep } from '../../../roboapply/services/RoboApplyBillingReminderService.js';

const NOW = new Date('2026-10-10T06:00:00.000Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000);
const sent: Array<{ to: string[]; subject: string; text: string }> = [];
let failNext = false;

function seed(subs: Record<string, unknown>[]) {
  for (const t of ['seekerSubscription', 'seekerProfile', 'user', 'notification', 'rAEmailLog']) fake.db[t].deleteMany({});
  subs.forEach((s, i) => {
    fake.db.user.create({ data: { id: `u_${i}`, email: `u${i}@example.test`, brand: s.brand ?? 'roboapply' } });
    fake.db.seekerProfile.create({ data: { id: `sp_${i}`, userId: `u_${i}`, locale: s.brand === 'goapply' ? 'zh' : 'en', deletedAt: null } });
    fake.db.seekerSubscription.create({
      data: { id: `sub_${i}`, seekerProfileId: `sp_${i}`, status: 'active', cancelAtPeriodEnd: false, currency: 'USD', amountMinor: 2499, ...s },
    });
  });
}

beforeEach(() => {
  sent.length = 0;
  failNext = false;
  vi.stubEnv('RESEND_API_KEY', 're_test');
  vi.stubEnv('CN_EMAIL_TRANSPORT', 'resend');
  vi.stubEnv('CN_EMAIL_FROM', 'noreply@mail.goapply.example');
  registerEmailTransport('resend', {
    name: 'resend',
    isConfigured: () => true,
    send: async (m) => {
      if (failNext) {
        failNext = false;
        return { ok: false, error: 'boom' };
      }
      sent.push({ to: m.to, subject: m.subject, text: m.text });
      return { ok: true, providerId: `re_${sent.length}` };
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEmailTransportsForTests();
});

describe('reminderFor', () => {
  it('picks the lead time per plan', () => {
    expect(reminderFor({ tier: 'pro', planKey: 'pro_weekly', interval: 'week', brand: 'roboapply', currency: 'USD', stripeSubscriptionId: 's' })).toEqual({ kind: 'auto', leadDays: 2 });
    expect(reminderFor({ tier: 'pro', planKey: 'pro_quarterly', interval: 'quarter', brand: 'roboapply', currency: 'USD', stripeSubscriptionId: 's' })).toEqual({ kind: 'auto', leadDays: 5 });
    expect(reminderFor({ tier: 'pro', planKey: 'pro_monthly', interval: 'pass', brand: 'goapply', currency: 'CNY', stripeSubscriptionId: null })).toEqual({ kind: 'pass', leadDays: 3 });
    expect(reminderFor({ tier: 'pro', planKey: 'pro_week_pass', interval: 'pass', brand: 'goapply', currency: 'CNY', stripeSubscriptionId: null })).toBeNull();
    expect(reminderFor({ tier: 'pro', planKey: 'pro_week_pass', interval: 'pass', brand: 'roboapply', currency: 'USD', stripeSubscriptionId: null })).toBeNull();
    expect(reminderFor({ tier: 'starter', planKey: null, interval: null, brand: null, currency: 'CNY', stripeSubscriptionId: null })).toEqual({ kind: 'pass', leadDays: 5 });
  });
});

describe('runRenewalReminderSweep', () => {
  it('sends 5 days before a monthly renewal, 2 before weekly, 3 before a GoApply pass, and logs each send', async () => {
    seed([
      { tier: 'pro', planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'st_a', currentPeriodEnd: inDays(4.5) },
      { tier: 'pro', planKey: 'pro_weekly', interval: 'week', stripeSubscriptionId: 'st_b', currentPeriodEnd: inDays(4.5) },
      { tier: 'pro', planKey: 'pro_weekly', interval: 'week', stripeSubscriptionId: 'st_c', currentPeriodEnd: inDays(1.5), amountMinor: 999 },
      { tier: 'pro', planKey: 'pro_monthly', interval: 'pass', brand: 'goapply', currency: 'CNY', amountMinor: 3900, currentPeriodEnd: inDays(2.5) },
      { tier: 'pro', planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'st_e', cancelAtPeriodEnd: true, currentPeriodEnd: inDays(3) },
    ]);
    const res = await runRenewalReminderSweep({ now: NOW });
    expect(res).toMatchObject({ scanned: 4, sent: 3, skipped: 1, failed: 0 });
    expect(sent.map((s) => s.to[0]).sort()).toEqual(['u0@example.test', 'u2@example.test', 'u3@example.test']);
    const monthly = sent.find((s) => s.to[0] === 'u0@example.test')!;
    expect(monthly.subject).toBe('Your RoboApply plan renews on October 14, 2026');
    expect(monthly.text).toContain('Pro Monthly renews automatically on October 14, 2026 for $24.99 every month.');
    expect(monthly.text).toContain('Cancel any time');
    const pass = sent.find((s) => s.to[0] === 'u3@example.test')!;
    expect(pass.subject).toContain('GoApply');
    // GoApply's default language is Simplified Chinese (WP-92): "it does not renew, nothing is charged".
    expect(pass.text).toContain('不会续费');
    expect(pass.text).not.toContain('does not renew');
    const logs = await fake.db.rAEmailLog.findMany({});
    expect(logs).toHaveLength(3);
    expect(logs.every((l: any) => l.template === 'billing.renewal_reminder' && l.status === 'sent')).toBe(true);
    expect(logs.map((l: any) => l.brand).sort()).toEqual(['goapply', 'roboapply', 'roboapply']);
  });

  it('quarterly reminders say "every 3 months"; a legacy pass reminder points to the current plans, not Pro', async () => {
    seed([
      { tier: 'pro', planKey: 'pro_quarterly', interval: 'quarter', stripeSubscriptionId: 'st_q', amountMinor: 5999, currentPeriodEnd: inDays(4.5) },
      { tier: 'starter', planKey: null, interval: null, currency: 'CNY', amountMinor: 1900, stripeSubscriptionId: null, currentPeriodEnd: inDays(4.5) },
    ]);
    expect(await runRenewalReminderSweep({ now: NOW })).toMatchObject({ sent: 2, failed: 0 });
    const quarterly = sent.find((m) => m.to[0] === 'u0@example.test')!;
    expect(quarterly.text).toContain('Pro Quarterly renews automatically on October 14, 2026 for $59.99 every 3 months.');
    const legacy = sent.find((m) => m.to[0] === 'u1@example.test')!;
    expect(legacy.text).toContain('Practice plan (legacy) ends on October 14, 2026. It does not renew and nothing will be charged.');
    expect(legacy.text).not.toMatch(/keep Pro|another pass/);
  });

  it('sends once per period, and a failed send is retried on the next run', async () => {
    seed([{ tier: 'pro', planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'st_a', currentPeriodEnd: inDays(4) }]);
    failNext = true;
    expect(await runRenewalReminderSweep({ now: NOW })).toMatchObject({ sent: 0, failed: 1 });
    expect(await runRenewalReminderSweep({ now: NOW })).toMatchObject({ sent: 1 });
    expect(await runRenewalReminderSweep({ now: NOW })).toMatchObject({ sent: 0, skipped: 1 });
    expect(sent).toHaveLength(1);
    const logs = await fake.db.rAEmailLog.findMany({});
    expect(logs.map((l: any) => l.status).sort()).toEqual(['failed', 'sent']);
  });
});

describe('annual reminder', () => {
  it('reminds a subscription running over 12 months once per year', async () => {
    seed([
      { tier: 'pro', planKey: 'pro_quarterly', interval: 'quarter', stripeSubscriptionId: 'st_a', startedAt: new Date('2025-09-01T00:00:00Z'), currentPeriodEnd: inDays(40), amountMinor: 5999 },
      { tier: 'pro', planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'st_b', startedAt: new Date('2026-03-01T00:00:00Z'), currentPeriodEnd: inDays(20) },
    ]);
    expect(await runAnnualReminderSweep({ now: NOW })).toMatchObject({ scanned: 1, sent: 1 });
    expect(await runAnnualReminderSweep({ now: NOW })).toMatchObject({ sent: 0, skipped: 1 });
    expect(sent[0]!.text).toContain('You have had Pro Quarterly since September 1, 2025. It renews every 3 months for $59.99.');
  });
});
