'use client';

// ExtensionStatusCard — the three-state setup card of /extension (ruling C32;
// F-ACCT-03): profile incomplete → Complete profile · no extension → Install
// · done → Explore jobs. Between "installed" and "done" it also asks to
// update an extension below the minimum version and to connect this browser
// (a device token handed straight to the extension, or an 8-character code
// for the extension's "Enter code" screen).
//
// The order is deliberate: the extension can only fill what the profile
// holds, so an incomplete profile comes first even when the extension is
// already installed.

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { ProfileCompletionCard } from '../profile';
import { WechatBrowserBanner } from '../auth-cn';
import { useProfile } from '../../../hooks/profile/useProfile';
import { isBelowMinVersion, useExtStatus, useExtensionPresence, usePairBrowser, usePairCode, type ExtensionPresence } from '../../../hooks/extension';
import { cn } from '../../../lib/utils';
import s from './extension.module.css';

export type SetupStage = 'loading' | 'unavailable' | 'profile' | 'mobile' | 'unsupported' | 'install' | 'update' | 'connect' | 'done';

/** Pure: which state the card shows. */
export function setupStage(input: {
  profileMissing: number | null;
  presence: Pick<ExtensionPresence, 'state' | 'version' | 'paired'>;
  minExtVersion: string | null;
  /** Live devices of this brand on the server (null while unknown). */
  liveDevices?: number | null;
}): SetupStage {
  const { presence } = input;
  if (presence.state === 'unavailable') return 'unavailable';
  if (input.profileMissing === null) return 'loading';
  if (input.profileMissing > 0) return 'profile';
  if (presence.state === 'mobile') return 'mobile';
  if (presence.state === 'unsupported') return 'unsupported';
  if (presence.state === 'checking') return 'loading';
  if (presence.state === 'absent') return 'install';
  if (isBelowMinVersion(presence.version, input.minExtVersion)) return 'update';
  // `paired` only says the extension holds a token: after "Disconnect" in
  // Settings → Devices that token is dead, so with no live device the browser
  // has to connect again.
  if (!presence.paired || input.liveDevices === 0) return 'connect';
  return 'done';
}

const STEP_OF: Partial<Record<SetupStage, number>> = { profile: 1, mobile: 2, unsupported: 2, install: 2, update: 2, connect: 3 };

export function ExtensionStatusCard() {
  const t = useTranslations('extensionWeb');
  const locale = useLocale();
  const profile = useProfile();
  const status = useExtStatus();
  const presence = useExtensionPresence();
  const pair = usePairBrowser(presence.extensionId, presence.version);
  const code = usePairCode();
  const [pairFailed, setPairFailed] = useState(false);

  const missing = profile.data && Array.isArray(profile.data.missing) ? profile.data.missing.length : profile.isError ? 0 : null;
  const stage = setupStage({
    profileMissing: missing,
    presence,
    minExtVersion: status.data?.minExtVersion ?? null,
    liveDevices: status.data ? status.data.devices.length : null,
  });

  if (stage === 'unavailable') return null;

  const step = STEP_OF[stage];
  const head = (title: string) => (
    <>
      {step ? <span className={s.stepTag}>{t('status.step', { current: step })}</span> : <span className={s.doneTag}>{t('status.title')}</span>}
      <h2 className={s.cardTitle} id="ext-status-title">
        {title}
      </h2>
    </>
  );

  let content;
  switch (stage) {
    case 'loading':
      content = (
        <p className={s.meta} role="status">
          {presence.state === 'checking' && missing === 0 ? t('status.install.checking') : t('status.loading')}
        </p>
      );
      break;
    case 'profile':
      content = (
        <>
          {head(t('status.profile.title'))}
          <p className={s.body}>{t('status.profile.body')}</p>
          <ProfileCompletionCard linkBase="/profile" profile={profile.data} />
          <div className={s.actions}>
            <Btn as="a" href="/profile" variant="primary">
              {t('status.profile.cta')}
            </Btn>
          </div>
        </>
      );
      break;
    case 'mobile':
    case 'unsupported':
      content = (
        <>
          {head(t('status.install.title'))}
          <p className={s.body}>{stage === 'mobile' ? t('status.mobile') : t('status.unsupported')}</p>
          <WechatBrowserBanner action="extension" />
        </>
      );
      break;
    case 'install':
      content = (
        <>
          {head(t('status.install.title'))}
          <p className={s.body}>{t('status.install.body')}</p>
          <div className={s.actions}>
            {presence.storeUrl ? (
              <Btn as="a" href={presence.storeUrl} target="_blank" rel="noopener noreferrer" variant="primary">
                {t('status.install.cta')}
              </Btn>
            ) : null}
            <Btn onClick={presence.recheck}>{t('status.install.recheck')}</Btn>
          </div>
        </>
      );
      break;
    case 'update':
      content = (
        <>
          {head(t('status.update.title'))}
          <p className={s.body}>{t('status.update.body', { version: presence.version ?? '' })}</p>
          <div className={s.actions}>
            {presence.storeUrl ? (
              <Btn as="a" href={presence.storeUrl} target="_blank" rel="noopener noreferrer" variant="primary">
                {t('status.update.cta')}
              </Btn>
            ) : null}
          </div>
        </>
      );
      break;
    case 'connect':
      content = (
        <>
          {head(t('status.connect.title'))}
          <p className={s.body}>{t('status.connect.body')}</p>
          <div className={s.actions}>
            <Btn
              variant="primary"
              disabled={pair.isPending}
              onClick={() =>
                pair.mutate(undefined, {
                  onSuccess: (outcome) => {
                    if (outcome === 'paired') {
                      setPairFailed(false);
                      presence.recheck();
                    } else setPairFailed(true);
                  },
                  onError: () => setPairFailed(true),
                })
              }
            >
              {pair.isPending ? t('status.connect.pending') : t('status.connect.cta')}
            </Btn>
          </div>
          {pairFailed ? (
            <p className={s.alert} role="alert">
              {t('status.connect.failed')}
            </p>
          ) : null}
          <section className={s.stack} aria-labelledby="ext-code-title">
            <h3 className={s.cardSub} id="ext-code-title">
              {t('status.code.title')}
            </h3>
            <p className={s.meta}>{t('status.code.body')}</p>
            {code.data ? (
              <>
                <p className={s.code} aria-live="polite">
                  {code.data.code}
                </p>
                <p className={s.meta}>
                  {t('status.code.expires', { time: new Date(code.data.expiresAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) })}
                </p>
              </>
            ) : null}
            {code.isError ? <p className={s.error}>{t('status.code.error')}</p> : null}
            <div className={s.actions}>
              <Btn disabled={code.isPending} onClick={() => code.mutate()}>
                {code.isPending ? t('status.code.pending') : t('status.code.cta')}
              </Btn>
            </div>
          </section>
        </>
      );
      break;
    case 'done':
      content = (
        <>
          <span className={s.doneTag}>{t('status.title')}</span>
          <h2 className={s.cardTitle} id="ext-status-title">
            {t('status.done.title')}
          </h2>
          <p className={s.body}>{t('status.done.body')}</p>
          <div className={s.actions}>
            <Btn as="a" href="/jobs" variant="primary">
              {t('status.done.cta')}
            </Btn>
          </div>
        </>
      );
      break;
  }

  return (
    <section className={cn(s.status, stage === 'done' && s.statusDone)} aria-labelledby="ext-status-title" data-stage={stage}>
      {stage === 'loading' ? (
        <h2 className={s.cardTitle} id="ext-status-title">
          {t('status.title')}
        </h2>
      ) : null}
      {content}
    </section>
  );
}

export default ExtensionStatusCard;
