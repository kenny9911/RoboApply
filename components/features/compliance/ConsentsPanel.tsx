'use client';

// ConsentsPanel — /settings#consents (GoApply; WP-13). Each consent is shown
// with its exact text and current state and can be changed on its own
// (PIPL: separate consents). Withdrawing the CN-0 cross-border consent asks
// first, because it closes the account and deletes its data.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { getConsents, recordConsent } from '../../../lib/api/compliance';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import type { ConsentCatalogItem } from '../../../lib/api/contracts/compliance';
import { Btn } from '../../v3/primitives/Btn';
import { Modal } from '../../v3/primitives/Modal';
import styles from './compliance.module.css';

export const CONSENTS_QUERY_KEY = ['compliance', 'consents'] as const;

type Change = { item: ConsentCatalogItem; granted: boolean };

export function ConsentsPanel() {
  const t = useTranslations('legal');
  const fmt = useFormatter();
  const locale = useLocale();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<ConsentCatalogItem | null>(null);
  const [closing, setClosing] = useState(false);

  const consents = useQuery({ queryKey: [...CONSENTS_QUERY_KEY, locale], queryFn: () => getConsents({ locale }) });
  const save = useMutation({
    mutationFn: ({ item, granted }: Change) => recordConsent({ type: item.type, granted, proseVersion: item.proseVersion, locale }),
    onSuccess: (res) => {
      setConfirm(null);
      if (res.accountClosing) setClosing(true);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: CONSENTS_QUERY_KEY }),
  });

  const change = (item: ConsentCatalogItem, granted: boolean) => {
    if (!granted && item.onWithdraw === 'close_and_purge_account') {
      setConfirm(item);
      return;
    }
    save.mutate({ item, granted });
  };

  if (closing) {
    return (
      <div className={styles.card} role="status" data-testid="consents-closing">
        <p className={styles.cardBody}>{t('consents.closing')}</p>
      </div>
    );
  }

  if (consents.isError) {
    return (
      <div className={styles.card}>
        <p className={styles.alert} role="alert">
          {t('consents.loadError')}
        </p>
        <div className={styles.actions}>
          <Btn onClick={() => void consents.refetch()}>{t('consents.retry')}</Btn>
        </div>
      </div>
    );
  }
  if (!consents.data) return <p className={styles.muted}>{t('disclosures.loading')}</p>;

  const outdated = save.isError && apiErrorCode(save.error) === 'version_conflict';

  return (
    <div className={styles.panel} data-testid="consents-panel">
      <section className={styles.card}>
        <h3 className={styles.cardTitle}>{t('consents.title')}</h3>
        <p className={styles.cardBody}>{t('consents.intro')}</p>
        {save.isError ? (
          <div className={styles.actions}>
            <p className={styles.alert} role="alert">
              {outdated ? t('consents.outdated') : t('consents.error')}
            </p>
            {outdated ? <Btn onClick={() => void consents.refetch()}>{t('consents.reload')}</Btn> : null}
          </div>
        ) : null}
        <ul className={styles.list}>
          {consents.data.items.map((item) => {
            const state = item.granted === true ? 'on' : item.granted === false ? 'off' : 'notChosen';
            const busy = save.isPending && save.variables?.item.type === item.type;
            return (
              <li key={item.type} className={styles.item} data-consent={item.type} data-state={state}>
                <div className={styles.itemMain}>
                  <p className={styles.itemMeta} style={{ marginTop: 0 }}>
                    <span className={styles.pill}>{item.required ? t('consents.required') : t('consents.optional')}</span>
                    <span className={`${styles.pill} ${state === 'on' ? styles.pillOn : ''}`}>{t(`consents.${state}`)}</span>
                    {item.answeredAt ? t('consents.changed', { date: fmt.dateTime(new Date(item.answeredAt), { dateStyle: 'medium' }) }) : null}
                  </p>
                  <p className={styles.prosePara} lang={item.proseLocale === 'zh' ? 'zh-CN' : 'en'}>
                    {item.prose}
                  </p>
                  {item.proseLocale === 'en' && locale !== 'en' ? <p className={styles.itemMeta}>{t('consents.englishOnly')}</p> : null}
                  {!item.withdrawable ? <p className={styles.itemMeta}>{t('consents.notWithdrawable')}</p> : null}
                </div>
                {item.withdrawable ? (
                  <div className={styles.actions}>
                    {item.granted !== true ? (
                      <Btn variant="primary" disabled={busy} onClick={() => change(item, true)}>
                        {t('consents.turnOn')}
                      </Btn>
                    ) : null}
                    {item.granted !== false ? (
                      <Btn disabled={busy} onClick={() => change(item, false)}>
                        {t('consents.turnOff')}
                      </Btn>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={t('consents.closeTitle')}
        maxWidth="sm"
        footer={
          <div className={styles.actions}>
            <Btn variant="ghost" onClick={() => setConfirm(null)}>
              {t('consents.closeKeep')}
            </Btn>
            <Btn
              variant="primary"
              disabled={save.isPending}
              onClick={() => confirm && save.mutate({ item: confirm, granted: false })}
              data-testid="consents-close-confirm"
            >
              {t('consents.closeConfirm')}
            </Btn>
          </div>
        }
      >
        <p className={styles.cardBody}>{t('consents.closeBody')}</p>
      </Modal>
    </div>
  );
}

export default ConsentsPanel;
