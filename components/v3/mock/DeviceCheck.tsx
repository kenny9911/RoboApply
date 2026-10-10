'use client';

// DeviceCheck — the pre-join step of the live interview (/practice/[id]).
//
// Runs BEFORE the room token is minted, because minting it dispatches the AI
// interviewer and starts the clock. Checking devices first means a blocked
// mic or a camera held by Zoom is fixed on this calm screen instead of
// killing a running interview. The Join tap is also the user gesture that
// lets the browser play the interviewer's voice.
//
// Mic and camera are opened SEPARATELY so one failing never hides the other,
// and each gets its own plain how-to-fix line. The mic is required (the
// interviewer has to hear you); the camera is not — a video interview can
// carry on voice-only, and the candidate is told so.
//
// Every stream opened here is stopped before onJoin fires, so LiveKit can open
// the same devices without a "device in use" race on Windows/Firefox.
//
// WP-63a: with `networkProbe` the check also rates the connection
// (NetworkPrecheck) and, on a weak one, offers the written practice. With
// `cameraLocalOnly` (GoApply) it says the camera is shown to the candidate
// alone — it is never sent or recorded.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../primitives/Btn';
import { IconCamera, IconMic } from '../primitives/Iconset';
import type { InterviewMode } from '../../../lib/api/interviewEngine';
import { NetworkPrecheck, type NetworkAssessment } from '../../features/practice/NetworkPrecheck';
import { pendingLiveCopy, type LiveCopyTranslator } from './liveConnection';
import {
  classifyMediaError,
  isDeviceFailure,
  levelFromSamples,
  mediaUnavailableReason,
  type DeviceState,
} from './deviceState';
import styles from './DeviceCheck.module.css';

export interface DeviceCheckResult {
  mic: DeviceState;
  camera: DeviceState;
}

interface Props {
  mode: InterviewMode;
  /** The session is already live (refresh or a second visit): say Rejoin. */
  rejoin?: boolean;
  /** Joining is in flight — the button shows progress and stays disabled. */
  busy?: boolean;
  onJoin: (result: DeviceCheckResult) => void;
  onBack: () => void;
  /** One small request to our server; enables the connection check. */
  networkProbe?: () => Promise<unknown>;
  /** Offered when the connection is weak: do this practice in writing. */
  onSwitchToText?: () => void;
  switchingToText?: boolean;
  onNetworkResult?: (result: NetworkAssessment) => void;
  /** The camera stays a local preview (GoApply): say so under the preview. */
  cameraLocalOnly?: boolean;
}

type Kind = 'mic' | 'camera';

function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* already stopped */ }
  }
}

export function DeviceCheck({
  mode,
  rejoin = false,
  busy = false,
  onJoin,
  onBack,
  networkProbe,
  onSwitchToText,
  switchingToText = false,
  onNetworkResult,
  cameraLocalOnly = false,
}: Props) {
  const t = useTranslations('practice');
  const video = mode === 'video';
  // practice.live.cam.localOnly: where the camera picture goes on a local-only brand.
  const localOnlyNote = cameraLocalOnly ? pendingLiveCopy(t as unknown as LiveCopyTranslator, 'camLocalOnly') : null;

  const [mic, setMic] = useState<DeviceState>('idle');
  const [camera, setCamera] = useState<DeviceState>(video ? 'idle' : 'off');
  const [level, setLevel] = useState(0);

  const micStreamRef = useRef<MediaStream | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // Per-kind request generation. Bumped by every open, by unmount and by join,
  // so a getUserMedia that resolves after it was superseded (overlapping
  // opens, the StrictMode mount→cleanup→mount, or a late answer after Join)
  // stops its own stream instead of leaking it (camera/mic light stuck on).
  const requestGenRef = useRef<Record<Kind, number>>({ mic: 0, camera: 0 });

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }, []);

  const startMeter = useCallback((stream: MediaStream) => {
    stopMeter();
    const Ctor: typeof AudioContext | undefined =
      typeof window !== 'undefined'
        ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctor) return; // no Web Audio — the status line still says "Working"
    try {
      const ctx = new Ctor();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let last = 0;
      const loop = (now: number) => {
        rafRef.current = window.requestAnimationFrame(loop);
        if (now - last < 66) return; // ~15fps is plenty for a meter
        last = now;
        analyser.getByteTimeDomainData(buf);
        setLevel(levelFromSamples(buf));
      };
      rafRef.current = window.requestAnimationFrame(loop);
    } catch {
      stopMeter();
    }
  }, [stopMeter]);

  const open = useCallback(async (kind: Kind) => {
    const set = kind === 'mic' ? setMic : setCamera;
    const unavailable = mediaUnavailableReason();
    if (unavailable) { set(unavailable); return; }
    set('checking');
    const gen = ++requestGenRef.current[kind];
    const isCurrent = () => mountedRef.current && requestGenRef.current[kind] === gen;
    if (kind === 'mic') { stopMeter(); stopStream(micStreamRef.current); micStreamRef.current = null; }
    else { stopStream(camStreamRef.current); camStreamRef.current = null; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        kind === 'mic'
          ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
          : { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } },
      );
      if (!isCurrent()) { stopStream(stream); return; }
      if (kind === 'mic') {
        // Never overwrite a live stream without releasing it.
        if (micStreamRef.current !== stream) stopStream(micStreamRef.current);
        micStreamRef.current = stream;
        startMeter(stream);
      } else {
        if (camStreamRef.current !== stream) stopStream(camStreamRef.current);
        camStreamRef.current = stream;
        const el = videoElRef.current;
        // autoPlay + muted + playsInline start the preview on every engine.
        if (el) el.srcObject = stream;
      }
      set('ok');
    } catch (err) {
      if (!isCurrent()) return;
      set(classifyMediaError(err));
    }
  }, [startMeter, stopMeter]);

  /** Invalidate in-flight opens and release every device. */
  const releaseAll = useCallback(() => {
    requestGenRef.current.mic += 1;
    requestGenRef.current.camera += 1;
    stopMeter();
    stopStream(micStreamRef.current);
    stopStream(camStreamRef.current);
    micStreamRef.current = null;
    camStreamRef.current = null;
  }, [stopMeter]);

  useEffect(() => {
    mountedRef.current = true;
    void open('mic');
    if (video) void open('camera');
    return () => {
      mountedRef.current = false;
      releaseAll();
    };
    // Runs once per mount: re-checks are explicit (Try again).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-attach the preview if the <video> element mounts after the stream.
  useEffect(() => {
    const el = videoElRef.current;
    if (el && camera === 'ok' && camStreamRef.current && el.srcObject !== camStreamRef.current) {
      el.srcObject = camStreamRef.current;
    }
  }, [camera]);

  const join = () => {
    // Release every device (and any still-pending open) before LiveKit
    // opens them again.
    releaseAll();
    onJoin({ mic, camera });
  };

  const micReady = mic === 'ok';
  const cameraFailed = video && isDeviceFailure(camera);
  const stillChecking = mic === 'checking' || mic === 'idle' || (video && (camera === 'checking' || camera === 'idle'));
  const joinLabel = busy
    ? t('live.device.joining')
    : cameraFailed
      ? t('live.device.joinVoiceOnly')
      : rejoin
        ? t('live.device.rejoin')
        : t('live.device.join');

  return (
    <div className={styles.wrap}>
      <section className={styles.card} aria-labelledby="device-check-title">
        <header className={styles.head}>
          <h1 id="device-check-title">{video ? t('live.device.title') : t('live.device.titleVoice')}</h1>
          <p>{t('live.device.body')}</p>
        </header>

        {video ? (
          <div className={styles.preview} data-state={camera}>
            <video
              ref={videoElRef}
              className={styles.previewVideo}
              autoPlay
              muted
              playsInline
              aria-label={t('live.device.preview')}
              hidden={camera !== 'ok'}
            />
            {camera !== 'ok' ? (
              <p className={styles.previewOff}>
                <IconCamera size={20} aria-hidden />
                <span>{deviceLabel(t, camera)}</span>
              </p>
            ) : null}
          </div>
        ) : null}
        {video && localOnlyNote ? <p className={styles.localOnly}>{localOnlyNote}</p> : null}

        <ul className={styles.devices}>
          <DeviceRow
            kind="mic"
            state={mic}
            level={level}
            onRetry={() => void open('mic')}
          />
          {video ? (
            <DeviceRow
              kind="camera"
              state={camera}
              onRetry={() => void open('camera')}
            />
          ) : null}
          {networkProbe ? (
            <NetworkPrecheck
              probe={networkProbe}
              onSwitchToText={onSwitchToText}
              switching={switchingToText}
              onResult={onNetworkResult}
            />
          ) : null}
        </ul>

        {!micReady && !stillChecking ? (
          <p role="alert" className={styles.required}>{t('live.device.micRequired')}</p>
        ) : null}

        <div className={styles.actions}>
          <Btn onClick={onBack} disabled={busy || switchingToText}>{t('live.backToSetup')}</Btn>
          <Btn
            variant="primary"
            onClick={join}
            disabled={!micReady || busy || switchingToText || (video && (camera === 'checking' || camera === 'idle'))}
          >
            {joinLabel}
          </Btn>
        </div>
      </section>
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;

function deviceLabel(t: T, state: DeviceState): string {
  switch (state) {
    case 'idle':
    case 'checking':
      return t('live.device.state.checking');
    case 'ok':
      return t('live.device.state.ok');
    case 'denied':
      return t('live.device.state.denied');
    case 'notFound':
      return t('live.device.state.notFound');
    case 'inUse':
      return t('live.device.state.inUse');
    case 'insecure':
      return t('live.device.state.insecure');
    case 'off':
      return t('live.device.state.off');
    default:
      return t('live.device.state.error');
  }
}

/** The one-line, plain how-to-fix for a failed device. Exported so the live
 *  room can reuse the exact same words when a device fails mid-interview. */
export function deviceFix(t: T, kind: Kind, state: DeviceState): string | null {
  if (!isDeviceFailure(state)) return null;
  if (kind === 'mic') {
    switch (state) {
      case 'denied': return t('live.device.fix.mic.denied');
      case 'notFound': return t('live.device.fix.mic.notFound');
      case 'inUse': return t('live.device.fix.mic.inUse');
      case 'insecure': return t('live.device.fix.mic.insecure');
      default: return t('live.device.fix.mic.error');
    }
  }
  switch (state) {
    case 'denied': return t('live.device.fix.camera.denied');
    case 'notFound': return t('live.device.fix.camera.notFound');
    case 'inUse': return t('live.device.fix.camera.inUse');
    case 'insecure': return t('live.device.fix.camera.insecure');
    default: return t('live.device.fix.camera.error');
  }
}

export function deviceStateLabel(t: T, state: DeviceState): string {
  return deviceLabel(t, state);
}

function DeviceRow({
  kind, state, level = 0, onRetry,
}: {
  kind: Kind;
  state: DeviceState;
  level?: number;
  onRetry: () => void;
}) {
  const t = useTranslations('practice');
  const failed = isDeviceFailure(state);
  const fix = deviceFix(t, kind, state);
  const name = kind === 'mic' ? t('live.device.mic') : t('live.device.camera');
  return (
    <li className={styles.device} data-state={state}>
      <span className={styles.deviceIcon} aria-hidden>
        {kind === 'mic' ? <IconMic size={18} /> : <IconCamera size={18} />}
      </span>
      <div className={styles.deviceBody}>
        <p className={styles.deviceName}>
          <span>{name}</span>
          <span className={styles.deviceState} data-state={state}>{deviceLabel(t, state)}</span>
        </p>
        {kind === 'mic' && state === 'ok' ? (
          <span
            className={styles.meter}
            role="meter"
            aria-label={t('live.device.level')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(level * 100)}
          >
            <span className={styles.meterFill} style={{ width: `${Math.round(level * 100)}%` }} />
          </span>
        ) : null}
        {fix ? <p className={styles.fix}>{fix}</p> : null}
        {kind === 'camera' && failed ? <p className={styles.fix}>{t('live.device.voiceOnlyNote')}</p> : null}
      </div>
      {failed ? (
        <Btn onClick={onRetry} aria-label={`${t('live.device.retry')} · ${name}`}>
          {t('live.device.retry')}
        </Btn>
      ) : null}
    </li>
  );
}
