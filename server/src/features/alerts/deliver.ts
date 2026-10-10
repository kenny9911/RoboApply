// server/src/features/alerts/deliver.ts
//
// One message → every channel the person allows (PRODUCT §7.1):
//   1. in-app: a `SeekerNotification` row, the source of truth for every
//      alert, reminder and notice (the message center is WP-39b's);
//   2. email: the platform `sendEmail` (brand transport, RAEmailLog, signed
//      unsubscribe link + RFC 8058 headers, the preference gate). GoApply's
//      channel is in-app; email goes out only when the brand has a working
//      email transport and the person has a real address;
//   3. registered channels (`registerDeliveryChannel`): WP-61 web push,
//      WP-73 WeChat. Each failure is isolated; none blocks the others.
//
// The caller has already checked quiet hours, frequency caps and the
// category preference ("Tips and reminders"); this module only fans out.

import type { Prisma } from '../../generated/prisma/client.js';
import { getBrand, type ProductBrand } from '../../platform/brand/registry.js';
import { isEnabledForBrand } from '../../platform/flags.js';
import {
  createEmailTranslator,
  defaultListFor,
  getEmailTemplate,
  sendEmail as platformSendEmail,
  type SendEmailInput,
  type SendEmailResult,
} from '../../platform/email/index.js';
import { logger } from '../../services/LoggerService.js';
import type { AlertKind, DeliveryChannel, DeliveryResult } from './contract.js';
import { channelAllowed, type PrefChannel, type StoredNotificationPrefs } from './preferences.js';
import type { Recipient } from './repo.js';

/** The message-center categories (WP-39b `NOTIFICATION_CATEGORIES`) this module writes. */
export type NotifyCategory = 'alert' | 'reminder' | 'tips';

export interface NotifyMessage {
  recipient: Recipient;
  kind: AlertKind;
  category: NotifyCategory;
  /** A registered email template key (`notify.*`); also the in-app `templateKey`. */
  templateKey: string;
  params: Record<string, unknown>;
  /** In-app deep link (app path). */
  href: string | null;
  relatedEntity?: { type: string; id: string } | null;
  /** The person's stored channel choices (WP-39b); default: every channel. */
  prefs?: StoredNotificationPrefs;
}

export interface InAppRow {
  seekerProfileId: string;
  userId: string;
  brand: string;
  type: string;
  category: NotifyCategory;
  templateKey: string;
  params: Record<string, unknown>;
  title: string;
  body: string | null;
  deepLink: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
}

export interface DeliverDeps {
  createInApp(row: InAppRow): Promise<{ id: string }>;
  markEmailed(notificationId: string, at: Date): Promise<void>;
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
  /** Extra channels for the brand (the registry in index.ts). */
  channels(brand: ProductBrand): DeliveryChannel[];
  /** `notify.email` capability for the brand. */
  emailEnabled(brand: ProductBrand): boolean;
  now?: () => Date;
}

export interface DeliverOutcome {
  notificationId: string | null;
  email: SendEmailResult | null;
  channels: Record<string, DeliveryResult>;
}

const CHANNEL_PREF: Record<string, PrefChannel> = { web_push: 'push', wechat_mp: 'wechat', email: 'email', in_app: 'in_app' };

/** In-app title/body in the person's language: the email subject and its one-line preview. */
export function inAppCopy(brand: ProductBrand, locale: string | null, templateKey: string, params: Record<string, unknown>, origin: string): { title: string; body: string | null } {
  const template = getEmailTemplate(templateKey);
  if (!template) return { title: templateKey, body: null };
  try {
    const t = createEmailTranslator(brand, locale ?? brand.defaultLocale);
    const out = template.render({ brand, t, params, origin });
    return { title: out.subject.slice(0, 300), body: out.preheader ? out.preheader.slice(0, 1000) : null };
  } catch (err) {
    logger.warn('NOTIFY', 'in-app copy render failed', { templateKey, error: err instanceof Error ? err.message : String(err) });
    return { title: templateKey, body: null };
  }
}

/** The unsubscribe list an email of this template belongs to. */
export function emailListFor(templateKey: string): string | undefined {
  const template = getEmailTemplate(templateKey);
  return template ? (template.list ?? defaultListFor(template.category)) : undefined;
}

async function db() {
  return (await import('../../lib/prisma.js')).default;
}

export function defaultDeliverDeps(channels: (brand: ProductBrand) => DeliveryChannel[]): DeliverDeps {
  return {
    async createInApp(row) {
      const p = await db();
      return p.seekerNotification.create({
        data: {
          seekerProfileId: row.seekerProfileId,
          userId: row.userId,
          brand: row.brand,
          type: row.type,
          category: row.category,
          templateKey: row.templateKey,
          params: row.params as Prisma.InputJsonValue,
          title: row.title,
          body: row.body,
          deepLink: row.deepLink,
          relatedEntityType: row.relatedEntityType,
          relatedEntityId: row.relatedEntityId,
        },
        select: { id: true },
      });
    },
    async markEmailed(notificationId, at) {
      const p = await db();
      await p.seekerNotification.update({ where: { id: notificationId }, data: { emailSentAt: at } });
    },
    sendEmail: (input) => platformSendEmail(input),
    channels,
    emailEnabled: (brand) => isEnabledForBrand('notify.email', brand),
  };
}

export async function deliverMessage(msg: NotifyMessage, deps: DeliverDeps): Promise<DeliverOutcome> {
  const now = deps.now ?? (() => new Date());
  const brand = getBrand(msg.recipient.brand);
  const prefs = msg.prefs ?? {};
  const outcome: DeliverOutcome = { notificationId: null, email: null, channels: {} };

  // 1. In-app (source of truth).
  if (msg.recipient.seekerProfileId && channelAllowed(prefs, msg.category, 'in_app')) {
    const copy = inAppCopy(brand, msg.recipient.locale, msg.templateKey, msg.params, '');
    try {
      const row = await deps.createInApp({
        seekerProfileId: msg.recipient.seekerProfileId,
        userId: msg.recipient.userId,
        brand: brand.id,
        type: msg.templateKey,
        category: msg.category,
        templateKey: msg.templateKey,
        params: msg.params,
        title: copy.title,
        body: copy.body,
        deepLink: msg.href,
        relatedEntityType: msg.relatedEntity?.type ?? null,
        relatedEntityId: msg.relatedEntity?.id ?? null,
      });
      outcome.notificationId = row.id;
    } catch (err) {
      logger.warn('NOTIFY', 'in-app write failed', { templateKey: msg.templateKey, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 2. Email (the platform gate checks the list preference again). Only the
  //    template's own list counts: a digest unsubscribe never stops instant
  //    alerts, and the other way round (RFC 8058: one list per email).
  if (msg.recipient.email && deps.emailEnabled(brand) && channelAllowed(prefs, msg.category, 'email', emailListFor(msg.templateKey))) {
    outcome.email = await deps.sendEmail({
      template: msg.templateKey,
      to: msg.recipient.email,
      userId: msg.recipient.userId,
      locale: msg.recipient.locale,
      params: msg.params,
      brand,
    });
    if (outcome.email.status === 'sent' && outcome.notificationId) {
      await deps.markEmailed(outcome.notificationId, now()).catch(() => undefined);
    }
  }

  // 3. Registered channels (web push, WeChat).
  for (const channel of deps.channels(brand)) {
    const pref = CHANNEL_PREF[channel.id] ?? (channel.id as PrefChannel);
    if (!channelAllowed(prefs, msg.category, pref)) {
      outcome.channels[channel.id] = { delivered: false, skippedReason: 'preference_off' };
      continue;
    }
    if (!channel.isConfigured()) {
      outcome.channels[channel.id] = { delivered: false, skippedReason: 'not_configured' };
      continue;
    }
    try {
      outcome.channels[channel.id] = await channel.deliver({
        userId: msg.recipient.userId,
        brand: brand.id,
        locale: msg.recipient.locale ?? brand.defaultLocale,
        kind: msg.kind,
        category: msg.category,
        templateKey: msg.templateKey,
        params: msg.params,
        href: msg.href,
        notificationId: outcome.notificationId,
      });
    } catch (err) {
      logger.warn('NOTIFY', `channel ${channel.id} failed`, { templateKey: msg.templateKey, error: err instanceof Error ? err.message : String(err) });
      outcome.channels[channel.id] = { delivered: false, skippedReason: 'error' };
    }
  }
  return outcome;
}
