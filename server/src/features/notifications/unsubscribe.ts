// server/src/features/notifications/unsubscribe.ts
//
// One-click unsubscribe without login (RFC 8058; PRODUCT_PLAN.md F-NOTIF-04;
// ARCHITECTURE.md §8.1). Every non-transactional email carries
//   List-Unsubscribe: <…/api/v1/public/email/unsubscribe?token=…>
//   List-Unsubscribe-Post: List-Unsubscribe=One-Click
// and a footer link to the page /unsubscribe/<token>.
//
//   preview(token)        GET  — what the link would turn off (no change: link scanners GET too)
//   unsubscribe(token)    POST — turns the list off; idempotent; works for a mail
//                                client's one-click POST and for the page's button
//   survey(body)          POST — optional reason, after unsubscribing
//
// The token is FND-3's stateless HMAC token, verified for the request's brand
// (a RoboApply link never changes a GoApply account). What "off" means per list:
//   alerts / digest → email off for job alerts, instant and summaries alike
//                     (one email channel per category; the inbox keeps them);
//   reminders       → email off for reminders;
//   tips            → "Tips and reminders" consent withdrawn (and the legacy Friday nudge opt-out set):
//                     tips stop everywhere, the inbox included;
//   marketing       → `marketing_email` consent withdrawn (product news never goes to the inbox).
// The preview's `alreadyUnsubscribed` is worked out from the live settings and
// consents (`listEmailOn`); `center.unsubscribed` only records when a list was left.
// A token for an address with no account (logged-out alerts, WP-78) marks the
// matching `RAAnonAlertSubscription` rows unsubscribed.

import { HttpError } from '../../platform/http.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { verifyUnsubscribeToken, type UnsubscribeList, type UnsubscribePayload, type EnvLike } from '../../platform/email/unsubscribe.js';
import { logger } from '../../services/LoggerService.js';
import { NOTIFICATIONS_ERROR_CODES, type UnsubscribePreview, type UnsubscribeReason, type UnsubscribeResponse } from './contract.js';
import { NotificationCenterService, categoryForList, readCenter, writeCenter, type NotificationsDb } from './service.js';

export interface UnsubscribeServiceDeps {
  db: NotificationsDb;
  center: NotificationCenterService;
  env?: EnvLike;
  now?: () => Date;
}

const FEEDBACK_KEEP = 5;

export class UnsubscribeService {
  constructor(private readonly deps: UnsubscribeServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Verify for this brand; any failure is the same plain 404-free answer (no oracle). */
  verify(token: string, brand: ProductBrand): UnsubscribePayload {
    let result;
    try {
      result = verifyUnsubscribeToken(token, { expectedBrand: brand.id, env: this.deps.env });
    } catch (err) {
      logger.error('NOTIFICATIONS', 'unsubscribe tokens cannot be verified (secret missing)', { error: err instanceof Error ? err.message : String(err) });
      throw new HttpError('invalid_request', 'This unsubscribe link is not valid.', { reason: NOTIFICATIONS_ERROR_CODES.tokenInvalid });
    }
    if (!result.ok) {
      throw new HttpError('invalid_request', 'This unsubscribe link is not valid.', { reason: NOTIFICATIONS_ERROR_CODES.tokenInvalid });
    }
    return result.payload;
  }

  async preview(token: string, brand: ProductBrand): Promise<UnsubscribePreview> {
    const payload = this.verify(token, brand);
    return { category: payload.list, alreadyUnsubscribed: await this.isOff(payload, brand), hasAccount: !!payload.userId };
  }

  /**
   * From the live state, never from the `unsubscribed` mark: a consent granted
   * again elsewhere (WP-13's consent route, the legacy account route) turns
   * the emails back on, and the page must then offer Unsubscribe again.
   */
  private async isOff(payload: UnsubscribePayload, brand: ProductBrand): Promise<boolean> {
    const { db, center } = this.deps;
    if (!payload.userId) {
      if (!payload.emailHash) return false;
      const live = await db.rAAnonAlertSubscription.count({
        where: { brand: payload.brand, emailHash: payload.emailHash, status: { not: 'unsubscribed' } },
      });
      return live === 0;
    }
    const on = await center.listEmailOn(payload.userId, brand, payload.list);
    // A deleted account has nothing left to send.
    return on !== true;
  }

  async unsubscribe(token: string, brand: ProductBrand): Promise<UnsubscribeResponse> {
    const payload = this.verify(token, brand);
    const at = this.now();
    if (payload.userId) await this.offForUser(payload.userId, payload.list, brand, at);
    else if (payload.emailHash && (payload.list === 'alerts' || payload.list === 'digest')) {
      await this.deps.db.rAAnonAlertSubscription.updateMany({
        where: { brand: brand.id, emailHash: payload.emailHash, status: { not: 'unsubscribed' } },
        data: { status: 'unsubscribed', unsubscribedAt: at },
      });
    }
    logger.info('NOTIFICATIONS', 'email list left', { brand: brand.id, list: payload.list, template: payload.template ?? null, account: !!payload.userId });
    return { category: payload.list, unsubscribed: true };
  }

  private async offForUser(userId: string, list: UnsubscribeList, brand: ProductBrand, at: Date): Promise<void> {
    const { db, center: svc } = this.deps;
    const profile = await db.seekerProfile.findUnique({
      where: { userId },
      select: { id: true, notificationPreferences: true },
    });
    // A deleted account has nothing left to send: the answer is still "unsubscribed".
    if (!profile) return;

    const raw = profile.notificationPreferences;
    const center = readCenter(raw);
    const cat = categoryForList(list);
    if (cat && cat !== 'tips') {
      const current = center.channels?.[cat];
      const base = current ?? ['in_app', 'email'];
      center.channels = { ...(center.channels ?? {}), [cat]: base.filter((c) => c !== 'email') };
    }
    center.unsubscribed = { ...(center.unsubscribed ?? {}), [list]: at.toISOString() };
    await db.seekerProfile.update({
      where: { id: profile.id },
      data: { notificationPreferences: writeCenter(raw, center), ...(list === 'tips' ? { weeklyNudgeOptOut: true } : {}) },
    });

    if (list === 'tips' || list === 'marketing') {
      await svc.writeConsent({
        userId,
        profileId: profile.id,
        brand,
        type: list === 'tips' ? 'tips_reminders' : 'marketing_email',
        granted: false,
      });
    }
  }

  async survey(input: { token: string; reason: UnsubscribeReason; note?: string }, brand: ProductBrand): Promise<void> {
    const payload = this.verify(input.token, brand);
    const at = this.now().toISOString();
    // The reason is counted in the logs; the free-text note never is (it may name a person).
    logger.info('NOTIFICATIONS', 'unsubscribe reason', { brand: brand.id, list: payload.list, reason: input.reason, template: payload.template ?? null });
    if (!payload.userId) return;
    const { db } = this.deps;
    const profile = await db.seekerProfile.findUnique({ where: { userId: payload.userId }, select: { id: true, notificationPreferences: true } });
    if (!profile) return;
    const raw = profile.notificationPreferences;
    const center = readCenter(raw);
    const note = input.note?.trim();
    center.feedback = [...(center.feedback ?? []), { list: payload.list, reason: input.reason, ...(note ? { note } : {}), at }].slice(-FEEDBACK_KEEP);
    await db.seekerProfile.update({ where: { id: profile.id }, data: { notificationPreferences: writeCenter(raw, center) } });
  }
}
