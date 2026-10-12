// server/src/platform/email/templates/_shell.ts
//
// The one HTML/text shell every platform email uses (ARCHITECTURE.md §8.1):
// brand wordmark, body, a footer with the reason the person gets this email,
// unsubscribe + settings links for non-transactional mail, and the brand's
// legal entity and postal address.
//
// Honesty (TASK_PLAN.md FND-3): the legal entity and address come from config
// (`LEGAL_ENTITY_NAME` / `LEGAL_POSTAL_ADDRESS`, `CN_` prefixed for GoApply via
// brandEnv) and are omitted when unset — never invented. The wordmark is text
// (the brand name), so a missing image asset never renders a broken logo.
// Email clients strip <style>, so styles are inline; email HTML is outside the
// web design-token system.

import { brandEnv, type EnvSource } from '../../brand/brandEnv.js';
import type { ProductBrand } from '../../brand/registry.js';
import type { EmailTranslator } from '../i18n.js';

export type EmailCategory = 'transactional' | 'alert' | 'tips' | 'marketing';

const ACCENT = '#5b5bd6';
const TEXT = '#111111';
const BODY = '#444444';
const MUTED = '#9aa0aa';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) and mailto links make it into an email. */
export function safeUrl(url: string): string {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : '#';
}

export function heading(text: string): string {
  return `<h1 style="font-size:22px;color:${TEXT};margin:0 0 16px;">${escapeHtml(text)}</h1>`;
}

export function paragraph(text: string): string {
  return `<p style="font-size:15px;color:${BODY};line-height:1.6;margin:0 0 12px;">${escapeHtml(text)}</p>`;
}

export function button(label: string, url: string): string {
  return `<div style="margin:16px 0 4px;"><a href="${escapeHtml(safeUrl(url))}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:10px;font-size:15px;">${escapeHtml(label)}</a></div>`;
}

export interface LegalFooter {
  entity?: string;
  address?: string;
}

/** The brand's legal entity and postal address, from config only. */
export function legalFooter(brand: ProductBrand, env: EnvSource = process.env): LegalFooter {
  const entity = brandEnv(brand, 'LEGAL_ENTITY_NAME', env) || brand.legalEntity || undefined;
  const address = brandEnv(brand, 'LEGAL_POSTAL_ADDRESS', env) || undefined;
  return { entity, address };
}

export interface ShellInput {
  brand: ProductBrand;
  t: EmailTranslator;
  category: EmailCategory;
  bodyHtml: string;
  bodyText: string;
  /** Hidden inbox preview line. */
  preheader?: string;
  /** Web unsubscribe page (required for non-transactional mail; omitted otherwise). */
  unsubscribeUrl?: string;
  /** Email settings page. */
  preferencesUrl?: string;
  /** Overrides the default reason line (e.g. billing's own footer sentence). */
  reasonText?: string;
  env?: EnvSource;
}

export interface ShellOutput {
  html: string;
  text: string;
}

const REASON_KEY: Record<EmailCategory, string> = {
  transactional: 'shell.reasonTransactional',
  alert: 'shell.reasonAlert',
  tips: 'shell.reasonTips',
  marketing: 'shell.reasonMarketing',
};

export function renderShell(input: ShellInput): ShellOutput {
  const { brand, t, category } = input;
  const reason = input.reasonText ?? t(REASON_KEY[category]);
  const legal = legalFooter(brand, input.env);
  const links: string[] = [];
  const textLinks: string[] = [];
  if (category !== 'transactional' && input.unsubscribeUrl) {
    links.push(`<a href="${escapeHtml(safeUrl(input.unsubscribeUrl))}" style="color:${MUTED};">${escapeHtml(t('shell.unsubscribe'))}</a>`);
    textLinks.push(`${t('shell.unsubscribe')}: ${input.unsubscribeUrl}`);
  }
  if (input.preferencesUrl) {
    links.push(`<a href="${escapeHtml(safeUrl(input.preferencesUrl))}" style="color:${MUTED};">${escapeHtml(t('shell.preferences'))}</a>`);
    textLinks.push(`${t('shell.preferences')}: ${input.preferencesUrl}`);
  }
  const legalLines: string[] = [];
  if (legal.entity) legalLines.push(t('shell.sentBy', { entity: legal.entity }));
  if (legal.address) legalLines.push(legal.address);

  const preheader = input.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>`
    : '';
  const footerHtml = [
    `<div>${escapeHtml(reason)}</div>`,
    links.length ? `<div style="margin-top:6px;">${links.join(' &middot; ')}</div>` : '',
    ...legalLines.map((l) => `<div style="margin-top:6px;">${escapeHtml(l)}</div>`),
  ].join('');

  const html = `<!doctype html><html lang="${escapeHtml(t.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${preheader}
  <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border-radius:16px;padding:32px;">
      <div style="font-size:20px;font-weight:700;color:${ACCENT};margin-bottom:24px;">${escapeHtml(brand.name)}</div>
      ${input.bodyHtml}
    </div>
    <div style="text-align:center;color:${MUTED};font-size:12px;margin-top:20px;line-height:1.6;">${footerHtml}</div>
  </div></body></html>`;

  const text = [brand.name, '', input.bodyText.trim(), '', '—', reason, ...textLinks, ...legalLines].join('\n');
  return { html, text };
}
