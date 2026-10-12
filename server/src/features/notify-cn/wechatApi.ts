// server/src/features/notify-cn/wechatApi.ts — the few 公众号 APIs WP-73 calls.
//
//   stable_token   client_credential access token (the "stable" endpoint, so a
//                  refresh here never invalidates a token another instance holds)
//   getticket      jsapi_ticket for the JS-SDK share card and open tags
//   bizsend        one 订阅通知 (subscribe message) to one openid
//
// Tokens and tickets are cached in memory per process until five minutes
// before they expire; nothing is stored. A token WeChat reports as invalid
// (40001 / 42001 / 40014) is dropped and the call retried once. Every request
// has a timeout. Only openids and template data leave the server (no names,
// phone numbers or emails).

import type { MpApp } from './config.js';

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export const WECHAT_API_BASE = 'https://api.weixin.qq.com';
export const WECHAT_TIMEOUT_MS = 5_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;
const TOKEN_ERRORS = new Set([40001, 40014, 42001]);

export class WechatMpApiError extends Error {
  constructor(
    readonly errcode: number | string,
    message?: string,
  ) {
    super(message ?? `WeChat API error ${errcode}`);
    this.name = 'WechatMpApiError';
  }
  /** Network, timeout or a WeChat-side 5xx / busy (-1): worth trying again later. */
  get transient(): boolean {
    return this.errcode === 'network' || this.errcode === -1 || (typeof this.errcode === 'string' && this.errcode.startsWith('http_5'));
  }
}

interface WechatJson {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  ticket?: string;
  expires_in?: number;
  msgid?: number | string;
}

export interface SubscribeMessage {
  touser: string;
  template_id: string;
  /** Absolute https URL the message opens. */
  page?: string;
  data: Record<string, { value: string }>;
}

export interface WechatMpApi {
  accessToken(app: MpApp): Promise<string>;
  jsapiTicket(app: MpApp): Promise<string>;
  /** Returns WeChat's msgid when it gives one. Throws WechatMpApiError. */
  sendSubscribeMessage(app: MpApp, msg: SubscribeMessage): Promise<string | null>;
}

export interface WechatMpApiDeps {
  fetch?: FetchFn;
  now?: () => number;
  timeoutMs?: number;
}

export function createWechatMpApi(deps: WechatMpApiDeps = {}): WechatMpApi {
  const fetchFn: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? WECHAT_TIMEOUT_MS;
  const tokens = new Map<string, { value: string; expiresAt: number }>();
  const tickets = new Map<string, { value: string; expiresAt: number }>();

  async function call(url: string, init?: { method?: string; body?: unknown }): Promise<WechatJson> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await fetchFn(url, {
        method: init?.method ?? 'GET',
        ...(init?.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
    } catch {
      throw new WechatMpApiError('network');
    } finally {
      clearTimeout(timer);
    }
    let body: WechatJson;
    try {
      body = JSON.parse((await res.text()) || '{}') as WechatJson;
    } catch {
      throw new WechatMpApiError(`http_${res.status}`);
    }
    if (typeof body.errcode === 'number' && body.errcode !== 0) throw new WechatMpApiError(body.errcode, body.errmsg);
    if (!res.ok) throw new WechatMpApiError(`http_${res.status}`);
    return body;
  }

  async function accessToken(app: MpApp, force = false): Promise<string> {
    const hit = tokens.get(app.appId);
    if (!force && hit && hit.expiresAt > now()) return hit.value;
    const body = await call(`${WECHAT_API_BASE}/cgi-bin/stable_token`, {
      method: 'POST',
      body: { grant_type: 'client_credential', appid: app.appId, secret: app.secret, ...(force ? { force_refresh: true } : {}) },
    });
    if (!body.access_token) throw new WechatMpApiError('no_access_token');
    const ttl = Math.max(60_000, (body.expires_in ?? 7200) * 1000 - EXPIRY_MARGIN_MS);
    tokens.set(app.appId, { value: body.access_token, expiresAt: now() + ttl });
    return body.access_token;
  }

  /** Run `fn` with a token; on a token error drop it and retry once. */
  async function withToken<T>(app: MpApp, fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await accessToken(app));
    } catch (err) {
      if (err instanceof WechatMpApiError && typeof err.errcode === 'number' && TOKEN_ERRORS.has(err.errcode)) {
        tokens.delete(app.appId);
        return fn(await accessToken(app, true));
      }
      throw err;
    }
  }

  return {
    accessToken: (app) => accessToken(app),
    async jsapiTicket(app) {
      const hit = tickets.get(app.appId);
      if (hit && hit.expiresAt > now()) return hit.value;
      const body = await withToken(app, (token) =>
        call(`${WECHAT_API_BASE}/cgi-bin/ticket/getticket?access_token=${encodeURIComponent(token)}&type=jsapi`),
      );
      if (!body.ticket) throw new WechatMpApiError('no_ticket');
      const ttl = Math.max(60_000, (body.expires_in ?? 7200) * 1000 - EXPIRY_MARGIN_MS);
      tickets.set(app.appId, { value: body.ticket, expiresAt: now() + ttl });
      return body.ticket;
    },
    async sendSubscribeMessage(app, msg) {
      const body = await withToken(app, (token) =>
        call(`${WECHAT_API_BASE}/cgi-bin/message/subscribe/bizsend?access_token=${encodeURIComponent(token)}`, { method: 'POST', body: msg }),
      );
      return body.msgid !== undefined && body.msgid !== null ? String(body.msgid) : null;
    },
  };
}

let shared: WechatMpApi | null = null;
/** The process-wide client (one token/ticket cache). */
export function wechatMpApi(): WechatMpApi {
  shared ??= createWechatMpApi();
  return shared;
}
