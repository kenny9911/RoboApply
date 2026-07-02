import { createRequire } from 'module';

/**
 * Business-email-only signup gate.
 *
 * Blocklist model (the industry standard — HubSpot's "block free email
 * providers", etc.): allow ANY domain EXCEPT known free/personal webmail
 * providers and disposable/temporary inboxes. You can't enumerate every company
 * domain, so we reject the finite set of consumer providers and let real company
 * / .edu / .gov / custom domains through.
 *
 * Data sources (maintained, data-only, zero-dependency npm packages):
 *   - free-email-domains       — ~12.7k free/personal webmail domains incl. all
 *                                major CJK providers (qq/163/126/sina/sohu/foxmail/…)
 *   - disposable-email-domains — ~121k disposable domains (index.json) + ~400
 *                                wildcard suffixes (wildcard.json)
 * Loaded via createRequire so the CJS arrays import cleanly under NodeNext ESM.
 *
 * Kill switch: BUSINESS_EMAIL_ONLY=false disables the gate (default ON; only the
 * literal "false" disables, fail-safe). Per-deployment overrides:
 *   BUSINESS_EMAIL_ALLOWLIST=comma,domains  — force-allow (partners / QA)
 *   BUSINESS_EMAIL_BLOCKLIST=comma,domains  — force-block extras
 * See docs/design-spec-signup-email-verification.md.
 */

const require = createRequire(import.meta.url);

const freeEmailDomains: string[] = require('free-email-domains');
const disposableDomains: string[] = require('disposable-email-domains');
let disposableWildcards: string[] = [];
try {
  disposableWildcards = require('disposable-email-domains/wildcard.json');
} catch {
  // wildcard list is optional — exact-match list still applies
}

const FREE_SET = new Set<string>(freeEmailDomains.map((d) => d.toLowerCase()));
const DISPOSABLE_SET = new Set<string>(disposableDomains.map((d) => d.toLowerCase()));
const DISPOSABLE_WILDCARDS: string[] = disposableWildcards.map((d) => d.toLowerCase());

// Belt-and-suspenders supplement: a small set of common free/personal providers
// to cover any lag in the upstream package (most are already included). Heavy on
// CJK + the largest global consumer providers since GoHire serves CN.
const SUPPLEMENTAL_FREE = new Set<string>([
  // Global
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com',
  'yandex.com', 'yandex.ru', 'zoho.com', 'tutanota.com', 'hey.com',
  // CJK
  'qq.com', 'vip.qq.com', 'foxmail.com', '163.com', 'vip.163.com', '126.com', 'yeah.net',
  'sina.com', 'sina.cn', 'vip.sina.com', 'sohu.com', '21cn.com', 'tom.com', 'aliyun.com',
  '139.com', '189.cn', '188.com', 'wo.cn', 'naver.com', 'daum.net', 'hanmail.net',
]);

function parseEnvSet(name: string): Set<string> {
  return new Set(
    (process.env[name] || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Read per-call so the kill switch applies without a restart. Default ON. */
export function businessEmailOnly(): boolean {
  return process.env.BUSINESS_EMAIL_ONLY !== 'false';
}

/** Lowercased domain part of an email, or null if structurally invalid. */
export function emailDomain(email: string): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  if (!domain.includes('.') || /\s/.test(domain)) return null;
  return domain;
}

function matchesDisposableWildcard(domain: string): boolean {
  return DISPOSABLE_WILDCARDS.some((w) => domain === w || domain.endsWith('.' + w));
}

export type EmailDomainReason = 'free_provider' | 'disposable' | 'invalid';

export interface EmailDomainVerdict {
  allowed: boolean;
  reason?: EmailDomainReason;
  domain?: string;
}

/**
 * Classify an email's domain. Precedence: env allowlist → env blocklist →
 * disposable → free/personal → allowed (business).
 */
export function classifyEmailDomain(email: string): EmailDomainVerdict {
  const domain = emailDomain(email);
  if (!domain) return { allowed: false, reason: 'invalid' };

  if (parseEnvSet('BUSINESS_EMAIL_ALLOWLIST').has(domain)) return { allowed: true, domain };
  if (parseEnvSet('BUSINESS_EMAIL_BLOCKLIST').has(domain)) {
    return { allowed: false, reason: 'free_provider', domain };
  }
  if (DISPOSABLE_SET.has(domain) || matchesDisposableWildcard(domain)) {
    return { allowed: false, reason: 'disposable', domain };
  }
  if (FREE_SET.has(domain) || SUPPLEMENTAL_FREE.has(domain)) {
    return { allowed: false, reason: 'free_provider', domain };
  }
  return { allowed: true, domain };
}

/** Convenience boolean — true when the email is acceptable as a work email. */
export function isBusinessEmail(email: string): boolean {
  return classifyEmailDomain(email).allowed;
}

/**
 * Throw a coded error when the gate is on and the email is not a business email.
 * No-op when BUSINESS_EMAIL_ONLY=false. The thrown error carries
 * `code = 'BUSINESS_EMAIL_REQUIRED'` and `reason` so callers can localize/route.
 */
export function assertBusinessEmail(email: string): void {
  if (!businessEmailOnly()) return;
  const verdict = classifyEmailDomain(email);
  if (verdict.allowed) return;

  const message =
    verdict.reason === 'disposable'
      ? 'Please sign up with your work email — temporary or disposable email addresses are not allowed.'
      : verdict.reason === 'invalid'
        ? 'Please enter a valid email address.'
        : 'Please sign up with your work email. Free or personal email providers (Gmail, Outlook, QQ, 163, …) are not allowed.';

  const err = new Error(message) as Error & { code?: string; reason?: EmailDomainReason };
  err.code = 'BUSINESS_EMAIL_REQUIRED';
  err.reason = verdict.reason;
  throw err;
}
