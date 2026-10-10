'use client';

// /settings#devices — the browsers connected to the extension, with
// "Disconnect" (TASK_PLAN.md WP-55a; ARCHITECTURE.md §6.3 step 5). A
// disconnected device's token stops working on its next call. Registered in
// components/features/settings/sectionComponents.ts (flag `extension`).

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Btn, Modal, toast } from '../../v3/primitives';
import { isBelowMinVersion, useExtStatus, useRevokeDevice } from '../../../hooks/extension';
import type { DeviceView } from '../../../lib/api/contracts/extension';
import type { SettingsSectionProps } from '../settings/sectionComponents';
import s from './extension.module.css';

export function SettingsSection(_props: SettingsSectionProps) {
  const t = useTranslations('extensionWeb');
  const locale = useLocale();
  const status = useExtStatus();
  const revoke = useRevokeDevice();
  const [confirming, setConfirming] = useState<DeviceView | null>(null);

  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });

  const onConfirm = () => {
    const device = confirming;
    if (!device) return;
    revoke.mutate(device.id, {
      onSuccess: () => {
        setConfirming(null);
        toast({ message: t('devices.revoked', { name: device.name }), tone: 'ok' });
      },
      onError: () => toast({ message: t('devices.revokeError'), tone: 'danger' }),
    });
  };

  let list;
  if (status.isLoading) list = <p className={s.meta}>{t('devices.loading')}</p>;
  else if (status.isError || !status.data)
    list = (
      <div className={s.actions}>
        <p className={s.error}>{t('devices.error')}</p>
        <Btn onClick={() => void status.refetch()}>{t('status.retry')}</Btn>
      </div>
    );
  else if (status.data.devices.length === 0)
    list = (
      <>
        <p className={s.body}>{t('devices.empty')}</p>
        <div className={s.actions}>
          <Btn as="a" href="/extension" variant="primary">
            {t('devices.setup')}
          </Btn>
        </div>
      </>
    );
  else
    list = (
      <ul className={s.devices}>
        {status.data.devices.map((d) => (
          <li key={d.id} className={s.device}>
            <div>
              <p className={s.deviceName}>
                {d.name}
                {isBelowMinVersion(d.extVersion, status.data!.minExtVersion) ? <span className={s.badge}>{t('devices.outdated')}</span> : null}
              </p>
              <p className={s.meta}>
                {[
                  d.extVersion ? t('devices.version', { version: d.extVersion }) : t('devices.unknownVersion'),
                  d.lastSeenAt ? t('devices.lastUsed', { date: date(d.lastSeenAt) }) : t('devices.neverUsed'),
                  t('devices.added', { date: date(d.createdAt) }),
                ].join(' · ')}
              </p>
            </div>
            <div className={s.actions}>
              <Btn onClick={() => setConfirming(d)} aria-label={`${t('devices.revoke')}: ${d.name}`}>
                {t('devices.revoke')}
              </Btn>
            </div>
          </li>
        ))}
      </ul>
    );

  return (
    <div className={s.stack}>
      <div>
        <h2 className={s.cardTitle}>{t('devices.title')}</h2>
        <p className={s.body}>{t('devices.intro')}</p>
      </div>
      {list}
      <Modal
        open={!!confirming}
        onClose={() => setConfirming(null)}
        title={confirming ? t('devices.revokeTitle', { name: confirming.name }) : ''}
        description={t('devices.revokeBody')}
        maxWidth="sm"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirming(null)}>
              {t('devices.cancel')}
            </Btn>
            <Btn variant="primary" onClick={onConfirm} disabled={revoke.isPending}>
              {t('devices.revoke')}
            </Btn>
          </>
        }
      >
        {null}
      </Modal>
    </div>
  );
}

export default SettingsSection;
