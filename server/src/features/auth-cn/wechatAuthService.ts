// server/src/features/auth-cn/wechatAuthService.ts — WeChat sign-in (web QR, 公众号,
// mini program) and WeChat re-verification for a phone change
// (TASK_PLAN.md WP-11; PRODUCT_PLAN.md G0 #5, F-ONB-11 cn, F-MOB-06 seam).
//
// Matching (acceptance "unionId merges identities"): an identity is looked up
// by (brand, 'wechat', appId, openid); when that misses and WeChat returned a
// `unionid`, any WeChat identity of the brand with the same unionid names the
// account, and the new app's openid is attached to it. Only then is a new
// account created (signup gate, consents given before the round trip,
// invite in invite mode).
//
// OAuth state: a single-use `RAAuthToken(kind 'oauth_state')`, stored hashed,
// 10 minutes, bound to the brand, the flow AND the browser that started it:
// `startUrl` also returns a random nonce that the route puts in a short-lived
// httpOnly cookie, and the state keeps only sha256(nonce). A callback whose
// browser does not hold that cookie is refused (oauth_state_invalid), so a
// callback URL someone else started cannot sign this browser into their
// account (login CSRF).
//
// Consents: a new WeChat account records the signup consents only when the
// sign-in was started with them in a POST body (`POST /auth/wechat/start`,
// validated by checkSignupConsents and stored in the state). The GET start
// routes never carry consents, so a shared or crafted link can never record
// them; a NEW account started that way ends with consent_required.
//
// A WeChat account without a verified phone must bind one before any AI
// feature (phone_binding_required) while a phone can be bound on this
// deployment (an SMS provider is live; phoneBinding.ts). The callback then
// tells the web client (`bind=1`) so it goes to /bind-phone first. With no SMS
// provider nothing is asked and the account uses AI like any other.

import crypto from 'node:crypto';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import type { FetchLike } from '../../platform/sms/index.js';
import { WECHAT_RETURN_PATH, type ConsentInput, type WechatReturnQuery } from './contract.js';
import { createGoApplyAccount, routeAfterSignIn, safeNext } from './accounts.js';
import { isUniqueViolation, type AuthCnDb } from './db.js';
import type { RawSignals } from '../growth/index.js';
import { AuthCnError } from './errors.js';
import { afterAccountCreated, afterPhoneBound, afterWechatLinked, cleanRef, type AccountHooks } from './hooks.js';
import { redeemInviteIn } from './inviteService.js';
import { sha256 } from './phoneAuthService.js';
import { assertSignupOpen, checkSignupConsents, cnSignupMode, publicOrigin } from './signupPolicy.js';
import {
  exchangeOauthCode,
  miniCodeToSession,
  miniPhoneNumber,
  mpAuthorizeUrl,
  qrConnectUrl,
  wechatApp,
  WechatApiError,
  type WechatApp,
  type WechatIdentity,
} from './wechat/client.js';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const REVERIFY_TTL_MS = 10 * 60 * 1000;

export interface WechatAuthDeps {
  db: AuthCnDb;
  env: EnvSource;
  now: () => Date;
  fetch: FetchLike;
  /** Invite attribution, invite check and the phone practice credit (hooks.ts). Absent = none run. */
  hooks?: AccountHooks;
}

interface StatePayload {
  provider: 'wechat';
  flow: 'web' | 'mp';
  next: string | null;
  /** Signup consents validated at start (POST body); null when none were given. */
  consents: ConsentInput[] | null;
  invite: string | null;
  /** The invite-friends code from the signup link (`?ref=`); used only when the account turns out to be new. */
  ref: string | null;
  purpose: 'signin' | 'reverify';
  /** sha256 of the browser-binding nonce (cookie). */
  nonceHash: string;
}

export type WechatCallbackOutcome =
  | { kind: 'session'; userId: string; isNew: boolean; phoneBound: boolean; nextRoute: string }
  | { kind: 'reverify'; token: string }
  | { kind: 'error'; code: string };

/** Relative URL of the web return page (same origin as the API in production; rewritten in dev). */
export function returnLocation(q: WechatReturnQuery): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  return `${WECHAT_RETURN_PATH}?${params.toString()}`;
}

function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function parseConsents(raw: unknown): ConsentInput[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ConsentInput[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') return null;
    const r = c as Record<string, unknown>;
    if (typeof r.type !== 'string' || typeof r.granted !== 'boolean' || typeof r.proseVersion !== 'string') return null;
    // The hash of the text the form showed rides with the pending sign-in, so the row written at the callback names it.
    const proseHash = typeof r.proseHash === 'string' && /^[0-9a-f]{64}$/.test(r.proseHash) ? r.proseHash : undefined;
    out.push({ type: r.type, granted: r.granted, proseVersion: r.proseVersion, ...(proseHash ? { proseHash } : {}) });
  }
  return out;
}

function parsePayload(raw: unknown): StatePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.provider !== 'wechat' || (p.flow !== 'web' && p.flow !== 'mp')) return null;
  if (typeof p.nonceHash !== 'string' || !p.nonceHash) return null;
  return {
    provider: 'wechat',
    flow: p.flow,
    next: typeof p.next === 'string' ? p.next : null,
    consents: parseConsents(p.consents),
    invite: typeof p.invite === 'string' ? p.invite : null,
    ref: typeof p.ref === 'string' ? cleanRef(p.ref) : null,
    purpose: p.purpose === 'reverify' ? 'reverify' : 'signin',
    nonceHash: p.nonceHash,
  };
}

function nonceMatches(nonce: string | null | undefined, expectedHash: string): boolean {
  if (!nonce) return false;
  const a = Buffer.from(sha256(nonce), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export function createWechatAuthService(deps: WechatAuthDeps) {
  const { db } = deps;

  function appFor(flow: 'web' | 'mp' | 'mini'): WechatApp {
    const app = wechatApp(flow, deps.env);
    if (!app) throw new HttpError('feature_disabled');
    return app;
  }

  async function findLinkedUser(brand: ProductBrand, app: WechatApp, identity: WechatIdentity): Promise<string | null> {
    const now = deps.now();
    const direct = await db.rAAuthIdentity.findFirst({
      where: { brand: brand.id, provider: 'wechat', appId: app.appId, subject: identity.openid },
      select: { id: true, userId: true, unionId: true },
    });
    if (direct) {
      await db.rAAuthIdentity.update({
        where: { id: direct.id },
        data: { lastUsedAt: now, ...(identity.unionid && !direct.unionId ? { unionId: identity.unionid } : {}) },
      });
      return direct.userId;
    }
    if (!identity.unionid) return null;
    const sibling = await db.rAAuthIdentity.findFirst({
      where: { brand: brand.id, provider: 'wechat', unionId: identity.unionid },
      select: { userId: true },
    });
    if (!sibling) return null;
    await linkIdentity(brand, sibling.userId, app, identity);
    await afterWechatLinked(deps.hooks, sibling.userId);
    return sibling.userId;
  }

  async function linkIdentity(brand: ProductBrand, userId: string, app: WechatApp, identity: WechatIdentity): Promise<void> {
    try {
      await db.rAAuthIdentity.create({
        data: { userId, brand: brand.id, provider: 'wechat', appId: app.appId, subject: identity.openid, unionId: identity.unionid, lastUsedAt: deps.now() },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // a parallel callback linked it already
    }
  }

  async function assertUsable(userId: string): Promise<{ phoneBound: boolean; onboardingStep: string }> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { isActive: true, phoneE164: true, phoneVerifiedAt: true } });
    if (!user) throw new HttpError('unauthorized');
    if (user.isActive === false) throw new HttpError('forbidden', 'This account has been suspended.');
    const profile = await db.seekerProfile.findUnique({ where: { userId }, select: { deletedAt: true, onboardingStep: true } });
    if (profile?.deletedAt) throw new HttpError('forbidden', 'This account has been deleted.');
    return { phoneBound: Boolean(user.phoneE164 && user.phoneVerifiedAt), onboardingStep: profile?.onboardingStep ?? 'done' };
  }

  async function createWechatAccount(input: {
    brand: ProductBrand;
    app: WechatApp;
    identity: WechatIdentity;
    consents: ConsentInput[];
    invite: string | null;
    phoneE164?: string | null;
    next?: string | null;
    locale?: string | null;
    ref?: string | null;
    signals?: RawSignals;
  }): Promise<string> {
    const inviteRequired = cnSignupMode(deps.env) === 'invite';
    if (inviteRequired && !input.invite) throw new AuthCnError('invite_invalid', { missing: true });
    const userId = await db.$transaction(async (tx) => {
      if (inviteRequired && input.invite) await redeemInviteIn(tx, input.brand.id, input.invite, deps.now());
      const userId = await createGoApplyAccount(tx, {
        brand: input.brand,
        provider: 'wechat',
        phoneE164: input.phoneE164 ?? null,
        consents: input.consents,
        locale: input.locale,
        next: input.next,
        now: deps.now(),
      });
      await tx.rAAuthIdentity.create({
        data: {
          userId,
          brand: input.brand.id,
          provider: 'wechat',
          appId: input.app.appId,
          subject: input.identity.openid,
          unionId: input.identity.unionid,
          lastUsedAt: deps.now(),
        },
      });
      return userId;
    });
    await afterAccountCreated(deps.hooks, userId, {
      ref: input.ref,
      signals: input.signals,
      phoneVerified: Boolean(input.phoneE164),
      now: deps.now(),
    });
    return userId;
  }

  return {
    /**
     * Builds the WeChat authorize URL and stores the single-use state.
     * `consents` (POST start only) are validated now — 422 consent_required
     * when incomplete — and recorded only if the WeChat account turns out to
     * be new. The returned `nonce` must be set as the browser-binding cookie.
     */
    async startUrl(input: {
      brand: ProductBrand;
      flow: 'web' | 'mp';
      next?: string;
      consents?: ConsentInput[];
      invite?: string;
      /** The invite-friends code from the signup link (`?ref=`). */
      ref?: string | null;
      purpose?: 'signin' | 'reverify';
      userId?: string | null;
    }): Promise<{ url: string; nonce: string }> {
      const app = appFor(input.flow);
      const purpose = input.purpose ?? 'signin';
      if (purpose === 'reverify' && !input.userId) throw new HttpError('unauthorized');
      const consents = purpose === 'signin' && input.consents !== undefined ? await checkSignupConsents(input.consents, input.brand, deps.env) : null;
      const raw = randomToken();
      const nonce = randomToken();
      const payload: StatePayload = {
        provider: 'wechat',
        flow: input.flow,
        next: safeNext(input.next),
        consents,
        invite: input.invite ?? null,
        ref: purpose === 'signin' ? cleanRef(input.ref) : null,
        purpose,
        nonceHash: sha256(nonce),
      };
      await db.rAAuthToken.create({
        data: {
          brand: input.brand.id,
          kind: 'oauth_state',
          tokenHash: sha256(raw),
          userId: purpose === 'reverify' ? (input.userId as string) : null,
          payload: { ...payload },
          expiresAt: new Date(deps.now().getTime() + OAUTH_STATE_TTL_MS),
        },
      });
      const origin = publicOrigin(input.brand, deps.env);
      const redirectUri = `${origin}/api/v1/roboapply/auth/wechat/${input.flow === 'mp' ? 'mp/callback' : 'callback'}`;
      const url = input.flow === 'mp' ? mpAuthorizeUrl(app.appId, redirectUri, raw) : qrConnectUrl(app.appId, redirectUri, raw);
      return { url, nonce };
    },

    /** Handles the OAuth return. Never throws for user-facing failures; returns an `error` outcome. */
    async callback(input: {
      brand: ProductBrand;
      flow: 'web' | 'mp';
      code?: string;
      state?: string;
      /** The browser-binding nonce from the cookie set at start. */
      nonce?: string | null;
      locale?: string | null;
      /** Risk signals of the callback request (the same browser that started), for the invite check. */
      signals?: RawSignals;
    }): Promise<WechatCallbackOutcome> {
      const now = deps.now();
      if (!input.state) return { kind: 'error', code: 'oauth_state_invalid' };
      const stateRow = await db.rAAuthToken.findUnique({
        where: { tokenHash: sha256(input.state) },
        select: { id: true, brand: true, kind: true, userId: true, payload: true, expiresAt: true, consumedAt: true },
      });
      const payload = parsePayload(stateRow?.payload);
      if (
        !stateRow ||
        !payload ||
        stateRow.kind !== 'oauth_state' ||
        stateRow.brand !== input.brand.id ||
        stateRow.consumedAt ||
        stateRow.expiresAt.getTime() <= now.getTime() ||
        payload.flow !== input.flow ||
        !nonceMatches(input.nonce, payload.nonceHash)
      ) {
        return { kind: 'error', code: 'oauth_state_invalid' };
      }
      const spent = await db.rAAuthToken.updateMany({ where: { id: stateRow.id, consumedAt: null }, data: { consumedAt: now } });
      if (spent.count !== 1) return { kind: 'error', code: 'oauth_state_invalid' };
      if (!input.code) return { kind: 'error', code: 'wechat_denied' };

      const app = appFor(input.flow);
      let identity: WechatIdentity;
      try {
        identity = await exchangeOauthCode(app, input.code, deps.fetch);
      } catch (err) {
        if (err instanceof WechatApiError) return { kind: 'error', code: 'wechat_failed' };
        throw err;
      }

      try {
        const linked = await findLinkedUser(input.brand, app, identity);

        if (payload.purpose === 'reverify') {
          if (!linked || linked !== stateRow.userId) return { kind: 'error', code: 'identity_proof_invalid' };
          const token = randomToken();
          await db.rAAuthToken.create({
            data: {
              brand: input.brand.id,
              kind: 'wechat_reverify',
              tokenHash: sha256(token),
              userId: linked,
              expiresAt: new Date(now.getTime() + REVERIFY_TTL_MS),
            },
          });
          return { kind: 'reverify', token };
        }

        let userId = linked;
        let isNew = false;
        if (!userId) {
          assertSignupOpen(deps.env);
          if (!payload.consents) throw new AuthCnError('consent_required');
          userId = await createWechatAccount({
            brand: input.brand,
            app,
            identity,
            // Checked again: the text may have changed while the person was at WeChat (then `consent_required`, and the form asks again).
            consents: await checkSignupConsents(payload.consents, input.brand, deps.env),
            invite: payload.invite,
            next: payload.next,
            locale: input.locale,
            ref: payload.ref,
            signals: input.signals,
          });
          isNew = true;
        }
        const state = await assertUsable(userId);
        return {
          kind: 'session',
          userId,
          isNew,
          phoneBound: state.phoneBound,
          nextRoute: await routeAfterSignIn(input.brand, deps.env, isNew ? 'account' : state.onboardingStep, payload.next),
        };
      } catch (err) {
        if (err instanceof AuthCnError) return { kind: 'error', code: err.code };
        if (err instanceof HttpError && (err.code === 'forbidden' || err.code === 'unauthorized')) return { kind: 'error', code: err.code };
        throw err;
      }
    },

    /** Mini-program sign-in (API only). Optional `phoneCode` binds the WeChat-verified number. */
    async miniLogin(input: {
      brand: ProductBrand;
      code: string;
      phoneCode?: string;
      consents?: ConsentInput[];
      inviteCode?: string;
      locale?: string | null;
      ref?: string | null;
      signals?: RawSignals;
    }): Promise<{ userId: string; isNewUser: boolean; phoneBound: boolean; nextRoute: string }> {
      const app = appFor('mini');
      let identity: WechatIdentity;
      let phone: string | null = null;
      try {
        identity = await miniCodeToSession(app, input.code, deps.fetch);
        if (input.phoneCode) phone = await miniPhoneNumber(app, input.phoneCode, deps.fetch);
      } catch (err) {
        if (err instanceof WechatApiError) throw new AuthCnError('wechat_failed');
        throw err;
      }

      let userId = await findLinkedUser(input.brand, app, identity);
      let isNew = false;
      if (!userId && phone) {
        const owner = await db.user.findFirst({ where: { brand: input.brand.id, phoneE164: phone }, select: { id: true } });
        if (owner) {
          await linkIdentity(input.brand, owner.id, app, identity);
          await afterWechatLinked(deps.hooks, owner.id);
          userId = owner.id;
        }
      }
      if (!userId) {
        assertSignupOpen(deps.env);
        const consents = await checkSignupConsents(input.consents, input.brand, deps.env);
        userId = await createWechatAccount({
          brand: input.brand,
          app,
          identity,
          consents,
          invite: input.inviteCode ?? null,
          phoneE164: phone,
          locale: input.locale,
          ref: input.ref,
          signals: input.signals,
        });
        isNew = true;
      } else if (phone) {
        const me = await db.user.findUnique({ where: { id: userId }, select: { phoneE164: true } });
        if (!me?.phoneE164) {
          const other = await db.user.findFirst({ where: { brand: input.brand.id, phoneE164: phone }, select: { id: true } });
          if (other && other.id !== userId) throw new AuthCnError('phone_taken');
          await db.user.update({ where: { id: userId }, data: { phoneE164: phone, phoneVerifiedAt: deps.now() } });
          await afterPhoneBound(deps.hooks, userId);
        }
      }
      const state = await assertUsable(userId);
      return {
        userId,
        isNewUser: isNew,
        phoneBound: state.phoneBound,
        nextRoute: await routeAfterSignIn(input.brand, deps.env, isNew ? 'account' : state.onboardingStep, null),
      };
    },
  };
}

export type WechatAuthService = ReturnType<typeof createWechatAuthService>;
