// server/src/features/jobs/import/directFetch.ts — a plain server read of an
// imported link (GOAPPLY_PARITY_PLAN §6 gap G127).
//
// Used ONLY on a mainland deployment (DEPLOY_REGION=cn-mainland), where the
// fetch provider cannot be reached or may not be used: instead of sending the
// user straight to "paste the job text", the server reads the one page the
// user gave, once, the way a link preview does. Everywhere else the provider
// (firecrawl.ts) stays the only reader.
//
// Threat model (SSRF via job import). Here OUR server opens the connection,
// so the lexical URL policy alone is not enough. Every hop is checked:
//   - the URL policy of urlPolicy.ts (http/https only, no login, web ports
//     only, no IP literal, no localhost / single-label / intranet name, not on
//     the no-scraping denylist: a listed board is never read, by redirect
//     either);
//   - the host is resolved once and EVERY address it resolves to must be a
//     public one (no loopback, private, link-local / cloud-metadata, CGNAT,
//     multicast, reserved or IPv4-mapped private address);
//   - the connection is pinned to the address that was checked (the socket's
//     own lookup returns that address), so a second DNS answer cannot move the
//     request to an internal host after the check (DNS rebinding);
//   - redirects are followed by hand, at most MAX_REDIRECTS, each hop through
//     the same checks;
//   - GET only, no cookies, no credentials, identity encoding asked for, a
//     hard time limit for the whole read, the body capped (after
//     decompression too), and only an HTML or plain-text page is accepted.
// The page text is data: nothing in it is executed, and the caller treats it
// like any pasted posting (rules, warnings, the user confirms every field).
// The page is also somebody else's input to OUR process: it is turned into
// text by the linear scanner of html.ts (one pass, no pattern that starts
// again at every unclosed tag), so a crafted 2 MB page costs milliseconds.
// D1: this reads a page; it never submits or posts anything.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { EnvSource } from '../../../platform/brand/index.js';
import { ScrapeError, type ScrapedPage } from './firecrawl.js';
import { htmlToText, pageOf, tidyText } from './html.js';
import { checkImportUrl } from './urlPolicy.js';

/** Body cap, counted after decompression. A job page is far below this. */
export const DIRECT_MAX_BYTES = 2 * 1024 * 1024;
/** The whole read (every hop) must finish in this long. */
export const DIRECT_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
/** Says what we are; a site that does not want this reader can refuse it by name. */
export const DIRECT_USER_AGENT = 'Mozilla/5.0 (compatible; JobLinkReader/1.0; reads one job page a user asked to add)';

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** One HTTP exchange, already pinned to `address`. Resolves with the status, headers and the capped body. */
export interface DirectResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface DirectFetchOptions {
  env?: EnvSource;
  /** DNS (tests pass a table). Default: the system resolver, every address. */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  /** The pinned GET (tests pass a fake). Default: node http/https. */
  request?: (url: URL, address: ResolvedAddress, limits: { timeoutMs: number; maxBytes: number; signal: AbortSignal }) => Promise<DirectResponse>;
  timeoutMs?: number;
  maxBytes?: number;
}

// ── Address rules ─────────────────────────────────────────────────────────

const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv6');
}

/** An IPv4 address carried inside an IPv6 one (`::ffff:10.0.0.1`, `::10.0.0.1`), or null. */
function embeddedIpv4(address: string): string | null {
  const m = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (m) return m[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1]!, 16);
  const lo = Number.parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True only for an address on the public internet. Anything unparseable is not public. */
export function isPublicAddress(address: string): boolean {
  try {
    const kind = net.isIP(address);
    if (kind === 4) return !BLOCKED.check(address, 'ipv4');
    if (kind !== 6) return false;
    const v4 = embeddedIpv4(address);
    if (v4) return net.isIP(v4) === 4 && !BLOCKED.check(v4, 'ipv4');
    return !BLOCKED.check(address, 'ipv6');
  } catch {
    // A scoped or malformed address the block list cannot read is not a public one.
    return false;
  }
}

async function systemResolve(host: string): Promise<ResolvedAddress[]> {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

// ── The pinned request ────────────────────────────────────────────────────

function decoderFor(encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  const e = (encoding ?? '').trim().toLowerCase();
  if (!e || e === 'identity') return null;
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  throw new ScrapeError('bad_response', `unsupported content encoding ${e}`);
}

/**
 * One GET over node http/https with the socket pinned to `address` (the name in
 * `url` is used for the Host header and TLS only, never resolved again).
 * Exported for its test.
 */
export function pinnedGet(url: URL, address: ResolvedAddress, limits: { timeoutMs: number; maxBytes: number; signal: AbortSignal }): Promise<DirectResponse> {
  return new Promise<DirectResponse>((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    // The socket asks for an address: it gets the one that was checked, whatever DNS says now.
    const lookup = ((_host: string, options: unknown, callback: (...args: unknown[]) => void) => {
      const cb = typeof options === 'function' ? (options as typeof callback) : callback;
      const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
      if (all) cb(null, [{ address: address.address, family: address.family }]);
      else cb(null, address.address, address.family);
    }) as unknown as net.LookupFunction;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        lookup,
        agent: false,
        timeout: limits.timeoutMs,
        signal: limits.signal,
        headers: {
          'user-agent': DIRECT_USER_AGENT,
          accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
          'accept-encoding': 'identity',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // A redirect or an error status carries nothing we read: drop the body.
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
          return;
        }
        let stream: NodeJS.ReadableStream = res;
        try {
          const decoder = decoderFor(typeof res.headers['content-encoding'] === 'string' ? res.headers['content-encoding'] : undefined);
          if (decoder) {
            decoder.on('error', () => reject(new ScrapeError('bad_response', 'the page could not be decoded')));
            stream = res.pipe(decoder);
          }
        } catch (err) {
          req.destroy();
          reject(err);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        stream.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > limits.maxBytes) {
            req.destroy();
            reject(new ScrapeError('too_large', `the page is larger than ${limits.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        stream.on('error', (err: Error) => reject(new ScrapeError('http_error', err.message)));
      },
    );
    req.on('timeout', () => req.destroy(new ScrapeError('timeout', `the page did not answer in ${limits.timeoutMs} ms`)));
    req.on('error', (err: Error) => reject(err instanceof ScrapeError ? err : new ScrapeError(limits.signal.aborted ? 'timeout' : 'http_error', err.message)));
    req.end();
  });
}

// ── HTML → the page the extractor reads ───────────────────────────────────

const header = (headers: DirectResponse['headers'], name: string): string => {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

/** The charset the page declares (header first, then its own <meta>), else utf-8. */
export function charsetOf(contentType: string, body: Buffer): string {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const head = body.subarray(0, 4096).toString('latin1');
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}

function decodeBody(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    // An unknown label: read as UTF-8 rather than fail the whole import.
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
}

/**
 * The part of the document a reader would call the page: <main> or <article>
 * when there is one, else <body>, without scripts, comments and site chrome.
 */
export function mainHtmlOf(html: string): string {
  return pageOf(html).mainHtml;
}

/**
 * A fetched HTML (or plain-text) document as the `ScrapedPage` the extractor
 * reads. The document is somebody else's and up to DIRECT_MAX_BYTES long: it
 * is read with the linear scanner of html.ts, never with a pattern over the
 * whole of it (one crafted page must not hold the process).
 */
export function toScrapedPage(html: string, finalUrl: string, status: number, plain = false): ScrapedPage {
  if (plain) {
    return { finalUrl, markdown: tidyText(html), rawHtml: '', metadata: { title: null, ogTitle: null, ogSiteName: null, description: null, statusCode: status } };
  }
  const page = pageOf(html);
  return {
    finalUrl,
    markdown: htmlToText(page.mainHtml),
    // The extractor reads only the structured-data blocks of the raw document: it gets those, not the document.
    rawHtml: page.ldJson.map((block) => `<script type="application/ld+json">${block}</script>`).join('\n'),
    metadata: {
      title: page.title,
      ogTitle: page.meta['og:title'] ?? null,
      ogSiteName: page.meta['og:site_name'] ?? null,
      description: page.meta.description ?? page.meta['og:description'] ?? null,
      statusCode: status,
    },
  };
}

// ── The read ──────────────────────────────────────────────────────────────

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Read one page directly, under the rules in the header. Throws `ScrapeError`:
 * `page_error` for a link (or a redirect target) the rules refuse, `timeout`,
 * `too_large`, `http_error` (not reachable, or a non-2xx answer),
 * `bad_response` (not an HTML or text page). Never returns a partial page.
 */
export async function fetchJobPageDirect(link: string, options: DirectFetchOptions = {}): Promise<ScrapedPage> {
  const env = options.env ?? process.env;
  const resolve = options.resolve ?? systemResolve;
  const request = options.request ?? pinnedGet;
  const timeoutMs = options.timeoutMs ?? DIRECT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DIRECT_MAX_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    let current = link;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const check = checkImportUrl(current, env);
      if (!check.ok) throw new ScrapeError('page_error', check.reason === 'blocked_site' ? 'the link leads to a site we do not read' : 'the link leads to an address we do not read');

      let addresses: ResolvedAddress[];
      try {
        addresses = await resolve(check.host);
      } catch (err) {
        throw new ScrapeError('http_error', `the host could not be resolved: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Every address must be public: a host that also answers with an internal address is refused whole.
      if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) throw new ScrapeError('page_error', 'the link resolves to an address we do not read');

      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0 || controller.signal.aborted) throw new ScrapeError('timeout', `the page did not answer in ${timeoutMs} ms`);
      let res: DirectResponse;
      try {
        res = await request(check.url, addresses[0]!, { timeoutMs: remaining, maxBytes, signal: controller.signal });
      } catch (err) {
        if (err instanceof ScrapeError) throw err;
        throw new ScrapeError(controller.signal.aborted ? 'timeout' : 'http_error', err instanceof Error ? err.message : String(err));
      }

      if (REDIRECTS.has(res.status)) {
        const location = header(res.headers, 'location').trim();
        if (!location) throw new ScrapeError('http_error', 'the page redirected nowhere');
        try {
          current = new URL(location, check.url).toString();
        } catch {
          throw new ScrapeError('http_error', 'the page redirected to something that is not a link');
        }
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new ScrapeError('http_error', `the page answered ${res.status}`);
      if (res.body.byteLength > maxBytes) throw new ScrapeError('too_large', `the page is larger than ${maxBytes} bytes`);

      const contentType = header(res.headers, 'content-type').toLowerCase();
      const isHtml = !contentType || /\b(?:text\/html|application\/xhtml\+xml)\b/.test(contentType);
      const isPlain = /\btext\/plain\b/.test(contentType);
      if (!isHtml && !isPlain) throw new ScrapeError('bad_response', 'the link is not a web page');
      const text = decodeBody(res.body, charsetOf(contentType, res.body));
      return toScrapedPage(text, check.url.toString(), res.status, isPlain);
    }
    throw new ScrapeError('http_error', 'the page redirected too many times');
  } finally {
    clearTimeout(timer);
  }
}
