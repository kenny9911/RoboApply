// extension/src/content/panel/Launcher.tsx — the collapsed panel: one button that opens it.
// GoApply (market cn) words it 一键填表 (`extension-cn` namespace).

import { useTranslations } from '../../i18n/index';
import { cnText } from './cnStrings';

export function Launcher({ onOpen, market = 'intl' }: { onOpen: () => void; market?: 'intl' | 'cn' }) {
  const t = useTranslations('extension');
  const cn = market === 'cn';
  return (
    <button type="button" className="launcher" onClick={onOpen} aria-label={cn ? cnText('launcher.label') : t('launcher.label')}>
      {cn ? cnText('launcher.text') : t('launcher.text')}
    </button>
  );
}
