'use client';

// components/features/feed/FeedTabs.tsx — For you · Explore · Added by you
// (PRODUCT F-FEED-01). Each tab is its own route (/jobs, /jobs/explore,
// /jobs/added); Saved and Applied live in /applications. WP-35 can render the
// same tabs on /jobs/added.

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Tabs, tabPanelProps } from '../../v3/primitives';

export type FeedTabId = 'forYou' | 'explore' | 'added';

export const FEED_TAB_HREF: Record<FeedTabId, string> = {
  forYou: '/jobs',
  explore: '/jobs/explore',
  added: '/jobs/added',
};

export const FEED_TABS_ID = 'jobs-tabs';

/** Props for the element that holds the active tab's content. */
export function feedTabPanelProps(tab: FeedTabId) {
  return tabPanelProps(FEED_TABS_ID, tab);
}

export interface FeedTabsProps {
  active: FeedTabId;
  /** Hide "For you" and "Explore" when the brand has no job feed (only imports remain). */
  feedOn?: boolean;
}

export function FeedTabs({ active, feedOn = true }: FeedTabsProps) {
  const t = useTranslations('jobs.workspace');
  const router = useRouter();
  const ids: FeedTabId[] = feedOn ? ['forYou', 'explore', 'added'] : ['added'];
  return (
    <Tabs<FeedTabId>
      tabs={ids.map((id) => ({ id, label: t(`tab.${id}`) }))}
      value={active}
      onChange={(id) => {
        if (id !== active) router.push(FEED_TAB_HREF[id]);
      }}
      ariaLabel={t('tabsLabel')}
      idBase={FEED_TABS_ID}
    />
  );
}
