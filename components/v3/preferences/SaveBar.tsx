'use client';

// SaveBar — the sticky "Unsaved changes" bar that appears when the preferences
// form is dirty and clears on save. Ported from the proto's `.pref-savebar`.
// The panel uses the CSS gradient background (var(--surface) → var(--bg-2)),
// which is fully opaque and resolves on :root in V3 — compliant with the
// CLAUDE.md solid-panel rule (V3 defines --surface on :root, not a scoped token).

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
  const t = useTranslations('preferences');
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
