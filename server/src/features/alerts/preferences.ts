// server/src/features/alerts/preferences.ts
//
// Who may get which message (PRODUCT §7.1; TASK_PLAN.md §2.2 "Messages").
//
//   - "Tips and reminders" (PRODUCT §7.3 rows 5, 6, 10 and the former Friday
//     practice nudge) go out only when that preference is on. It is the
//     `tips_reminders` consent record (latest row wins); with no record the
//     regional default applies: OFF for GoApply and for people in the EEA,
//     the UK, Switzerland and Canada (ePrivacy, CASL, PRC Advertising Law
//     Art. 43), OFF when we do not know the country, ON elsewhere.
//   - Alerts, digests and reminders follow the per-category channel choice
//     WP-39b stores in `SeekerProfile.notificationPreferences`
//     (`channels: { alert: ['email', …], reminder: [...] }`), plus the legacy
//     keys (`matchAlerts`, `applicationUpdates`) and a one-click unsubscribe
//     record (`unsubscribed: { <list>: <iso> }`) when present.
//   - Product news needs the `marketing_email` opt-in.
//
// `createEmailPreferenceGate()` turns this into the platform email gate
// (`setEmailPreferenceGate`, FND-3): until it is installed every
// non-transactional email is suppressed.

import type { BrandId, ProductBrand } from '../../platform/brand/registry.js';
import { setEmailPreferenceGate, type EmailPreferenceGate } from '../../platform/email/index.js';
import { logger } from '../../services/LoggerService.js';
import { normalizeQuietHours, resolveTimeZone, type QuietHours } from './time.js';

/** Countries where "Tips and reminders" starts OFF: EU 27 + IS, LI, NO (EEA) + UK + CH + CA. */
export const TIPS_DEFAULT_OFF_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB', 'CH', 'CA',
]);

/**
 * The regional default of "Tips and reminders" (no stored choice).
 * `country` is ISO alpha-2, or 'EU' for a person we only know is in the EU.
 */
export function tipsRemindersDefault(brand: BrandId | Pick<ProductBrand, 'id' | 'market'>, country: string | null | undefined): boolean {
  const market = typeof brand === 'string' ? (brand === 'goapply' ? 'cn' : 'intl') : brand.market;
  if (market === 'cn') return false;
  const c = (country ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return false;
  if (c === 'EU' || c === 'UK') return false;
  return !TIPS_DEFAULT_OFF_COUNTRIES.has(c);
}

export const PREF_CATEGORIES = ['alert', 'reminder', 'tips', 'marketing'] as const;
export type PrefCategory = (typeof PREF_CATEGORIES)[number];
export type PrefChannel = 'email' | 'in_app' | 'push' | 'wechat';

/** What WP-39b stores in `SeekerProfile.notificationPreferences` (every key optional). */
export interface StoredNotificationPrefs {
  channels?: Partial<Record<string, PrefChannel[]>>;
  quietHours?: QuietHours;
  /** One-click unsubscribes by list (`alerts`, `digest`, `reminders`, `tips`, `marketing`) → ISO time. */
  unsubscribed?: Partial<Record<string, string>>;
  /** Legacy shape (pre-clone): `{ matchAlerts, applicationUpdates, weeklyDigest }`. */
  matchAlerts?: boolean;
  applicationUpdates?: boolean;
  weeklyDigest?: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Lenient read of the stored JSON: unknown keys and malformed values are ignored. */
export function parseStoredPrefs(raw: unknown): StoredNotificationPrefs {
  if (!isObj(raw)) return {};
  const out: StoredNotificationPrefs = {};
  if (isObj(raw.channels)) {
    const channels: Record<string, PrefChannel[]> = {};
    for (const [k, v] of Object.entries(raw.channels)) {
      if (Array.isArray(v)) channels[k] = v.filter((c): c is PrefChannel => c === 'email' || c === 'in_app' || c === 'push' || c === 'wechat');
    }
    out.channels = channels;
  }
  if (isObj(raw.quietHours) && typeof raw.quietHours.start === 'string' && typeof raw.quietHours.end === 'string') {
    out.quietHours = normalizeQuietHours({ start: raw.quietHours.start, end: raw.quietHours.end });
  }
  if (isObj(raw.unsubscribed)) {
    const u: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.unsubscribed)) if (typeof v === 'string' || v === true) u[k] = String(v);
    out.unsubscribed = u;
  }
  for (const k of ['matchAlerts', 'applicationUpdates', 'weeklyDigest'] as const) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k] as boolean;
  }
  return out;
}

/** Which unsubscribe lists a category's email belongs to. */
const LISTS_FOR: Record<PrefCategory, string[]> = {
  alert: ['alerts', 'digest'],
  reminder: ['reminders'],
  tips: ['tips'],
  marketing: ['marketing'],
};

/** Whether the person allows `channel` for `category` (default: yes, except where noted). */
export function channelAllowed(prefs: StoredNotificationPrefs, category: PrefCategory, channel: PrefChannel, list?: string): boolean {
  const chosen = prefs.channels?.[category];
  if (Array.isArray(chosen) && !chosen.includes(channel)) return false;
  if (channel === 'email') {
    const lists = list ? [list] : LISTS_FOR[category];
    if (lists.some((l) => prefs.unsubscribed?.[l])) return false;
    if (category === 'alert' && prefs.matchAlerts === false) return false;
    if (category === 'reminder' && prefs.applicationUpdates === false) return false;
  }
  return true;
}

/** Everything the gates need about one person. */
export interface PreferenceFacts {
  userId: string;
  brand: BrandId;
  /** Latest `tips_reminders` record, or null when they never chose. */
  tipsGranted: boolean | null;
  /** Latest `marketing_email` record, or null. */
  marketingGranted: boolean | null;
  /** ISO alpha-2 (or 'EU'), or null when unknown. */
  country: string | null;
  prefs: StoredNotificationPrefs;
  /** IANA zone (already resolved with the brand fallback). */
  timeZone: string;
  quietHours: QuietHours;
  /** Legacy `SeekerProfile.weeklyNudgeOptOut`: the person turned off the old Friday practice nudge (honoured by the practice tip). */
  practiceNudgeOptOut?: boolean;
}

export function tipsEnabled(facts: Pick<PreferenceFacts, 'brand' | 'tipsGranted' | 'country' | 'prefs'>): boolean {
  if (facts.prefs.unsubscribed?.tips) return false;
  return facts.tipsGranted ?? tipsRemindersDefault(facts.brand, facts.country);
}

/** Whether a message of this category may reach the person at all (any channel). */
export function categoryAllowed(facts: PreferenceFacts, category: PrefCategory): boolean {
  if (category === 'tips') return tipsEnabled(facts);
  if (category === 'marketing') return facts.marketingGranted === true;
  return true;
}

export interface PreferencesRepo {
  load(userId: string): Promise<PreferenceFacts | null>;
}

// ── Prisma implementation ────────────────────────────────────────────────

async function db() {
  return (await import('../../lib/prisma.js')).default;
}

const MARKET_COUNTRY: Record<string, string> = { us: 'US', cn: 'CN', tw: 'TW', jp: 'JP', eu: 'EU' };

async function countryCode(...values: Array<string | null | undefined>): Promise<string | null> {
  const { resolveCountry } = await import('../jobs/geo/index.js');
  for (const v of values) {
    if (!v || !v.trim()) continue;
    const c = resolveCountry(v);
    if (c) return c.code;
  }
  return null;
}

/** False for a deactivated account or a soft-deleted seeker profile (no non-transactional message goes there). */
export function isLiveAccount<T extends { isActive: boolean; seekerProfile?: { deletedAt: Date | null } | null }>(user: T | null | undefined): user is T {
  if (!user || user.isActive === false) return false;
  return !user.seekerProfile?.deletedAt;
}

export function createPrismaPreferencesRepo(): PreferencesRepo {
  return {
    async load(userId) {
      const p = await db();
      const user = await p.user.findUnique({
        where: { id: userId },
        select: {
          brand: true,
          isActive: true,
          seekerProfile: {
            select: {
              id: true,
              deletedAt: true,
              notificationPreferences: true,
              timezone: true,
              market: true,
              weeklyNudgeOptOut: true,
              subscription: { select: { billingCountry: true } },
            },
          },
          raProfile: { select: { country: true } },
        },
      });
      // A deactivated or deleted account (deletedAt is stamped ~30 days before the purge) gets nothing:
      // the gate refuses and notifyUser answers `skipped: no_user`.
      if (!isLiveAccount(user)) return null;
      const brand: BrandId = user.brand === 'goapply' ? 'goapply' : 'roboapply';
      const sp = user.seekerProfile;
      let tipsGranted: boolean | null = null;
      let marketingGranted: boolean | null = null;
      if (sp) {
        const rows = await p.seekerConsentRecord.findMany({
          where: { seekerProfileId: sp.id, consentType: { in: ['tips_reminders', 'marketing_email'] } },
          orderBy: { createdAt: 'desc' },
          select: { consentType: true, granted: true },
          take: 20,
        });
        for (const r of rows) {
          if (r.consentType === 'tips_reminders' && tipsGranted === null) tipsGranted = r.granted;
          if (r.consentType === 'marketing_email' && marketingGranted === null) marketingGranted = r.granted;
        }
      }
      const marketCountry = sp?.market ? MARKET_COUNTRY[sp.market] ?? null : null;
      const country = (await countryCode(user.raProfile?.country, sp?.subscription?.billingCountry)) ?? marketCountry;
      const prefs = parseStoredPrefs(sp?.notificationPreferences);
      return {
        userId,
        brand,
        tipsGranted,
        marketingGranted,
        country,
        prefs,
        timeZone: resolveTimeZone(sp?.timezone, brand),
        quietHours: normalizeQuietHours(prefs.quietHours),
        practiceNudgeOptOut: sp?.weeklyNudgeOptOut === true,
      };
    },
  };
}

// ── The platform email gate ──────────────────────────────────────────────

const LIST_CATEGORY: Record<string, PrefCategory> = {
  alerts: 'alert',
  digest: 'alert',
  reminders: 'reminder',
  tips: 'tips',
  marketing: 'marketing',
};

/**
 * The email preference gate. Without an account (logged-out alerts, WP-78's
 * double-opt-in subscriptions) only the alert lists pass; WP-78 checks its
 * own subscription status before sending.
 */
export function createEmailPreferenceGate(repo: PreferencesRepo = createPrismaPreferencesRepo()): EmailPreferenceGate {
  return async ({ userId, list }) => {
    const category = LIST_CATEGORY[list] ?? 'marketing';
    if (!userId) return category === 'alert';
    const facts = await repo.load(userId);
    if (!facts) return false;
    if (!categoryAllowed(facts, category)) return false;
    return channelAllowed(facts.prefs, category, 'email', list);
  };
}

let installed = false;

/** Install the gate once per process (idempotent). Called by the email worker and the crons on import. */
export function installEmailPreferenceGate(repo?: PreferencesRepo): void {
  if (installed && !repo) return;
  setEmailPreferenceGate(createEmailPreferenceGate(repo));
  installed = true;
  logger.debug('NOTIFY', 'email preference gate installed');
}

/** Tests only. */
export function resetEmailPreferenceGateForTests(): void {
  installed = false;
  setEmailPreferenceGate(null);
}
