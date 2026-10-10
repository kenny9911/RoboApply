// server/src/features/visitor/alerts.ts — logged-out job alerts (WP-78; F-NOTIF-03, F-TOOL-04).
//
// Double opt-in:
//   1. POST /alerts stores a PENDING subscription and emails a confirm link
//      (`/alerts/confirm/<token>`; RAAuthToken `anon_alert_confirm`, 72 h,
//      only the sha256 of the token is stored). The answer is always 202
//      `pending_confirmation`, whether or not the address already has alerts,
//      so the form cannot be used to learn who subscribed.
//   2. The page reads the link (GET, no change — mail scanners open links)
//      and the visitor presses Confirm (POST), which marks it CONFIRMED.
//   3. Only confirmed subscriptions ever get a job email (digest.ts; the
//      platform preference gate checks it again).
// One click out: every alert email carries the signed unsubscribe token
// (list `alerts`, hash of the address); POST /alerts/unsubscribe or the
// shared /unsubscribe/<token> page (WP-39b) marks the address unsubscribed.
//
// Abuse limits: 5 signups a day per IP (429), 3 confirm emails a day per
// address and 5 live alerts per address (beyond those: still 202, nothing sent).

import crypto from 'node:crypto';
import { clampLocaleToBrand, type ProductBrand } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { hashEmail, verifyUnsubscribeToken, type EnvLike } from '../../platform/email/unsubscribe.js';
import type { SendEmailResult } from '../../platform/email/EmailService.js';
import { DAY } from '../../platform/ratelimit/defaults.js';
import {
  ANON_ALERT_CONFIRM_TTL_HOURS,
  ANON_ALERT_TOKEN_KIND,
  AnonAlertFiltersSchema,
  VISITOR_ERROR_CODES,
  VISITOR_LIMITS,
  type AnonAlertCadence,
  type AnonAlertFilters,
  type AnonAlertState,
  type AnonAlertUnsubscribeResponse,
  type AnonAlertView,
  type CreateAnonAlertResponse,
} from './contract.js';
import { VISITOR_EMAIL_TEMPLATES, type AlertConfirmParams } from './emails.js';
import type { AnonAlertRow, VisitorAlertsRepo } from './repo.js';

export interface VisitorRate {
  /** Count one hit for `name`/`id`; false when over the windows. */
  consume(name: string, scope: 'ip' | 'id', id: string, windows: ReadonlyArray<{ limit: number; windowSec: number }>): Promise<{ allowed: boolean; retryAfterSec: number }>;
}

export interface VisitorAlertsDeps {
  repo: VisitorAlertsRepo;
  rate: VisitorRate;
  sendConfirm(input: { brand: ProductBrand; to: string; locale: string; params: AlertConfirmParams }): Promise<SendEmailResult>;
  /** Brand public origin for links (no trailing slash). */
  origin(brand: ProductBrand): string;
  now?: () => Date;
  env?: EnvLike;
  newToken?: () => string;
}

export interface CreateAnonAlertInput {
  email: string;
  filters: AnonAlertFilters;
  frequency: AnonAlertCadence;
  locale: string;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** `j•••@example.com` — enough to recognise one's own address, not to read someone else's. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}•••@${domain}`;
}

/** Stable comparison key of a filter set (order of keys and list items does not matter). */
export function filtersKey(filters: unknown): string {
  const parsed = AnonAlertFiltersSchema.safeParse(filters);
  if (!parsed.success) return JSON.stringify(filters ?? null);
  const f = parsed.data;
  return JSON.stringify({
    q: f.q?.trim().toLowerCase() ?? '',
    t: [...(f.taxonomyIds ?? [])].sort(),
    c: f.country ?? '',
    l: (f.locations ?? []).map((l) => `${(l.city ?? l.label).trim().toLowerCase()}|${(l.country ?? '').toUpperCase()}`).sort(),
    w: [...(f.workModels ?? [])].sort(),
  });
}

/**
 * Visitor text as it may appear in an email: no links (scheme, `www.` or
 * `host.tld/path` words), no `@`, no `<>`, no control characters, whitespace
 * collapsed, at most `max` characters. A bare `word.word` stays (it cannot be
 * told apart from "Node.js" or "ASP.NET").
 * The confirm email goes to whatever address was typed, so typed text must not
 * be able to carry a link or an address into mail sent from the brand's domain.
 */
export function emailSafeText(value: string, max = 120): string {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\S*(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi, ' ')
    .replace(/\S+\.\S+\/\S*/g, ' ')
    .replace(/[@<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** The search in plain words for emails ("Data analyst · Taipei"); '' when nothing narrows it (the email then says "any job"). */
export function searchLabel(filters: AnonAlertFilters): string {
  const parts: string[] = [];
  if (filters.q?.trim()) parts.push(emailSafeText(filters.q));
  if (filters.locations?.length) parts.push(...filters.locations.map((l) => emailSafeText(l.label, 80)));
  else if (filters.country) parts.push(filters.country);
  return parts.filter(Boolean).join(' · ');
}

function readFilters(row: AnonAlertRow): AnonAlertFilters {
  const parsed = AnonAlertFiltersSchema.safeParse(row.filters);
  return parsed.success ? parsed.data : {};
}

function cadenceOf(row: AnonAlertRow): AnonAlertCadence {
  return row.cadence === 'daily' ? 'daily' : 'weekly';
}

function stateOf(row: AnonAlertRow): AnonAlertState {
  return row.status === 'confirmed' || row.status === 'unsubscribed' ? row.status : 'pending';
}

export function alertView(row: AnonAlertRow): AnonAlertView {
  return { state: stateOf(row), cadence: cadenceOf(row), filters: readFilters(row), emailMasked: maskEmail(row.email) };
}

const invalidToken = () => new HttpError('not_found', 'This link is not valid any more.', { reason: VISITOR_ERROR_CODES.alertTokenInvalid });

export class VisitorAlertsService {
  constructor(private readonly deps: VisitorAlertsDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private newToken(): string {
    return (this.deps.newToken ?? (() => crypto.randomBytes(32).toString('base64url')))();
  }

  async create(input: CreateAnonAlertInput, ctx: { brand: ProductBrand; ip: string }): Promise<CreateAnonAlertResponse> {
    const { repo, rate } = this.deps;
    const accepted: CreateAnonAlertResponse = { status: 'pending_confirmation' };
    const perIp = await rate.consume('visitorAlertSignupPerIp', 'ip', ctx.ip, [{ limit: VISITOR_LIMITS.alertSignupsPerIpPerDay, windowSec: DAY }]);
    if (!perIp.allowed) {
      throw new HttpError('rate_limited', 'Too many sign-ups from this network today. Try again tomorrow.', { retryAfterSec: perIp.retryAfterSec }, {
        'Retry-After': String(perIp.retryAfterSec),
      });
    }
    const brand = ctx.brand;
    const email = input.email.trim().toLowerCase();
    const emailHash = hashEmail(email);
    const locale = clampLocaleToBrand(brand, input.locale);
    const key = filtersKey(input.filters);

    const live = await repo.liveByEmail(brand.id, emailHash);
    const same = live.find((r) => filtersKey(r.filters) === key);
    if (same?.status === 'confirmed') {
      // Already on: nothing changes and nothing is sent. Anyone can type an address, so
      // a signup must not alter what the owner confirmed (e.g. weekly → daily). To change
      // the cadence the owner unsubscribes (one click) and signs up again, which asks
      // for a fresh confirmation.
      return accepted;
    }
    if (!same && live.length >= VISITOR_LIMITS.alertsPerEmail) return accepted;

    // Protect the inbox of an address someone else typed: at most 3 confirm emails a day.
    const perEmail = await rate.consume('visitorAlertConfirmPerEmail', 'id', emailHash, [{ limit: VISITOR_LIMITS.alertConfirmsPerEmailPerDay, windowSec: DAY }]);
    if (!perEmail.allowed) return accepted;

    const now = this.now();
    const row = same ?? (await repo.create({ brand: brand.id, email, emailHash, locale, filters: input.filters, cadence: input.frequency }));
    // A re-sent link for a pending sign-up: restart its 72-hour clock too, so the
    // pending purge (by `createdAt`) cannot delete it while the new link still works.
    if (same) await repo.update(same.id, { cadence: input.frequency, locale, createdAt: now });

    const token = this.newToken();
    await repo.createToken({
      brand: brand.id,
      tokenHash: sha256(token),
      subscriptionId: row.id,
      expiresAt: new Date(now.getTime() + ANON_ALERT_CONFIRM_TTL_HOURS * 3_600_000),
    });
    await this.deps.sendConfirm({
      brand,
      to: email,
      locale,
      params: {
        url: `${this.deps.origin(brand)}/alerts/confirm/${encodeURIComponent(token)}`,
        search: searchLabel(input.filters),
        cadence: input.frequency,
        hours: ANON_ALERT_CONFIRM_TTL_HOURS,
      },
    });
    return accepted;
  }

  private async resolve(token: string, brand: ProductBrand): Promise<{ tokenId: string; row: AnonAlertRow }> {
    const t = await this.deps.repo.findToken(sha256(token));
    if (!t || t.kind !== ANON_ALERT_TOKEN_KIND || t.brand !== brand.id) throw invalidToken();
    if (t.expiresAt.getTime() <= this.now().getTime()) throw invalidToken();
    const subscriptionId = (t.payload as { subscriptionId?: unknown } | null)?.subscriptionId;
    if (typeof subscriptionId !== 'string') throw invalidToken();
    const row = await this.deps.repo.find(subscriptionId);
    if (!row || row.brand !== brand.id) throw invalidToken();
    return { tokenId: t.id, row };
  }

  /** What the confirm link is for. Changes nothing. */
  async preview(token: string, brand: ProductBrand): Promise<AnonAlertView> {
    return alertView((await this.resolve(token, brand)).row);
  }

  /** Confirm (idempotent). An address that left the list is not put back by an old link. */
  async confirm(token: string, brand: ProductBrand): Promise<AnonAlertView> {
    const { tokenId, row } = await this.resolve(token, brand);
    const now = this.now();
    if (row.status === 'pending') {
      await this.deps.repo.update(row.id, { status: 'confirmed', confirmedAt: now });
      await this.deps.repo.consumeToken(tokenId, now);
      return alertView({ ...row, status: 'confirmed', confirmedAt: now });
    }
    return alertView(row);
  }

  /** One click: every live alert of the address on this brand stops. */
  async unsubscribe(token: string, brand: ProductBrand): Promise<AnonAlertUnsubscribeResponse> {
    let result;
    try {
      result = verifyUnsubscribeToken(token, { expectedBrand: brand.id, env: this.deps.env });
    } catch {
      throw invalidToken();
    }
    if (!result.ok || !result.payload.emailHash || result.payload.userId) throw invalidToken();
    if (result.payload.list !== 'alerts' && result.payload.list !== 'digest') throw invalidToken();
    await this.deps.repo.unsubscribeByEmailHash(brand.id, result.payload.emailHash, this.now());
    return { unsubscribed: true };
  }
}

/** Template key re-exported for callers wiring `sendConfirm` to EmailService. */
export const ALERT_CONFIRM_TEMPLATE = VISITOR_EMAIL_TEMPLATES.confirm;
