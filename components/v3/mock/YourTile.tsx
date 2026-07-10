'use client';

// YourTile — the candidate's own tile on the right stage. Video mode uses a
// real webcam via getUserMedia with graceful fallback across all permission
// states (proto `YourVideoTile`). Voice mode shows the avatar + mic-viz
// (proto `.iv-you`). `active` = mic open (interviewer is listening).

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MicViz } from './MicViz';

type PermState = 'idle' | 'requesting' | 'granted' | 'denied' | 'unavailable';

interface Props {
  /** display name (the signed-in user) */
  name: string;
  /** subtitle role */
  role: string;
  /** 2-letter monogram */
  initials: string;
  /** mic open (interviewer listening) */
  active: boolean;
  video: boolean;
  camOn: boolean;
  onCamChange: (on: boolean) => void;
}

export function YourTile({
  name,
  role,
  initials,
  active,
  video,
  camOn,
  onCamChange,
}: Props) {
  const t = useTranslations('mock');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [permState, setPermState] = useState<PermState>('idle');

  const requestCam = async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPermState('unavailable');
      return;
    }
    setPermState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 360 },
        audio: false,
      });
      streamRef.current = stream;
      setPermState('granted');
    } catch {
      setPermState('denied');
    }
  };

  const stopCam = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  // Attach the stream to the <video> once it mounts (only exists at 'granted').
  useEffect(() => {
    if (permState === 'granted' && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      const p = videoRef.current.play?.();
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    }
  }, [permState]);

  // React to the cam toggle (video mode only).
  useEffect(() => {
    if (!video) return;
    if (camOn && permState !== 'granted' && permState !== 'requesting') {
      void requestCam();
    } else if (!camOn && permState === 'granted') {
      stopCam();
      setPermState('idle');
    }
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camOn, video]);

  // Stop the camera entirely on unmount.
  useEffect(() => {
    return () => stopCam();
  }, []);

  // ── Voice mode ──
  if (!video) {
    return (
      <div className="iv-you">
        <div className="iv-you-head">
          <div className="iv-avatar-sm">{initials}</div>
          <div>
            <div className="iv-you-name">{t('live.youName', { name })}</div>
            <div className="iv-you-state">
              {active ? (
                <>
                  <span className="iv-mic-dot" /> {t('live.micOpen')}
                </>
              ) : (
                t('live.waitForQuestion')
              )}
            </div>
          </div>
        </div>
        <MicViz active={active} />
      </div>
    );
  }

  // ── Video mode ──
  return (
    <div className={`iv-video-tile you ${active ? 'speaking' : ''}`}>
      <div className="iv-vt-canvas you-canvas">
        {permState === 'granted' ? (
          <video ref={videoRef} autoPlay playsInline muted className="iv-vt-feed" />
        ) : (
          <div className="iv-vt-placeholder">
            <div className="iv-vt-ph-avatar">{initials}</div>
            {permState === 'requesting' ? (
              <div className="iv-vt-ph-text">
                <strong>{t('live.cam.requesting')}</strong>
                <span>{t('live.cam.requestingSub')}</span>
              </div>
            ) : null}
            {permState === 'denied' ? (
              <div className="iv-vt-ph-text">
                <strong>{t('live.cam.denied')}</strong>
                <span>{t('live.cam.deniedSub')}</span>
                <button
                  type="button"
                  className="btn"
                  style={{ marginTop: 8 }}
                  onClick={() => void requestCam()}
                >
                  {t('live.cam.tryAgain')}
                </button>
              </div>
            ) : null}
            {permState === 'unavailable' ? (
              <div className="iv-vt-ph-text">
                <strong>{t('live.cam.unavailable')}</strong>
                <span>{t('live.cam.unavailableSub')}</span>
              </div>
            ) : null}
            {permState === 'idle' && !camOn ? (
              <div className="iv-vt-ph-text">
                <strong>{t('live.cam.off')}</strong>
                <button
                  type="button"
                  className="btn"
                  style={{ marginTop: 8 }}
                  onClick={() => onCamChange(true)}
                >
                  {t('live.cam.turnOn')}
                </button>
              </div>
            ) : null}
            {permState === 'idle' && camOn ? (
              <div className="iv-vt-ph-text">
                <strong>{t('live.cam.allow')}</strong>
                <button
                  type="button"
                  className="btn"
                  style={{ marginTop: 8 }}
                  onClick={() => void requestCam()}
                >
                  {t('live.cam.enable')}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="iv-vt-badge you">
        <span
          className="iv-mic-dot"
          style={{
            background: active ? 'var(--live)' : 'var(--muted)',
            boxShadow: active ? '0 0 8px var(--live)' : 'none',
          }}
        />
        {active ? t('live.micOpenShort') : t('live.micReady')}
      </div>

      <div className="iv-vt-state-pill">
        {active ? (
          <>
            <span className="dot speaking" /> {t('live.you')}
          </>
        ) : (
          t('live.you')
        )}
      </div>

      <div className="iv-vt-name-overlay">
        <div className="iv-vt-name">{name}</div>
        <div className="iv-vt-role">{role}</div>
      </div>

      <div className="iv-vt-wave">
        <MicViz active={active} compact />
      </div>
    </div>
  );
}
