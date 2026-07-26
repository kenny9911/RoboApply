'use client';

// SaveBar — the sticky "Unsaved changes" bar that appears when the preferences
// form is dirty and clears on save. Ported from the proto's `.pref-savebar`.
// The panel background is a flat var(--surface) — fully opaque and resolved on
// :root in V3, so it satisfies the CLAUDE.md solid-panel rule (V3 defines
// --surface on :root, not as a scoped token).

import { useTranslations } from 'next-intl';
import { Btn, IconCheck } from '../primitives';

export function SaveBar({
  saving,
  onDiscard,
  onSave,
}: {
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const t = useTranslations('settings');
  return (
    <div className="pref-savebar" role="region" aria-label={t('savebar.unsaved')}>
      <div className="pref-savebar-meta">
        <span className="pref-savebar-dot" />
        {t('savebar.unsaved')}
      </div>
      <div style={{ display: 'flex', gap: 9 }}>
        <Btn variant="ghost" onClick={onDiscard} disabled={saving}>
          {t('savebar.discard')}
        </Btn>
        <Btn
          variant="primary"
          onClick={onSave}
          disabled={saving}
          icon={<IconCheck size={13} strokeWidthValue={3} />}
        >
          {saving ? t('savebar.saving') : t('savebar.save')}
        </Btn>
      </div>
    </div>
  );
}
