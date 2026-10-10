// extension/src/content/bridge.ts — the content script's view of the API: every
// call goes to the service worker, which holds the token.

import type { ApiCall, ApiResult, ApiResults, InternalMessage } from '../shared/messages';

export type ExtApi = <K extends ApiCall['op']>(call: Extract<ApiCall, { op: K }>) => Promise<ApiResult<ApiResults[K]>>;

export function runtimeApi(): ExtApi {
  return async (call) => {
    try {
      const msg: InternalMessage = { type: 'api', call };
      const res = (await chrome.runtime.sendMessage(msg)) as ApiResult<never> | undefined;
      return res ?? { ok: false, code: 'network_error', status: 0 };
    } catch (err) {
      return { ok: false, code: 'network_error', status: 0, message: err instanceof Error ? err.message : String(err) };
    }
  };
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
