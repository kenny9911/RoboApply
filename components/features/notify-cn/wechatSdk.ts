'use client';

// components/features/notify-cn/wechatSdk.ts — the WeChat JS-SDK inside the WeChat browser (WP-73).
//
// Loaded only inside WeChat (UA `MicroMessenger`) on GoApply with
// `notify.wechat` on. One `wx.config` per signed URL, shared by every
// SubscribeOnTap and the share card on the page. The script is WeChat's own
// (res.wx.qq.com, the only host WeChat allows for it); it is injected at
// runtime, not bundled (no npm dependency).
//
// Which URL WeChat checks the signature against:
//   - Android: the page's current URL;
//   - iOS: the URL the WebView first loaded. App Router navigations use
//     history.pushState, which iOS WeChat does not see, so after any client
//     navigation the current URL would fail with "invalid signature". iOS
//     therefore signs the entry URL (the document's navigation entry, or the
//     URL when this module first ran).
//
// Open tags (`wx-open-subscribe`) need WeChat 7.0.12 or later. When WeChat
// cannot use them it fires `WeixinOpenTagsError` on the document; from then
// on no open tag is laid over anything (callers keep their plain control).

import { getJsSdkSignature } from '../../../lib/api/notifyCn';
import type { JsSdkSignatureResponse } from '../../../lib/api/contracts/notify-cn';

export const JWEIXIN_SRC = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js';

/** The part of the `wx` global this area uses. */
export interface WxShareData {
  title: string;
  desc?: string;
  link: string;
  imgUrl: string;
  success?: () => void;
}
export interface WxSdk {
  config(c: {
    debug: boolean;
    appId: string;
    timestamp: number;
    nonceStr: string;
    signature: string;
    jsApiList: string[];
    openTagList?: string[];
  }): void;
  ready(cb: () => void): void;
  error(cb: (res: unknown) => void): void;
  updateAppMessageShareData?(d: WxShareData): void;
  updateTimelineShareData?(d: Omit<WxShareData, 'desc'>): void;
}

export const JS_API_LIST = ['updateAppMessageShareData', 'updateTimelineShareData'];
export const OPEN_TAG_LIST = ['wx-open-subscribe'];

export function isWechatBrowser(userAgent: string | null | undefined): boolean {
  return /MicroMessenger/i.test(userAgent ?? '');
}

export function currentUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

/** iPhone / iPad / iPod WeChat: signatures are checked against the entry URL. */
export function isIosWechat(userAgent: string | null | undefined): boolean {
  const ua = userAgent ?? '';
  return isWechatBrowser(ua) && /iPhone|iPad|iPod/i.test(ua);
}

/** WeChat's version from the UA (`MicroMessenger/8.0.50(0x…)`), or null. */
export function wechatVersion(userAgent: string | null | undefined): [number, number, number] | null {
  const m = /MicroMessenger\/(\d+)\.(\d+)(?:\.(\d+))?/i.exec(userAgent ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** Open tags such as `wx-open-subscribe` exist from WeChat 7.0.12. */
export const OPEN_TAG_MIN_VERSION: readonly [number, number, number] = [7, 0, 12];

export function supportsOpenTags(userAgent: string | null | undefined): boolean {
  const v = wechatVersion(userAgent);
  if (!v) return false;
  for (let i = 0; i < 3; i += 1) {
    if (v[i]! !== OPEN_TAG_MIN_VERSION[i]) return v[i]! > OPEN_TAG_MIN_VERSION[i]!;
  }
  return true;
}

/** The page URL WeChat signs (no fragment). */
export function signedPageUrl(href: string): string {
  const i = href.indexOf('#');
  return i === -1 ? href : href.slice(0, i);
}

/** The URL when this module first ran (fallback for the entry URL). */
const MODULE_ENTRY_HREF: string | null = typeof window === 'undefined' ? null : window.location.href;

/** The URL this document was loaded at (unchanged by pushState). */
export function entryPageHref(): string | null {
  try {
    if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav && typeof nav.name === 'string' && /^https?:/i.test(nav.name)) return nav.name;
    }
  } catch {
    // fall through
  }
  return MODULE_ENTRY_HREF;
}

/** The URL to sign for the current page: the entry URL on iOS WeChat, the current one elsewhere. */
export function urlToSign(currentHref: string, userAgent: string = currentUserAgent()): string {
  return signedPageUrl(isIosWechat(userAgent) ? (entryPageHref() ?? currentHref) : currentHref);
}

// ── WeixinOpenTagsError: open tags unusable on this page ──

let openTagsBroken = false;
const openTagsListeners = new Set<() => void>();
let openTagsListening = false;

function listenForOpenTagsError(): void {
  if (openTagsListening || typeof document === 'undefined') return;
  openTagsListening = true;
  document.addEventListener('WeixinOpenTagsError', () => {
    openTagsBroken = true;
    for (const cb of [...openTagsListeners]) cb();
  });
}

/** False once WeChat said open tags cannot be used on this page. */
export function openTagsUsable(): boolean {
  return !openTagsBroken;
}

/** Called once WeChat says open tags cannot be used; returns an unsubscribe. */
export function onOpenTagsError(cb: () => void): () => void {
  listenForOpenTagsError();
  openTagsListeners.add(cb);
  return () => {
    openTagsListeners.delete(cb);
  };
}

function wxGlobal(): WxSdk | null {
  return typeof window === 'undefined' ? null : ((window as unknown as { wx?: WxSdk }).wx ?? null);
}

let scriptPromise: Promise<WxSdk> | null = null;

/** Inject jweixin once; resolves with `window.wx`. */
export function loadWechatSdk(): Promise<WxSdk> {
  const existing = wxGlobal();
  if (existing) return Promise.resolve(existing);
  scriptPromise ??= new Promise<WxSdk>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JWEIXIN_SRC;
    s.async = true;
    s.onload = () => {
      const wx = wxGlobal();
      if (wx) resolve(wx);
      else reject(new Error('wx missing'));
    };
    s.onerror = () => reject(new Error('jweixin failed to load'));
    document.head.appendChild(s);
  }).catch((err: unknown) => {
    scriptPromise = null;
    throw err;
  });
  return scriptPromise;
}

export interface WechatReady {
  wx: WxSdk;
  config: JsSdkSignatureResponse;
}

const configured = new Map<string, Promise<WechatReady>>();

/**
 * Load the SDK, fetch the signature for this page and run `wx.config` once
 * per URL. Rejects when anything fails (callers then stay pass-through).
 */
export function readyWechat(pageHref: string): Promise<WechatReady> {
  listenForOpenTagsError();
  const url = urlToSign(pageHref);
  let p = configured.get(url);
  if (!p) {
    p = (async () => {
      const [wx, config] = await Promise.all([loadWechatSdk(), getJsSdkSignature({ url })]);
      await new Promise<void>((resolve, reject) => {
        wx.ready(resolve);
        wx.error(reject);
        wx.config({
          debug: false,
          appId: config.appId,
          timestamp: config.timestamp,
          nonceStr: config.nonceStr,
          signature: config.signature,
          jsApiList: JS_API_LIST,
          openTagList: OPEN_TAG_LIST,
        });
      });
      return { wx, config };
    })();
    p.catch(() => configured.delete(url));
    configured.set(url, p);
  }
  return p;
}

/** Test seam. */
export function resetWechatSdkForTests(): void {
  configured.clear();
  scriptPromise = null;
  openTagsBroken = false;
  openTagsListeners.clear();
}

/**
 * `wx-open-subscribe` success detail → template key → result.
 * WeChat sends `subscribeDetails` as JSON: `{ "<templateId>": "{\"status\":\"accept\"}" }`.
 */
export function parseSubscribeDetails(
  raw: unknown,
  templates: Partial<Record<string, string>>,
): Record<string, 'accept' | 'reject' | 'ban' | 'filter'> {
  const out: Record<string, 'accept' | 'reject' | 'ban' | 'filter'> = {};
  let details: unknown = raw;
  try {
    if (typeof details === 'string') details = JSON.parse(details);
  } catch {
    return out;
  }
  if (!details || typeof details !== 'object') return out;
  const byId = new Map(Object.entries(templates).map(([k, id]) => [id, k]));
  for (const [id, value] of Object.entries(details as Record<string, unknown>)) {
    const key = byId.get(id);
    if (!key) continue;
    let status: unknown = value;
    try {
      if (typeof status === 'string') status = (JSON.parse(status) as { status?: unknown }).status;
      else if (status && typeof status === 'object') status = (status as { status?: unknown }).status;
    } catch {
      continue;
    }
    if (status === 'accept' || status === 'reject' || status === 'ban' || status === 'filter') out[key] = status;
  }
  return out;
}
