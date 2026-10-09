// server/src/platform/email/EmailService.ts
//
// The brand-aware email platform (ARCHITECTURE.md §8.1, TASK_PLAN.md FND-3):
//
//   await sendEmail({ template: 'auth.password_reset', to, userId, locale, params: { url } });
//
// For every send it:
//   1. takes the brand from the argument (workers) or the current context;
//   2. refuses malformed and `.invalid` addresses (GoApply's placeholder
//      `…@users.goapply.invalid`, CN plan L-8) → `suppressed`;
//   3. for non-transactional mail (alerts, tips, marketing) asks the
//      preference gate (WP-39a registers it; none registered → suppressed:
//      nothing promotional goes out by default);
//   4. picks the transport by brand: RoboApply → Resend; GoApply →
//      `CN_EMAIL_TRANSPORT` (`resend` with `CN_EMAIL_FROM`, `aliyun_dm` —
//      registered here, live once WP-15 fills its stub — unset/`none` → no email, matching the
//      `notify.email` capability);
//   5. renders the template in the brand × locale, wraps it in the shell, and
//      for non-transactional mail adds the signed unsubscribe link and the
//      RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers;
//   6. writes one `RAEmailLog` row (status sent | failed | suppressed; the
//      address is stored only as sha256).
// It never throws for delivery problems; it returns the outcome.

import prisma from '../../lib/prisma.js';
import { getCurrentBrand } from '../brand/brandContext.js';
import { brandEnv, type EnvSource } from '../brand/brandEnv.js';
import { getBrand, type BrandId, type ProductBrand } from '../brand/registry.js';
import { requirementsMet } from '../flags.js';
import { logger } from '../../services/LoggerService.js';
import { createEmailTranslator } from './i18n.js';
import { renderShell, type EmailCategory } from './templates/_shell.js';
import { defaultListFor, getEmailTemplate, type EmailTemplate } from './templates/registry.js';
import { createResendTransport, type EmailMessage, type EmailTransport } from './transports/resend.js';
import { createAliyunDmTransport } from './transports/aliyunDirectMail.js';
import {
  createUnsubscribeToken,
  hashEmail,
  listUnsubscribeHeaders,
  unsubscribeUrls,
  type UnsubscribeList,
} from './unsubscribe.js';

export type EmailDb = Pick<typeof prisma, 'rAEmailLog'>;

export type SendStatus = 'sent' | 'failed' | 'suppressed';

export type SuppressReason =
  | 'invalid_address'
  | 'placeholder_address'
  | 'transport_not_configured'
  | 'preference_off'
  | 'no_preference_gate'
  | 'unsubscribe_unavailable';

export interface SendEmailInput<P = Record<string, unknown>> {
  template: string | EmailTemplate<P>;
  to: string;
  userId?: string | null;
  /** Recipient locale; clamped to the brand's locales (default: the brand's default). */
  locale?: string | null;
  params: P;
  /** Explicit brand (workers/crons); otherwise the current unit of work's brand. */
  brand?: BrandId | ProductBrand;
}

export interface SendEmailResult {
  status: SendStatus;
  provider?: string;
  providerId?: string;
  reason?: SuppressReason | string;
}

/** Decides whether a non-transactional email may go to this person (WP-39a). */
export type EmailPreferenceGate = (input: {
  brand: ProductBrand;
  userId: string | null;
  email: string;
  category: Exclude<EmailCategory, 'transactional'>;
  list: UnsubscribeList;
  template: string;
}) => Promise<boolean>;

// ── Configuration seams ──────────────────────────────────────────────────

let preferenceGate: EmailPreferenceGate | null = null;

/** WP-39a registers the preference/consent check for alerts, tips and marketing. */
export function setEmailPreferenceGate(gate: EmailPreferenceGate | null): void {
  preferenceGate = gate;
}

/** Default transports, registered statically (WP-15 fills transports/aliyunDirectMail.ts in place). */
function defaultTransports(): Array<[string, EmailTransport]> {
  return [
    ['resend', createResendTransport()],
    ['aliyun_dm', createAliyunDmTransport()],
  ];
}

const transports = new Map<string, EmailTransport>(defaultTransports());

/** Register or replace a transport by name (tests inject fakes). */
export function registerEmailTransport(name: string, transport: EmailTransport): void {
  transports.set(name, transport);
}

/** Tests only: restore the default transport set. */
export function resetEmailTransportsForTests(): void {
  transports.clear();
  for (const [name, t] of defaultTransports()) transports.set(name, t);
  preferenceGate = null;
}

/** Transport name for the brand: 'resend' for RoboApply; `CN_EMAIL_TRANSPORT` for GoApply ('none' when unset). */
export function transportNameFor(brand: ProductBrand, env: EnvSource = process.env): string {
  if (brand.market !== 'cn') return 'resend';
  const v = (env.CN_EMAIL_TRANSPORT || '').trim().toLowerCase();
  return v === 'resend' || v === 'aliyun_dm' ? v : 'none';
}

/** The configured transport, or null (no email on this brand/deployment). */
export function transportFor(brand: ProductBrand, env: EnvSource = process.env): EmailTransport | null {
  if (!requirementsMet('notify.email', brand, env)) return null;
  const t = transports.get(transportNameFor(brand, env));
  return t && t.isConfigured() ? t : null;
}

const ADDRESS_RE = /<([^<>\s]+@[^<>\s]+)>/;

/** Extract `a@b.c` from `Name <a@b.c>` or a bare address. */
export function addressOf(from: string): string | null {
  const m = ADDRESS_RE.exec(from);
  const addr = (m ? m[1] : from).trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : null;
}

/**
 * From header: always the brand's display name, with the address from config.
 * RoboApply reads `ROBOAPPLY_EMAIL_FROM` (the product sender today), then
 * `EMAIL_FROM`; GoApply reads only `CN_EMAIL_FROM` (R-03, no fallback to the
 * international sender). The registry address is the last resort.
 */
export function fromFor(brand: ProductBrand, env: EnvSource = process.env): string {
  const candidates =
    brand.market === 'cn'
      ? [brandEnv(brand, 'EMAIL_FROM', env)]
      : [env.ROBOAPPLY_EMAIL_FROM?.trim(), brandEnv(brand, 'EMAIL_FROM', env)];
  const address = candidates.map((c) => (c ? addressOf(c) : null)).find(Boolean) ?? brand.email.fromAddress;
  return `${brand.email.fromName} <${address}>`;
}

/** Reply-To only when ops configured a support mailbox (`SUPPORT_EMAIL` / `CN_SUPPORT_EMAIL`). */
export function replyToFor(brand: ProductBrand, env: EnvSource = process.env): string | undefined {
  const v = brandEnv(brand, 'SUPPORT_EMAIL', env);
  return v && addressOf(v) ? (addressOf(v) as string) : undefined;
}

/** Public origin for links: `CANONICAL_ORIGIN` / `CN_CANONICAL_ORIGIN`, else the registry origin. */
export function emailOrigin(brand: ProductBrand, env: EnvSource = process.env): string {
  return (brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin).replace(/\/+$/, '');
}

// ── Addresses ────────────────────────────────────────────────────────────

export function classifyAddress(to: string): 'ok' | 'invalid_address' | 'placeholder_address' {
  const addr = (to ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return 'invalid_address';
  if (addr.endsWith('.invalid')) return 'placeholder_address';
  return 'ok';
}

// ── Send ─────────────────────────────────────────────────────────────────

function toBrand(b: SendEmailInput['brand']): ProductBrand {
  if (!b) return getCurrentBrand();
  return typeof b === 'string' ? getBrand(b) : b;
}

export interface EmailServiceDeps {
  db?: EmailDb;
  env?: EnvSource;
  now?: () => Date;
}

export async function sendEmail<P>(input: SendEmailInput<P>, deps: EmailServiceDeps = {}): Promise<SendEmailResult> {
  const env = deps.env ?? process.env;
  const brand = toBrand(input.brand);
  const template = typeof input.template === 'string' ? getEmailTemplate(input.template) : input.template;
  if (!template) throw new Error(`email: unknown template "${String(input.template)}"`);
  const userId = input.userId ?? null;
  const log = (r: SendEmailResult) => writeLog(deps.db ?? prisma, brand, template.key, input.to, userId, r);

  const addr = classifyAddress(input.to);
  if (addr !== 'ok') return log({ status: 'suppressed', reason: addr });

  const category = template.category;
  const list = category === 'transactional' ? undefined : (template.list ?? defaultListFor(category));
  if (category !== 'transactional') {
    if (!preferenceGate) return log({ status: 'suppressed', reason: 'no_preference_gate' });
    let allowed = false;
    try {
      allowed = await preferenceGate({ brand, userId, email: input.to, category, list: list!, template: template.key });
    } catch (err) {
      logger.warn('EMAIL', 'preference gate failed; not sending', { template: template.key, error: errText(err) });
      allowed = false;
    }
    if (!allowed) return log({ status: 'suppressed', reason: 'preference_off' });
  }

  const transport = transportFor(brand, env);
  if (!transport) return log({ status: 'suppressed', reason: 'transport_not_configured' });

  const origin = emailOrigin(brand, env);
  let message: EmailMessage;
  try {
    const t = createEmailTranslator(brand, input.locale ?? brand.defaultLocale);
    const body = template.render({ brand, t, params: input.params, origin, userId });
    let unsubscribeUrl: string | undefined;
    let headers: Record<string, string> = {};
    if (list) {
      let token: string;
      try {
        token = createUnsubscribeToken({ brand: brand.id, list, userId, email: input.to, template: template.key, now: deps.now?.(), env });
      } catch (err) {
        logger.error('EMAIL', 'cannot sign unsubscribe link; not sending', { template: template.key, error: errText(err) });
        return log({ status: 'suppressed', reason: 'unsubscribe_unavailable' });
      }
      const urls = unsubscribeUrls(origin, token);
      unsubscribeUrl = urls.page;
      headers = listUnsubscribeHeaders(urls.oneClick);
    }
    const shell = renderShell({
      brand,
      t,
      category,
      bodyHtml: body.bodyHtml,
      bodyText: body.bodyText,
      preheader: body.preheader,
      reasonText: body.reasonText,
      unsubscribeUrl,
      preferencesUrl: `${origin}/settings#notifications`,
      env,
    });
    message = {
      from: fromFor(brand, env),
      to: [input.to.trim()],
      subject: body.subject,
      html: shell.html,
      text: shell.text,
      replyTo: replyToFor(brand, env),
      headers,
    };
  } catch (err) {
    logger.error('EMAIL', `render failed for ${template.key}`, { error: errText(err) });
    return log({ status: 'failed', reason: `render_failed: ${errText(err)}` });
  }

  const sent = await transport.send(message);
  if (sent.ok) return log({ status: 'sent', provider: transport.name, providerId: sent.providerId });
  logger.warn('EMAIL', `send failed for ${template.key}`, { provider: transport.name, error: sent.error });
  return log({ status: 'failed', provider: transport.name, reason: sent.error });
}

async function writeLog(
  db: EmailDb,
  brand: ProductBrand,
  template: string,
  to: string,
  userId: string | null,
  result: SendEmailResult,
): Promise<SendEmailResult> {
  try {
    await db.rAEmailLog.create({
      data: {
        brand: brand.id,
        userId,
        template,
        toHash: hashEmail(to ?? ''),
        provider: result.provider ?? transportNameFor(brand),
        providerId: result.providerId ?? null,
        status: result.status,
        error: result.reason ? String(result.reason).slice(0, 1000) : null,
      },
    });
  } catch (err) {
    // The log must never decide whether mail goes out.
    logger.warn('EMAIL', 'RAEmailLog write failed', { template, error: errText(err) });
  }
  return result;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Object form for callers that prefer a service instance. */
export const platformEmailService = {
  send: sendEmail,
  transportFor,
  fromFor,
  emailOrigin,
  setPreferenceGate: setEmailPreferenceGate,
  registerTransport: registerEmailTransport,
};
