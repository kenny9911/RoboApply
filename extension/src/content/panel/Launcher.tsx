// extension/src/content/panel/Launcher.tsx — the collapsed panel: one button that opens it.

import { useTranslations } from '../../i18n/index';

export function Launcher({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations('extension');
  return (
    <button type="button" className="launcher" onClick={onOpen} aria-label={t('launcher.label')}>
      {t('launcher.text')}
    </button>
  );
}
