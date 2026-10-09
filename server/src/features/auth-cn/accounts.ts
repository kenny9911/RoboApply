// server/src/features/auth-cn/accounts.ts — GoApply account creation, sessions and
// sign-in routing shared by the phone and WeChat flows.
//
// A phone- or WeChat-only account has no real email. `User.email` is unique
// and required, so it gets a placeholder `u-<random>@users.goapply.invalid`
// with `emailIsPlaceholder = true`; the email platform refuses every
// `.invalid` address, so a placeholder never receives mail (CN plan L-8).
//
// New accounts are brand-stamped, start at onboarding stage `account`
// written explicitly (R-06), and record the signup consents in the same
// transaction as the user row.

import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { clampLocaleToBrand, type BrandId, type ProductBrand } from '../../platform/brand/registry.js';
import { isEnabled } from '../../platform/flags.js';
import { buildCookieOptions, SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import { createSeekerSession } from '../../roboapply/engine/lib/seekerSession.js';
import { firstValueRoute, nextStage, routeForStage, isStageOfBrand } from '../onboarding/index.js';
import type { ConsentInput } from './contract.js';
import type { AuthCnTx } from './db.js';

export const PLACEHOLDER_EMAIL_DOMAIN = 'users.goapply.invalid';

export function placeholderEmail(): string {
  return `u-${crypto.randomBytes(12).toString('hex')}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.toLowerCase().endsWith('.invalid');
}

/** A same-site relative path or null (no `//host`, no backslash tricks). */
export function safeNext(next: string | null | undefined): string | null {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : null;
}

export interface NewAccountInput {
  brand: ProductBrand;
  provider: 'phone' | 'wechat';
  phoneE164?: string | null;
  consents: ConsentInput[];
  locale?: string | null;
  next?: string | null;
  now: Date;
}

/** Creates User + SeekerProfile + consent rows inside `tx`. Returns the user id. */
export async function createGoApplyAccount(tx: AuthCnTx, input: NewAccountInput): Promise<string> {
  const { brand, now } = input;
  const user = await tx.user.create({
    data: {
      email: placeholderEmail(),
      emailIsPlaceholder: true,
      passwordHash: null,
      provider: input.provider,
      role: 'seeker',
      roles: ['seeker'],
      brand: brand.id,
      market: brand.market === 'cn' ? 'cn' : 'other',
      phoneE164: input.phoneE164 ?? null,
      phoneVerifiedAt: input.phoneE164 ? now : null,
    },
    select: { id: true },
  });
  const jobMatch = safeNext(input.next)?.match(/^\/jobs\/([A-Za-z0-9_-]{1,64})$/);
  const profile = await tx.seekerProfile.create({
    data: {
      userId: user.id,
      source: 'organic',
      locale: clampLocaleToBrand(brand, input.locale),
      market: brand.market === 'cn' ? 'cn' : 'other',
      onboardingStep: 'account',
      onboardingStartedAt: now,
      ...(jobMatch ? { onboardingEntry: { jobId: jobMatch[1] } } : {}),
    },
    select: { id: true },
  });
  for (const c of input.consents) {
    await tx.seekerConsentRecord.create({
      data: { seekerProfileId: profile.id, consentType: c.type, granted: c.granted, proseVersion: c.proseVersion },
    });
  }
  return user.id;
}

const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function sameSite(): 'lax' | 'strict' | 'none' {
  const configured = (process.env.COOKIE_SAME_SITE || 'lax').toLowerCase();
  return configured === 'strict' ? 'strict' : configured === 'none' ? 'none' : 'lax';
}

export type SessionIssuer = (userId: string) => Promise<{ token: string }>;

export const defaultSessionIssuer: SessionIssuer = (userId) => createSeekerSession(userId);

/** Creates a DB session and sets the `ra_session_token` cookie (same constant as the legacy login). */
export async function issueSessionCookie(req: Request, res: Response, userId: string, issue: SessionIssuer): Promise<string> {
  const { token } = await issue(userId);
  res.cookie(SESSION_COOKIE_NAME, token, buildCookieOptions(req, { sameSite: sameSite(), maxAge: SESSION_COOKIE_MAX_AGE_MS }));
  return token;
}

/** The caller's session token (cookie or `X-Session-Token`), to keep it when revoking the others. */
export function currentSessionToken(req: Request): string | null {
  const cookie = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE_NAME];
  if (cookie) return cookie;
  const header = req.headers['x-session-token'];
  return typeof header === 'string' && header ? header : null;
}

/** First-value route for GoApply (R-14: /campus → /jobs → /resume). */
export async function firstValueFor(brand: ProductBrand, env: EnvSource): Promise<string> {
  const [campusCalendar, jobsFeed] = await Promise.all([
    isEnabled('jobs.campusCalendar', { brand, env }),
    isEnabled('jobs.feed', { brand, env }),
  ]);
  return firstValueRoute(brand.id, { campusCalendar, jobsFeed });
}

/**
 * Where a sign-in lands: the unfinished onboarding stage (stage `account` →
 * the stage after it), else the requested `next`, else the first-value route.
 */
export async function routeAfterSignIn(
  brand: ProductBrand,
  env: EnvSource,
  onboardingStep: string | null | undefined,
  next: string | null | undefined,
): Promise<string> {
  const id: BrandId = brand.id;
  const step = onboardingStep && isStageOfBrand(id, onboardingStep) ? onboardingStep : 'done';
  if (step !== 'done') {
    const stage = step === 'account' ? nextStage(id, 'account', null) : step;
    if (stage === 'tour') return firstValueFor(brand, env);
    const route = stage === 'done' ? null : routeForStage(id, stage, {});
    if (route) return route;
  }
  return safeNext(next) ?? (await firstValueFor(brand, env));
}
