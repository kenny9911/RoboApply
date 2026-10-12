// server/src/features/push/service.ts — subscriptions and sends (WP-61).
//
//   vapidPublicKey(brand)            the applicationServerKey the browser subscribes with
//   subscribe(userId, brand, body)   after the person clicked "Get alerts on this device"
//   unsubscribe(userId, id)          "Stop alerts on this device"
//   lookup(userId, brand, endpoint)  is this browser's subscription the caller's own row?
//   devicesFor(userId, brand)        the person's devices (cheap pre-check for senders)
//   sendToUser(userId, brand, p)     every device of one person; prunes failures:
//                                    404/410 → deleted now; other failures count up
//                                    and the device is dropped after PUSH_POLICY.maxFailures.
//
// Both brands are served (D5). The routes are gated on the `webPush` flag of
// the request's brand (404 `feature_disabled` when off, e.g.
// FLAG_GOAPPLY_WEB_PUSH=false); without the brand's VAPID set the HTTP entry
// points answer 501 `provider_not_configured` and the senders send nothing.
// Every row and every send is scoped to one brand, so a GoApply device never
// receives a RoboApply message and the reverse.

import type { z } from 'zod';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { getBrand, type BrandId, type ProductBrand } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { logger } from '../../services/LoggerService.js';
import { vapidConfig, type VapidConfig } from './config.js';
import {
  isAllowedPushEndpoint,
  PUSH_ERROR_CODES,
  PUSH_POLICY,
  type CreatePushSubscriptionBodySchema,
  type PushPayload,
  type PushSubscriptionLookupResponse,
  type PushSubscriptionView,
  type VapidKeyResponse,
} from './contract.js';
import { createPrismaPushRepo, type PushRepo, type PushSubscriptionRow } from './repo.js';
import { pushTopic, webPushSender, type PushSender } from './sender.js';

export interface PushServiceDeps {
  repo?: PushRepo;
  sender?: PushSender;
  env?: EnvSource;
  now?: () => Date;
}

export interface SendToUserResult {
  /** Devices the person had on the brand before sending. */
  subscriptions: number;
  sent: number;
  failed: number;
  /** Devices deleted by this send (gone, or too many failures). */
  pruned: number;
}

type Brandish = BrandId | ProductBrand;
const brandOf = (b: Brandish): ProductBrand => (typeof b === 'string' ? getBrand(b) : b);

export function toSubscriptionView(row: PushSubscriptionRow): PushSubscriptionView {
  return {
    id: row.id,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastSuccessAt: row.lastOkAt ? row.lastOkAt.toISOString() : null,
  };
}

/** Same-site path for a notification click; anything else opens the inbox. */
export function safeHref(href: string | null | undefined): string {
  if (typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') && !href.includes('\\') && href.length <= 500) return href;
  return '/inbox';
}

/** Clip to what notifications display; the payload must stay well under 4 KB. */
export function serializePayload(p: PushPayload): string {
  return JSON.stringify({
    title: p.title.slice(0, 120),
    body: p.body ? p.body.slice(0, 300) : null,
    href: safeHref(p.href),
    tag: p.tag.slice(0, 64),
  });
}

export class PushService {
  private readonly repo: PushRepo;
  private readonly sender: PushSender;
  private readonly env: EnvSource;
  private readonly now: () => Date;

  constructor(deps: PushServiceDeps = {}) {
    this.repo = deps.repo ?? createPrismaPushRepo();
    this.sender = deps.sender ?? webPushSender;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => new Date());
  }

  /** The brand's VAPID config (its own `CN_VAPID_*` set or the shared one, through `brandEnv`); null when missing. */
  config(brand: Brandish): VapidConfig | null {
    return vapidConfig(brandOf(brand), this.env);
  }

  private requireConfig(brand: Brandish): VapidConfig {
    const cfg = this.config(brand);
    if (!cfg) {
      throw new HttpError('provider_not_configured', 'Alerts on this device are not available right now.', { reason: PUSH_ERROR_CODES.vapidUnset });
    }
    return cfg;
  }

  vapidPublicKey(brand: Brandish): VapidKeyResponse {
    return { publicKey: this.requireConfig(brand).publicKey };
  }

  async subscribe(userId: string, brand: Brandish, body: z.output<typeof CreatePushSubscriptionBodySchema>): Promise<PushSubscriptionView> {
    const b = brandOf(brand);
    this.requireConfig(b);
    if (!isAllowedPushEndpoint(body.endpoint)) {
      throw new HttpError('invalid_request', 'This browser’s push service is not supported.', {
        reason: PUSH_ERROR_CODES.endpointNotAllowed,
        where: 'body',
        issues: [{ path: ['endpoint'], code: 'custom', message: 'Unsupported push service.' }],
      });
    }
    const row = await this.repo.upsert({
      userId,
      brand: b.id,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: body.userAgent?.trim() || null,
    });
    // Keep the newest devices only.
    const all = await this.repo.listForUser(userId, b.id);
    const excess = all.length - PUSH_POLICY.maxSubscriptionsPerUser;
    if (excess > 0) {
      const drop = all.filter((r) => r.id !== row.id).slice(0, excess).map((r) => r.id);
      await this.repo.deleteIds(drop);
    }
    return toSubscriptionView(row);
  }

  /**
   * The caller's own row for this browser endpoint on the brand, or null.
   * The opt-in shows "Alerts are on" only for a non-null answer: a browser
   * still holding another account's subscription (shared device) or one the
   * server pruned reads as off, and turning it on re-claims the endpoint.
   */
  async lookup(userId: string, brand: Brandish, endpoint: string): Promise<PushSubscriptionLookupResponse> {
    const b = brandOf(brand);
    const row = await this.repo.findByEndpoint(endpoint);
    if (!row || row.userId !== userId || row.brand !== b.id) return { subscription: null };
    return { subscription: toSubscriptionView(row) };
  }

  /** The person's devices on the brand (none without VAPID keys). */
  async devicesFor(userId: string, brand: Brandish): Promise<PushSubscriptionRow[]> {
    const b = brandOf(brand);
    if (!this.config(b)) return [];
    return this.repo.listForUser(userId, b.id);
  }

  async unsubscribe(userId: string, id: string): Promise<void> {
    const row = await this.repo.findOwned(id, userId);
    if (!row) throw new HttpError('not_found', 'This device is not subscribed.');
    await this.repo.deleteIds([row.id]);
  }

  /**
   * Send one notification to every device the person has on the brand. Never
   * throws for a device failure. `devices` (from `devicesFor`) skips a second
   * read when the caller already listed them.
   */
  async sendToUser(userId: string, brand: Brandish, payload: PushPayload, devices?: readonly PushSubscriptionRow[]): Promise<SendToUserResult> {
    const b = brandOf(brand);
    const cfg = this.config(b);
    const result: SendToUserResult = { subscriptions: 0, sent: 0, failed: 0, pruned: 0 };
    if (!cfg) return result;
    const subs = devices ? devices.filter((d) => d.userId === userId && d.brand === b.id) : await this.repo.listForUser(userId, b.id);
    result.subscriptions = subs.length;
    if (!subs.length) return result;
    const body = serializePayload(payload);
    const topic = pushTopic(payload.tag);
    const prune: string[] = [];
    await Promise.all(
      subs.map(async (sub) => {
        const res = await this.sender({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, cfg, { topic });
        if (res.ok) {
          result.sent += 1;
          await this.repo.markOk(sub.id, this.now()).catch(() => undefined);
          return;
        }
        result.failed += 1;
        if (res.gone) {
          prune.push(sub.id);
          return;
        }
        const count = await this.repo.markFailed(sub.id).catch(() => sub.failedCount + 1);
        if (count >= PUSH_POLICY.maxFailures) prune.push(sub.id);
        logger.warn('PUSH', 'web push send failed', { status: res.statusCode, failures: count });
      }),
    );
    if (prune.length) result.pruned = await this.repo.deleteIds(prune);
    return result;
  }

  async markNotificationPushed(notificationId: string): Promise<void> {
    await this.repo.markNotificationPushed(notificationId, this.now());
  }
}

let shared: PushService | null = null;
/** The process-wide service (Prisma + web-push + process.env). */
export function pushService(): PushService {
  shared ??= new PushService();
  return shared;
}
