'use client';

// /mock-interview/[id] — LIVE real-time AI voice/video interview.
//
// Real LiveKit room (full-duplex voice with the dispatched Python interviewer
// worker), re-skinned onto the V3 .iv-* design system + components (LiveBar,
// InterviewerTile, YourTile, LiveTranscript). The (auth) layout renders this
// route full-focus (no sidebar).
//
// Disconnect ≠ end: the backend keeps 'live' sessions rejoinable (re-mints a
// token, re-dispatches a missing agent), so only a deliberate End/Back or a
// server-side termination finalizes — finalizing on a WiFi blip would score
// and bill a half-run interview. An unexpected drop first gets ONE automatic
// rejoin attempt; only if that fails does the manual Rejoin screen appear.

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoTrack,
  useVoiceAssistant,
  useLocalParticipant,
  useRoomContext,
  useTracks,
} from '@livekit/components-react';
import {
  RoomEvent,
  Track,
  ConnectionState,
  ConnectionQuality,
  DisconnectReason,
  MediaDeviceFailure,
  type TranscriptionSegment,
  type Participant,
} from 'livekit-client';
import '@livekit/components-styles';

import { useMockCatalog } from '../../../../hooks/useMockV3';
import { useAuth } from '../../../../lib/auth/AuthProvider';
import { useMockRoleLabels } from '../../../../lib/mockRoleLabels';
import { Btn } from '../../../../components/v3/primitives/Btn';
import { IconPlay, IconX } from '../../../../components/v3/primitives/Iconset';
import {
  LiveBar, InterviewerTile, YourTile, LiveTranscript, type AiState,
  useLiveCoach, LiveQuestionCard, LiveCoachNudge, CoachMeters, CoachToggle,
} from '../../../../components/v3/mock';
// Imported directly (not via the ./mock barrel) so non-live pages don't pull
// livekit-client into their bundles.
import {
  classifyDisconnect,
  qualityLevel,
  type QualityLevel,
} from '../../../../components/v3/mock/liveConnection';
import {
  interviewEngineApi,
  postClientEvents,
  type IEClientEvent,
  type IEConnection,
  type IESessionDetail,
} from '../../../../lib/api/interviewEngine';
import type { RAMockInterviewer, RAMockTurn } from '../../../../lib/api/v2/types';
import styles from './live.module.css';

type Phase =
  | 'loading' | 'ready' | 'micDenied' | 'agentUnavailable' | 'reconnecting'
  | 'connectionLost' | 'error' | 'ended';

type ExitIntent = 'report' | 'setup';

// One automatic rejoin per disconnect episode: the short delay lets a flapping
// network settle before re-minting a token, and the single-attempt cap means a
// genuinely dead connection lands on the manual screen instead of looping.
const AUTO_REJOIN_DELAY_MS = 1_500;
// connection() reports agentDispatched=false on a mere 8s dispatch TIMEOUT —
// the dispatch usually still lands moments later (the backend persists the
// late dispatch id). Re-check once before declaring the interviewer gone.
const AGENT_DISPATCH_RETRY_DELAY_MS = 3_000;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'You';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const FALLBACK_INTERVIEWER: RAMockInterviewer = {
  id: 'interviewer', name: 'Interviewer', role: '', blurb: '', difficulty: 2,
  palette: ['#4ED8FF', '#8B5BFF'], company: '', style: '', archetype: 'behavioral',
};

// Probe the mic BEFORE mounting the room: the session auto-connects with
// audio, so a denied/absent mic would otherwise yield a silent one-way
// interview that still bills. Only hard permission/absence failures block
// entry — transient errors (device busy etc.) fall through to the in-room
// onMediaDeviceFailure banner.
async function probeMicrophone(): Promise<'ok' | 'denied'> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'ok';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return 'ok';
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return name === 'NotAllowedError' || name === 'NotFoundError' ? 'denied' : 'ok';
  }
}

export default function MockLivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('practice');
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<IESessionDetail | null>(null);
  const [connection, setConnection] = useState<IEConnection | null>(null);
  // Bumped on every re-minted token so LiveKitRoom remounts with the fresh
  // credentials (its `token` prop is only read at mount time).
  const [roomKey, setRoomKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [deviceFailure, setDeviceFailure] = useState(false);
  const [exitIntent, setExitIntent] = useState<ExitIntent | null>(null);
  const endingRef = useRef(false);
  const connectRef = useRef(false);
  // Set by the End/Back paths BEFORE the room disconnects, so the disconnect
  // handler can tell a deliberate end from a dropped connection.
  const intentionalEndRef = useRef(false);
  const busyRef = useRef(false);
  const sessionRef = useRef<IESessionDetail | null>(null);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // ── Client telemetry — buffered, flushed every 10s + on unmount/end.
  // Losing a batch is fine; blocking the interview on telemetry is not.
  const eventsRef = useRef<IEClientEvent[]>([]);
  const trackEvent = useCallback((type: string, data?: Record<string, unknown>) => {
    if (eventsRef.current.length >= 200) return; // hard cap — never grow unbounded
    eventsRef.current.push(data ? { type, ts: Date.now(), data } : { type, ts: Date.now() });
  }, []);
  const flushEvents = useCallback((keepalive = false) => {
    const buf = eventsRef.current;
    if (buf.length === 0) return;
    eventsRef.current = [];
    // postClientEvents caps a call at 50 events — chunk so nothing is dropped.
    for (let i = 0; i < buf.length; i += 50) {
      postClientEvents(id, buf.slice(i, i + 50), { keepalive });
    }
  }, [id]);
  useEffect(() => {
    const h = window.setInterval(() => flushEvents(false), 10_000);
    return () => { window.clearInterval(h); flushEvents(true); };
  }, [flushEvents]);

  const catalogQuery = useMockCatalog();
  const interviewer: RAMockInterviewer =
    catalogQuery.data?.catalog.interviewers.find((i) => i.id === session?.personaId) ?? FALLBACK_INTERVIEWER;

  // agentDispatched=false is often a false negative (8s server-side dispatch
  // timeout, not a failed dispatch), so re-fetch once before treating it as
  // terminal — the retry reads the late-persisted dispatch id.
  const fetchConnection = useCallback(async (): Promise<IEConnection> => {
    const { connection: c } = await interviewEngineApi.connection(id);
    if (c.agentDispatched !== false) return c;
    trackEvent('agent_dispatch_retry');
    await new Promise((r) => { window.setTimeout(r, AGENT_DISPATCH_RETRY_DELAY_MS); });
    const { connection: retried } = await interviewEngineApi.connection(id);
    return retried;
  }, [id, trackEvent]);

  useEffect(() => {
    // Run EXACTLY once. connection() dispatches the AI interviewer into the
    // room, so a double-invocation (React StrictMode runs effects twice in dev,
    // re-renders, etc.) would put two interviewers in the room — overlapping
    // voices + doubled transcript. The ref guard survives StrictMode's
    // double-invoke; the backend also claims the dispatch atomically.
    // (Rejoin after a drop deliberately bypasses this effect — it only
    // re-calls connection(), which is safe for 'live' sessions.)
    if (connectRef.current) return;
    connectRef.current = true;
    (async () => {
      try {
        const [{ session: s }, c] = await Promise.all([
          interviewEngineApi.get(id),
          fetchConnection(),
        ]);
        // connection() stamps startedAt server-side, but this session snapshot
        // raced it — approximate with "now" so the timer starts at zero; a
        // rejoin re-fetch replaces it with the true server value.
        setSession(s.startedAt ? s : { ...s, startedAt: new Date().toISOString() });
        setConnection(c);
        if (c.agentDispatched === false) {
          // The backend already knows the interviewer dispatch failed —
          // entering the room would just burn the 15s wait into silence.
          setPhase('agentUnavailable');
          return;
        }
        if ((await probeMicrophone()) === 'denied') {
          trackEvent('mic_denied');
          setPhase('micDenied');
          return;
        }
        setPhase('ready');
      } catch (err) {
        trackEvent('connect_failed', { message: err instanceof Error ? err.message : String(err) });
        setPhase('error');
      }
    })();
  }, [id, trackEvent, fetchConnection]);

  const finish = useCallback(async (toReport: boolean, intentional = true) => {
    if (endingRef.current) return;
    endingRef.current = true;
    intentionalEndRef.current = true;
    setExitIntent(null);
    setPhase('ended');
    const startedAt = sessionRef.current?.startedAt;
    const startedMs = startedAt ? Date.parse(startedAt) : NaN;
    trackEvent('session_end', {
      elapsedSec: Number.isFinite(startedMs) ? Math.max(0, Math.round((Date.now() - startedMs) / 1000)) : null,
      intentional,
    });
    flushEvents(true);
    try { await interviewEngineApi.end(id); } catch { /* finalize is idempotent server-side */ }
    router.push(toReport ? `/practice/${id}/report` : '/practice');
  }, [id, router, trackEvent, flushEvents]);

  const requestExit = useCallback((intent: ExitIntent) => {
    if (endingRef.current) return;
    setExitIntent(intent);
  }, []);

  const cancelExit = useCallback(() => setExitIntent(null), []);

  const confirmExit = useCallback(() => {
    if (!exitIntent) return;
    void finish(exitIntent === 'report');
  }, [exitIntent, finish]);

  // One automatic reacquire per disconnect episode (reset on successful
  // rejoin). The timer is cleared on unmount so a navigation away doesn't
  // trigger a stray reconnect.
  const autoRejoinUsedRef = useRef(false);
  const autoRejoinTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (autoRejoinTimerRef.current !== null) window.clearTimeout(autoRejoinTimerRef.current);
  }, []);

  // Re-mint a token (the backend re-dispatches a missing agent for 'live'
  // sessions) and re-enter via a key bump — never through the initial effect,
  // whose connectRef one-shot guard exists to prevent double agent dispatch.
  const reacquire = useCallback(async (isRejoin: boolean, auto = false) => {
    if (busyRef.current || endingRef.current) return;
    busyRef.current = true;
    setBusy(true);
    if (isRejoin) trackEvent('rejoin_attempt', { auto });
    try {
      const c = await fetchConnection();
      setConnection(c);
      if (c.agentDispatched === false) { setPhase('agentUnavailable'); return; }
      // True elapsed across refresh/rejoin comes from the server's startedAt.
      try {
        const { session: s } = await interviewEngineApi.get(id);
        if (s.startedAt) setSession(s);
      } catch { /* keep the local snapshot */ }
      if ((await probeMicrophone()) === 'denied') {
        trackEvent('mic_denied');
        setPhase('micDenied');
        return;
      }
      if (isRejoin) trackEvent('rejoin_success', { auto });
      // Recovery closes the disconnect episode — the next drop gets its own
      // automatic attempt.
      autoRejoinUsedRef.current = false;
      setRoomKey((k) => k + 1);
      setPhase('ready');
    } catch {
      // connection() rejects once the session has left 'live' — a completed
      // session goes to its report, a dead one to the expired screen; a plain
      // network failure stays put so the user can retry.
      try {
        const { session: s } = await interviewEngineApi.get(id);
        if (s.status === 'completed' || s.status === 'finalizing') {
          router.push(`/practice/${id}/report`);
          return;
        }
        if (s.status === 'failed' || s.status === 'expired') {
          setPhase('error');
          return;
        }
      } catch { /* offline */ }
      // The automatic attempt must never strand the user on the transient
      // 'reconnecting' screen — hand over to the manual Rejoin screen.
      if (auto) setPhase('connectionLost');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [id, router, trackEvent, fetchConnection]);

  // Reason-aware disconnect: deliberate end or server termination → finalize
  // as before; anything else (network loss, signal closed, unknown) → try ONE
  // automatic rejoin, then offer the manual screen — never end + bill the
  // session on a drop.
  const handleDisconnected = useCallback((reason?: DisconnectReason) => {
    if (endingRef.current) return;
    trackEvent('disconnected', {
      reason: reason !== undefined ? DisconnectReason[reason] ?? String(reason) : 'unknown',
    });
    if (classifyDisconnect(reason, intentionalEndRef.current) === 'finalize') {
      void finish(true, intentionalEndRef.current);
      return;
    }
    if (!autoRejoinUsedRef.current) {
      autoRejoinUsedRef.current = true;
      setPhase('reconnecting');
      autoRejoinTimerRef.current = window.setTimeout(() => {
        autoRejoinTimerRef.current = null;
        void reacquire(true, true);
      }, AUTO_REJOIN_DELAY_MS);
      return;
    }
    // A duplicate disconnect signal while the auto attempt is pending or in
    // flight must not yank the UI to the manual screen — the attempt itself
    // routes to 'ready' or 'connectionLost' when it resolves.
    if (autoRejoinTimerRef.current !== null || busyRef.current) return;
    setPhase('connectionLost');
  }, [finish, trackEvent, reacquire]);

  const retryMic = useCallback(async () => {
    if (busyRef.current || endingRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if ((await probeMicrophone()) === 'denied') { trackEvent('mic_denied'); return; }
      setPhase('ready');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [trackEvent]);

  if (phase === 'loading') return <CenterMsg>{t('live.loading')}</CenterMsg>;
  if (phase === 'ended') return <CenterMsg>{t('live.ending')}</CenterMsg>;
  if (phase === 'error' || !connection || !session) {
    return (
      <CenterMsg>
        <p style={{ fontSize: 'var(--fs-subtitle)', fontWeight: 600, color: 'var(--text)', margin: 0 }}>{t('live.expired.title')}</p>
        <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-body)', margin: '8px 0 16px' }}>{t('live.expired.body')}</p>
        <Btn variant="primary" as="a" href="/practice">{t('live.expired.cta')}</Btn>
      </CenterMsg>
    );
  }
  if (phase === 'micDenied') {
    return (
      <CenterMsg>
        <p style={{ fontSize: 'var(--fs-subtitle)', fontWeight: 600, color: 'var(--text)', margin: 0 }}>{t('live.micDeniedTitle')}</p>
        <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-body)', margin: '8px 0 16px', maxWidth: 440 }}>{t('live.micDeniedBody')}</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <Btn variant="primary" onClick={() => void retryMic()} disabled={busy}>{t('live.micRetry')}</Btn>
          <Btn as="a" href="/practice">{t('live.expired.cta')}</Btn>
        </div>
      </CenterMsg>
    );
  }
  if (phase === 'agentUnavailable') {
    return (
      <CenterMsg>
        <p style={{ fontSize: 'var(--fs-subtitle)', fontWeight: 600, color: 'var(--text)', margin: 0 }}>{t('live.interviewerUnavailableTitle')}</p>
        <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-body)', margin: '8px 0 16px', maxWidth: 440 }}>{t('live.interviewerUnavailableBody')}</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <Btn variant="primary" onClick={() => void reacquire(false)} disabled={busy}>{t('live.retry')}</Btn>
          <Btn as="a" href="/practice">{t('live.expired.cta')}</Btn>
        </div>
      </CenterMsg>
    );
  }
  if (phase === 'reconnecting') {
    // Transient — the automatic reacquire either remounts the room ('ready')
    // or falls through to the manual 'connectionLost' screen.
    return (
      <CenterMsg>
        <p style={{ fontSize: 'var(--fs-subtitle)', fontWeight: 600, color: 'var(--text)', margin: 0 }}>{t('live.autoRejoinTitle')}</p>
        <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-body)', margin: '8px 0 0', maxWidth: 440 }}>{t('live.autoRejoinBody')}</p>
      </CenterMsg>
    );
  }
  if (phase === 'connectionLost') {
    return (
      <>
        <CenterMsg>
          <p style={{ fontSize: 'var(--fs-subtitle)', fontWeight: 600, color: 'var(--text)', margin: 0 }}>{t('live.connectionLostTitle')}</p>
          <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-body)', margin: '8px 0 16px', maxWidth: 440 }}>{t('live.connectionLostBody')}</p>
          <div className={styles.centerActions}>
            <Btn variant="primary" onClick={() => void reacquire(true)} disabled={busy}>{t('live.rejoin')}</Btn>
            <Btn onClick={() => requestExit('report')} disabled={busy}>{t('live.endAnyway')}</Btn>
          </div>
        </CenterMsg>
        {exitIntent && (
          <ExitConfirmDialog
            intent={exitIntent}
            onCancel={cancelExit}
            onConfirm={confirmExit}
          />
        )}
      </>
    );
  }

  return (
    <LiveKitRoom
      key={roomKey}
      serverUrl={connection.url}
      token={connection.token}
      connect
      audio
      video={connection.mode === 'video'}
      // Full-duplex audio tuning. echoCancellation is CRITICAL: it runs in the
      // candidate's browser (the only place with the speaker reference signal)
      // so the agent's own voice played through the candidate's speakers is not
      // picked up by the mic and re-transcribed — without it, full duplex breaks
      // into a feedback loop. DTX skips sending silence (lower latency/bandwidth)
      // and RED adds redundant audio packets so brief packet loss doesn't glitch
      // the conversation.
      options={{
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        publishDefaults: { dtx: true, red: true },
      }}
      onDisconnected={handleDisconnected}
      onError={(err) => {
        trackEvent('connect_failed', { message: err?.message });
        setPhase('error');
      }}
      onMediaDeviceFailure={(failure) => {
        if (failure === MediaDeviceFailure.PermissionDenied || failure === MediaDeviceFailure.NotFound) {
          trackEvent('mic_denied');
        }
        setDeviceFailure(true);
      }}
      className={`iv-live ${styles.room}`}
    >
      <RoomAudioRenderer />
      {deviceFailure && (
        <div role="alert" className={styles.deviceAlert}>
          <span>{t('live.deviceFailure')}</span>
          <button
            type="button"
            onClick={() => setDeviceFailure(false)}
            aria-label={t('live.dismiss')}
          >
            <IconX size={16} />
          </button>
        </div>
      )}
      <RoomStage
        session={session}
        connection={connection}
        interviewer={interviewer}
        onEnd={() => requestExit('report')}
        onBack={() => requestExit('setup')}
        onEvent={trackEvent}
      />
      {exitIntent && (
        <ExitConfirmDialog
          intent={exitIntent}
          onCancel={cancelExit}
          onConfirm={confirmExit}
        />
      )}
    </LiveKitRoom>
  );
}

function CenterMsg({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.centerMsg}>
      {children}
    </div>
  );
}

function ExitConfirmDialog({
  intent,
  onCancel,
  onConfirm,
}: {
  intent: ExitIntent;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('practice');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [onCancel]);

  const bodyKey = intent === 'report' ? 'live.exitDialog.reportBody' : 'live.exitDialog.setupBody';
  const confirmKey = intent === 'report' ? 'live.exitDialog.reportConfirm' : 'live.exitDialog.setupConfirm';

  return (
    <div
      className={styles.dialogBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="practice-exit-title"
        aria-describedby="practice-exit-description"
      >
        <div className={styles.dialogMark} aria-hidden>!</div>
        <div>
          <h2 id="practice-exit-title">{t('live.exitDialog.title')}</h2>
          <p id="practice-exit-description">{t(bodyKey)}</p>
        </div>
        <div className={styles.dialogActions}>
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
            {t('live.exitDialog.cancel')}
          </button>
          <button type="button" className={`btn ${styles.dialogConfirm}`} onClick={onConfirm}>
            {t(confirmKey)}
          </button>
        </div>
      </div>
    </div>
  );
}

function AudioUnlockDialog({ onUnlock }: { onUnlock: () => void }) {
  const t = useTranslations('practice');
  const dialogRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => actionRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      // This gate cannot be dismissed: the worker deliberately waits for the
      // client_ready handshake so the opening question is never spoken into a
      // muted browser. Escape therefore keeps the dialog open and returns
      // focus to its one safe action.
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        actionRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  return (
    <div className={styles.audioOverlay}>
      <div
        ref={dialogRef}
        className={styles.audioDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="practice-audio-title"
        aria-describedby="practice-audio-description"
      >
        <div className={styles.audioIcon} aria-hidden>
          <IconPlay size={24} />
        </div>
        <h2 id="practice-audio-title">{t('live.audioUnlockTitle')}</h2>
        <p id="practice-audio-description">{t('live.audioUnlockBody')}</p>
        <button
          ref={actionRef}
          type="button"
          onClick={onUnlock}
          className={`btn primary ${styles.audioButton}`}
        >
          <IconPlay size={16} />
          {t('live.enableAudio')}
        </button>
      </div>
    </div>
  );
}

// ─── Connection quality indicator ──────────────────────────────────────────

// good stays visually quiet (no alarm during a healthy interview); fair warns,
// poor alarms.
const QUALITY_TONE: Record<QualityLevel, { bar: string; text: string; border: string; bg: string }> = {
  good: { bar: '#34d399', text: 'var(--text-2)', border: 'var(--rule)', bg: 'var(--surface)' },
  fair: { bar: '#f59e0b', text: '#f59e0b', border: 'rgba(245, 158, 11, 0.45)', bg: 'rgba(245, 158, 11, 0.12)' },
  poor: { bar: '#ef4444', text: '#ef4444', border: 'rgba(239, 68, 68, 0.45)', bg: 'rgba(239, 68, 68, 0.12)' },
};

function QualityPill({ level, label }: { level: QualityLevel; label: string }) {
  const tone = QUALITY_TONE[level];
  const lit = level === 'good' ? 3 : level === 'fair' ? 2 : 1;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '3px 10px', borderRadius: 999, fontSize: 'var(--fs-label)', fontWeight: 600,
        border: `1px solid ${tone.border}`, background: tone.bg, color: tone.text,
      }}
    >
      <span aria-hidden style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2 }}>
        {[5, 8, 11].map((h, i) => (
          <span
            key={h}
            style={{ width: 3, height: h, borderRadius: 1, background: i < lit ? tone.bar : 'var(--rule)' }}
          />
        ))}
      </span>
      {label}
    </span>
  );
}

// ─── In-room stage (LiveKit room context) ─────────────────────────────────

// Audio-ready handshake with the interview worker. The worker holds its opening
// greeting until it receives this one-shot signal on this topic, so the greeting
// is never spoken into a browser output the autoplay policy has muted. Reliable
// delivery (not lossy) — the worker only greets once.
const IE_DATA_TOPIC = 'ie';
const READY_PACKET = new TextEncoder().encode(JSON.stringify({ type: 'client_ready' }));

function RoomStage({
  session, connection, interviewer, onEnd, onBack, onEvent,
}: {
  session: IESessionDetail;
  connection: IEConnection;
  interviewer: RAMockInterviewer;
  onEnd: () => void;
  onBack: () => void;
  onEvent: (type: string, data?: Record<string, unknown>) => void;
}) {
  const t = useTranslations('practice');
  const { localizeRole, localizeType } = useMockRoleLabels();
  const { user } = useAuth();
  const room = useRoomContext();
  const { state } = useVoiceAssistant();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();

  const video = connection.mode === 'video';
  const [transcript, setTranscript] = useState<RAMockTurn[]>([]);
  const [agentJoined, setAgentJoined] = useState(false);
  const [agentSlow, setAgentSlow] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // Persistent 3-level indicator for the LOCAL uplink, plus a separate flag for
  // the interviewer's (remote agent's) side — a struggling agent sounds like
  // "the app broke" unless it's labeled as a connection problem.
  const [localQuality, setLocalQuality] = useState<QualityLevel | null>(null);
  const [agentDegraded, setAgentDegraded] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [openPanel, setOpenPanel] = useState<'self' | 'coach' | 'transcript' | null>(null);
  const segMapRef = useRef<Map<string, RAMockTurn>>(new Map());

  const togglePanel = useCallback((panel: 'self' | 'coach' | 'transcript', open: boolean) => {
    setOpenPanel((current) => (open ? panel : current === panel ? null : current));
  }, []);
  useEffect(() => {
    if (!openPanel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenPanel(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openPanel]);

  // Coach Mode — on by default (this is a practice tool), persisted per browser.
  const [coachOn, setCoachOn] = useState(true);
  const [hintOpen, setHintOpen] = useState(false);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem('ie_coach_mode');
      if (v === '0') setCoachOn(false);
    } catch { /* ignore */ }
  }, []);
  const toggleCoach = useCallback(() => {
    setCoachOn((on) => {
      const next = !on;
      try { window.localStorage.setItem('ie_coach_mode', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const coach = useLiveCoach({ sessionId: session.id, transcript, session, enabled: coachOn });

  // Timer — derived from the server's startedAt (not a local 0-based counter)
  // so a refresh or rejoin shows TRUE elapsed time. Display freezes while
  // reconnecting: ticking through an outage would misrepresent interview time.
  const startedMs = session.startedAt ? Date.parse(session.startedAt) : NaN;
  const baseMsRef = useRef(Number.isFinite(startedMs) ? startedMs : Date.now());
  useEffect(() => {
    if (Number.isFinite(startedMs)) baseMsRef.current = startedMs;
  }, [startedMs]);
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - baseMsRef.current) / 1000)));
  useEffect(() => {
    if (reconnecting) return; // stale by design — see comment above
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - baseMsRef.current) / 1000)));
    tick();
    const h = window.setInterval(tick, 1000);
    return () => window.clearInterval(h);
  }, [reconnecting, startedMs]);

  // Connection-state awareness: during a reconnect the room is silent and the
  // voice-assistant state is meaningless, so surface a banner instead of
  // letting the UI sit on 'Thinking…' through a network blip. Terminal
  // disconnects are handled reason-aware by LiveKitRoom's onDisconnected.
  const reconnectStartRef = useRef<number | null>(null);
  useEffect(() => {
    const onState = (s: ConnectionState) => {
      if (s === ConnectionState.Reconnecting || s === ConnectionState.SignalReconnecting) {
        if (reconnectStartRef.current === null) {
          reconnectStartRef.current = Date.now();
          // `state` distinguishes a full RTC reconnect from a signal-only one.
          onEvent('reconnecting', { state: s });
          console.info(`[interview] reconnecting (${s})`);
        }
        setReconnecting(true);
      } else if (s === ConnectionState.Connected) {
        if (reconnectStartRef.current !== null) {
          const offlineMs = Date.now() - reconnectStartRef.current;
          onEvent('reconnected', { offlineMs });
          console.info(`[interview] reconnected after ${offlineMs}ms`);
          reconnectStartRef.current = null;
        }
        setReconnecting(false);
      }
    };
    room.on(RoomEvent.ConnectionStateChanged, onState);
    return () => { room.off(RoomEvent.ConnectionStateChanged, onState); };
  }, [room, onEvent]);

  // Connection quality — LOCAL and REMOTE (agent) participants both. Every
  // transition is logged (identity, from→to; trackEvent stamps the ts) so
  // "was that interview laggy" is answerable server-side, plus console.info
  // for live debugging. Unknown is ignored (no reading yet, not a transition).
  const poorRef = useRef(false);
  const qualityMapRef = useRef<Map<string, QualityLevel>>(new Map());
  useEffect(() => {
    const onQuality = (quality: ConnectionQuality, participant: Participant) => {
      const level = qualityLevel(quality);
      if (level === null) return;
      const key = participant.identity || (participant.isLocal ? 'local' : 'remote');
      const prev = qualityMapRef.current.get(key) ?? null;
      if (prev === level) return;
      qualityMapRef.current.set(key, level);
      onEvent('quality_change', {
        identity: participant.identity, isLocal: participant.isLocal, from: prev, to: level,
      });
      console.info(
        `[interview] connection quality ${key}${participant.isLocal ? ' (local)' : ' (agent)'}: ${prev ?? 'unknown'} → ${level}`,
      );
      if (participant.isLocal) {
        setLocalQuality(level);
        // Boundary events kept alongside quality_change — existing dashboards
        // read quality_poor/quality_recovered.
        const poor = level === 'poor';
        if (poor !== poorRef.current) {
          poorRef.current = poor;
          onEvent(poor ? 'quality_poor' : 'quality_recovered');
        }
      } else {
        setAgentDegraded(level === 'poor');
      }
    };
    room.on(RoomEvent.ConnectionQualityChanged, onQuality);
    return () => { room.off(RoomEvent.ConnectionQualityChanged, onQuality); };
  }, [room, onEvent]);

  // Audio autoplay unlock + worker greeting handshake. This page auto-connects
  // with NO user gesture, so on a fresh document load (refresh / deep-link / new
  // tab / Safari) the browser autoplay policy blocks remote audio — the agent
  // would speak into a muted output and the candidate would hear nothing, with
  // nothing looking wrong. Two parts:
  //   (1) proactively call room.startAudio() — a no-op grant where the browser
  //       already allows playback, so the common case unlocks with zero delay;
  //   (2) once playback is CONFIRMED unlocked, publish a one-shot `client_ready`
  //       message. The worker holds its greeting until it arrives, so the
  //       opening is never lost to a muted output. A blocked browser shows the
  //       enable-audio overlay, whose tap both unlocks AND fires the signal.
  const readySentRef = useRef(false);
  const signalReady = useCallback(() => {
    if (readySentRef.current) return;
    if (room.state !== ConnectionState.Connected || !room.canPlaybackAudio) return;
    readySentRef.current = true;
    room.localParticipant
      .publishData(READY_PACKET, { reliable: true, topic: IE_DATA_TOPIC })
      .then(() => onEvent('client_ready'))
      .catch(() => { readySentRef.current = false; /* not ready yet — a later event retries */ });
  }, [room, onEvent]);
  useEffect(() => {
    const sync = () => {
      const blocked = !room.canPlaybackAudio;
      setAudioBlocked(blocked);
      if (blocked) onEvent('audio_blocked');
      else signalReady();
    };
    // Proactively unlock where the browser permits it; on a blocked browser this
    // rejects and the enable-audio overlay drives the unlock via unlockAudio.
    room.startAudio().catch(() => { /* blocked — overlay takes over */ }).finally(sync);
    room.on(RoomEvent.AudioPlaybackStatusChanged, sync);
    room.on(RoomEvent.ConnectionStateChanged, sync);
    return () => {
      room.off(RoomEvent.AudioPlaybackStatusChanged, sync);
      room.off(RoomEvent.ConnectionStateChanged, sync);
    };
  }, [room, onEvent, signalReady]);
  const unlockAudio = useCallback(() => {
    room.startAudio()
      .then(() => { setAudioBlocked(false); onEvent('audio_unlocked'); signalReady(); })
      .catch(() => { /* keep the overlay — the next tap retries */ });
  }, [room, onEvent, signalReady]);

  // Agent-joined detection: voice-assistant state leaves connecting/disconnected
  // once the worker is in the room and talking/listening.
  const joinStartRef = useRef(Date.now());
  const agentJoinedRef = useRef(false);
  useEffect(() => {
    if (agentJoinedRef.current) return;
    if (state === 'listening' || state === 'speaking' || state === 'thinking') {
      agentJoinedRef.current = true;
      onEvent('agent_join_ms', { ms: Date.now() - joinStartRef.current });
      setAgentJoined(true);
    }
  }, [state, onEvent]);

  // If the interviewer hasn't joined within 15s, surface a hint (usually means
  // the agent worker isn't deployed/registered).
  useEffect(() => {
    if (agentJoined) { setAgentSlow(false); return; }
    const h = window.setTimeout(() => {
      setAgentSlow(true);
      onEvent('agent_slow_15s');
    }, 15000);
    return () => window.clearTimeout(h);
  }, [agentJoined, onEvent]);

  // Live transcript from LiveKit's transcription stream.
  useEffect(() => {
    const onTr = (segments: TranscriptionSegment[], participant?: Participant) => {
      const isCandidate = participant ? participant.identity === connection.identity || participant.isLocal : false;
      const who: RAMockTurn['who'] = isCandidate ? 'you' : 'them';
      const map = segMapRef.current;
      for (const seg of segments) map.set(seg.id, { who, text: seg.text });
      setTranscript(Array.from(map.values()));
    };
    room.on(RoomEvent.TranscriptionReceived, onTr);
    return () => { room.off(RoomEvent.TranscriptionReceived, onTr); };
  }, [room, connection.identity]);

  const cameraTracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  const localCamera = cameraTracks.find((tr) => tr.participant.isLocal);

  const aiState: AiState =
    state === 'speaking' ? 'asking' : state === 'listening' ? 'listening' : 'thinking';

  const candidateName = user?.name?.trim() || user?.email?.split('@')[0] || t('live.you');
  const roleLabel = localizeRole(session.role);
  const typeLabel = localizeType(session.interviewType, 'label');

  return (
    <>
      <LiveBar
        role={roleLabel}
        typeLabel={typeLabel}
        format={connection.mode}
        elapsedSec={elapsed}
        currentIndex={0}
        // The real-time engine is conversational rather than a fixed N-question
        // sequence. Zero intentionally hides progress instead of showing the
        // misleading "Question 1 of 0" label.
        total={0}
        onBack={onBack}
        className={styles.header}
      />

      {(localQuality !== null || agentDegraded) && (
        <div role="status" className={styles.qualityRow}>
          {localQuality !== null && (
            <QualityPill level={localQuality} label={t(`live.quality.${localQuality}`)} />
          )}
          {agentDegraded && (
            <QualityPill level="poor" label={t('live.agentQualityPoor')} />
          )}
        </div>
      )}

      {audioBlocked && (
        // BLOCKING overlay, not a small pill: while the browser autoplay policy
        // has audio muted the candidate would otherwise see the interviewer
        // animate to "speaking" and hear nothing (the avatar state tracks the
        // agent, not local playback), masking the failure. Covering the stage
        // forces the one tap that unlocks audio AND signals the worker to greet.
        <AudioUnlockDialog onUnlock={unlockAudio} />
      )}

      <div className={`iv-live-stage ${styles.stage}`}>
        {/* LEFT — interviewer */}
        <section className={`iv-stage-left ${styles.interviewerColumn}`} aria-label={t('live.interviewer')}>
          <InterviewerTile interviewer={interviewer} aiState={aiState} video={video} />
          {!agentJoined && (
            <div role="status" className={styles.agentStatus}>
              {agentSlow ? t('live.agentSlow') : t('live.agentJoining')}
            </div>
          )}
          {coachOn && agentJoined && (
            <LiveQuestionCard
              question={coach.question}
              hint={coach.hint}
              hintLoading={coach.hintLoading}
              hintOpen={hintOpen}
              onToggleHint={() => setHintOpen((o) => !o)}
            />
          )}
        </section>

        {/* RIGHT — candidate + controls + transcript */}
        <section className={`iv-stage-right ${styles.candidateColumn}`} aria-label={t('live.you')}>
          <details
            className={`${styles.auxDisclosure} ${styles.selfViewDisclosure}`}
            open={openPanel === 'self'}
            onToggle={(event) => togglePanel('self', event.currentTarget.open)}
          >
            <summary>
              <span>{t('live.you')}</span>
              <span className={styles.auxStatus}>
                {isMicrophoneEnabled ? t('live.micReady') : t('live.unmuteMic')}
              </span>
            </summary>
            <div className={styles.selfViewBody}>
              {video ? (
                <div className={styles.videoFrame}>
                  {localCamera ? (
                    <VideoTrack trackRef={localCamera} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div className={styles.cameraOff}>
                      {t('live.cameraOff')}
                    </div>
                  )}
                </div>
              ) : (
                <YourTile
                  name={candidateName}
                  role={roleLabel}
                  initials={initialsOf(candidateName)}
                  active={state === 'listening'}
                  video={false}
                  camOn={false}
                  onCamChange={() => undefined}
                />
              )}
            </div>
          </details>

          {/* Controls (iv-* design) */}
          <div className={`iv-controls ${styles.controls}`}>
            <button type="button" className="btn" onClick={() => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)}>
              {isMicrophoneEnabled ? t('live.muteMic') : t('live.unmuteMic')}
            </button>
            {video && (
              <button type="button" className="btn" onClick={() => void localParticipant.setCameraEnabled(!isCameraEnabled)}>
                {isCameraEnabled ? t('live.stopCam') : t('live.startCam')}
              </button>
            )}
            <CoachToggle on={coachOn} onToggle={toggleCoach} />
            <button type="button" className={`btn ${styles.endButton}`} onClick={onEnd}>
              {t('live.endInterview')}
            </button>
          </div>

          {coachOn && coach.nudge && (
            <LiveCoachNudge tip={coach.nudge} onDismiss={coach.dismissNudge} />
          )}

          {coachOn && agentJoined && (
            <details
              className={`${styles.auxDisclosure} ${styles.coachDisclosure}`}
              open={openPanel === 'coach'}
              onToggle={(event) => togglePanel('coach', event.currentTarget.open)}
            >
              <summary>{t('live.coach.coachMode')}</summary>
              <div className={styles.coachPanel}>
                <CoachMeters metrics={coach.metrics} listeningFor={coach.listeningFor} />
              </div>
            </details>
          )}

          <details
            className={`${styles.auxDisclosure} ${styles.transcriptDisclosure}`}
            open={openPanel === 'transcript'}
            onToggle={(event) => togglePanel('transcript', event.currentTarget.open)}
          >
            <summary>{t('live.transcript')}</summary>
            <LiveTranscript
              turns={transcript}
              interviewerName={interviewer.name}
              typing={state === 'thinking'}
            />
          </details>
        </section>

        {/* Reconnecting overlay — covers the stage so the AI tile can't sit on
            a misleading 'Thinking…' while the connection is down. */}
        {reconnecting && (
          <div
            role="status"
            className={styles.reconnectOverlay}
          >
            <span>
              {t('live.reconnecting')}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
