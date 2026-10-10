// server/src/features/notify-cn/repo.ts — storage for WeChat notices (WP-73).
//
// Narrow typed adapter. Nothing here needs a new table:
//   - the 公众号 openid is the `RAAuthIdentity` row WP-11's in-WeChat sign-in
//     writes (brand, provider 'wechat', appId = WECHAT_MP_APP_ID, subject = openid);
//   - each accepted one-time subscribe prompt is one single-use `RAAuthToken`
//     row, kind `wechat_sub:<templateKey>` (payload `{ templateId, scene,
//     eventId?, source, paired }`; tokenHash = sha256 of random bytes, never
//     a secret anyone holds). Sending one message consumes one row
//     (`consumedAt`), so the table is the ledger of what WeChat allows us to
//     send. Rows expire after GRANT_TTL_DAYS and are deleted with the account
//     (cascade);
//   - one acceptance is reported twice: by the page (POST /subscribe-messages,
//     source 'client') and by WeChat itself (`subscribe_msg_popup_event`,
//     source 'wechat'). Whichever arrives second within PAIR_WINDOW_MS marks
//     the first row `paired` instead of adding a row, so one acceptance is one
//     grant, and an acceptance survives when either report is lost. Each add
//     runs in a SERIALIZABLE transaction, so the pairing and the live-grant
//     cap hold under concurrent taps and retries;
//   - a delivered message stamps `SeekerNotification.pushSentAt` on the
//     in-app row it mirrors (GoApply has no web push, so the column is free
//     there; WP-39a carry-over).
// Schema request SR-73-1 (handoff) documents the token kind; no DDL needed.

import crypto from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type prismaClient from '../../lib/prisma.js';
import type { BrandId } from '../../platform/brand/registry.js';
import type { WechatSubscribeScene, WechatTemplateKey } from './contract.js';

export type NotifyCnDb = Pick<typeof prismaClient, 'rAAuthToken' | 'rAAuthIdentity' | 'seekerNotification' | '$transaction'>;
type GrantTx = Pick<NotifyCnDb, 'rAAuthToken'>;

/** One accepted prompt stays usable this long. */
export const GRANT_TTL_DAYS = 180;
/** Live grants kept per person and template (more acceptances are not stored). */
export const MAX_LIVE_GRANTS = 20;

/** The page's and WeChat's report of the same acceptance are paired within this window. */
export const PAIR_WINDOW_MS = 10 * 60_000;
/** Attempts for a grant transaction that lost a serialization race (P2034). */
export const GRANT_TX_ATTEMPTS = 3;

export const grantKind = (key: WechatTemplateKey) => `wechat_sub:${key}`;

/** Who reported the acceptance: the page after WeChat's prompt, or WeChat's own server event. */
export type GrantSource = 'client' | 'wechat';

export interface GrantInput {
  templateKey: WechatTemplateKey;
  templateId: string;
  /** The tap's scene (unknown for WeChat's own event). */
  scene?: WechatSubscribeScene | null;
  /** The thing the tap was for (e.g. the campus event id); unknown for WeChat's own event. */
  eventId?: string | null;
  /** Default 'client'. */
  source?: GrantSource;
  /**
   * Same report seen twice (WeChat retries a server message it got no answer
   * to within 5 s): a second report with this key changes nothing.
   */
  dedupeKey?: string | null;
}

export interface ClaimedGrant {
  id: string;
  templateId: string | null;
}

export interface NotifyCnRepo {
  /** The person's openid under the 公众号, or null when the account is not linked. */
  mpOpenId(userId: string, brand: BrandId, appId: string): Promise<string | null>;
  /** The account linked to a 公众号 openid, or null. */
  userForOpenId(openid: string, brand: BrandId, appId: string): Promise<string | null>;
  /**
   * Store accepted prompts (capped per template; a second report of the same
   * acceptance pairs with the first instead of adding a row). Returns, per
   * template, how many acceptances are now on record from this call.
   */
  addGrants(userId: string, brand: BrandId, grants: GrantInput[], now: Date): Promise<Partial<Record<WechatTemplateKey, number>>>;
  /**
   * Take one live grant for the template (atomic): the oldest one given for
   * `eventId` when there is one, else the oldest. Null when there is none.
   */
  claimGrant(userId: string, brand: BrandId, templateKey: WechatTemplateKey, now: Date, eventId?: string | null): Promise<ClaimedGrant | null>;
  /** Give a claimed grant back (the send failed for a reason that did not use it up). */
  releaseGrant(id: string): Promise<void>;
  /** Use up every live grant for the template (the person turned it off in WeChat). */
  revokeGrants(userId: string, brand: BrandId, templateKey: WechatTemplateKey, now: Date): Promise<number>;
  /** Stamp the in-app row as delivered to another channel. */
  markDelivered(notificationId: string, at: Date): Promise<void>;
}

async function defaultDb(): Promise<NotifyCnDb> {
  return (await import('../../lib/prisma.js')).default;
}

function payloadObject(payload: Prisma.JsonValue | null): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

function payloadTemplateId(payload: Prisma.JsonValue | null): string | null {
  const v = payloadObject(payload).templateId;
  return typeof v === 'string' ? v : null;
}

function prismaCode(err: unknown): string | null {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

/** One acceptance inside a transaction: pair with the other source's recent report, else insert under the cap. */
async function addOneGrant(tx: GrantTx, userId: string, brand: BrandId, g: GrantInput, now: Date): Promise<boolean> {
  const kind = grantKind(g.templateKey);
  const source: GrantSource = g.source ?? 'client';
  const other: GrantSource = source === 'client' ? 'wechat' : 'client';
  const recent = await tx.rAAuthToken.findMany({
    where: { userId, brand, kind, createdAt: { gte: new Date(now.getTime() - PAIR_WINDOW_MS) }, expiresAt: { gt: now } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, payload: true },
  });
  if (g.dedupeKey && recent.some((r) => payloadObject(r.payload).dedupeKey === g.dedupeKey)) return true;
  const partner = recent.find((r) => {
    const p = payloadObject(r.payload);
    return p.source === other && p.paired === false && p.templateId === g.templateId;
  });
  if (partner) {
    const p = payloadObject(partner.payload);
    await tx.rAAuthToken.update({
      where: { id: partner.id },
      data: {
        payload: {
          ...(p as Prisma.InputJsonObject),
          paired: true,
          // The page knows what the tap was for; WeChat's event does not.
          ...(source === 'client' && g.scene ? { scene: g.scene } : {}),
          ...(source === 'client' && g.eventId ? { eventId: g.eventId } : {}),
          ...(g.dedupeKey ? { dedupeKey: g.dedupeKey } : {}),
        },
      },
      select: { id: true },
    });
    return true;
  }
  const live = await tx.rAAuthToken.count({ where: { userId, brand, kind, consumedAt: null, expiresAt: { gt: now } } });
  if (live >= MAX_LIVE_GRANTS) return false;
  await tx.rAAuthToken.create({
    data: {
      userId,
      brand,
      kind,
      tokenHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
      payload: {
        templateId: g.templateId,
        ...(g.scene ? { scene: g.scene } : {}),
        ...(g.eventId ? { eventId: g.eventId } : {}),
        source,
        paired: false,
        ...(g.dedupeKey ? { dedupeKey: g.dedupeKey } : {}),
      },
      expiresAt: new Date(now.getTime() + GRANT_TTL_DAYS * 86_400_000),
    },
    select: { id: true },
  });
  return true;
}

export function createPrismaNotifyCnRepo(getDb: () => Promise<NotifyCnDb> = defaultDb): NotifyCnRepo {
  return {
    async mpOpenId(userId, brand, appId) {
      const db = await getDb();
      const row = await db.rAAuthIdentity.findFirst({
        where: { userId, brand, provider: 'wechat', appId },
        orderBy: { lastUsedAt: { sort: 'desc', nulls: 'last' } },
        select: { subject: true },
      });
      return row?.subject ?? null;
    },
    async userForOpenId(openid, brand, appId) {
      const db = await getDb();
      const row = await db.rAAuthIdentity.findFirst({ where: { brand, provider: 'wechat', appId, subject: openid }, select: { userId: true } });
      return row?.userId ?? null;
    },
    async addGrants(userId, brand, grants, now) {
      const db = await getDb();
      const stored: Partial<Record<WechatTemplateKey, number>> = {};
      for (const g of grants) {
        for (let attempt = 1; ; attempt += 1) {
          try {
            const added = await db.$transaction((tx) => addOneGrant(tx as unknown as GrantTx, userId, brand, g, now), { isolationLevel: 'Serializable' });
            if (added) stored[g.templateKey] = (stored[g.templateKey] ?? 0) + 1;
            break;
          } catch (err) {
            if (prismaCode(err) === 'P2034' && attempt < GRANT_TX_ATTEMPTS) continue;
            throw err;
          }
        }
      }
      return stored;
    },
    async claimGrant(userId, brand, templateKey, now, eventId) {
      const db = await getDb();
      // Two tries: a concurrent sender may take the same row first.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const rows = await db.rAAuthToken.findMany({
          where: { userId, brand, kind: grantKind(templateKey), consumedAt: null, expiresAt: { gt: now } },
          orderBy: { createdAt: 'asc' },
          take: MAX_LIVE_GRANTS * 2,
          select: { id: true, payload: true },
        });
        // A grant given for this very event first, so a reminder for another
        // event does not spend it; otherwise any grant for the template.
        const row = (eventId ? rows.find((r) => payloadObject(r.payload).eventId === eventId) : undefined) ?? rows[0];
        if (!row) return null;
        const took = await db.rAAuthToken.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: now } });
        if (took.count === 1) return { id: row.id, templateId: payloadTemplateId(row.payload) };
      }
      return null;
    },
    async releaseGrant(id) {
      const db = await getDb();
      await db.rAAuthToken.updateMany({ where: { id }, data: { consumedAt: null } });
    },
    async revokeGrants(userId, brand, templateKey, now) {
      const db = await getDb();
      const r = await db.rAAuthToken.updateMany({
        where: { userId, brand, kind: grantKind(templateKey), consumedAt: null },
        data: { consumedAt: now },
      });
      return r.count;
    },
    async markDelivered(notificationId, at) {
      const db = await getDb();
      await db.seekerNotification.updateMany({ where: { id: notificationId, pushSentAt: null }, data: { pushSentAt: at } });
    },
  };
}
