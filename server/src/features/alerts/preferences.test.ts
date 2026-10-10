// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import {
  categoryAllowed,
  channelAllowed,
  createEmailPreferenceGate,
  createPrismaPreferencesRepo,
  parseStoredPrefs,
  tipsEnabled,
  tipsRemindersDefault,
  type PreferenceFacts,
} from './preferences.js';
import { getBrand } from '../../platform/brand/registry.js';
import { inQuietHours, normalizeQuietHours } from './time.js';
import { tipsRemindersDefault as centerTipsDefault } from '../notifications/contract.js';

const facts = (over: Partial<PreferenceFacts> = {}): PreferenceFacts => ({
  userId: 'u1',
  brand: 'roboapply',
  tipsGranted: null,
  marketingGranted: null,
  country: 'US',
  prefs: {},
  timeZone: 'UTC',
  quietHours: { start: '21:00', end: '08:00' },
  ...over,
});

describe('"Tips and reminders" regional default', () => {
  it.each([
    ['US', true],
    ['TW', true],
    ['JP', true],
    ['DE', false],
    ['FR', false],
    ['NO', false],
    ['GB', false],
    ['CH', false],
    ['CA', false],
    ['EU', false],
    [null, false], // unknown country: off (privacy first)
  ])('RoboApply in %s → %s', (country, expected) => {
    expect(tipsRemindersDefault('roboapply', country)).toBe(expected);
  });

  it('GoApply is always off by default (PRC Advertising Law Art. 43)', () => {
    expect(tipsRemindersDefault('goapply', 'US')).toBe(false);
    expect(tipsRemindersDefault(getBrand('goapply'), 'CN')).toBe(false);
  });

  it('a recorded choice wins over the default; a tips unsubscribe turns it off', () => {
    expect(tipsEnabled(facts({ country: 'DE', tipsGranted: true }))).toBe(true);
    expect(tipsEnabled(facts({ country: 'US', tipsGranted: false }))).toBe(false);
    expect(tipsEnabled(facts({ country: 'US' }))).toBe(true);
    expect(tipsEnabled(facts({ country: 'US', prefs: { unsubscribed: { tips: '2026-10-01' } } }))).toBe(false);
    expect(tipsEnabled(facts({ brand: 'goapply', country: 'CN' }))).toBe(false);
    expect(tipsEnabled(facts({ brand: 'goapply', country: 'CN', tipsGranted: true }))).toBe(true);
  });
});

describe('stored notification preferences', () => {
  it('reads channels, quiet hours, unsubscribes and the legacy keys; ignores junk', () => {
    const p = parseStoredPrefs({
      channels: { alert: ['in_app', 'bogus'], reminder: ['email', 'in_app'] },
      quietHours: { start: '22:00', end: '07:00' },
      unsubscribed: { digest: '2026-10-01T00:00:00Z' },
      matchAlerts: true,
      extra: 1,
    });
    expect(p).toEqual({
      channels: { alert: ['in_app'], reminder: ['email', 'in_app'] },
      quietHours: { start: '22:00', end: '07:00' },
      unsubscribed: { digest: '2026-10-01T00:00:00Z' },
      matchAlerts: true,
    });
    expect(parseStoredPrefs('nope')).toEqual({});
  });

  it('channel choices, list unsubscribes and the legacy switches block email', () => {
    expect(channelAllowed({}, 'alert', 'email')).toBe(true);
    expect(channelAllowed({ channels: { alert: ['in_app'] } }, 'alert', 'email')).toBe(false);
    expect(channelAllowed({ channels: { alert: ['in_app'] } }, 'alert', 'in_app')).toBe(true);
    expect(channelAllowed({ unsubscribed: { digest: 'x' } }, 'alert', 'email', 'digest')).toBe(false);
    expect(channelAllowed({ unsubscribed: { digest: 'x' } }, 'alert', 'email', 'alerts')).toBe(true);
    expect(channelAllowed({ matchAlerts: false }, 'alert', 'email')).toBe(false);
    expect(channelAllowed({ applicationUpdates: false }, 'reminder', 'email')).toBe(false);
  });

  it('marketing needs the opt-in', () => {
    expect(categoryAllowed(facts(), 'marketing')).toBe(false);
    expect(categoryAllowed(facts({ marketingGranted: true }), 'marketing')).toBe(true);
  });
});

describe('the platform email preference gate', () => {
  const gateFor = (f: PreferenceFacts | null) => createEmailPreferenceGate({ load: async () => f });
  const input = (list: 'alerts' | 'digest' | 'tips' | 'marketing' | 'reminders', userId: string | null = 'u1') => ({
    brand: getBrand('roboapply'),
    userId,
    email: 'a@example.com',
    category: (list === 'tips' ? 'tips' : list === 'marketing' ? 'marketing' : 'alert') as 'tips' | 'marketing' | 'alert',
    list,
    template: 'notify.x',
  });

  it('tips go only with the preference on (per region default)', async () => {
    expect(await gateFor(facts({ country: 'US' }))(input('tips'))).toBe(true);
    expect(await gateFor(facts({ country: 'DE' }))(input('tips'))).toBe(false);
    expect(await gateFor(facts({ brand: 'goapply', country: 'CN' }))(input('tips'))).toBe(false);
  });

  it('alerts and reminders follow the channel choice; marketing needs consent', async () => {
    expect(await gateFor(facts())(input('alerts'))).toBe(true);
    expect(await gateFor(facts({ prefs: { channels: { reminder: ['in_app'] } } }))(input('reminders'))).toBe(false);
    expect(await gateFor(facts())(input('marketing'))).toBe(false);
  });

  it('without an account only the alert lists pass; an unknown account gets nothing', async () => {
    expect(await gateFor(null)(input('alerts', null))).toBe(true);
    expect(await gateFor(null)(input('tips', null))).toBe(false);
    expect(await gateFor(null)(input('alerts'))).toBe(false);
  });
});

describe('Settings (WP-39b `notificationPreferences.center`) drive the senders', () => {
  /** A prisma double for `createPrismaPreferencesRepo().load` (the module mock above is `{}`). */
  async function loadWith(notificationPreferences: unknown, over: { raCountry?: string | null; market?: string | null; billingCountry?: string | null } = {}) {
    const prisma = (await import('../../lib/prisma.js')).default as unknown as Record<string, unknown>;
    prisma.user = {
      findUnique: async () => ({
        brand: 'roboapply',
        isActive: true,
        seekerProfile: {
          id: 'sp1',
          deletedAt: null,
          notificationPreferences,
          timezone: 'America/New_York',
          market: over.market ?? null,
          weeklyNudgeOptOut: false,
          subscription: over.billingCountry ? { billingCountry: over.billingCountry } : null,
        },
        raProfile: { country: over.raCountry ?? null },
      }),
    };
    prisma.seekerConsentRecord = { findMany: async () => [] };
    return (await createPrismaPreferencesRepo().load('u1'))!;
  }

  it('center channels, quiet hours and unsubscribes win over the root keys (unsubscribes from both count)', () => {
    const p = parseStoredPrefs({
      channels: { alert: ['email', 'in_app'], reminder: ['email'] },
      quietHours: { start: '20:00', end: '09:00' },
      unsubscribed: { tips: '2026-09-01T00:00:00Z' },
      center: {
        v: 1,
        channels: { alert: ['in_app', 'push'] },
        quietHours: { start: '23:00', end: '07:00' },
        unsubscribed: { digest: '2026-10-01T00:00:00Z' },
        regionCountry: 'us',
      },
    });
    expect(p.channels).toEqual({ alert: ['in_app', 'push'], reminder: ['email'] });
    expect(p.quietHours).toEqual({ start: '23:00', end: '07:00' });
    expect(p.unsubscribed).toEqual({ tips: '2026-09-01T00:00:00Z', digest: '2026-10-01T00:00:00Z' });
    expect(p.regionCountry).toBe('US');
    expect(channelAllowed(p, 'alert', 'email')).toBe(false);
    expect(channelAllowed(p, 'alert', 'push')).toBe(true);
  });

  it('quiet hours set in Settings (23:00–07:00) defer at 23:30 local, not at 22:30 (the 21:00 default would)', async () => {
    const f = await loadWith({ center: { v: 1, quietHours: { start: '23:00', end: '07:00' } } });
    expect(f.quietHours).toEqual({ start: '23:00', end: '07:00' });
    // America/New_York is UTC-4 in October.
    expect(inQuietHours(new Date('2026-10-11T02:30:00Z'), f.timeZone, f.quietHours)).toBe(false); // 22:30 local
    expect(inQuietHours(new Date('2026-10-11T03:30:00Z'), f.timeZone, f.quietHours)).toBe(true); // 23:30 local
    expect(inQuietHours(new Date('2026-10-11T02:30:00Z'), f.timeZone, normalizeQuietHours(undefined))).toBe(true);
  });

  it('a US regionCountry gives "Tips and reminders" ON in both areas; a DE one OFF in both, whatever the UI-language market', async () => {
    const us = await loadWith({ center: { v: 1, regionCountry: 'US' } });
    expect(us.country).toBe('US');
    expect(tipsEnabled(us)).toBe(true);
    expect(centerTipsDefault({ market: 'intl', country: 'US' })).toBe(true);

    const de = await loadWith({ center: { v: 1, regionCountry: 'DE' } }, { market: 'us' });
    expect(de.country).toBe('DE');
    expect(tipsEnabled(de)).toBe(false);
    expect(centerTipsDefault({ market: 'intl', country: 'DE' })).toBe(false);
  });
});
