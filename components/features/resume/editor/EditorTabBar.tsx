'use client';

// EditorTabBar — Edit · Customize · Review · Tailor over the resume editor,
// after resume.io's editor tabs. The shared Tabs primitive (underline tabs,
// arrow keys, Home / End); on a narrow screen the list scrolls sideways
// instead of widening the page. Tailor carries a "New" tag and is listed only
// when AI tailoring may run for this user (R-04: a disabled AI path has no
// entry). Each tab's content sits in an <EditorTabPanel>.

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { cn } from '../../../../lib/utils';
import { Tabs, Tag, tabPanelProps, type TabItem } from '../../../v3/primitives';
import { EDITOR_TABS_ID, type EditorTab } from './tabs';
import styles from './EditorTabs.module.css';

export interface EditorTabBarProps {
  value: EditorTab;
  onChange: (tab: EditorTab) => void;
  /** List the Tailor tab (AI tailoring may run for this user). */
  tailor: boolean;
}

export function EditorTabBar({ value, onChange, tailor }: EditorTabBarProps) {
  const t = useTranslations('resume.editor_tabs');
  const tabs: TabItem<EditorTab>[] = [
    { id: 'edit', label: t('edit') },
    { id: 'customize', label: t('customize') },
    { id: 'review', label: t('review') },
  ];
  if (tailor) {
    tabs.push({
      id: 'tailor',
      label: (
        <>
          {t('tailor')}{' '}
          <Tag tone="strong" className={styles.newTag}>
            {t('new')}
          </Tag>
        </>
      ),
    });
  }
  return <Tabs tabs={tabs} value={value} onChange={onChange} ariaLabel={t('label')} idBase={EDITOR_TABS_ID} className={styles.tabs} />;
}

/**
 * The element that holds one tab's content, wired to its tab. A panel that is
 * not open is hidden, not removed: the caller decides whether its content
 * mounts (the editor mounts a tab's content the first time it opens). The
 * editor gives every panel its left-pane class, so the open one takes the
 * pane's column beside the preview (hidden ones take no grid cell).
 */
export function EditorTabPanel({ tab, active, className, children }: { tab: EditorTab; active: boolean; className?: string; children?: ReactNode }) {
  return (
    <div {...tabPanelProps(EDITOR_TABS_ID, tab)} hidden={!active} className={cn(styles.panel, className)} data-tab={tab}>
      {children}
    </div>
  );
}
