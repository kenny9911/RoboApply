'use client';

// /settings#assistant — what the Assistant remembers, with delete (flag
// `copilot`; F-ORION-09; TASK_PLAN.md WP-51).
//
// • The list of remembered facts (max MEMORY_MAX), each deletable.
// • GoApply: memory needs the `copilot_memory` consent. Its exact text is
//   shown with Turn on / Turn off; while it is off nothing is saved (the
//   memory card in a chat asks for it first too).
// • The floating Assistant button: hide or show it again.

import { useFormatter, useTranslations } from 'next-intl';

import { useDeleteMemory, useMemory, useMemoryConsent, useRailMemory } from '../../../hooks/copilot';
import { useFlag } from '../../../lib/flags';
import { Btn } from '../../v3/primitives';
import type { SettingsSectionProps } from '../settings/sectionComponents';
import styles from './copilot.module.css';

/** Client twin of the server's COPILOT_MEMORY_MAX (a parity test keeps them equal). */
export const MEMORY_MAX = 50;

export function SettingsSection(_props: SettingsSectionProps) {
  const t = useTranslations('assistant');
  const fmt = useFormatter();
  const enabled = useFlag('copilot');
  const memory = useMemory({ enabled });
  const del = useDeleteMemory();
  const consent = useMemoryConsent();
  const fab = useRailMemory({ enabled, open: false, track: false });

  if (!enabled) return null;

  const facts = memory.data ?? [];
  return (
    <div className={styles.settings} data-testid="assistant-settings">
      <section className={styles.settingsCard} aria-labelledby="assistant-memory-title">
        <h3 id="assistant-memory-title" className={styles.panelTitle}>
          {t('memory.title')}
        </h3>
        <p className={styles.panelIntro}>{t('memory.intro')}</p>

        {consent.required ? (
          <div className={styles.consent} data-testid="assistant-memory-consent" data-state={consent.granted === true ? 'on' : 'off'}>
            {consent.item ? (
              <p className={styles.cardText} lang={consent.item.proseLocale === 'zh' ? 'zh-CN' : 'en'}>
                {consent.item.prose}
              </p>
            ) : null}
            <p className={styles.cardText}>{consent.granted === true ? t('memory.consentOn') : t('memory.consentOff')}</p>
            {consent.error ? (
              <p className={styles.alert} role="alert">
                {t('memory.consentFailed')}
              </p>
            ) : null}
            {consent.item ? (
              <div className={styles.row}>
                {consent.granted === true ? (
                  <Btn disabled={consent.saving} onClick={() => void consent.set(false)}>
                    {t('memory.turnOff')}
                  </Btn>
                ) : (
                  <Btn variant="primary" disabled={consent.saving} onClick={() => void consent.set(true)}>
                    {t('memory.turnOn')}
                  </Btn>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {memory.isError ? (
          <div className={styles.row}>
            <p className={styles.alert} role="alert">
              {t('memory.loadFailed')}
            </p>
            <Btn onClick={() => void memory.refetch()}>{t('memory.retry')}</Btn>
          </div>
        ) : memory.data ? (
          <>
            <p className={styles.label}>{t('memory.count', { count: facts.length, max: MEMORY_MAX })}</p>
            {facts.length === 0 ? (
              <p className={styles.muted}>{t('memory.empty')}</p>
            ) : (
              <ul className={styles.cardList} data-testid="assistant-memory-list">
                {facts.map((f) => {
                  const at = new Date(f.createdAt);
                  return (
                    <li key={f.id} className={styles.factRow}>
                      <p className={styles.factText}>
                        {f.fact}
                        {Number.isNaN(at.getTime()) ? null : <span className={styles.factDate}>{t('memory.saved', { date: fmt.dateTime(at, { dateStyle: 'medium' }) })}</span>}
                      </p>
                      <Btn aria-label={t('memory.deleteAria', { fact: f.fact })} disabled={del.isPending && del.variables === f.id} onClick={() => del.mutate(f.id)}>
                        {t('memory.delete')}
                      </Btn>
                    </li>
                  );
                })}
              </ul>
            )}
            {del.isError ? (
              <p className={styles.alert} role="alert">
                {t('memory.deleteFailed')}
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      {fab.fabHidden !== null ? (
        <section className={styles.settingsCard} aria-labelledby="assistant-fab-title">
          <h3 id="assistant-fab-title" className={styles.panelTitle}>
            {t('fabSetting.title')}
          </h3>
          <p className={styles.panelIntro}>{fab.fabHidden ? t('fabSetting.hidden') : t('fabSetting.visible')}</p>
          <div className={styles.row}>
            {fab.fabHidden ? <Btn onClick={fab.showFab}>{t('fabSetting.show')}</Btn> : <Btn onClick={fab.hideFab}>{t('fabSetting.hide')}</Btn>}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export default SettingsSection;
