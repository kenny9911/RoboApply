// @vitest-environment node
// Deactivated / soft-deleted accounts and per-list unsubscribes (WP-39a review
// resolution): nothing non-transactional reaches an account that is being
// deleted, and a one-click unsubscribe removes the person from that list only.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../lib/prisma.js', () => ({
  get default() {
    return h.db;
  },
}));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../platform/brand/registry.js';
import type { SendEmailInput, SendEmailResult } from '../../platform/email/index.js';
import { NOTIFY_TEMPLATES } from '../../platform/email/templates/notify/index.js';
import { createPrismaEmailRecipientLoader } from '../notifications/workers.js';
import { deliverMessage, emailListFor, type DeliverDeps, type NotifyMessage } from './deliver.js';
import { notifyUserWith } from './notify.js';
import { createEmailPreferenceGate, createPrismaPreferencesRepo, isLiveAccount, type StoredNotificationPrefs } from './preferences.js';
import { createPrismaAlertsRepo, type Recipient } from './repo.js';

interface StubUser {
  id: string;
  brand: string;
  isActive: boolean;
  email: string;
  emailIsPlaceholder: boolean;
  seekerProfile: {
    id: string;
    deletedAt: Date | null;
    locale: string | null;
    timezone: string | null;
    notificationPreferences: unknown;
    market: string | null;
    weeklyNudgeOptOut: boolean;
    subscription: null;
  } | null;
  raProfile: null;
}

const user = (id: string, over: Partial<StubUser> = {}, deletedAt: Date | null = null): StubUser => ({
  id,
  brand: 'roboapply',
  isActive: true,
  email: `${id}@example.com`,
  emailIsPlaceholder: false,
  seekerProfile: { id: `sp-${id}`, deletedAt, locale: 'en', timezone: 'America/New_York', notificationPreferences: null, market: 'us', weeklyNudgeOptOut: false, subscription: null },
  raProfile: null,
  ...over,
});

const USERS = new Map<string, StubUser>([
  ['live', user('live')],
  ['deleted', user('deleted', {}, new Date('2026-10-01T00:00:00Z'))],
  ['inactive', user('inactive', { isActive: false })],
]);

beforeEach(() => {
  h.db = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => USERS.get(where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.flatMap((id) => (USERS.has(id) ? [USERS.get(id)!] : [])),
    },
    seekerConsentRecord: { findMany: async () => [] },
  };
});

const reminderInput = {
  templateKey: NOTIFY_TEMPLATES.followUpReminder,
  params: { entryId: 'e1', title: 'Engineer', company: 'Acme', appliedAt: '2026-09-30T10:00:00Z', days: 10 },
  href: '/applications?entry=e1',
  category: 'reminder' as const,
  now: new Date('2026-10-10T16:00:00Z'), // 12:00 New York
};

describe('deactivated and soft-deleted accounts get no reminders', () => {
  it('isLiveAccount: inactive or soft-deleted is not live', () => {
    expect(isLiveAccount(USERS.get('live'))).toBe(true);
    expect(isLiveAccount(USERS.get('deleted'))).toBe(false);
    expect(isLiveAccount(USERS.get('inactive'))).toBe(false);
    expect(isLiveAccount(null)).toBe(false);
  });

  it('the preferences loader and the recipients query leave them out', async () => {
    const prefs = createPrismaPreferencesRepo();
    expect(await prefs.load('live')).toMatchObject({ userId: 'live', brand: 'roboapply' });
    expect(await prefs.load('deleted')).toBeNull();
    expect(await prefs.load('inactive')).toBeNull();
    const recipients = await createPrismaAlertsRepo().recipients(['live', 'deleted', 'inactive']);
    expect([...recipients.keys()]).toEqual(['live']);
  });

  it('the platform email gate refuses every list for them', async () => {
    const gate = createEmailPreferenceGate(createPrismaPreferencesRepo());
    const input = (userId: string, list: 'alerts' | 'reminders') => ({ brand: getBrand('roboapply'), userId, email: 'x@example.com', category: 'alert' as const, list, template: 'notify.x' });
    expect(await gate(input('live', 'reminders'))).toBe(true);
    for (const id of ['deleted', 'inactive']) {
      expect(await gate(input(id, 'reminders'))).toBe(false);
      expect(await gate(input(id, 'alerts'))).toBe(false);
    }
  });

  it('notifyUser answers skipped: no_user and delivers nothing', async () => {
    const sent: NotifyMessage[] = [];
    const deps = {
      repo: createPrismaAlertsRepo(),
      prefs: createPrismaPreferencesRepo(),
      deliver: async (msg: NotifyMessage) => (sent.push(msg), { notificationId: 'n1', email: null, channels: {} }),
    };
    for (const id of ['deleted', 'inactive']) {
      expect(await notifyUserWith({ ...reminderInput, userId: id }, deps)).toEqual({ status: 'skipped', reason: 'no_user' });
    }
    expect(sent).toHaveLength(0);
    expect((await notifyUserWith({ ...reminderInput, userId: 'live' }, deps)).status).toBe('delivered');
  });

  it('the email.send loader marks them inactive (the worker then sends transactional mail only)', async () => {
    const load = createPrismaEmailRecipientLoader();
    expect(await load('live', 'roboapply')).toMatchObject({ active: true, email: 'live@example.com' });
    expect(await load('deleted', 'roboapply')).toMatchObject({ active: false });
    expect(await load('inactive', 'roboapply')).toMatchObject({ active: false });
    expect(await load('missing', 'roboapply')).toBeNull();
  });
});

describe('one-click unsubscribe removes the person from that list only', () => {
  const recipient: Recipient = { userId: 'u1', brand: 'roboapply', email: 'u1@example.com', locale: 'en', timeZone: 'UTC', seekerProfileId: 'sp1' };
  const job = { id: 'j1', title: 'Engineer', company: 'Acme', place: null, remote: true, pay: null, tier: 'good', gap: null, href: '/jobs/j1' };

  function run(prefs: StoredNotificationPrefs, templateKey: string, params: Record<string, unknown>) {
    const emails: SendEmailInput[] = [];
    const deps: DeliverDeps = {
      createInApp: async () => ({ id: 'n1' }),
      markEmailed: async () => undefined,
      sendEmail: async (input): Promise<SendEmailResult> => (emails.push(input), { status: 'sent' }),
      channels: () => [],
      emailEnabled: () => true,
    };
    return deliverMessage({ recipient, kind: 'instant', category: 'alert', templateKey, params, href: '/jobs', prefs }, deps).then(() => emails);
  }

  it('each alert template has its own list', () => {
    expect(emailListFor(NOTIFY_TEMPLATES.jobAlertInstant)).toBe('alerts');
    expect(emailListFor(NOTIFY_TEMPLATES.jobAlertDigest)).toBe('digest');
    expect(emailListFor(NOTIFY_TEMPLATES.welcome)).toBe('reminders');
  });

  it('a digest unsubscribe keeps instant alert emails, and the other way round', async () => {
    const instant = { search: 'Data', jobs: [job] };
    const digest = { search: 'Data', cadence: 'daily', jobs: [job], moreCount: 0 };
    const noDigest = { unsubscribed: { digest: '2026-10-01T00:00:00Z' } };
    const noInstant = { unsubscribed: { alerts: '2026-10-01T00:00:00Z' } };
    expect(await run(noDigest, NOTIFY_TEMPLATES.jobAlertInstant, instant)).toHaveLength(1);
    expect(await run(noDigest, NOTIFY_TEMPLATES.jobAlertDigest, digest)).toHaveLength(0);
    expect(await run(noInstant, NOTIFY_TEMPLATES.jobAlertDigest, digest)).toHaveLength(1);
    expect(await run(noInstant, NOTIFY_TEMPLATES.jobAlertInstant, instant)).toHaveLength(0);
  });
});
