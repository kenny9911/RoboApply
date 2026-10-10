// server/src/features/jobs/import/urlPolicy.ts — which links an import may
// hand to Firecrawl (WP-35; ARCH §3.4, ruling H11, threat model "SSRF via job
// import").
//
// Our server never fetches an imported link itself: the only outbound call is
// the Firecrawl API. On top of that, a link is refused before it reaches
// Firecrawl when it
//   - is not http(s), carries a login (`user:pass@`), uses a non-web port, or
//     names an IP address / localhost / a single-label intranet host
//     (`not_a_web_address`);
//   - is on IMPORT_FETCH_DENYLIST (boards whose terms forbid scraping:
//     LinkedIn, Indeed, Glassdoor, BOSS直聘, 智联, 猎聘, 51job, 脉脉, 104,
//     1111, Cake, Yourator) → `blocked_site`: the user pastes the job text or
//     saves it with the extension.
// The same denylist is applied to the page Firecrawl ends up on, so a
// redirect onto a listed board is discarded.
//
// Pure: reads only the `env` it is given.

import type { EnvSource } from '../../../platform/brand/index.js';
import { DEFAULT_IMPORT_FETCH_DENYLIST, type ImportReason } from './contract.js';

/** Labels after `name` in a `name.*` pattern: a TLD and at most one second-level part (co.uk, com.tw). */
const COUNTRY_SUFFIX_RE = /^[a-z]{2,3}$/;

/** The denylist: built-in patterns plus `IMPORT_FETCH_DENYLIST` (comma list), lower case, de-duplicated. */
export function importDenylist(env: EnvSource = process.env): string[] {
  const extra = (env.IMPORT_FETCH_DENYLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
  return [...new Set([...DEFAULT_IMPORT_FETCH_DENYLIST, ...extra])];
}

/** Lower-cased host without a trailing dot, or null. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/** Whether `host` is matched by one denylist pattern. */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = pattern.toLowerCase();
  if (p.endsWith('.*')) {
    const name = p.slice(0, -2);
    if (!name) return false;
    const labels = h.split('.');
    for (let i = 0; i < labels.length; i += 1) {
      if (labels[i] !== name) continue;
      const rest = labels.slice(i + 1);
      if (rest.length >= 1 && rest.length <= 2 && rest.every((l) => COUNTRY_SUFFIX_RE.test(l))) return true;
    }
    return false;
  }
  return h === p || h.endsWith(`.${p}`);
}

export function isDeniedHost(host: string, env: EnvSource = process.env): boolean {
  return importDenylist(env).some((p) => hostMatchesPattern(host, p));
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export type UrlCheck =
  | { ok: true; url: URL; host: string }
  | { ok: false; reason: Extract<ImportReason, 'blocked_site' | 'not_a_web_address'>; host: string | null };

/** Decide whether `raw` may be sent to Firecrawl. */
export function checkImportUrl(raw: string, env: EnvSource = process.env): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'not_a_web_address', host: null };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'not_a_web_address', host: null };
  const host = normalizeHost(url.hostname.replace(/^\[|\]$/g, ''));
  if (!host) return { ok: false, reason: 'not_a_web_address', host: null };
  if (url.username || url.password) return { ok: false, reason: 'not_a_web_address', host };
  if (url.port && url.port !== '80' && url.port !== '443') return { ok: false, reason: 'not_a_web_address', host };
  // IP literals (v4 and v6), localhost, *.localhost, *.local / *.internal names and single-label hosts.
  if (IPV4_RE.test(host) || host.includes(':')) return { ok: false, reason: 'not_a_web_address', host };
  if (!host.includes('.') || host === 'localhost' || /\.(?:localhost|local|internal|lan|home|corp|intranet)$/.test(host)) {
    return { ok: false, reason: 'not_a_web_address', host };
  }
  if (isDeniedHost(host, env)) return { ok: false, reason: 'blocked_site', host };
  return { ok: true, url, host };
}
