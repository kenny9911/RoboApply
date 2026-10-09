'use client';

// SubscribeOnTap — wraps a "remind me" control (e.g. 截止提醒) so the tap also
// asks WeChat for a one-time subscribe-message permission (公众号 / 小程序
// 订阅消息) (TASK_PLAN.md WP-73).
//
// STUB (FND-6b). Owner: WP-73. Renders its children unchanged, so the wrapped
// control keeps working everywhere: WP-58 wraps the campus calendar's 截止提醒
// button with it today. When filled it adds the WeChat request only inside
// WeChat with `WECHAT_MP_*` configured; elsewhere it stays a pass-through.

import type { ReactNode } from 'react';

/** Server message templates (IDs come from env; a template without an ID never sends). */
export type SubscribeTemplate = 'deadline_reminder' | 'report_ready' | 'payment_success';

export interface SubscribeOnTapProps {
  template: SubscribeTemplate;
  children: ReactNode;
}

export function SubscribeOnTap({ children }: SubscribeOnTapProps) {
  return <>{children}</>;
}

export default SubscribeOnTap;
