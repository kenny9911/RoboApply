'use client';

// RecordingConsentSheet — "Keep a recording of this practice?" (TASK_PLAN.md
// WP-43; rulings H8 + C2, both brands).
//
// Recording is OFF unless the user turns it on here, for this session:
//   1. `interview_recording` — keep the audio and transcript (required for
//      any recording);
//   2. `interview_video` — a SECOND opt-in for the camera, offered only for a
//      video practice and only when the brand's consent catalog carries it.
// Both boxes start unticked (unless the user already chose them for this
// session). The text of each box is the server's consent prose (WP-13): we
// send back its `proseVersion`, so the record stores the hash of exactly what
// was shown. A box the user ticks is recorded as a grant before the choice is
// returned; the server re-checks the grant when the session is created, so a
// failed save can never start a recording.

import { useEffect, useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Sheet } from '../../v3/primitives/Sheet';
import { Btn } from '../../v3/primitives/Btn';
import { getConsents, recordConsent } from '../../../lib/api/compliance';
import type { ConsentCatalogItem } from '../../../lib/api/contracts/compliance';
import type { PracticeRecordingRequest } from '../../../lib/api/interviewEngine';
import styles from './practice.module.css';

export interface RecordingConsentSheetProps {
  open: boolean;
  onClose: () => void;
  /** The practice format: video can offer the second (camera) opt-in. */
  mode: 'voice' | 'video';
  /** The server's media policy: false = video is never recorded here, so the
   *  camera opt-in is not offered. Default true. */
  videoAllowed?: boolean;
  /** The choice already made for this session (starts all-off). */
  initial?: PracticeRecordingRequest;
  /** Called with the confirmed choice after any new grants were recorded. */
  onConfirm: (choice: PracticeRecordingRequest) => void;
}

type LoadState = 'loading' | 'ready' | 'error';

export function RecordingConsentSheet({ open, onClose, mode, videoAllowed = true, initial, onConfirm }: RecordingConsentSheetProps) {
  const t = useTranslations('practice.recording');
  const locale = useLocale();
  const audioId = useId();
  const videoId = useId();

  const [state, setState] = useState<LoadState>('loading');
  const [items, setItems] = useState<ConsentCatalogItem[]>([]);
  const [audio, setAudio] = useState(initial?.audio === true);
  const [video, setVideo] = useState(initial?.video === true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState('loading');
    setSaveError(false);
    setAudio(initial?.audio === true);
    setVideo(initial?.video === true);
    getConsents({ locale })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
    // `initial` is read when the sheet opens; later prop changes must not reset ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, locale]);

  const audioItem = items.find((item) => item.type === 'interview_recording') ?? null;
  const videoItem = mode === 'video' && videoAllowed ? (items.find((item) => item.type === 'interview_video') ?? null) : null;
  const canRecord = state === 'ready' && audioItem !== null;

  async function save() {
    if (!canRecord || !audioItem) return;
    const choice: PracticeRecordingRequest = { audio, video: audio && video && videoItem !== null };
    setSaving(true);
    setSaveError(false);
    try {
      const grants: ConsentCatalogItem[] = [];
      if (choice.audio && audioItem.granted !== true) grants.push(audioItem);
      if (choice.video && videoItem && videoItem.granted !== true) grants.push(videoItem);
      for (const item of grants) {
        await recordConsent({ type: item.type, granted: true, proseVersion: item.proseVersion, locale });
      }
      onConfirm(choice);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  function keepOff() {
    onConfirm({ audio: false, video: false });
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('sheet.title')}
      description={t('sheet.sub')}
      footer={
        <div className={styles.actions}>
          <Btn variant="primary" onClick={() => void save()} disabled={!canRecord || saving}>
            {saving ? t('sheet.saving') : t('sheet.save')}
          </Btn>
          <Btn onClick={keepOff} disabled={saving}>
            {t('sheet.keepOff')}
          </Btn>
        </div>
      }
    >
      <div className={styles.sheetBody}>
        {state === 'loading' ? (
          <p className={styles.muted} aria-live="polite">{t('sheet.loading')}</p>
        ) : null}

        {state === 'error' || (state === 'ready' && !audioItem) ? (
          <p className={styles.muted} role="status">{t('sheet.unavailable')}</p>
        ) : null}

        {canRecord && audioItem ? (
          <>
            <label className={styles.check} htmlFor={audioId}>
              <input
                id={audioId}
                type="checkbox"
                checked={audio}
                onChange={(event) => {
                  setAudio(event.target.checked);
                  if (!event.target.checked) setVideo(false);
                }}
              />
              <span>{audioItem.prose}</span>
            </label>

            {mode === 'video' && videoItem ? (
              <label className={`${styles.check} ${audio ? '' : styles.checkDisabled}`} htmlFor={videoId}>
                <input
                  id={videoId}
                  type="checkbox"
                  checked={audio && video}
                  disabled={!audio}
                  aria-describedby={audio ? undefined : `${videoId}-hint`}
                  onChange={(event) => setVideo(event.target.checked)}
                />
                <span>
                  {videoItem.prose}
                  {!audio ? (
                    <span id={`${videoId}-hint`} className={styles.muted}> {t('sheet.videoNeedsAudio')}</span>
                  ) : null}
                </span>
              </label>
            ) : (
              <p className={styles.muted}>{mode === 'video' ? t('sheet.videoNotOffered') : t('sheet.voiceOnly')}</p>
            )}

            <p className={styles.muted}>{t('sheet.withdraw')}</p>
          </>
        ) : null}

        {saveError ? (
          <p className={styles.error} role="alert">{t('sheet.error')}</p>
        ) : null}
      </div>
    </Sheet>
  );
}

export default RecordingConsentSheet;
