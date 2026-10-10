// extension/src/background/router.ts — the service worker's message handling,
// free of chrome.* so it can be unit tested (sw.ts wires it to chrome.runtime).
//
// Pairing (ARCHITECTURE.md §6.3): the brand's own web page (/extension, logged
// in) sends { type:'pair', token, apiOrigin } after POST /ext/devices. We take
// it only from the brand's hosts (dev hosts in dev builds), only a well-formed
// `rax_` token, and only an API origin of the same brand; production builds
// then store the brand's canonical API origin (the only one with host
// permission), never the page-supplied value. The fallback is an
// 8-character code typed into the popup.

import { isTrustedBrandOrigin, type ExtBrandConfig } from '../brands/index';
import { EXT_TOKEN_RE, PAIR_CODE_RE } from '../shared/contract';
import type { ApiResult, ExternalMessage, InternalMessage, PairResponse, PingResponse, StatusResponse } from '../shared/messages';
import { callApi, isAuthFailure, redeemPairCode, type FetchLike } from './api';
import { clearAuth, needsReconnect, readAuth, writeAuth, type KeyValueStore } from './storage';

export interface RouterDeps {
  brand: ExtBrandConfig;
  dev: boolean;
  /** Build default API origin (used for code redemption before pairing). */
  apiOrigin: string;
  version: string;
  /** "Chrome" | "Edge": the device name shown in the web app's device list. */
  browserName: string;
  store: KeyValueStore;
  fetch: FetchLike;
  now?: () => Date;
}

export interface SenderLike {
  /** The sending page's origin (chrome ≥ 80 sets it for external messages). */
  origin?: string;
  url?: string;
  /** Our own extension id for internal messages. */
  id?: string;
}

function senderOrigin(sender: SenderLike): string | null {
  if (sender.origin) return sender.origin;
  if (!sender.url) return null;
  try {
    return new URL(sender.url).origin;
  } catch {
    return null;
  }
}

export function webOriginFor(deps: Pick<RouterDeps, 'brand' | 'dev' | 'apiOrigin'>): string {
  return deps.dev ? deps.apiOrigin : deps.brand.apiOrigin;
}

export function createRouter(deps: RouterDeps) {
  const now = deps.now ?? (() => new Date());

  async function status(): Promise<StatusResponse> {
    const auth = await readAuth(deps.store);
    return {
      connected: Boolean(auth),
      needsReconnect: !auth && (await needsReconnect(deps.store)),
      brand: deps.brand.id,
      version: deps.version,
      webOrigin: auth?.apiOrigin ?? webOriginFor(deps),
    };
  }

  async function handleExternal(message: unknown, sender: SenderLike): Promise<PingResponse | PairResponse | { ok: false; code: 'untrusted_origin' | 'unknown_message' }> {
    const origin = senderOrigin(sender);
    if (!origin || !isTrustedBrandOrigin(deps.brand, origin, deps.dev)) return { ok: false, code: 'untrusted_origin' };
    const msg = message as ExternalMessage | null;
    if (msg?.type === 'ping') {
      const auth = await readAuth(deps.store);
      return { ok: true, brand: deps.brand.id, version: deps.version, connected: Boolean(auth) };
    }
    if (msg?.type === 'pair') {
      if (typeof msg.token !== 'string' || !EXT_TOKEN_RE.test(msg.token)) return { ok: false, code: 'invalid_token' };
      const apiOrigin = typeof msg.apiOrigin === 'string' ? msg.apiOrigin.replace(/\/$/, '') : '';
      if (!isTrustedBrandOrigin(deps.brand, apiOrigin, deps.dev)) return { ok: false, code: 'wrong_brand' };
      // Production: host permission covers only the brand's canonical API
      // origin, so that is what we store, whichever brand host sent the page
      // (apex, www, api). Dev builds keep the page's origin (localhost ports).
      const stored = deps.dev ? apiOrigin : deps.brand.apiOrigin.replace(/\/$/, '');
      await writeAuth(deps.store, { token: msg.token, apiOrigin: stored, pairedAt: now().toISOString() });
      return { ok: true };
    }
    return { ok: false, code: 'unknown_message' };
  }

  async function handleInternal(message: unknown): Promise<unknown> {
    const msg = message as InternalMessage | null;
    switch (msg?.type) {
      case 'status':
        return status();
      case 'disconnect':
        await clearAuth(deps.store, { needsReconnect: false });
        return status();
      case 'redeem': {
        const code = String(msg.code ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
        if (!PAIR_CODE_RE.test(code)) return { ok: false, code: 'pair_code_invalid', status: 0 } satisfies ApiResult<never>;
        const apiOrigin = webOriginFor(deps);
        const res = await redeemPairCode({ apiOrigin, fetch: deps.fetch }, { code, name: deps.browserName, browser: deps.browserName, extVersion: deps.version });
        if (!res.ok) return res;
        if (!EXT_TOKEN_RE.test(res.data.token)) return { ok: false, code: 'invalid_response', status: 0 } satisfies ApiResult<never>;
        await writeAuth(deps.store, { token: res.data.token, apiOrigin, pairedAt: now().toISOString() });
        return { ok: true, data: await status() };
      }
      case 'api': {
        const auth = await readAuth(deps.store);
        const res = await callApi({ apiOrigin: auth?.apiOrigin ?? webOriginFor(deps), token: auth?.token ?? null, fetch: deps.fetch }, msg.call as never);
        if (auth && isAuthFailure(res)) await clearAuth(deps.store, { needsReconnect: true });
        return res;
      }
      default:
        return { ok: false, code: 'unknown_message', status: 0 };
    }
  }

  return { handleExternal, handleInternal, status };
}
