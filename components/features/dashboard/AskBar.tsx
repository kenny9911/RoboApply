'use client';

// AskBar — the floating "ask" bar at the foot of the Dashboard, after
// resume.io's "Ask AI coach anything." pill (docs/resume-io/TEARDOWN.md).
// It opens the Assistant rail (the same rail the Topbar's Ask opens), and is
// shown under the same rule: the `copilot` capability is on and the surface
// has shipped (useAskVisible). It sticks to the bottom of the workspace while
// the page scrolls; below 760px it sits above the bottom bar.

import { useTranslations } from 'next-intl';

import { useOpenAssistant } from '../../../hooks/shared/useOpenAssistant';
import { useAskVisible } from '../../v3/shell/Topbar';
import { IconSparkle } from '../../v3/primitives/Iconset';
import styles from './dashboard.module.css';

export function AskBar() {
  const t = useTranslations('dashboard');
  const visible = useAskVisible();
  const openAssistant = useOpenAssistant();
  if (!visible) return null;
  return (
    <div className={styles.askDock}>
      <button type="button" className={styles.askBar} onClick={() => openAssistant({ source: 'other' })}>
        <span className={styles.askIcon} aria-hidden="true">
          <IconSparkle size={18} />
        </span>
        <span>{t('ask_bar')}</span>
      </button>
    </div>
  );
}
