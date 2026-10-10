'use client';

// PwaInstallPrompt — "Add <brand> to your home screen" (F-MOB-03; WP-61).
//
// Shown at most ONCE (per device and per account), from the second browser
// session on, only when the browser can install (Chromium's captured
// `beforeinstallprompt`, or iOS Safari's manual Add to Home Screen), never
// when already installed or inside WeChat. It is an unprompted popup, so it
// asks lib/ui/popupGate.ts first (one per page view, 24 h between popups).
// Not an app-download modal: a bottom sheet with "Install" / "Not now".
//
// Mounted once in the authenticated shell (layout slot; see the WP-61 handoff).

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { Sheet } from '../../v3/primitives/Sheet';
import { useAuth } from '../../../lib/auth/useAuth';
import { usePopupGate } from '../../../lib/ui/popupGate';
import { useInstallPrompt } from '../../../hooks/pwa';
import styles from './pwa.module.css';

export const PWA_INSTALL_POPUP_KEY = 'pwa:install';

export function PwaInstallPrompt() {
  const t = useTranslations('pwa.install');
  const { status } = useAuth();
  const authed = status === 'authenticated';
  const prompt = useInstallPrompt({ enabled: authed });
  // Latch: once granted, keep the platform we offered even after markShown().
  const [offered, setOffered] = useState<'prompt' | 'ios' | null>(null);
  const [open, setOpen] = useState(false);
  const { granted } = usePopupGate(PWA_INSTALL_POPUP_KEY, 'announcement', { enabled: authed && prompt.eligible && offered === null });

  useEffect(() => {
    if (!granted || offered !== null || !prompt.platform) return;
    setOffered(prompt.platform);
    setOpen(true);
    prompt.markShown();
  }, [granted, offered, prompt]);

  if (!offered) return null;

  const close = () => setOpen(false);
  const install = async () => {
    await prompt.install();
    setOpen(false);
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title={t('title')}
      footer={
        <div className={styles.actions}>
          {offered === 'prompt' ? (
            <>
              <Btn variant="ghost" onClick={close}>
                {t('notNow')}
              </Btn>
              <Btn variant="primary" onClick={() => void install()}>
                {t('install')}
              </Btn>
            </>
          ) : (
            <Btn variant="primary" onClick={close}>
              {t('gotIt')}
            </Btn>
          )}
        </div>
      }
    >
      <div className={styles.stack} data-testid="pwa-install-prompt">
        <p className={styles.text}>{t('body')}</p>
        {offered === 'ios' ? <p className={styles.text}>{t('iosSteps')}</p> : null}
      </div>
    </Sheet>
  );
}

export default PwaInstallPrompt;
