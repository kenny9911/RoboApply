'use client';

// WechatShareCard — the card WeChat shows when a GoApply page is shared from
// inside WeChat (PRODUCT F-JOB-08 cn; TASK_PLAN.md WP-73). Renders nothing.
//
// Only inside WeChat on GoApply, signed in, with `notify.wechat` on: it sets
// the JS-SDK share data (chat and Moments) to the page's own facts. Elsewhere
// it does nothing and WeChat falls back to its default card. The title and
// description come from the caller's real data (job title, company, place);
// with no description the card says only where the page is.
//
//   <WechatShareCard title={`${job.title} · ${job.company}`} description={job.locationText} path={`/jobs/${job.id}`} />

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand/BrandProvider';
import { useWechatEnabled, useWechatReady } from './useWechat';
import { signedPageUrl } from './wechatSdk';

export interface WechatShareCardProps {
  /** e.g. "数据分析师 · 某公司". Clipped to 60 characters. */
  title: string;
  /** Real facts only (place, pay as listed); omitted → "View on %BRAND%". */
  description?: string | null;
  /** Same-site path to share (default: this page). */
  path?: string | null;
}

const clip = (s: string, n: number) => {
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length <= n ? chars.join('') : `${chars.slice(0, n - 1).join('')}…`;
};

export function WechatShareCard({ title, description, path }: WechatShareCardProps) {
  const t = useTranslations('notifyCn.share');
  const brand = useBrand();
  const enabled = useWechatEnabled();
  const ready = useWechatReady(enabled);
  const fallback = t('defaultDescription');

  useEffect(() => {
    if (!ready || !title.trim()) return;
    const origin = window.location.origin;
    const samePath = typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : null;
    const link = samePath ? new URL(samePath, origin).href : signedPageUrl(window.location.href);
    const imgUrl = new URL(brand.assets.appleTouch, origin).href;
    const cardTitle = clip(title, 60);
    const desc = clip(description?.trim() ? description : fallback, 80);
    ready.wx.updateAppMessageShareData?.({ title: cardTitle, desc, link, imgUrl });
    ready.wx.updateTimelineShareData?.({ title: cardTitle, link, imgUrl });
  }, [ready, title, description, path, fallback, brand.assets.appleTouch]);

  return null;
}

export default WechatShareCard;
