'use client';

// WechatMethod — 微信登录: QR code on desktop, the 公众号 OAuth round trip
// inside WeChat (PRODUCT_PLAN.md §4.5 G0; TASK_PLAN.md WP-11).
//
// STUB (FND-6b). Owner: WP-11. Renders nothing. Rendered by login/signup
// through components/auth/methods/registry.ts (`wechat`) only when
// `auth.wechatWeb` or `auth.wechatInApp` is on. A WeChat user without a phone
// is sent to /bind-phone before any AI feature.

import type { AuthMethodProps } from '../../auth/methods/registry';

export function WechatMethod(_props: AuthMethodProps): null {
  return null;
}

export default WechatMethod;
