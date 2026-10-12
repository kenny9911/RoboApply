'use client';

// InstallPrompt — "Get the extension" (F-EXT-02; WP-55a), in two modes:
//
//   popup   the app-shell slot (app/(auth)/layout.tsx). Unprompted, so it
//           goes through lib/ui/popupGate.ts (one popup per page view, 24 h
//           between popups) and asks only after real use: on a job page, once
//           the user has opened at least REAL_USE_JOB_VIEWS different jobs in
//           this browser. Never on phones, tablets, WeChat's browser or
//           non-Chromium browsers (the extension cannot run there), never when
//           the extension already answers, and not again for 30 days after
//           "Not now".
//   inline  a card inside a page (Ready to apply's setup step, WP-53): install,
//           detect and version check, no gate. The host page owns "Skip".
//
// Renders nothing when the brand has no published extension or the
// `extension` capability is off.

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { WechatBrowserBanner } from '../auth-cn';
import { useFlag } from '../../../lib/flags';
import { useBrandId } from '../../../lib/brand/BrandProvider';
import { usePopupGate } from '../../../lib/ui/popupGate';
import { browserSupport, extensionIdFor, isBelowMinVersion, useExtStatus, useExtensionPresence } from '../../../hooks/extension';
import s from './extension.module.css';

export interface InstallPromptProps {
  /** 'popup' = the shell slot (gated by popupGate); 'inline' = a card inside a page. */
  mode?: 'popup' | 'inline';
}

export const REAL_USE_JOB_VIEWS = 2;
export const PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
export const JOB_VIEWS_KEY = 'ra_ext_job_views';
export const PROMPT_DISMISSED_KEY = 'ra_ext_prompt_dismissed_at';

/** `/jobs/<id>` (not the jobs list, Explore, Added or the report pages). */
export function jobIdFromPath(pathname: string): string | null {
  const m = /^\/jobs\/([^/?#]+)\/?$/.exec(pathname);
  if (!m || ['explore', 'added', 'report'].includes(m[1]!)) return null;
  return m[1]!;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the prompt simply keeps its defaults.
  }
}

/** Remember a job page view; returns how many different jobs this browser has opened (capped at 20). */
export function noteJobView(jobId: string): number {
  const seen = readJson<string[]>(JOB_VIEWS_KEY, []).filter((x) => typeof x === 'string');
  if (!seen.includes(jobId)) {
    seen.push(jobId);
    write(JOB_VIEWS_KEY, seen.slice(-20));
  }
  return Math.min(seen.length, 20);
}

export function promptSnoozed(now: number = Date.now()): boolean {
  const at = readJson<number | null>(PROMPT_DISMISSED_KEY, null);
  return typeof at === 'number' && now - at < PROMPT_SNOOZE_MS;
}

export function InstallPrompt({ mode = 'popup' }: InstallPromptProps = {}) {
  return mode === 'inline' ? <InlineInstall /> : <PopupInstall />;
}

function PopupInstall() {
  const t = useTranslations('extensionWeb');
  const brand = useBrandId();
  const on = useFlag('extension');
  const pathname = usePathname() ?? '';
  const [candidate, setCandidate] = useState(false);
  const [closed, setClosed] = useState(false);

  // Real use: a job page, after REAL_USE_JOB_VIEWS different jobs.
  useEffect(() => {
    const jobId = jobIdFromPath(pathname);
    if (!on || !extensionIdFor(brand) || !jobId || browserSupport() !== 'chromium' || promptSnoozed()) return;
    if (noteJobView(jobId) >= REAL_USE_JOB_VIEWS) setCandidate(true);
  }, [on, brand, pathname]);

  // Ask the extension only once the prompt could show.
  const presence = useExtensionPresence({ enabled: candidate });
  const { granted } = usePopupGate('extension:install', 'extension_prompt', { enabled: candidate && presence.state === 'absent' && !closed });

  if (!granted || closed || presence.state !== 'absent') return null;

  const dismiss = () => {
    write(PROMPT_DISMISSED_KEY, Date.now());
    setClosed(true);
  };

  return (
    <aside className={s.popup} role="dialog" aria-modal="false" aria-labelledby="ext-prompt-title">
      <div className={s.popupHead}>
        <h2 className={s.cardSub} id="ext-prompt-title">
          {t('prompt.title')}
        </h2>
        <button type="button" className={s.close} onClick={dismiss} aria-label={t('prompt.close')}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <p className={s.body}>{t('prompt.body')}</p>
      <div className={s.actions}>
        {presence.storeUrl ? (
          <Btn as="a" href={presence.storeUrl} target="_blank" rel="noopener noreferrer" variant="primary" onClick={dismiss}>
            {t('prompt.cta')}
          </Btn>
        ) : null}
        <Btn as="a" href="/extension" variant="ghost">
          {t('prompt.learnMore')}
        </Btn>
        <Btn variant="ghost" onClick={dismiss}>
          {t('prompt.dismiss')}
        </Btn>
      </div>
    </aside>
  );
}

function InlineInstall() {
  const t = useTranslations('extensionWeb');
  const brand = useBrandId();
  const on = useFlag('extension');
  const published = !!extensionIdFor(brand);
  const presence = useExtensionPresence({ enabled: on && published });
  const status = useExtStatus({ enabled: on && published });
  if (!on || !published || presence.state === 'unavailable') return null;

  const min = status.data?.minExtVersion ?? null;
  let body;
  if (presence.state === 'mobile') body = <p className={s.body}>{t('prompt.mobile')}</p>;
  else if (presence.state === 'unsupported') body = <p className={s.body}>{t('prompt.unsupported')}</p>;
  else if (presence.state === 'checking')
    body = (
      <p className={s.meta} role="status">
        {t('status.install.checking')}
      </p>
    );
  else if (presence.state === 'absent')
    body = (
      <>
        <p className={s.body}>{t('prompt.body')}</p>
        <div className={s.actions}>
          {presence.storeUrl ? (
            <Btn as="a" href={presence.storeUrl} target="_blank" rel="noopener noreferrer" variant="primary">
              {t('prompt.cta')}
            </Btn>
          ) : null}
          <Btn onClick={presence.recheck}>{t('status.install.recheck')}</Btn>
        </div>
      </>
    );
  else if (isBelowMinVersion(presence.version, min))
    body = (
      <>
        <p className={s.alert}>{t('prompt.updateNeeded', { version: min ?? '' })}</p>
        {presence.storeUrl ? (
          <div className={s.actions}>
            <Btn as="a" href={presence.storeUrl} target="_blank" rel="noopener noreferrer">
              {t('status.update.cta')}
            </Btn>
          </div>
        ) : null}
      </>
    );
  else
    body = (
      <>
        <p className={s.body}>{t('prompt.installed', { version: presence.version ?? '' })}</p>
        {!presence.paired ? (
          <div className={s.actions}>
            <Btn as="a" href="/extension" variant="primary">
              {t('prompt.connectCta')}
            </Btn>
          </div>
        ) : null}
      </>
    );

  return (
    <section className={s.card} aria-labelledby="ext-inline-title" data-state={presence.state}>
      <h2 className={s.cardSub} id="ext-inline-title">
        {t('prompt.cta')}
      </h2>
      <WechatBrowserBanner action="extension" />
      {body}
    </section>
  );
}

export default InstallPrompt;
