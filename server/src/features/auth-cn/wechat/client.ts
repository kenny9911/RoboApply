// server/src/features/auth-cn/wechat/client.ts — the few WeChat endpoints sign-in needs
// (CN_TW_LAUNCH_PLAN.md §4.2 WP-AUTH-CN, §5.2; TASK_PLAN.md WP-11).
//
//   web  WeChat Open Platform website app: QR sign-in (`snsapi_login`).
//        WECHAT_OPEN_APP_ID / WECHAT_OPEN_APP_SECRET
//   mp   公众号 (service account) OAuth inside WeChat (`snsapi_userinfo`,
//        the scope that returns `unionid` so accounts can be matched).
//        WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET
//   mini mini program: `jscode2session`, and the phone-number code exchange.
//        WECHAT_MINI_APP_ID / WECHAT_MINI_APP_SECRET
//
// Only `openid` and `unionid` are kept. Access tokens and the mini-program
// `session_key` are never stored (RAAuthIdentity has no token columns).

import type { EnvSource } from '../../../platform/brand/brandEnv.js';
import type { FetchLike } from '../../../platform/sms/index.js';

export type WechatFlow = 'web' | 'mp' | 'mini';

export interface WechatApp {
  appId: string;
  secret: string;
}

export function wechatApp(flow: WechatFlow, env: EnvSource = process.env): WechatApp | null {
  const pairs: Record<WechatFlow, [string, string]> = {
    web: ['WECHAT_OPEN_APP_ID', 'WECHAT_OPEN_APP_SECRET'],
    mp: ['WECHAT_MP_APP_ID', 'WECHAT_MP_APP_SECRET'],
    mini: ['WECHAT_MINI_APP_ID', 'WECHAT_MINI_APP_SECRET'],
  };
  const [idName, secretName] = pairs[flow];
  const appId = (env[idName] || '').trim();
  const secret = (env[secretName] || '').trim();
  return appId && secret ? { appId, secret } : null;
}

export class WechatApiError extends Error {
  constructor(readonly errcode: number | string, message?: string) {
    super(message ?? `WeChat API error ${errcode}`);
    this.name = 'WechatApiError';
  }
}

/** Desktop QR sign-in (website app). */
export function qrConnectUrl(appId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ appid: appId, redirect_uri: redirectUri, response_type: 'code', scope: 'snsapi_login', state });
  return `https://open.weixin.qq.com/connect/qrconnect?${q.toString()}#wechat_redirect`;
}

/** 公众号 OAuth inside the WeChat browser. */
export function mpAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ appid: appId, redirect_uri: redirectUri, response_type: 'code', scope: 'snsapi_userinfo', state });
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${q.toString()}#wechat_redirect`;
}

export interface WechatIdentity {
  openid: string;
  unionid: string | null;
}

interface WechatJson {
  errcode?: number;
  errmsg?: string;
  openid?: string;
  unionid?: string;
  access_token?: string;
  phone_info?: { purePhoneNumber?: string; countryCode?: string };
}

async function getJson(fetchFn: FetchLike, url: string, init?: Parameters<FetchLike>[1]): Promise<WechatJson> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url, init);
  } catch {
    throw new WechatApiError('network');
  }
  let body: WechatJson;
  try {
    body = JSON.parse((await res.text()) || '{}') as WechatJson;
  } catch {
    throw new WechatApiError(`http_${res.status}`);
  }
  if (body.errcode && body.errcode !== 0) throw new WechatApiError(body.errcode, body.errmsg);
  if (!res.ok) throw new WechatApiError(`http_${res.status}`);
  return body;
}

/** OAuth code → openid/unionid (web and mp flows). */
export async function exchangeOauthCode(app: WechatApp, code: string, fetchFn: FetchLike): Promise<WechatIdentity> {
  const q = new URLSearchParams({ appid: app.appId, secret: app.secret, code, grant_type: 'authorization_code' });
  const body = await getJson(fetchFn, `https://api.weixin.qq.com/sns/oauth2/access_token?${q.toString()}`);
  if (!body.openid) throw new WechatApiError('no_openid');
  return { openid: body.openid, unionid: body.unionid || null };
}

/** Mini program `wx.login()` code → openid/unionid (`session_key` is dropped). */
export async function miniCodeToSession(app: WechatApp, code: string, fetchFn: FetchLike): Promise<WechatIdentity> {
  const q = new URLSearchParams({ appid: app.appId, secret: app.secret, js_code: code, grant_type: 'authorization_code' });
  const body = await getJson(fetchFn, `https://api.weixin.qq.com/sns/jscode2session?${q.toString()}`);
  if (!body.openid) throw new WechatApiError('no_openid');
  return { openid: body.openid, unionid: body.unionid || null };
}

/** Mini program `getPhoneNumber` code → `+86…` (null for numbers outside the mainland). */
export async function miniPhoneNumber(app: WechatApp, phoneCode: string, fetchFn: FetchLike): Promise<string | null> {
  const tokenBody = await getJson(fetchFn, 'https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: app.appId, secret: app.secret }),
  });
  if (!tokenBody.access_token) throw new WechatApiError('no_access_token');
  const body = await getJson(
    fetchFn,
    `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(tokenBody.access_token)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: phoneCode }) },
  );
  const info = body.phone_info;
  if (!info?.purePhoneNumber || info.countryCode !== '86' || !/^1[3-9]\d{9}$/.test(info.purePhoneNumber)) return null;
  return `+86${info.purePhoneNumber}`;
}
