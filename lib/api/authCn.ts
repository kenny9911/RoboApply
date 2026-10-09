// lib/api/authCn.ts — GoApply auth: phone OTP, WeChat sign-in, bind/change phone, invite codes (admin).
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-11.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// The WeChat OAuth callbacks are browser redirect targets of
// open.weixin.qq.com and are not wrapped.
//
// Endpoints:
//   POST   /api/v1/roboapply/auth/phone/send-code
//   POST   /api/v1/roboapply/auth/phone/verify
//   POST   /api/v1/roboapply/auth/phone/bind
//   POST   /api/v1/roboapply/auth/phone/change
//   GET    /api/v1/roboapply/auth/wechat/qr
//   GET    /api/v1/roboapply/auth/wechat/mp/start
//   POST   /api/v1/roboapply/auth/wechat/mini/login
//   GET    /api/v1/roboapply/admin/auth-cn/invites
//   POST   /api/v1/roboapply/admin/auth-cn/invites

import { apiUrl, call, type CallOptions, type In, type Items, withQuery } from './contracts/wire';
import type * as AC from './contracts/auth-cn';

/** `authCn.sendCode` — POST /api/v1/roboapply/auth/phone/send-code */
export function sendPhoneCode(body: In<typeof AC.SendCodeBodySchema>, opts?: CallOptions): Promise<AC.SendCodeResponse> {
  return call<AC.SendCodeResponse>('POST', `/api/v1/roboapply/auth/phone/send-code`, { ...opts, body });
}

/** `authCn.verify` — POST /api/v1/roboapply/auth/phone/verify */
export function verifyPhoneCode(body: In<typeof AC.VerifyCodeBodySchema>, opts?: CallOptions): Promise<AC.PhoneSessionResponse> {
  return call<AC.PhoneSessionResponse>('POST', `/api/v1/roboapply/auth/phone/verify`, { ...opts, body });
}

/** `authCn.bind` — POST /api/v1/roboapply/auth/phone/bind */
export function bindPhone(body: In<typeof AC.BindPhoneBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/auth/phone/bind`, { ...opts, body });
}

/** `authCn.change` — POST /api/v1/roboapply/auth/phone/change */
export function changePhone(body: In<typeof AC.ChangePhoneBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/auth/phone/change`, { ...opts, body });
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
export function wechatMiniLogin(body: In<typeof AC.WechatMiniLoginBodySchema>, opts?: CallOptions): Promise<AC.PhoneSessionResponse> {
  return call<AC.PhoneSessionResponse>('POST', `/api/v1/roboapply/auth/wechat/mini/login`, { ...opts, body });
}

/** `authCn.admin.listInvites` — GET /api/v1/roboapply/admin/auth-cn/invites */
export function adminListInvites(query?: In<typeof AC.ListInvitesQuerySchema>, opts?: CallOptions): Promise<Items<AC.InviteView>> {
  return call<Items<AC.InviteView>>('GET', withQuery(`/api/v1/roboapply/admin/auth-cn/invites`, query), opts);
}

/** `authCn.admin.createInvites` — POST /api/v1/roboapply/admin/auth-cn/invites */
export function adminCreateInvites(body: In<typeof AC.CreateInvitesBodySchema>, opts?: CallOptions): Promise<Items<AC.InviteView>> {
  return call<Items<AC.InviteView>>('POST', `/api/v1/roboapply/admin/auth-cn/invites`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const authCnApi = {
  sendPhoneCode,
  verifyPhoneCode,
  bindPhone,
  changePhone,
  wechatQrUrl,
  wechatMpStartUrl,
  wechatMiniLogin,
  adminListInvites,
  adminCreateInvites,
};
