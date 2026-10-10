'use client';

// hooks/extension/bridge.ts — talking to the installed extension from a web
// page (ARCHITECTURE.md §6.3). The page reaches the extension through
// `chrome.runtime.sendMessage(<extension id>, message)`, which works only in
// Chromium browsers and only for the brand's own hosts (the extension's
// `externally_connectable`). Messages are the contract's `ExtWebMessage`
// (`ping`, `pair`); WP-55b answers them.
//
// The device token goes from the API response straight into the `pair`
// message: it is never written to page storage.

import type { BrandId } from '../../lib/brand/registry.generated';
import type { ExtPingReply, ExtWebMessage } from '../../lib/api/contracts/extension';

/** The brand's published extension id (inlined at build), or null: nothing is advertised without one. */
export function extensionIdFor(brand: BrandId): string | null {
  const id = brand === 'goapply' ? process.env.NEXT_PUBLIC_CN_EXT_ID : process.env.NEXT_PUBLIC_EXT_ID;
  return id && id.trim() ? id.trim() : null;
}

/**
 * Where to install it, or null (no install button).
 *   RoboApply  `NEXT_PUBLIC_EXT_STORE_URL`, else the Chrome Web Store listing of the id.
 *   GoApply    `NEXT_PUBLIC_CN_EXT_STORE_URL` only (Microsoft Edge Add-ons first,
 *              ARCH §6.8): the Chrome Web Store does not open in mainland China,
 *              so there is no default.
 */
export function extensionStoreUrl(brand: BrandId): string | null {
  const override = brand === 'goapply' ? process.env.NEXT_PUBLIC_CN_EXT_STORE_URL : process.env.NEXT_PUBLIC_EXT_STORE_URL;
  if (override && /^https:\/\//.test(override.trim())) return override.trim();
  if (brand === 'goapply') return null;
  const id = extensionIdFor(brand);
  return id ? `https://chromewebstore.google.com/detail/${encodeURIComponent(id)}` : null;
}

/**
 * ATS types the brand's extension build can fill, with their display names.
 * Mirrors the server's `EXTENSION_ATS_TYPES_BY_MARKET` (RoboApply = intl,
 * GoApply = cn; a test keeps them equal). Job detail's `autofill.supported`
 * comes from one brand-agnostic registry, so the web checks this list too.
 */
export const EXTENSION_ATS_BY_BRAND: Record<BrandId, ReadonlyArray<{ type: string; name: string }>> = {
  roboapply: [
    { type: 'greenhouse', name: 'Greenhouse' },
    { type: 'lever', name: 'Lever' },
    { type: 'ashby', name: 'Ashby' },
    { type: 'workday', name: 'Workday' },
    { type: 'smartrecruiters', name: 'SmartRecruiters' },
    { type: 'icims', name: 'iCIMS' },
    { type: 'workable', name: 'Workable' },
    { type: 'taleo', name: 'Taleo' },
    { type: 'successfactors', name: 'SuccessFactors' },
  ],
  goapply: [
    { type: 'moka', name: 'Moka' },
    { type: 'beisen', name: 'Beisen' },
    { type: 'feishu', name: 'Feishu' },
    { type: 'dayee', name: 'Dayee' },
  ],
};

/**
 * Forms filled page by page: until one run covers a whole application (R4,
 * WP-93) every page reserves its own autofill credit, so job pages do not
 * offer the extension for them. Mirrors the server's
 * `EXTENSION_PER_PAGE_ATS_TYPES` (a test keeps them equal).
 */
export const EXTENSION_PER_PAGE_ATS: readonly string[] = ['workday', 'icims', 'taleo', 'successfactors'];

/**
 * Whether a job page offers the brand's extension for this ATS type. The
 * server's `autofill.supported` also checks the application URL's host.
 */
export function extensionFillsAts(brand: BrandId, atsType: string | null | undefined): boolean {
  return !!atsType && !EXTENSION_PER_PAGE_ATS.includes(atsType) && (EXTENSION_ATS_BY_BRAND[brand] ?? []).some((a) => a.type === atsType);
}

/** What this browser can do with an extension. */
export type BrowserSupport = 'chromium' | 'mobile' | 'other';

export function browserSupport(nav: { userAgent?: string; userAgentData?: { mobile?: boolean } } | undefined = typeof navigator === 'undefined' ? undefined : (navigator as never)): BrowserSupport {
  if (!nav) return 'other';
  const ua = nav.userAgent ?? '';
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile|MicroMessenger/i.test(ua)) return 'mobile';
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'chromium';
  return 'other';
}

/** The page-side transport (tests replace it with `__setExtensionBridge`). */
export interface ExtensionBridge {
  /** Null when this page cannot message any extension (no `chrome.runtime`). */
  send<T>(extensionId: string, message: ExtWebMessage, timeoutMs: number): Promise<T | null>;
}

type ChromeRuntime = {
  sendMessage?: (id: string, message: unknown, callback: (reply: unknown) => void) => void;
  lastError?: unknown;
};

const chromeBridge: ExtensionBridge = {
  send<T>(extensionId: string, message: ExtWebMessage, timeoutMs: number): Promise<T | null> {
    const runtime = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
    if (!runtime?.sendMessage) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => {
      let done = false;
      const finish = (value: T | null) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      try {
        runtime.sendMessage!(extensionId, message, (reply) => {
          clearTimeout(timer);
          // Reading lastError marks it handled (no console noise when absent).
          finish(runtime.lastError ? null : ((reply ?? null) as T | null));
        });
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    });
  },
};

let bridge: ExtensionBridge = chromeBridge;

/** Test seam. `null` restores the chrome.runtime bridge. */
export function __setExtensionBridge(next: ExtensionBridge | null): void {
  bridge = next ?? chromeBridge;
}

export const PING_TIMEOUT_MS = 1500;

/** The installed extension's answer to `ping`, or null when it is not there. */
export async function pingExtension(extensionId: string): Promise<ExtPingReply | null> {
  const reply = await bridge.send<ExtPingReply>(extensionId, { type: 'ping' }, PING_TIMEOUT_MS);
  return reply && reply.ok === true && typeof reply.version === 'string' ? reply : null;
}

/** Hand a fresh device token to the extension. */
export async function sendPairToken(extensionId: string, token: string, apiOrigin: string): Promise<boolean> {
  const reply = await bridge.send<{ ok?: boolean }>(extensionId, { type: 'pair', token, apiOrigin }, 5000);
  return reply?.ok === true;
}

/** Dotted numeric comparison ('1.10.0' > '1.9.2'). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True only when both versions are known and `version` is below `min`. */
export function isBelowMinVersion(version: string | null | undefined, min: string | null | undefined): boolean {
  if (!version || !min) return false;
  return compareVersions(version, min) < 0;
}
