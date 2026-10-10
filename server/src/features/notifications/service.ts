// server/src/features/notifications/service.ts
//
// The message center over `SeekerNotification` and the notification settings
// (ARCHITECTURE.md §8.3; PRODUCT_PLAN.md §7.1; TASK_PLAN.md WP-39b).
//
//   list / unreadCount / markRead / markAllRead / respond   (inbox)
//   getPreferences / patchPreferences                       (/settings#notifications)
//   allowsEmail                                             (the email preference gate WP-39a registers)
//   create                                                  (producer helper; producers may also write rows directly)
//
// Rows belong to a seeker profile (`seekerProfileId` is always set; `userId`
// is a denormalized copy that legacy rows lack), so every inbox query is
// scoped by the profile. Legacy auto-apply / recruiter-activity rows are never
// shown (HIDDEN_LEGACY_TYPES).
//
// Settings live in `SeekerProfile.notificationPreferences.center` (JSON; the
// legacy keys beside it are kept). "Tips and reminders" is the
// `tips_reminders` consent record; without one the regional default applies
// (off for GoApply, EEA/UK/CH/CA and unknown countries; on elsewhere). The
// country is the profile's own (RAProfile.country); else 'DE' for the legacy
// 'eu' market (it can only turn the default off); else the edge country stored
// the first time it was seen (`center.regionCountry`: settings, the unread-count
// poll, or `rememberRegion()` from auth); else the request's edge country —
// persisted then, so the email gate (which has no request) resolves the same
// default as the settings page. The legacy market is otherwise ignored: it was
// set from the UI language (ja → 'jp', zh-TW → 'tw'), not from where the person is.

import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { isEnabled } from '../../platform/flags.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import type { EmailPreferenceGate, UnsubscribeList } from '../../platform/email/index.js';
import { hashEmail } from '../../platform/email/index.js';
import {
  CONSENT_PROSE_VERSION,
  consentProseHash,
  findConsentDefinition,
  recordConsent,
  resolveConsentProse,
  type ConsentDefinition,
} from '../compliance/index.js';
import { logger } from '../../services/LoggerService.js';
import {
  CONFIGURABLE_CATEGORIES,
  DEFAULT_QUIET_HOURS,
  HIDDEN_LEGACY_TYPES,
  IN_APP_ONLY_CATEGORIES,
  LOCKED_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATIONS_ERROR_CODES,
  STORED_CATEGORY_MAP,
  categoryOf,
  tipsRemindersDefault,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferencesPatch,
  type NotificationPreferencesView,
  type NotificationView,
  type NotificationsResponse,
  type StoredNotificationCenter,
} from './contract.js';

export type NotificationsDb = Pick<
  typeof prisma,
  'seekerNotification' | 'seekerProfile' | 'seekerConsentRecord' | 'user' | 'rAProfile' | 'rAAnonAlertSubscription' | 'rAPersonalInfoRequest' | '$transaction'
>;

/** Which channels this account may use on this brand. */
export interface ChannelCapabilities {
  /** `notify.email` is on for the brand. */
  email: boolean;
  /** `webPush` (WP-61). */
  push: boolean;
  /** `notify.wechat` (WP-73). */
  wechat: boolean;
  /** `invitations` (recruiter invitations; Later). */
  invitations: boolean;
  /** `jobs.alerts` (off on GoApply while CN_RECRUITMENT_INFO_MODE=off): no alert is ever sent. */
  alerts: boolean;
}

/** `userId` is null for a logged-out alert subscription. */
export type CapabilityResolver = (userId: string | null, brand: ProductBrand) => Promise<ChannelCapabilities>;

export interface NotificationServiceDeps {
  db?: NotificationsDb;
  env?: EnvSource;
  now?: () => Date;
  capabilities?: CapabilityResolver;
}

export interface ProfileRef {
  /** SeekerProfile.id */
  id: string;
  userId: string;
}

export interface PreferenceContext extends ProfileRef {
  brand: ProductBrand;
  /** Edge country of the request (`x-vercel-ip-country`), when known. */
  requestCountry?: string | null;
  locale?: string | null;
}

export const DEFAULT_PAGE_SIZE = 20;
const FEEDBACK_KEEP = 5;
const TIPS_CONSENT = 'tips_reminders';
const MARKETING_CONSENT = 'marketing_email';

/**
 * The legacy 'eu' market (SeekerProfile.market) stands for an EEA country.
 * It is the only market used for the regional default, because it can only
 * turn the default off; the others came from the UI language.
 */
const EU_MARKET_COUNTRY = 'DE';

/** Profiles whose edge country this process already offered to `rememberRegion` (bounded). */
const REMEMBERED = new Set<string>();
const REMEMBERED_MAX = 10_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normCountry(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = v.trim().toUpperCase();
  if (c === 'UK') return 'GB';
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

// ── Cursor (createdAt desc, id desc) ────────────────────────────────────

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.getTime().toString(36)}.${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const dot = raw.indexOf('.');
    if (dot <= 0) return null;
    const ms = parseInt(raw.slice(0, dot), 36);
    const id = raw.slice(dot + 1);
    if (!Number.isFinite(ms) || !id) return null;
    return { createdAt: new Date(ms), id };
  } catch {
    return null;
  }
}

// ── Stored settings (pure) ──────────────────────────────────────────────

/** Tolerant read of `notificationPreferences.center`. */
export function readCenter(raw: unknown): StoredNotificationCenter {
  const root = isObject(raw) ? raw : {};
  const src = isObject(root.center) ? root.center : {};
  const out: StoredNotificationCenter = { v: 1 };
  if (isObject(src.channels)) {
    const channels: StoredNotificationCenter['channels'] = {};
    for (const [cat, list] of Object.entries(src.channels)) {
      if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(cat) || !Array.isArray(list)) continue;
      channels[cat as NotificationCategory] = normalizeChannelList(list);
    }
    out.channels = channels;
  }
  if (isObject(src.quietHours) && typeof src.quietHours.start === 'string' && typeof src.quietHours.end === 'string') {
    out.quietHours = { start: src.quietHours.start, end: src.quietHours.end };
  }
  const region = normCountry(src.regionCountry);
  if (region) out.regionCountry = region;
  if (isObject(src.unsubscribed)) {
    const u: Record<string, string> = {};
    for (const [k, v] of Object.entries(src.unsubscribed)) if (typeof v === 'string') u[k] = v;
    out.unsubscribed = u;
  }
  if (Array.isArray(src.feedback)) {
    out.feedback = src.feedback
      .filter((f): f is { list: string; reason: string; note?: string; at: string } => isObject(f) && typeof f.list === 'string' && typeof f.reason === 'string' && typeof f.at === 'string')
      .slice(-FEEDBACK_KEEP);
  }
  return out;
}

/** Write `center` back next to the legacy keys. */
export function writeCenter(raw: unknown, center: StoredNotificationCenter): Prisma.InputJsonValue {
  const root = isObject(raw) ? { ...raw } : {};
  root.center = center;
  return root as unknown as Prisma.InputJsonValue;
}

/** Unique known channels, `in_app` first and always present. */
export function normalizeChannelList(list: readonly unknown[]): NotificationChannel[] {
  const set = new Set<NotificationChannel>(['in_app']);
  for (const c of list) if ((NOTIFICATION_CHANNELS as readonly unknown[]).includes(c)) set.add(c as NotificationChannel);
  return [...set];
}

/** Channels the account can receive: in-app always; email/push/wechat by capability (email also needs a real address). */
export function availableChannels(caps: ChannelCapabilities, hasRealEmail: boolean): NotificationChannel[] {
  const out: NotificationChannel[] = ['in_app'];
  if (caps.email && hasRealEmail) out.push('email');
  if (caps.push) out.push('push');
  if (caps.wechat) out.push('wechat');
  return out;
}

/** Why email is not offered ('not_offered' wins: adding an address would not help). */
export function emailUnavailableReason(caps: ChannelCapabilities, hasRealEmail: boolean): 'no_address' | 'not_offered' | null {
  if (!caps.email) return 'not_offered';
  if (!hasRealEmail) return 'no_address';
  return null;
}

/** Categories with channel choices: 'alert' needs `jobs.alerts`, 'invitation' needs `invitations`. */
export function configurableCategoriesFor(caps: ChannelCapabilities): NotificationCategory[] {
  return CONFIGURABLE_CATEGORIES.filter((c) => (c !== 'invitation' || caps.invitations) && (c !== 'alert' || caps.alerts));
}

function hasRealEmailOf(user: { email: string | null; emailIsPlaceholder: boolean | null } | null | undefined): boolean {
  return !!user?.email && !user.emailIsPlaceholder && !user.email.endsWith('.invalid');
}

/**
 * The "Tips and reminders" consent text shown next to the switch, and its hash.
 * From the brand's catalog entry; GoApply (until WP-13 adds its own entry)
 * gets the RoboApply English text with the brand name, so what is shown and
 * what the record hashes are always the same text.
 */
export function tipsConsentProse(brand: ProductBrand, locale: string | null | undefined): { text: string; locale: 'en' | 'zh'; version: string; hash: string } {
  const own = findConsentDefinition(brand.id, 'tips_reminders');
  if (own) return resolveConsentProse(own, brand, locale);
  const fallback = findConsentDefinition('roboapply', 'tips_reminders');
  const text = (fallback?.prose.en ?? '').split('%BRAND%').join(brand.name);
  return {
    text,
    locale: 'en',
    version: CONSENT_PROSE_VERSION,
    hash: consentProseHash({ brand: brand.id, type: 'tips_reminders', version: CONSENT_PROSE_VERSION, locale: 'en', text }),
  };
}

/**
 * Effective channels per category: stored choices (configurable categories),
 * else the default (every available channel except push/wechat, which are
 * opt-in per device or subscription); locked categories get every available
 * channel; announcements are in-app only. Unavailable channels are dropped.
 */
export function effectiveChannels(
  center: StoredNotificationCenter,
  available: readonly NotificationChannel[],
  legacy: { matchAlerts?: unknown } = {},
): Record<NotificationCategory, NotificationChannel[]> {
  const avail = new Set(available);
  const defaults = available.filter((c) => c === 'in_app' || c === 'email');
  const out = {} as Record<NotificationCategory, NotificationChannel[]>;
  for (const cat of NOTIFICATION_CATEGORIES) {
    if ((LOCKED_CATEGORIES as readonly string[]).includes(cat)) {
      out[cat] = [...available];
      continue;
    }
    if ((IN_APP_ONLY_CATEGORIES as readonly string[]).includes(cat)) {
      out[cat] = ['in_app'];
      continue;
    }
    const stored = center.channels?.[cat];
    let base: NotificationChannel[];
    if (stored) base = stored;
    else if (cat === 'alert' && legacy.matchAlerts === false) base = ['in_app'];
    else base = defaults;
    out[cat] = normalizeChannelList(base).filter((c) => avail.has(c));
  }
  return out;
}

/** The unsubscribe lists a category's email channel answers to. */
const LISTS_FOR_CATEGORY: Readonly<Record<string, readonly UnsubscribeList[]>> = {
  alert: ['alerts', 'digest'],
  reminder: ['reminders'],
  tips: ['tips'],
};

/** Turning email back on in settings forgets the matching unsubscribe marks. */
function clearUnsubscribed(center: StoredNotificationCenter, lists: readonly string[]): void {
  if (!center.unsubscribed) return;
  const next = { ...center.unsubscribed };
  for (const l of lists) delete next[l];
  center.unsubscribed = next;
}

/** Map an unsubscribe list to the category whose email channel it turns off (null: handled by consent). */
export function categoryForList(list: UnsubscribeList): NotificationCategory | null {
  switch (list) {
    case 'alerts':
    case 'digest':
      return 'alert';
    case 'reminders':
      return 'reminder';
    case 'tips':
      return 'tips';
    default:
      return null;
  }
}

function toView(row: {
  id: string;
  category: string | null;
  type: string;
  templateKey: string | null;
  params: unknown;
  title: string;
  body: string | null;
  deepLink: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationView {
  const params = isObject(row.params) ? { ...row.params } : null;
  const category = categoryOf(row);
  let response: NotificationView['response'];
  if (category === 'invitation') {
    const r = params && isObject(params.response) ? params.response : null;
    response = r && typeof r.interested === 'boolean' && typeof r.at === 'string' ? { interested: r.interested, at: r.at } : null;
  }
  if (params) delete params.response;
  const view: NotificationView = {
    id: row.id,
    category,
    templateKey: row.templateKey ?? null,
    params: params && Object.keys(params).length ? params : null,
    title: row.title || null,
    body: row.body ?? null,
    href: safeHref(row.deepLink),
    readAt: iso(row.readAt),
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
  };
  if (response !== undefined) view.response = response;
  return view;
}

/** Only same-site paths are rendered as links (a stored absolute URL is dropped). */
export function safeHref(href: string | null | undefined): string | null {
  if (!href || typeof href !== 'string') return null;
  if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return null;
  return href;
}

const VIEW_SELECT = {
  id: true,
  category: true,
  type: true,
  templateKey: true,
  params: true,
  title: true,
  body: true,
  deepLink: true,
  readAt: true,
  createdAt: true,
} as const;

// ── Invitation responder seam ───────────────────────────────────────────

export type InvitationResponder = (input: {
  userId: string;
  notificationId: string;
  interested: boolean;
  form?: Record<string, string>;
  params: Record<string, unknown> | null;
}) => Promise<void>;

let invitationResponder: InvitationResponder | null = null;

/** The RoboHire/GoHire invitation integration (Later) registers how a reply reaches the recruiter. */
export function registerInvitationResponder(fn: InvitationResponder | null): void {
  invitationResponder = fn;
}

// ── Default capability resolver ─────────────────────────────────────────

export function defaultCapabilities(env?: EnvSource): CapabilityResolver {
  return async (userId, brand) => {
    const opts = { userId: userId ?? undefined, brand, env };
    const [email, push, wechat, invitations, alerts] = await Promise.all([
      isEnabled('notify.email', opts),
      isEnabled('webPush', opts),
      isEnabled('notify.wechat', opts),
      isEnabled('invitations', opts),
      isEnabled('jobs.alerts', opts),
    ]);
    return { email, push, wechat, invitations, alerts };
  };
}

// ── Service ─────────────────────────────────────────────────────────────

export interface CreateNotificationInput {
  userId: string;
  brand: ProductBrand['id'];
  category: NotificationCategory;
  /** i18n key under `inbox.templates.*` (client-rendered); `title`/`body` are the fallbacks. */
  templateKey?: string | null;
  params?: Record<string, unknown> | null;
  /** Fallback title (required by the table). Real text only; never invented numbers (D3). */
  title: string;
  body?: string | null;
  /** Same-site path, e.g. `/jobs/<id>?src=alert`. */
  href?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
}

export class NotificationCenterService {
  readonly db: NotificationsDb;
  private readonly env: EnvSource;
  private readonly now: () => Date;
  private readonly caps: CapabilityResolver;

  constructor(deps: NotificationServiceDeps = {}) {
    this.db = deps.db ?? prisma;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => new Date());
    this.caps = deps.capabilities ?? defaultCapabilities(deps.env);
  }

  private baseWhere(profileId: string, brandId: string) {
    return {
      seekerProfileId: profileId,
      type: { notIn: [...HIDDEN_LEGACY_TYPES] },
      OR: [{ brand: brandId }, { brand: null }],
    };
  }

  async profileFor(userId: string): Promise<ProfileRef | null> {
    const p = await this.db.seekerProfile.findUnique({ where: { userId }, select: { id: true, userId: true } });
    return p ? { id: p.id, userId: p.userId } : null;
  }

  // ── Inbox ──

  async list(profile: ProfileRef, brand: ProductBrand, query: { cursor?: string; limit?: number } = {}): Promise<NotificationsResponse> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), 50);
    const after = decodeCursor(query.cursor);
    if (query.cursor && !after) throw new HttpError('invalid_request', 'The cursor is not valid.', { where: 'query', field: 'cursor' });
    const where = after
      ? {
          AND: [
            this.baseWhere(profile.id, brand.id),
            { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] },
          ],
        }
      : this.baseWhere(profile.id, brand.id);
    const rows = await this.db.seekerNotification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: VIEW_SELECT,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toView(r)),
      cursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  async unreadCountForProfile(profileId: string, brand: ProductBrand): Promise<number> {
    return this.db.seekerNotification.count({ where: { ...this.baseWhere(profileId, brand.id), readAt: null } });
  }

  /** Unread messages for a user (0 when the account has no seeker profile). */
  async unreadCount(userId: string, brand: ProductBrand): Promise<number> {
    const profile = await this.profileFor(userId);
    return profile ? this.unreadCountForProfile(profile.id, brand) : 0;
  }

  private async ownRow(profile: ProfileRef, brand: ProductBrand, id: string) {
    const row = await this.db.seekerNotification.findFirst({
      where: { id, ...this.baseWhere(profile.id, brand.id) },
      select: VIEW_SELECT,
    });
    if (!row) throw new HttpError('not_found', 'This message does not exist.', { reason: NOTIFICATIONS_ERROR_CODES.notFound });
    return row;
  }

  async markRead(profile: ProfileRef, brand: ProductBrand, id: string): Promise<void> {
    const row = await this.ownRow(profile, brand, id);
    if (row.readAt) return;
    await this.db.seekerNotification.updateMany({ where: { id, seekerProfileId: profile.id, readAt: null }, data: { readAt: this.now() } });
  }

  async markAllRead(profile: ProfileRef, brand: ProductBrand): Promise<{ updated: number }> {
    const res = await this.db.seekerNotification.updateMany({
      where: { ...this.baseWhere(profile.id, brand.id), readAt: null },
      data: { readAt: this.now() },
    });
    return { updated: res.count };
  }

  async respond(profile: ProfileRef, brand: ProductBrand, id: string, body: { interested: boolean; form?: Record<string, string> }): Promise<NotificationView> {
    const row = await this.ownRow(profile, brand, id);
    if (categoryOf(row) !== 'invitation') {
      throw new HttpError('invalid_request', 'Only invitations take a reply.', { reason: NOTIFICATIONS_ERROR_CODES.notInvitation });
    }
    const params = isObject(row.params) ? { ...row.params } : {};
    if (isObject(params.response)) {
      throw new HttpError('conflict', 'You already answered this invitation.', { reason: 'invitation_already_answered' });
    }
    const at = this.now();
    // Forward first: a failed hand-off leaves the invitation unanswered so the person can retry.
    if (invitationResponder) {
      const { response: _r, ...rest } = params;
      await invitationResponder({ userId: profile.userId, notificationId: id, interested: body.interested, form: body.form, params: rest });
    }
    params.response = { interested: body.interested, at: at.toISOString() };
    await this.db.seekerNotification.updateMany({
      where: { id, seekerProfileId: profile.id },
      data: { params: params as Prisma.InputJsonValue, readAt: row.readAt ?? at },
    });
    return toView({ ...row, params, readAt: row.readAt ?? at });
  }

  /** Producer helper: one inbox row (WP-38/39a/58/52/21a may call it or write rows directly). */
  async create(input: CreateNotificationInput): Promise<{ id: string }> {
    const profile = await this.profileFor(input.userId);
    if (!profile) throw new HttpError('not_found', 'No seeker profile for this account.');
    const row = await this.db.seekerNotification.create({
      data: {
        seekerProfileId: profile.id,
        userId: input.userId,
        brand: input.brand,
        type: input.category,
        category: input.category,
        templateKey: input.templateKey ?? null,
        params: (input.params ?? undefined) as Prisma.InputJsonValue | undefined,
        title: input.title,
        body: input.body ?? null,
        deepLink: safeHref(input.href),
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
      },
      select: { id: true },
    });
    return row;
  }

  // ── Settings ──

  private async latestConsent(profileId: string, type: string): Promise<boolean | null> {
    const rec = await this.db.seekerConsentRecord.findFirst({
      where: { seekerProfileId: profileId, consentType: type },
      orderBy: { createdAt: 'desc' },
      select: { granted: true },
    });
    return rec ? rec.granted : null;
  }

  private async loadState(userId: string) {
    const [profile, user, raProfile] = await Promise.all([
      this.db.seekerProfile.findUnique({
        where: { userId },
        select: { id: true, userId: true, market: true, notificationPreferences: true, weeklyNudgeOptOut: true },
      }),
      this.db.user.findUnique({ where: { id: userId }, select: { email: true, emailIsPlaceholder: true } }),
      this.db.rAProfile.findUnique({ where: { userId }, select: { country: true } }),
    ]);
    return { profile, user, raProfile };
  }

  /** The country the regional default is resolved for (see the file header), and whether it should be stored. */
  private resolveCountry(
    state: Awaited<ReturnType<NotificationCenterService['loadState']>>,
    center: StoredNotificationCenter,
    requestCountry: string | null | undefined,
  ): { country: string | null; persist: string | null } {
    const own = normCountry(state.raProfile?.country);
    if (own) return { country: own, persist: null };
    if (state.profile?.market === 'eu') return { country: EU_MARKET_COUNTRY, persist: null };
    if (center.regionCountry) return { country: center.regionCountry, persist: null };
    const req = normCountry(requestCountry);
    return { country: req, persist: req };
  }

  private async tipsState(profileId: string, brand: ProductBrand, country: string | null, weeklyNudgeOptOut: boolean) {
    const recorded = await this.latestConsent(profileId, TIPS_CONSENT);
    const def = tipsRemindersDefault({ market: brand.market, country });
    if (recorded !== null) return { value: recorded, def, source: 'user' as const };
    // The legacy Friday-nudge opt-out was the same kind of message: honour it.
    if (weeklyNudgeOptOut) return { value: false, def, source: 'user' as const };
    return { value: def, def, source: 'default' as const };
  }

  async getPreferences(ctx: PreferenceContext): Promise<NotificationPreferencesView> {
    const state = await this.loadState(ctx.userId);
    if (!state.profile) throw new HttpError('not_found', 'No seeker profile for this account.');
    const raw = state.profile.notificationPreferences;
    const center = readCenter(raw);
    const { country, persist } = this.resolveCountry(state, center, ctx.requestCountry);
    if (persist) {
      center.regionCountry = persist;
      await this.db.seekerProfile.update({ where: { id: state.profile.id }, data: { notificationPreferences: writeCenter(raw, center) } });
    }
    return this.view(ctx, state, center, country);
  }

  private async view(
    ctx: PreferenceContext,
    state: Awaited<ReturnType<NotificationCenterService['loadState']>>,
    center: StoredNotificationCenter,
    country: string | null,
  ): Promise<NotificationPreferencesView> {
    const profile = state.profile!;
    const caps = await this.caps(ctx.userId, ctx.brand);
    const hasRealEmail = hasRealEmailOf(state.user);
    const available = availableChannels(caps, hasRealEmail);
    const legacy = isObject(profile.notificationPreferences) ? profile.notificationPreferences : {};
    const [tips, productNews] = await Promise.all([
      this.tipsState(profile.id, ctx.brand, country, profile.weeklyNudgeOptOut === true),
      this.latestConsent(profile.id, MARKETING_CONSENT),
    ]);
    const channels = effectiveChannels(center, available, legacy);
    // No alert is ever sent while `jobs.alerts` is off: no choices, no email.
    if (!caps.alerts) channels.alert = ['in_app'];
    const prose = tipsConsentProse(ctx.brand, ctx.locale);
    return {
      tipsReminders: tips.value,
      channels,
      quietHours: center.quietHours ?? { ...DEFAULT_QUIET_HOURS },
      tipsRemindersDefault: tips.def,
      tipsRemindersSource: tips.source,
      tipsRemindersConsent: { text: prose.text, locale: prose.locale, version: prose.version },
      availableChannels: available,
      emailUnavailableReason: emailUnavailableReason(caps, hasRealEmail),
      configurableCategories: configurableCategoriesFor(caps),
      lockedCategories: [...LOCKED_CATEGORIES],
      productNewsEmail: productNews,
    };
  }

  async patchPreferences(ctx: PreferenceContext, patch: NotificationPreferencesPatch): Promise<NotificationPreferencesView> {
    const state = await this.loadState(ctx.userId);
    if (!state.profile) throw new HttpError('not_found', 'No seeker profile for this account.');
    const raw = state.profile.notificationPreferences;
    const center = readCenter(raw);
    let dirty = false;

    if (patch.tipsReminders !== undefined && patch.tipsRemindersProseVersion !== undefined && patch.tipsRemindersProseVersion !== CONSENT_PROSE_VERSION) {
      throw new HttpError('version_conflict', 'The consent text changed. Reload to see the current text.', {
        reason: 'consent_prose_outdated',
        currentVersion: CONSENT_PROSE_VERSION,
      });
    }

    if (patch.channels) {
      const caps = await this.caps(ctx.userId, ctx.brand);
      const available = new Set(availableChannels(caps, hasRealEmailOf(state.user)));
      const configurable = new Set<string>(configurableCategoriesFor(caps));
      const next = { ...(center.channels ?? {}) };
      for (const [cat, list] of Object.entries(patch.channels)) {
        if (!configurable.has(cat)) {
          if ((CONFIGURABLE_CATEGORIES as readonly string[]).includes(cat)) {
            throw new HttpError('invalid_request', 'These messages are not offered here.', { reason: NOTIFICATIONS_ERROR_CODES.categoryUnavailable, category: cat });
          }
          throw new HttpError('invalid_request', 'These messages are always sent.', { reason: NOTIFICATIONS_ERROR_CODES.categoryLocked, category: cat });
        }
        const bad = (list ?? []).filter((c) => !available.has(c));
        if (bad.length) {
          throw new HttpError('invalid_request', 'This channel is not available for your account.', {
            reason: NOTIFICATIONS_ERROR_CODES.channelUnavailable,
            category: cat,
            channels: bad,
          });
        }
        next[cat as NotificationCategory] = normalizeChannelList(list ?? []);
        if (next[cat as NotificationCategory]!.includes('email')) clearUnsubscribed(center, LISTS_FOR_CATEGORY[cat] ?? []);
      }
      center.channels = next;
      dirty = true;
    }

    if (patch.quietHours) {
      center.quietHours = { start: patch.quietHours.start, end: patch.quietHours.end };
      dirty = true;
    }

    if (patch.tipsReminders === true && center.unsubscribed?.tips) {
      clearUnsubscribed(center, ['tips']);
      dirty = true;
    }

    const { country, persist } = this.resolveCountry(state, center, ctx.requestCountry);
    if (persist) {
      center.regionCountry = persist;
      dirty = true;
    }

    if (dirty) {
      await this.db.seekerProfile.update({ where: { id: state.profile.id }, data: { notificationPreferences: writeCenter(raw, center) } });
      state.profile = { ...state.profile, notificationPreferences: writeCenter(raw, center) as unknown as typeof state.profile.notificationPreferences };
    }

    if (patch.tipsReminders !== undefined) {
      await this.writeConsent({ userId: ctx.userId, profileId: state.profile.id, brand: ctx.brand, type: TIPS_CONSENT, granted: patch.tipsReminders, locale: ctx.locale });
      if (patch.tipsReminders && state.profile.weeklyNudgeOptOut) {
        await this.db.seekerProfile.update({ where: { id: state.profile.id }, data: { weeklyNudgeOptOut: false } });
        state.profile = { ...state.profile, weeklyNudgeOptOut: false };
      }
    }

    return this.view(ctx, state, center, country);
  }

  /**
   * One consent record. Through the compliance catalog when the brand offers
   * the consent there; otherwise (GoApply `tips_reminders` until WP-13 adds
   * its catalog entry) the same record is written directly with the
   * RoboApply prose, brand-substituted, so the ledger stays provable.
   */
  async writeConsent(input: { userId: string; profileId: string; brand: ProductBrand; type: string; granted: boolean; locale?: string | null }): Promise<void> {
    const def = findConsentDefinition(input.brand.id, input.type);
    if (def) {
      await recordConsent(
        { userId: input.userId, brand: input.brand, type: input.type, granted: input.granted, proseVersion: CONSENT_PROSE_VERSION, locale: input.locale },
        { db: this.db, env: this.env },
      );
      return;
    }
    const fallback: ConsentDefinition | null = findConsentDefinition('roboapply', input.type);
    if (!fallback) throw new HttpError('invalid_request', 'This consent is not offered here.');
    const hash =
      input.type === TIPS_CONSENT
        ? tipsConsentProse(input.brand, input.locale).hash
        : consentProseHash({
            brand: input.brand.id,
            type: input.type,
            version: CONSENT_PROSE_VERSION,
            locale: 'en',
            text: fallback.prose.en.split('%BRAND%').join(input.brand.name),
          });
    await this.db.seekerConsentRecord.create({
      data: {
        seekerProfileId: input.profileId,
        consentType: input.type,
        granted: input.granted,
        proseVersion: CONSENT_PROSE_VERSION,
        proseHash: hash,
      },
    });
  }

  /**
   * The effective settings for a user outside a request (crons, delivery
   * channels): same resolution as the settings page, nothing written. Null
   * without a seeker profile.
   */
  async preferencesFor(userId: string, brand: ProductBrand): Promise<NotificationPreferencesView | null> {
    const state = await this.loadState(userId);
    if (!state.profile) return null;
    const center = readCenter(state.profile.notificationPreferences);
    const { country } = this.resolveCountry(state, center, null);
    return this.view({ id: state.profile.id, userId, brand }, state, center, country);
  }

  /**
   * Store the edge country for the regional default the first time it is
   * seen, so "Tips and reminders" gets its regional default before the person
   * opens Settings. Nothing changes once a country is known (the profile's own,
   * the 'eu' market, or one stored earlier). Returns true when it wrote.
   */
  async rememberRegion(userId: string, country: string | null | undefined): Promise<boolean> {
    const c = normCountry(country);
    if (!c) return false;
    const [profile, raProfile] = await Promise.all([
      this.db.seekerProfile.findUnique({ where: { userId }, select: { id: true, market: true, notificationPreferences: true } }),
      this.db.rAProfile.findUnique({ where: { userId }, select: { country: true } }),
    ]);
    if (!profile || normCountry(raProfile?.country) || profile.market === 'eu') return false;
    const raw = profile.notificationPreferences;
    const center = readCenter(raw);
    if (center.regionCountry) return false;
    center.regionCountry = c;
    await this.db.seekerProfile.update({ where: { id: profile.id }, data: { notificationPreferences: writeCenter(raw, center) } });
    return true;
  }

  /**
   * `rememberRegion` at most once per profile per process (the unread-count
   * poll calls it every minute). Never throws.
   */
  async rememberRegionOnce(profile: ProfileRef, country: string | null | undefined): Promise<void> {
    if (!normCountry(country) || REMEMBERED.has(profile.id)) return;
    if (REMEMBERED.size >= REMEMBERED_MAX) REMEMBERED.clear();
    REMEMBERED.add(profile.id);
    try {
      await this.rememberRegion(profile.userId, country);
    } catch (err) {
      REMEMBERED.delete(profile.id);
      logger.warn('NOTIFICATIONS', 'could not store the region for the tips default', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Is email of this list on right now for this account, by the person's own
   * choices and consents (not by whether the brand can send email today)?
   * Null without a seeker profile. The unsubscribe page reads this, so a
   * consent granted again elsewhere shows the Unsubscribe button again.
   */
  async listEmailOn(userId: string, brand: ProductBrand, list: UnsubscribeList): Promise<boolean | null> {
    const state = await this.loadState(userId);
    if (!state.profile) return null;
    if (list === 'marketing') return (await this.latestConsent(state.profile.id, MARKETING_CONSENT)) === true;
    const cat = categoryForList(list);
    if (!cat) return false;
    const center = readCenter(state.profile.notificationPreferences);
    const legacy = isObject(state.profile.notificationPreferences) ? state.profile.notificationPreferences : {};
    const chosen = effectiveChannels(center, ['in_app', 'email'], legacy)[cat];
    if (!chosen.includes('email')) return false;
    if (cat === 'tips') {
      const { country } = this.resolveCountry(state, center, null);
      return (await this.tipsState(state.profile.id, brand, country, state.profile.weeklyNudgeOptOut === true)).value;
    }
    return true;
  }

  // ── Email preference gate (WP-39a registers it with setEmailPreferenceGate) ──

  /**
   * May a non-transactional email of `list` go to this person?
   *   no account  → only `alerts` to a confirmed logged-out alert subscription (WP-78), with `jobs.alerts` on;
   *   marketing   → the latest `marketing_email` consent is a grant;
   *   tips        → "Tips and reminders" is on (record or regional default) and tips email is on;
   *   alerts/digest/reminders → email is on for that category (alerts also need `jobs.alerts`).
   */
  async allowsEmail(input: { brand: ProductBrand; userId: string | null; email: string; list: UnsubscribeList }): Promise<boolean> {
    if (!input.userId) {
      if (input.list !== 'alerts' && input.list !== 'digest') return false;
      if (!(await this.caps(null, input.brand)).alerts) return false;
      const sub = await this.db.rAAnonAlertSubscription.findFirst({
        where: { brand: input.brand.id, emailHash: hashEmail(input.email), status: 'confirmed' },
        select: { id: true },
      });
      return !!sub;
    }
    const state = await this.loadState(input.userId);
    if (!state.profile) return false;
    if (input.list === 'marketing') return (await this.latestConsent(state.profile.id, MARKETING_CONSENT)) === true;
    const center = readCenter(state.profile.notificationPreferences);
    const { country } = this.resolveCountry(state, center, null);
    const view = await this.view({ id: state.profile.id, userId: input.userId, brand: input.brand }, state, center, country);
    if (!view.availableChannels.includes('email')) return false;
    const cat = categoryForList(input.list);
    if (!cat) return false;
    if (cat === 'tips' && !view.tipsReminders) return false;
    return view.channels[cat].includes('email');
  }

  /** The gate in the shape `platform/email` expects. */
  emailPreferenceGate(): EmailPreferenceGate {
    return async ({ brand, userId, email, list }) => {
      try {
        return await this.allowsEmail({ brand, userId, email, list });
      } catch (err) {
        logger.warn('NOTIFICATIONS', 'email preference check failed; not sending', { list, error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    };
  }
}

/** Known stored category values (for producers writing rows directly). */
export const STORED_CATEGORIES = Object.keys(STORED_CATEGORY_MAP);
