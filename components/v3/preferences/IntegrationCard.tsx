'use client';

// IntegrationCard — one row in the Integrations grid (§05). Ported from the
// proto's `.pref-integ`. Wired live to integrations.connect/disconnect via the
// mutation callbacks passed from the section. The icon tile uses the brand
// color from the server-supplied `RAIntegration.brandColor`.

import { useTranslations } from 'next-intl';
import { Btn } from '../primitives';
import type { RAIntegration } from '../../../lib/api/v2';

export function IntegrationCard({
  integration,
  pending,
  onConnect,
  onDisconnect,
}: {
  integration: RAIntegration;
  pending: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const t = useTranslations('preferences');
  const { connected, name, description, account, brandColor } = integration;
  return (
    <div className={`pref-integ ${connected ? 'on' : ''}`}>
      <div className="pref-integ-ic" style={{ background: brandColor }}>
        {name.charAt(0)}
      </div>
      <div className="pref-integ-body">
        <div className="pref-integ-head">
          <span className="pref-integ-name">{name}</span>
          {connected ? (
            <span className="pref-integ-status">● {t('integ.connected')}</span>
          ) : null}
        </div>
        <div className="pref-integ-desc">{description}</div>
        {connected && account ? (
          <div className="pref-integ-acct">{account}</div>
        ) : null}
      </div>
      <Btn
        variant={connected ? 'default' : 'primary'}
        disabled={pending}
        onClick={connected ? onDisconnect : onConnect}
      >
        {connected ? t('integ.disconnect') : t('integ.connect')}
      </Btn>
    </div>
  );
}
