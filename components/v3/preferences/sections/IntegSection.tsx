'use client';

// §05 Integrations — LinkedIn / Gmail / GCal / Slack / Notion / GitHub
// connect-disconnect tiles. Self-contained: reads the integrations list and
// fires connect/disconnect mutations directly (does NOT touch the prefs draft /
// SaveBar — integration state is its own server resource).

import { useTranslations } from 'next-intl';
import { PrefHeader } from '../controls';
import { IntegrationCard } from '../IntegrationCard';
import {
  useIntegrations,
  useConnectIntegration,
  useDisconnectIntegration,
} from '../../../../hooks/useIntegrations';

export function IntegSection() {
  const t = useTranslations('preferences');
  const { data, isLoading } = useIntegrations();
  const connect = useConnectIntegration();
  const disconnect = useDisconnectIntegration();

  const pendingProvider = connect.isPending
    ? connect.variables
    : disconnect.isPending
      ? disconnect.variables
      : null;

  return (
    <>
      <PrefHeader
        eyebrow={t('integ.eyebrow')}
        title={
          <>
            {t('integ.title_before')} <em>{t('integ.title_em')}</em>
            {t('integ.title_after')}
          </>
        }
        sub={t('integ.sub')}
      />

      {isLoading ? (
        <div className="pref-row-sub">{t('integ.loading')}</div>
      ) : (
        <div className="pref-integ-grid">
          {data?.integrations.map((it) => (
            <IntegrationCard
              key={it.provider}
              integration={it}
              pending={pendingProvider === it.provider}
              onConnect={() => connect.mutate(it.provider)}
              onDisconnect={() => disconnect.mutate(it.provider)}
            />
          ))}
        </div>
      )}
    </>
  );
}
