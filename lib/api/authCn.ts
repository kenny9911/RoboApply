// lib/api/authCn.ts — GoApply auth: phone OTP, WeChat sign-in, bind/change phone, invite codes (admin).
//
// Thin typed wrappers over the area contract (FND-7; filled by WP-11).
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// The WeChat OAuth callbacks are browser redirect targets of
// open.weixin.qq.com and are not wrapped. Sign-in/up from the web form starts
// with POST /auth/wechat/start (consents in the body) and then navigates to
// the returned URL; the GET start endpoints (returning users, `reverify`) are
// URLs the browser navigates to (302 to WeChat), so they are built, not called.
//
// Endpoints:
//   GET    /api/v1/roboapply/auth/phone/policy
//   GET    /api/v1/roboapply/auth/phone/me
//   POST   /api/v1/roboapply/auth/phone/send-code
//   POST   /api/v1/roboapply/auth/phone/verify
//   POST   /api/v1/roboapply/auth/phone/bind
//   POST   /api/v1/roboapply/auth/phone/change
//   POST   /api/v1/roboapply/auth/wechat/start
//   GET    /api/v1/roboapply/auth/wechat/qr
//   GET    /api/v1/roboapply/auth/wechat/mp/start
//   POST   /api/v1/roboapply/auth/wechat/mini/login
//   GET    /api/v1/roboapply/admin/auth-cn/invites
//   POST   /api/v1/roboapply/admin/auth-cn/invites

import { apiUrl, call, type CallOptions, type In, withQuery } from './contracts/wire';
import type * as AC from './contracts/auth-cn';

/**
 * `authCn.policy` — GET /api/v1/roboapply/auth/phone/policy?locale=
 * `locale` is the language the form is read in: the policy carries the text
 * of each required consent in that language (shown verbatim beside its box).
 */
export function getSignupPolicy(locale?: string | null, opts?: CallOptions): Promise<AC.SignupPolicyResponse> {
  return call<AC.SignupPolicyResponse>('GET', withQuery(`/api/v1/roboapply/auth/phone/policy`, locale ? { locale } : null), opts);
}

/** `authCn.me` — GET /api/v1/roboapply/auth/phone/me */
export function getPhoneStatus(opts?: CallOptions): Promise<AC.PhoneStatusResponse> {
  return call<AC.PhoneStatusResponse>('GET', `/api/v1/roboapply/auth/phone/me`, opts);
}

/** `authCn.sendCode` — POST /api/v1/roboapply/auth/phone/send-code */
export function sendPhoneCode(body: In<typeof AC.SendCodeBodySchema>, opts?: CallOptions): Promise<AC.SendCodeResponse> {
  return call<AC.SendCodeResponse>('POST', `/api/v1/roboapply/auth/phone/send-code`, { ...opts, body });
}

/** `authCn.verify` — POST /api/v1/roboapply/auth/phone/verify */
export function verifyPhoneCode(body: In<typeof AC.VerifyCodeBodySchema>, opts?: CallOptions): Promise<AC.PhoneSessionResponse> {
  return call<AC.PhoneSessionResponse>('POST', `/api/v1/roboapply/auth/phone/verify`, { ...opts, body });
}

/** `authCn.bind` — POST /api/v1/roboapply/auth/phone/bind */
export function bindPhone(body: In<typeof AC.BindPhoneBodySchema>, opts?: CallOptions): Promise<AC.BindPhoneResponse> {
  return call<AC.BindPhoneResponse>('POST', `/api/v1/roboapply/auth/phone/bind`, { ...opts, body });
}

/** `authCn.change` — POST /api/v1/roboapply/auth/phone/change */
export function changePhone(body: In<typeof AC.ChangePhoneBodySchema>, opts?: CallOptions): Promise<AC.ChangePhoneResponse> {
  return call<AC.ChangePhoneResponse>('POST', `/api/v1/roboapply/auth/phone/change`, { ...opts, body });
}

/** `authCn.wechatStart` — POST /api/v1/roboapply/auth/wechat/start → `{ url }` to navigate to */
export function startWechatSignIn(body: In<typeof AC.WechatStartBodySchema>, opts?: CallOptions): Promise<AC.WechatStartResponse> {
  return call<AC.WechatStartResponse>('POST', `/api/v1/roboapply/auth/wechat/start`, { ...opts, body });
}

/** `authCn.wechatQr` — GET /api/v1/roboapply/auth/wechat/qr */
export function wechatQrUrl(query?: In<typeof AC.WechatStartQuerySchema>): string {
  return apiUrl(withQuery(`/api/v1/roboapply/auth/wechat/qr`, query));
}

/** `authCn.wechatMpStart` — GET /api/v1/roboapply/auth/wechat/mp/start */
export function wechatMpStartUrl(query?: In<typeof AC.WechatStartQuerySchema>): string {
  return apiUrl(withQuery(`/api/v1/roboapply/auth/wechat/mp/start`, query));
}

/** `authCn.wechatMiniLogin` — POST /api/v1/roboapply/auth/wechat/mini/login */
export function wechatMiniLogin(body: In<typeof AC.WechatMiniLoginBodySchema>, opts?: CallOptions): Promise<AC.WechatMiniLoginResponse> {
  return call<AC.WechatMiniLoginResponse>('POST', `/api/v1/roboapply/auth/wechat/mini/login`, { ...opts, body });
}

/** Invite list page (`cursor` = the next page, null at the end). */
export interface InvitePage {
  items: AC.InviteView[];
  cursor: string | null;
}

/** `authCn.admin.listInvites` — GET /api/v1/roboapply/admin/auth-cn/invites */
export function adminListInvites(query?: In<typeof AC.ListInvitesQuerySchema>, opts?: CallOptions): Promise<InvitePage> {
  return call<InvitePage>('GET', withQuery(`/api/v1/roboapply/admin/auth-cn/invites`, query), opts);
}

/** `authCn.admin.createInvites` — POST /api/v1/roboapply/admin/auth-cn/invites */
export function adminCreateInvites(body: In<typeof AC.CreateInvitesBodySchema>, opts?: CallOptions): Promise<{ items: AC.InviteView[] }> {
  return call<{ items: AC.InviteView[] }>('POST', `/api/v1/roboapply/admin/auth-cn/invites`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const authCnApi = {
  getSignupPolicy,
  getPhoneStatus,
  sendPhoneCode,
  verifyPhoneCode,
  bindPhone,
  changePhone,
  startWechatSignIn,
  wechatQrUrl,
  wechatMpStartUrl,
  wechatMiniLogin,
  adminListInvites,
  adminCreateInvites,
};
