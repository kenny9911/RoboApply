// server/src/features/cn/campus/source.ts — where a campus programme may come
// from, and the one fetch the curation flow makes (WP-58).
//
// Rules (TASK_PLAN.md WP-58, D3):
//   - only the employer's OFFICIAL page: no crawler, no aggregator source. A
//     URL on CAMPUS_AGGREGATOR_HOSTS or the import area's job-board denylist
//     is refused as an official URL and as a source URL;
//   - the admin pastes one URL and the server fetches that ONE page with a
//     plain HTTP request (CN-1 compatible; no Firecrawl, no link following
//     beyond at most MAX_REDIRECTS redirects, each re-checked);
//   - SSRF: http(s) only, ports 80/443, no IP literals or intranet names
//     (`checkImportUrl`), and every resolved address must be public;
//   - the body is capped (MAX_PAGE_BYTES) and must be HTML or text.
// The page text is untrusted data; extract.ts fences it in the prompt.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { EnvSource } from '../../../platform/brand/index.js';
import { checkImportUrl, hostMatchesPattern } from '../../jobs/import/index.js';
import { CAMPUS_AGGREGATOR_HOSTS, CAMPUS_ERROR_CODES, type CampusErrorReason } from './contract.js';

export const MAX_REDIRECTS = 3;
export const MAX_PAGE_BYTES = 1_500_000;
export const FETCH_TIMEOUT_MS = 10_000;
/** Characters of page text kept for the extractor. */
export const MAX_PAGE_TEXT = 12_000;

export type SourceCheck = { ok: true; url: URL; host: string } | { ok: false; reason: CampusErrorReason; host: string | null };

export function isAggregatorHost(host: string): boolean {
  return CAMPUS_AGGREGATOR_HOSTS.some((p) => hostMatchesPattern(host, p));
}

/** May this URL be a campus programme's official or source URL? (No network.) */
export function checkCampusSourceUrl(raw: string, env: EnvSource = process.env): SourceCheck {
  const base = checkImportUrl(raw, env);
  if (!base.ok) {
    return { ok: false, reason: base.reason === 'blocked_site' ? CAMPUS_ERROR_CODES.aggregatorSource : CAMPUS_ERROR_CODES.notAWebAddress, host: base.host };
  }
  if (isAggregatorHost(base.host)) return { ok: false, reason: CAMPUS_ERROR_CODES.aggregatorSource, host: base.host };
  return { ok: true, url: base.url, host: base.host };
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const b = ipv6Bytes(address);
    if (!b) return true;
    const zeroTo = (n: number) => b.slice(0, n).every((x) => x === 0);
    const v4At = (i: number) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
    // ::ffff:0:0/96 (mapped, dotted or hex form): judge the IPv4 it carries.
    if (zeroTo(10) && b[10] === 0xff && b[11] === 0xff) return isPrivateAddress(v4At(12));
    // ::/96 — unspecified, loopback and the deprecated IPv4-compatible form.
    if (zeroTo(12)) return true;
    // 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64) can reach any IPv4 behind the gateway.
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;
    // 2002::/16 (6to4): judge the IPv4 it carries.
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddress(v4At(2));
    // 2001::/32 (Teredo, obfuscated IPv4) and 2001:db8::/32 (documentation).
    if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0x00 && b[3] === 0x00) || (b[2] === 0x0d && b[3] === 0xb8))) return true;
    // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
    return (b[0]! & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1]! & 0xc0) >= 0x80) || b[0] === 0xff;
  }
  return true;
}

/** The 16 bytes of an IPv6 address (any form: '::' compression, embedded dotted IPv4, zone id); null when malformed. */
export function ipv6Bytes(address: string): number[] | null {
  let s = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    tail = dotted.slice(1, 5).map(Number);
    if (tail.some((n) => n > 255)) return null;
    s = s.slice(0, dotted.index) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part ? part.split(':') : []);
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface FetchedPage {
  finalUrl: string;
  html: string;
  contentType: string;
  fetchedAt: Date;
}

export class CampusSourceError extends Error {
  constructor(
    readonly reason: CampusErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'CampusSourceError';
  }
}

export interface FetchPageDeps {
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  env?: EnvSource;
  now?: () => Date;
  timeoutMs?: number;
}

async function assertPublicHost(host: string, resolve: Resolver): Promise<void> {
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new CampusSourceError(CAMPUS_ERROR_CODES.pageUnreachable, `could not resolve ${host}`);
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new CampusSourceError(CAMPUS_ERROR_CODES.notAWebAddress, `${host} does not resolve to a public address`);
  }
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > cap) throw new CampusSourceError(CAMPUS_ERROR_CODES.pageUnreachable, 'page too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new CampusSourceError(CAMPUS_ERROR_CODES.pageUnreachable, 'page too large');
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1]?.toLowerCase();
  try {
    return new TextDecoder(charset && charset !== 'utf8' ? charset : 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** Fetch ONE official page (plus at most MAX_REDIRECTS redirects, each re-checked). */
export async function fetchOfficialPage(rawUrl: string, deps: FetchPageDeps = {}): Promise<FetchedPage> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolve = deps.resolve ?? defaultResolver;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = checkCampusSourceUrl(current, env);
    if (!check.ok) throw new CampusSourceError(check.reason, `refused ${check.host ?? current}`);
    await assertPublicHost(check.host, resolve);
    let res: Response;
    try {
      res = await fetchImpl(check.url.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; campus-calendar-check/1.0)' },
        signal: AbortSignal.timeout(deps.timeoutMs ?? FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new CampusSourceError(CAMPUS_ERROR_CODES.pageUnreachable, 'fetch failed');
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new CampusSourceError(CAMPUS_ERROR_CODES.pageUnreachable, 'redirect without location');
      current = new URL(location, check.url).toString();
      continue;
    }
    if (!res.ok) throw new CampusSourceError(CAMPUS_ERROR_CODES.pageUnreachable, `status ${res.status}`);
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !/text\/html|application\/xhtml|text\/plain/.test(contentType)) {
      throw new CampusSourceError(CAMPUS_ERROR_CODES.pageUnreachable, `unsupported content type ${contentType}`);
    }
    const html = await readCapped(res, MAX_PAGE_BYTES);
    return { finalUrl: check.url.toString(), html, contentType, fetchedAt: (deps.now ?? (() => new Date()))() };
  }
  throw new CampusSourceError(CAMPUS_ERROR_CODES.pageUnreachable, 'too many redirects');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The page <title>, if any. */
export function pageTitleOf(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? decodeEntities(m[1]!).replace(/\s+/g, ' ').trim() : '';
  return t ? t.slice(0, 200) : null;
}

/** Visible text of an HTML page (scripts, styles and comments removed; block tags become line breaks). */
export function htmlToText(html: string, max = MAX_PAGE_TEXT): string {
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/table)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? text.slice(0, max) : text;
}
