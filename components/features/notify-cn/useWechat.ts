'use client';

// components/features/notify-cn/useWechat.ts — when the WeChat JS-SDK may run, and its config (WP-73).
//
// All of these must hold, otherwise nothing loads and nothing changes on the page:
//   - GoApply (brand market 'cn') with `notify.wechat` on (WECHAT_MP_* set);
//   - a signed-in session (the signature route is seeker-only; a visitor
//     never triggers a 401);
//   - the WeChat browser (UA `MicroMessenger`), read after mount so server
//     and client render the same markup.

import { useEffect, useState } from 'react';

import { useAuth } from '../../../lib/auth/AuthProvider';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { useFlag } from '../../../lib/flags';
import { currentUserAgent, isWechatBrowser, readyWechat, type WechatReady } from './wechatSdk';

/** True only inside WeChat, on GoApply, signed in, with WeChat notices configured. */
export function useWechatEnabled(): boolean {
  const brand = useBrand();
  const on = useFlag('notify.wechat');
  const { status } = useAuth();
  const [inWechat, setInWechat] = useState(false);
  useEffect(() => {
    setInWechat(isWechatBrowser(currentUserAgent()));
  }, []);
  return brand.market === 'cn' && on && status === 'authenticated' && inWechat;
}

/** The configured SDK for this page, or null (not enabled, loading, or failed: callers stay as they are). */
export function useWechatReady(enabled: boolean): WechatReady | null {
  const [ready, setReady] = useState<WechatReady | null>(null);
  useEffect(() => {
    if (!enabled) {
      setReady(null);
      return;
    }
    let live = true;
    readyWechat(window.location.href).then(
      (r) => {
        if (live) setReady(r);
      },
      () => {
        if (live) setReady(null);
      },
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return ready;
}
