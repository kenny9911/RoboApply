'use client';

// YourTile — the candidate's own tile on the right stage. Video mode uses a
// real webcam via getUserMedia with graceful fallback across all permission
// states (proto `YourVideoTile`). Voice mode shows the avatar + mic-viz
// (proto `.iv-you`). `active` = mic open (interviewer is listening).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MicViz } from './MicViz';
import { classifyMediaError, isDeviceFailure, mediaUnavailableReason, type DeviceState } from './deviceState';

function stopTracks(stream: MediaStream | null) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* already stopped */ }
  }
}

export interface LocalCameraPreview {
  /** The local camera stream while the preview is on. Never published. */
  stream: MediaStream | null;
  state: DeviceState;
  /** The preview is showing. */
  on: boolean;
  /** The candidate (or the initial state) asked for the preview at least once. */
  tried: boolean;
  start: () => void;
  stop: () => void;
}

/**
 * The candidate's camera as a LOCAL self-view only (WP-63a, CN L-11): the
 * stream comes straight from getUserMedia and is never handed to the room, so
 * no video track is published, recorded or analysed. GoApply's live room uses
 * this in video mode. A getUserMedia that answers after it was superseded
 * (toggle, unmount) stops its own stream so the camera light never sticks.
 * `offState` is shown while it starts off (e.g. why the device check failed).
 */
export function useLocalCameraPreview(initiallyOn: boolean, offState: DeviceState = 'off'): LocalCameraPreview {
  const [wanted, setWanted] = useState(initiallyOn);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DeviceState>(initiallyOn ? 'checking' : offState);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    if (!wanted) {
      setState((s) => (isDeviceFailure(s) ? s : 'off'));
      return undefined;
    }
    const unavailable = mediaUnavailableReason();
    if (unavailable) {
      setState(unavailable);
      return undefined;
    }
    let current: MediaStream | null = null;
    setState('checking');
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        if (gen !== genRef.current) { stopTracks(s); return; }
        current = s;
        setStream(s);
        setState('ok');
      })
      .catch((err: unknown) => {
        if (gen !== genRef.current) return;
        setState(classifyMediaError(err));
      });
    return () => {
      genRef.current += 1;
      stopTracks(current);
      setStream(null);
    };
  }, [wanted, attempt]);

  const start = useCallback(() => {
    setWanted(true);
    setAttempt((a) => a + 1);
  }, []);
  const stop = useCallback(() => setWanted(false), []);

  return { stream, state, on: wanted && state === 'ok' && stream !== null, tried: initiallyOn || attempt > 0, start, stop };
}

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
  const t = useTranslations('practice');
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
            background: active ? 'var(--live)' : 'var(--text-muted)',
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
