// lib/api/notifyCn.ts — GoApply WeChat notices: subscribe messages, JS-SDK signature.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-73.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// `/api/v1/webhooks/wechat-mp` (GET verify, POST XML) is WeChat-server-only
// and is not wrapped.
//
// Endpoints:
//   POST   /api/v1/roboapply/notify-cn/subscribe-messages
//   GET    /api/v1/roboapply/notify-cn/js-sdk-signature

import { call, type CallOptions, type In, withQuery } from './contracts/wire';
import type * as NC from './contracts/notify-cn';

/** `notifyCn.subscribe` — POST /api/v1/roboapply/notify-cn/subscribe-messages */
export function subscribeWechatMessages(body: In<typeof NC.SubscribeMessagesBodySchema>, opts?: CallOptions): Promise<NC.SubscribeMessagesResponse> {
  return call<NC.SubscribeMessagesResponse>('POST', `/api/v1/roboapply/notify-cn/subscribe-messages`, { ...opts, body });
}

/** `notifyCn.jsSdkSignature` — GET /api/v1/roboapply/notify-cn/js-sdk-signature */
export function getJsSdkSignature(query: In<typeof NC.JsSdkSignatureQuerySchema>, opts?: CallOptions): Promise<NC.JsSdkSignatureResponse> {
  return call<NC.JsSdkSignatureResponse>('GET', withQuery(`/api/v1/roboapply/notify-cn/js-sdk-signature`, query), opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const notifyCnApi = {
  subscribeWechatMessages,
  getJsSdkSignature,
};
