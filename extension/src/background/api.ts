// extension/src/background/api.ts — the extension's API client (service worker).
//
// Device routes authenticate with `Authorization: Bearer rax_…`. The token is
// only ever sent to the paired API origin, and file downloads are accepted only
// from that origin's `/ext/files/` route, so a signed URL can never carry the
// token elsewhere. Credit-spending calls carry an `Idempotency-Key`.

import type { Envelope } from '../shared/contract';
import type { ApiCall, ApiResult, ApiResults, FetchedFile } from '../shared/messages';

export const EXT_API_PREFIX = '/api/v1/roboapply/ext';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientDeps {
  apiOrigin: string;
  token: string | null;
  fetch: FetchLike;
}

function endpoint(call: ApiCall): { method: string; path: string; body?: unknown; idempotencyKey?: string } {
  switch (call.op) {
    case 'me':
      return { method: 'GET', path: '/me' };
    case 'autofillProfile':
      return { method: 'GET', path: '/autofill-profile' };
    case 'pageJob':
      return { method: 'POST', path: '/page-job', body: call.body };
    case 'saveJob':
      return { method: 'POST', path: '/jobs/save', body: call.body };
    case 'createRun':
      return { method: 'POST', path: '/autofill-runs', body: call.body, idempotencyKey: call.idempotencyKey };
    case 'patchRun':
      return { method: 'PATCH', path: `/autofill-runs/${encodeURIComponent(call.id)}`, body: call.body };
    case 'answer':
      return { method: 'POST', path: '/answers', body: call.body, idempotencyKey: call.idempotencyKey };
    case 'resumeForJob':
      return { method: 'POST', path: '/resume-for-job', body: call.body };
    case 'siteRequest':
      return { method: 'POST', path: '/site-requests', body: call.body };
    case 'fetchFile':
      throw new Error('fetchFile has no JSON endpoint');
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function fileNameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : null;
}

/** Is `url` the paired origin's signed-file route? */
export function isOwnFileUrl(apiOrigin: string, url: string): boolean {
  try {
    const u = new URL(url, apiOrigin);
    return u.origin === new URL(apiOrigin).origin && u.pathname.startsWith(`${EXT_API_PREFIX}/files/`);
  } catch {
    return false;
  }
}

async function readEnvelope<T>(res: Response): Promise<ApiResult<T>> {
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    body = null;
  }
  if (res.ok && body && body.success === true) return { ok: true, data: body.data };
  if (body && body.success === false) return { ok: false, code: body.code, status: res.status, message: body.error, details: body.details };
  return { ok: false, code: res.ok ? 'invalid_response' : `http_${res.status}`, status: res.status };
}

export async function callApi<K extends ApiCall['op']>(deps: ApiClientDeps, call: Extract<ApiCall, { op: K }>): Promise<ApiResult<ApiResults[K]>> {
  if (!deps.token) return { ok: false, code: 'not_connected', status: 0 };
  const headers: Record<string, string> = { Authorization: `Bearer ${deps.token}`, Accept: 'application/json' };
  try {
    if (call.op === 'fetchFile') {
      const url = (call as Extract<ApiCall, { op: 'fetchFile' }>).url;
      if (!isOwnFileUrl(deps.apiOrigin, url)) return { ok: false, code: 'untrusted_file_url', status: 0 };
      const res = await deps.fetch(new URL(url, deps.apiOrigin).toString(), { method: 'GET', headers: { Authorization: headers.Authorization }, credentials: 'omit' });
      if (!res.ok) return readEnvelope(res) as Promise<ApiResult<ApiResults[K]>>;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const file: FetchedFile = {
        base64: toBase64(bytes),
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        fileName: fileNameFrom(res.headers.get('content-disposition')),
      };
      return { ok: true, data: file as ApiResults[K] };
    }
    const ep = endpoint(call);
    if (ep.body !== undefined) headers['Content-Type'] = 'application/json';
    if (ep.idempotencyKey) headers['Idempotency-Key'] = ep.idempotencyKey;
    const res = await deps.fetch(`${deps.apiOrigin}${EXT_API_PREFIX}${ep.path}`, {
      method: ep.method,
      headers,
      body: ep.body === undefined ? undefined : JSON.stringify(ep.body),
      credentials: 'omit',
    });
    return readEnvelope<ApiResults[K]>(res);
  } catch (err) {
    return { ok: false, code: 'network_error', status: 0, message: err instanceof Error ? err.message : String(err) };
  }
}

/** POST /ext/pair-codes/redeem — public (no token). */
export async function redeemPairCode(
  deps: { apiOrigin: string; fetch: FetchLike },
  body: { code: string; name: string; browser?: string; extVersion?: string },
): Promise<ApiResult<{ token: string }>> {
  try {
    const res = await deps.fetch(`${deps.apiOrigin}${EXT_API_PREFIX}/pair-codes/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
    });
    return readEnvelope<{ token: string }>(res);
  } catch (err) {
    return { ok: false, code: 'network_error', status: 0, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Codes that mean the device token no longer works. */
export function isAuthFailure(result: ApiResult<unknown>): boolean {
  return !result.ok && (result.code === 'unauthorized' || result.code === 'device_revoked' || result.status === 401);
}
