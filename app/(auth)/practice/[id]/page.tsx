'use client';

// /practice/[id] — LIVE real-time AI voice/video interview.
//
// Real LiveKit room (full-duplex voice with the dispatched interviewer
// worker). The (auth) layout renders this route full-focus (no sidebar), so
// the screen owns all of its own chrome.
//
// The page walks one session through four steps:
//
//   1. PREPARING — the setup screen navigates here the moment the session row
//      exists. While the server writes the interview plan (POST /prepare, an
//      LLM call that can take a while) the candidate sees calm progress copy,
//      not a spinner on the setup button. A GET poll backs the long request
//      up. A failed plan shows what went wrong and a Retry; it is never
//      charged.
//   2. DEVICE CHECK — mic (always) and camera (video mode) are opened and
//      shown BEFORE the room token is minted, because minting it dispatches
//      the interviewer and starts the clock. The Join tap is also the user
//      gesture that lets the browser play the interviewer's voice.
//   3. ROOM — mic and camera are published explicitly after Connected, each
//      with its own error handling. A camera that fails keeps the interview
//      going voice-only; a mic that fails blocks with a how-to-fix. Only a
//      real connection error is fatal.
//   4. END — the end request is fired with keepalive and the page goes
//      straight to the report, which polls while the server finalizes.
//
// Disconnect ≠ end: the backend keeps 'live' sessions rejoinable (re-mints a
// token, re-dispatches a missing agent), so only a deliberate End/Back or a
// server-side termination finalizes — finalizing on a WiFi blip would score
// and bill a half-run interview. An unexpected drop first gets ONE automatic
// rejoin attempt; only if that fails does the manual Rejoin screen appear. A
// second tab taking the seat (duplicate identity) stops and asks instead of
// rejoining, so two tabs never evict each other in a loop.
//
// Per brand (WP-63a): the server picks the brand's media plane (GoApply:
// CN LiveKit, 'GoApply-Interview'); the page only reads `connection.url`. On
// GoApply — or whenever the connection says `cameraPublish: false` — the
// camera is a LOCAL preview only: no video track is ever published
// (cameraPlan + useLocalCameraPreview). The device check also rates the
// connection (NetworkPrecheck) and, on a weak one, offers to do the practice
// in writing instead; that ends the unstarted live session (never charged)
// and runs the written practice here.

import { use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
  ParticipantKind,
  type RoomOptions,
  type TranscriptionSegment,
  type Participant,
  type RemoteParticipant,
} from 'livekit-client';
import '@livekit/components-styles';

import { useMockCatalog } from '../../../../hooks/useMockV3';
import { useAuth } from '../../../../lib/auth/AuthProvider';
import { useBrand } from '../../../../lib/brand/BrandProvider';
import { TextPracticeRoom } from '../../../../components/features/practice';
import type { NetworkAssessment } from '../../../../components/features/practice/NetworkPrecheck';
import { useLocalCameraPreview } from '../../../../components/v3/mock/YourTile';
import { useMockRoleLabels } from '../../../../lib/mockRoleLabels';
import { Btn } from '../../../../components/v3/primitives/Btn';
import {
  IconCamera,
  IconCameraOff,
  IconEndCall,
  IconMic,
  IconMicOff,
  IconPlay,
  IconSparkle,
  IconTranscript,
  IconX,
} from '../../../../components/v3/primitives/Iconset';
import {
  LiveBar, InterviewerTile, YourTile, LiveTranscript, type AiState,
  useLiveCoach, LiveQuestionCard, LiveCoachNudge, CoachMeters, type LiveTurn,
} from '../../../../components/v3/mock';
import {
  DeviceCheck,
  deviceFix,
  deviceStateLabel,
  type DeviceCheckResult,
} from '../../../../components/v3/mock/DeviceCheck';
import {
  classifyMediaError,
  isDeviceFailure,
  type DeviceState,
} from '../../../../components/v3/mock/deviceState';
// Imported directly (not via the ./mock barrel) so non-live pages don't pull
// livekit-client into their bundles.
import {
  cameraPlan,
  classifyDisconnect,
  pendingLiveCopy,
  type LiveCopyTranslator,
  qualityLevel,
  type QualityLevel,
} from '../../../../components/v3/mock/liveConnection';
// Parley pilot transport (see ParleyStage at the bottom of this file).
import { useParleyCall } from '../../../../components/v3/mock/parley/useParleyCall';
import { LocalVideo } from '../../../../components/v3/mock/parley/LocalVideo';
import type { CaptionSegment } from '../../../../components/v3/mock/parley/parleyCaptions';
import {
  ieErrorInfo,
  interviewEngineApi,
  practiceApi,
  postClientEvents,
  RETRYABLE_PREPARE_ERRORS,
  type IEClientEvent,
  type IEConnection,
  type IEParleyJoin,
  type IESessionDetail,
} from '../../../../lib/api/interviewEngine';
import type { RAMockInterviewer, RAMockTurn } from '../../../../lib/api/v2/types';
import styles from './live.module.css';

type Phase =
  | 'loading' | 'preparing' | 'prepareFailed' | 'deviceCheck' | 'ready'
  | 'agentUnavailable' | 'reconnecting' | 'connectionLost' | 'superseded'
  | 'connectError' | 'expired' | 'ended' | 'text';

type PrepareErrorCode = 'llm_unavailable' | 'prepare_failed';

type ExitIntent = 'report' | 'setup';

// One automatic rejoin per disconnect episode: the short delay lets a flapping
// network settle before re-minting a token, and the single-attempt cap means a
// genuinely dead connection lands on the manual screen instead of looping.
const AUTO_REJOIN_DELAY_MS = 1_500;
// connection() reports agentDispatched=false on a mere 8s dispatch TIMEOUT —
// the dispatch usually still lands moments later (the backend persists the
// late dispatch id). Re-check once before declaring the interviewer gone.
const AGENT_DISPATCH_RETRY_DELAY_MS = 3_000;
// Backup poll while POST /prepare is in flight (a proxy can drop a long
// request even though the server finishes the plan).
const PREPARE_POLL_MS = 3_000;
// After this long the preparing screen adds a "still working" line.
const PREPARE_SLOW_MS = 45_000;
// When the /prepare request itself dies without a contract code (proxy reset,
// 504, the serving instance recycled mid-run), nothing server-side moves the
// row out of 'preparing' — the run died with the request. If the poll still
// sees 'preparing' this long after the failure, /prepare is issued again (the
// server dedupes in-process and writes only WHERE status='preparing'), at
// most PREPARE_MAX_REISSUES times per attempt.
const PREPARE_REISSUE_AFTER_MS = 15_000;
const PREPARE_MAX_REISSUES = 3;

// Full-duplex audio tuning. echoCancellation is CRITICAL: it runs in the
// candidate's browser (the only place with the speaker reference signal) so the
// agent's own voice played through the candidate's speakers is not picked up
// by the mic and re-transcribed — without it, full duplex breaks into a
// feedback loop. DTX skips sending silence (lower latency/bandwidth) and RED
// adds redundant audio packets so brief packet loss doesn't glitch the
// conversation. Module-level so its identity never changes: LiveKitRoom
// rebuilds the Room when this object's serialization changes.
const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  audioCaptureDefaults: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  publishDefaults: { dtx: true, red: true },
};

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

/** A callback whose identity never changes but always runs the latest closure.
 *  LiveKitRoom lists onError / onDisconnected / onMediaDeviceFailure as effect
 *  dependencies; a new identity on every parent render re-ran its connect
 *  effect, and mid-reconnect that started a second full connect. */
function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** A LiveKit error that means the room connection itself failed (as opposed
 *  to a device or publish error, which must never end the interview). */
function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  const message = String((err as { message?: unknown }).message ?? '');
  return name === 'ConnectionError' || /no livekit url/i.test(message);
}

export default function MockLivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('practice');
  const router = useRouter();
  const brand = useBrand();

  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<IESessionDetail | null>(null);
  const [connection, setConnection] = useState<IEConnection | null>(null);
  const [prepareError, setPrepareError] = useState<PrepareErrorCode>('prepare_failed');
  // Bumped on every re-run of /prepare (the Retry button) so the preparing
  // effect starts over.
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  // What the device check found — the room publishes the camera only when
  // the candidate's camera actually worked there.
  const [devicePlan, setDevicePlan] = useState<DeviceCheckResult | null>(null);
  // Bumped on every re-minted token so LiveKitRoom remounts with the fresh
  // credentials (its `token` prop is only read at mount time).
  const [roomKey, setRoomKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [exitIntent, setExitIntent] = useState<ExitIntent | null>(null);
  const endingRef = useRef(false);
  // Set by the End/Back paths BEFORE the room disconnects, so the disconnect
  // handler can tell a deliberate end from a dropped connection.
  const intentionalEndRef = useRef(false);
  const busyRef = useRef(false);
  const sessionRef = useRef<IESessionDetail | null>(null);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // ── Session-scoped live state. Lives HERE, above the keyed room subtree, so
  // a rejoin (which remounts the room) keeps the transcript and the
  // interviewer-joined state instead of wiping them mid-interview.
  const [transcript, setTranscript] = useState<LiveTurn[]>([]);
  const segMapRef = useRef<Map<string, LiveTurn>>(new Map());
  const addSegments = useCallback((
    segments: Array<Pick<TranscriptionSegment, 'id' | 'text' | 'final'>>,
    who: RAMockTurn['who'],
  ) => {
    const map = segMapRef.current;
    for (const seg of segments) map.set(seg.id, { who, text: seg.text, final: seg.final });
    setTranscript(Array.from(map.values()));
  }, []);
  // Parley captions carry their own speaker.
  const addCaptionSegments = useCallback((segments: CaptionSegment[]) => {
    for (const seg of segments) addSegments([seg], seg.who);
  }, [addSegments]);
  const [agentJoined, setAgentJoined] = useState(false);
  const markAgentJoined = useCallback(() => setAgentJoined(true), []);

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

  // The catalog only names the interviewer. A focus refetch would re-render
  // the page that hosts the room for nothing, so it is off here.
  const catalogQuery = useMockCatalog({ refetchOnWindowFocus: false });
  const interviewer: RAMockInterviewer =
    catalogQuery.data?.catalog.interviewers.find((i) => i.id === session?.personaId) ?? FALLBACK_INTERVIEWER;

  const reportHref = `/practice/${id}/report`;

  /** Route the page by the server's view of the session. */
  const routeBySession = useCallback((s: IESessionDetail) => {
    setSession(s);
    switch (s.status) {
      case 'preparing':
        setPhase('preparing');
        return;
      case 'created':
      case 'live':
        setPhase('deviceCheck');
        return;
      case 'failed':
        if (s.error && RETRYABLE_PREPARE_ERRORS.has(s.error)) {
          setPrepareError(s.error as PrepareErrorCode);
          setPhase('prepareFailed');
          return;
        }
        // no_answer and worker failures have their own report states.
        router.replace(reportHref);
        return;
      case 'finalizing':
      case 'completed':
        router.replace(reportHref);
        return;
      default:
        setPhase('expired');
    }
  }, [router, reportHref]);

  // ── 0. Load the session once.
  const loadedRef = useRef(false);
  const loadSession = useCallback(async () => {
    try {
      const { session: s } = await interviewEngineApi.get(id);
      routeBySession(s);
    } catch (err) {
      const info = ieErrorInfo(err);
      trackEvent('load_failed', { status: info.status, network: info.network });
      setPhase(info.status === 404 ? 'expired' : 'connectError');
    }
  }, [id, routeBySession, trackEvent]);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void loadSession();
  }, [loadSession]);

  // ── 1. Preparing: run /prepare (long) with a GET poll as backup.
  const [prepareSlow, setPrepareSlow] = useState(false);
  useEffect(() => {
    if (phase !== 'preparing') return;
    let cancelled = false;
    const ctrl = new AbortController();
    setPrepareSlow(false);
    const slowTimer = window.setTimeout(() => { if (!cancelled) setPrepareSlow(true); }, PREPARE_SLOW_MS);
    const startedAt = Date.now();
    trackEvent('prepare_start', { attempt: prepareAttempt });
    let inFlight = false;
    let deadSince: number | null = null;
    let reissues = 0;
    const runPrepare = () => {
      inFlight = true;
      deadSince = null;
      interviewEngineApi
        // retry:true on every attempt after the first. It only matters to a
        // 'failed' session; a 'preparing' one just runs (deduped server-side).
        .prepare(id, { retry: prepareAttempt > 0, signal: ctrl.signal })
        .then(({ session: s }) => {
          inFlight = false;
          if (cancelled) return;
          trackEvent('prepare_done', { ms: Date.now() - startedAt, status: s.status });
          if (s.status !== 'preparing') routeBySession(s);
          else deadSince = Date.now(); // answered but still preparing: let the poll re-issue
        })
        .catch((err) => {
          inFlight = false;
          if (cancelled) return;
          const info = ieErrorInfo(err);
          if (info.code === 'llm_unavailable' || info.code === 'prepare_failed') {
            trackEvent('prepare_failed', { code: info.code });
            if (info.session) setSession(info.session);
            setPrepareError(info.code);
            setPhase('prepareFailed');
            return;
          }
          // A proxy timeout, a dropped connection or an older API without
          // /prepare: the poll below settles it, re-issuing /prepare if the
          // session is still 'preparing' a while later.
          deadSince = Date.now();
          trackEvent('prepare_request_failed', { status: info.status, network: info.network });
        });
    };
    runPrepare();
    const poll = window.setInterval(() => {
      interviewEngineApi
        .get(id)
        .then(({ session: s }) => {
          if (cancelled) return;
          if (s.status !== 'preparing') {
            routeBySession(s);
            return;
          }
          if (
            !inFlight
            && deadSince !== null
            && Date.now() - deadSince >= PREPARE_REISSUE_AFTER_MS
            && reissues < PREPARE_MAX_REISSUES
          ) {
            reissues += 1;
            trackEvent('prepare_reissue', { reissue: reissues });
            runPrepare();
          }
        })
        .catch(() => undefined);
    }, PREPARE_POLL_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearInterval(poll);
      window.clearTimeout(slowTimer);
    };
  }, [phase, prepareAttempt, id, routeBySession, trackEvent]);

  const retryPrepare = useCallback(() => {
    setPrepareAttempt((n) => n + 1);
    setPhase('preparing');
  }, []);

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

  /** connection() refused or failed: decide where that leaves the candidate. */
  const handleConnectionFailure = useCallback(async (err: unknown, fallback: Phase) => {
    const info = ieErrorInfo(err);
    trackEvent('connect_failed', { code: info.code, status: info.status, network: info.network });
    switch (info.code) {
      case 'not_ready':
        setPhase('preparing');
        return;
      case 'session_failed':
        if (info.reason && RETRYABLE_PREPARE_ERRORS.has(info.reason)) {
          setPrepareError(info.reason as PrepareErrorCode);
          setPhase('prepareFailed');
        } else {
          router.replace(reportHref);
        }
        return;
      case 'session_ended':
        router.replace(reportHref);
        return;
      case 'worker_unavailable':
        setPhase('agentUnavailable');
        return;
      default:
        break;
    }
    // An older API rejects connection() without a code once the session has
    // left 'live' — ask for its status before showing a generic error.
    try {
      const { session: s } = await interviewEngineApi.get(id);
      if (s.status !== 'created' && s.status !== 'live') {
        routeBySession(s);
        return;
      }
    } catch { /* offline — fall through */ }
    setPhase(fallback);
  }, [id, router, reportHref, routeBySession, trackEvent]);

  // ── 2 → 3. Join (from the device check) and every rejoin.
  //
  // Re-mints a token (the backend re-dispatches a missing agent for 'live'
  // sessions) and re-enters via a key bump. Rejoins skip the device check:
  // in-room device failures are handled in the room.
  const enterRoom = useCallback(async (opts: { isRejoin: boolean; auto?: boolean }) => {
    if (busyRef.current || endingRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const { isRejoin, auto = false } = opts;
    if (isRejoin) trackEvent('rejoin_attempt', { auto });
    try {
      const c = await fetchConnection();
      setConnection(c);
      if (c.agentDispatched === false) { setPhase('agentUnavailable'); return; }
      // True elapsed across refresh/rejoin comes from the server's startedAt,
      // which connection() just stamped.
      try {
        const { session: s } = await interviewEngineApi.get(id);
        setSession(s.startedAt ? s : { ...s, startedAt: new Date().toISOString() });
      } catch {
        setSession((prev) => (prev && !prev.startedAt ? { ...prev, startedAt: new Date().toISOString() } : prev));
      }
      if (isRejoin) trackEvent('rejoin_success', { auto });
      // Recovery closes the disconnect episode — the next drop gets its own
      // automatic attempt.
      autoRejoinUsedRef.current = false;
      setRoomKey((k) => k + 1);
      setPhase('ready');
    } catch (err) {
      // The automatic attempt must never strand the user on the transient
      // 'reconnecting' screen — hand over to the manual Rejoin screen.
      await handleConnectionFailure(err, isRejoin ? 'connectionLost' : 'connectError');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [id, fetchConnection, handleConnectionFailure, trackEvent]);

  const joinFromDeviceCheck = useCallback((result: DeviceCheckResult) => {
    trackEvent('device_check', { mic: result.mic, camera: result.camera });
    setDevicePlan(result);
    void enterRoom({ isRejoin: false });
  }, [enterRoom, trackEvent]);

  // ── 2b. Connection check (WP-63a). The probe is one small, authenticated
  // read of this session through lib/api: an HTTP error still proves the
  // round trip, only a network failure counts as a lost probe.
  const networkProbe = useCallback(
    () => interviewEngineApi.get(id).then(
      () => undefined,
      (err: unknown) => { if (ieErrorInfo(err).network) throw err; },
    ),
    [id],
  );
  const onNetworkResult = useCallback((r: NetworkAssessment) => {
    trackEvent('network_check', { level: r.level, rttMs: r.rttMs, jitterMs: r.jitterMs, failures: r.failures });
  }, [trackEvent]);

  // Weak connection → the written practice instead. Only before the live
  // session started: ending an unstarted session is never charged.
  const [switchingToText, setSwitchingToText] = useState(false);
  const [textJobId, setTextJobId] = useState<string | null>(null);
  const switchToText = useCallback(async () => {
    if (endingRef.current) return;
    setSwitchingToText(true);
    trackEvent('switch_to_text');
    let jobId: string | null = null;
    try {
      const { practice } = await practiceApi.info(id);
      jobId = practice.job?.id ?? null;
    } catch { /* no job: the written practice runs on the role */ }
    endingRef.current = true;
    intentionalEndRef.current = true;
    flushEvents(true);
    interviewEngineApi.endKeepalive(id);
    setTextJobId(jobId);
    setSwitchingToText(false);
    setPhase('text');
  }, [id, trackEvent, flushEvents]);

  // ── 4. End: fire the end request (keepalive) and go to the report now.
  // The server tells the interviewer to stop, waits for the final transcript
  // and scores in the background; the report page polls for it.
  const finish = useCallback((toReport: boolean, intentional = true) => {
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
    interviewEngineApi.endKeepalive(id);
    router.push(toReport ? reportHref : '/practice');
  }, [id, router, reportHref, trackEvent, flushEvents]);

  const requestExit = useCallback((intent: ExitIntent) => {
    if (endingRef.current) return;
    setExitIntent(intent);
  }, []);

  const cancelExit = useCallback(() => setExitIntent(null), []);

  const confirmExit = useCallback(() => {
    if (!exitIntent) return;
    finish(exitIntent === 'report');
  }, [exitIntent, finish]);

  // One automatic reacquire per disconnect episode (reset on successful
  // rejoin). The timer is cleared on unmount so a navigation away doesn't
  // trigger a stray reconnect.
  const autoRejoinUsedRef = useRef(false);
  const autoRejoinTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (autoRejoinTimerRef.current !== null) window.clearTimeout(autoRejoinTimerRef.current);
  }, []);

  // Reason-aware disconnect: deliberate end or server termination → finalize;
  // another tab took the seat → stop and ask; anything else (network loss,
  // signal closed, unknown) → ONE automatic rejoin, then the manual screen —
  // never end + bill the session on a drop.
  const handleDisconnected = useStableCallback((reason?: DisconnectReason) => {
    if (endingRef.current) return;
    trackEvent('disconnected', {
      reason: reason !== undefined ? DisconnectReason[reason] ?? String(reason) : 'unknown',
    });
    const action = classifyDisconnect(reason, intentionalEndRef.current);
    if (action === 'finalize') {
      finish(true, intentionalEndRef.current);
      return;
    }
    if (action === 'superseded') {
      if (autoRejoinTimerRef.current !== null) {
        window.clearTimeout(autoRejoinTimerRef.current);
        autoRejoinTimerRef.current = null;
      }
      setPhase('superseded');
      return;
    }
    if (!autoRejoinUsedRef.current) {
      autoRejoinUsedRef.current = true;
      setPhase('reconnecting');
      autoRejoinTimerRef.current = window.setTimeout(() => {
        autoRejoinTimerRef.current = null;
        void enterRoom({ isRejoin: true, auto: true });
      }, AUTO_REJOIN_DELAY_MS);
      return;
    }
    // A duplicate disconnect signal while the auto attempt is pending or in
    // flight must not yank the UI to the manual screen — the attempt itself
    // routes to 'ready' or 'connectionLost' when it resolves.
    if (autoRejoinTimerRef.current !== null || busyRef.current) return;
    setPhase('connectionLost');
  });

  // Only a failed CONNECTION is fatal. LiveKitRoom also reports publish
  // failures here; tracks are published by RoomStage with their own handling,
  // so anything else is logged and the interview carries on.
  const handleRoomError = useStableCallback((err: Error) => {
    if (endingRef.current) return;
    if (isConnectionError(err)) {
      trackEvent('room_connect_failed', { message: err?.message });
      setPhase('connectError');
      return;
    }
    trackEvent('room_error', { name: err?.name, message: err?.message });
  });

  const handleDeviceFailure = useStableCallback((failure?: unknown, kind?: MediaDeviceKind) => {
    trackEvent('device_failure', { failure: failure === undefined ? null : String(failure), kind: kind ?? null });
  });

  // ── Render ─────────────────────────────────────────────────────────────

  if (phase === 'loading') return <CenterMsg>{t('live.loading')}</CenterMsg>;
  if (phase === 'ended') return <CenterMsg>{t('live.ending')}</CenterMsg>;

  if (phase === 'preparing') {
    return (
      <CenterMsg>
        <div className={styles.preparing} role="status" aria-live="polite" aria-busy="true">
          <span className={styles.preparingBar} aria-hidden />
          <p className={styles.centerTitle}>{t('live.preparing.title')}</p>
          <p className={styles.centerBody}>{t('live.preparing.body')}</p>
          <p className={styles.centerNote}>
            {prepareSlow ? t('live.preparing.slow') : t('live.preparing.note')}
          </p>
        </div>
        <div className={styles.centerActions}>
          <Btn as="a" href="/practice">{t('live.backToSetup')}</Btn>
        </div>
      </CenterMsg>
    );
  }

  if (phase === 'prepareFailed') {
    const llm = prepareError === 'llm_unavailable';
    return (
      <CenterMsg>
        <div role="alert">
          <p className={styles.centerTitle}>
            {llm ? t('live.prepareFailed.llmTitle') : t('live.prepareFailed.title')}
          </p>
          <p className={styles.centerBody}>
            {llm ? t('live.prepareFailed.llmBody') : t('live.prepareFailed.body')}
          </p>
        </div>
        <div className={styles.centerActions}>
          <Btn variant="primary" onClick={retryPrepare}>{t('live.retry')}</Btn>
          <Btn as="a" href="/practice">{t('live.backToSetup')}</Btn>
        </div>
      </CenterMsg>
    );
  }

  if (phase === 'expired' || !session) {
    return (
      <CenterMsg>
        <p className={styles.centerTitle}>{t('live.expired.title')}</p>
        <p className={styles.centerBody}>{t('live.expired.body')}</p>
        <Btn variant="primary" as="a" href="/practice">{t('live.expired.cta')}</Btn>
      </CenterMsg>
    );
  }

  if (phase === 'text') {
    return (
      <div className={styles.textRoom}>
        <TextPracticeRoom
          role={session.role}
          interviewerId={session.personaId ?? ''}
          typeId={session.interviewType}
          language={session.language}
          durationMinutes={session.durationMinutes}
          jobId={textJobId}
          onStartRefused={() => { router.push('/practice'); return true; }}
          onExit={() => router.push('/practice')}
        />
      </div>
    );
  }

  if (phase === 'deviceCheck') {
    // The written practice is offered only before the interview started, and
    // only with a catalog interviewer to run it.
    const canSwitchToText = session.status === 'created' && !!session.personaId;
    return (
      <DeviceCheck
        mode={session.mode}
        rejoin={session.status === 'live'}
        busy={busy}
        onJoin={joinFromDeviceCheck}
        onBack={() => router.push('/practice')}
        networkProbe={networkProbe}
        onNetworkResult={onNetworkResult}
        onSwitchToText={canSwitchToText ? () => void switchToText() : undefined}
        switchingToText={switchingToText}
        cameraLocalOnly={brand.market === 'cn'}
      />
    );
  }

  if (phase === 'connectError') {
    return (
      <CenterMsg>
        <div role="alert">
          <p className={styles.centerTitle}>{t('live.connectError.title')}</p>
          <p className={styles.centerBody}>{t('live.connectError.body')}</p>
        </div>
        <div className={styles.centerActions}>
          <Btn
            variant="primary"
            disabled={busy}
            onClick={() => {
              if (connection) void enterRoom({ isRejoin: true });
              else { setPhase('loading'); void loadSession(); }
            }}
          >
            {t('live.retry')}
          </Btn>
          <Btn as="a" href="/practice">{t('live.backToSetup')}</Btn>
        </div>
      </CenterMsg>
    );
  }

  if (phase === 'agentUnavailable') {
    return (
      <CenterMsg>
        <p className={styles.centerTitle}>{t('live.interviewerUnavailableTitle')}</p>
        <p className={styles.centerBody}>{t('live.interviewerUnavailableBody')}</p>
        <div className={styles.centerActions}>
          <Btn variant="primary" onClick={() => void enterRoom({ isRejoin: false })} disabled={busy}>{t('live.retry')}</Btn>
          <Btn as="a" href="/practice">{t('live.expired.cta')}</Btn>
        </div>
      </CenterMsg>
    );
  }

  if (phase === 'reconnecting') {
    // Transient — the automatic attempt either remounts the room ('ready')
    // or falls through to the manual 'connectionLost' screen.
    return (
      <CenterMsg>
        <p className={styles.centerTitle}>{t('live.autoRejoinTitle')}</p>
        <p className={styles.centerBody}>{t('live.autoRejoinBody')}</p>
      </CenterMsg>
    );
  }

  if (phase === 'superseded') {
    return (
      <CenterMsg>
        <div role="alert">
          <p className={styles.centerTitle}>{t('live.superseded.title')}</p>
          <p className={styles.centerBody}>{t('live.superseded.body')}</p>
        </div>
        <div className={styles.centerActions}>
          <Btn variant="primary" onClick={() => void enterRoom({ isRejoin: true })} disabled={busy}>
            {t('live.superseded.useHere')}
          </Btn>
          <Btn as="a" href="/practice">{t('live.backToSetup')}</Btn>
        </div>
      </CenterMsg>
    );
  }

  if (phase === 'connectionLost' || !connection) {
    return (
      <>
        <CenterMsg>
          <p className={styles.centerTitle}>{t('live.connectionLostTitle')}</p>
          <p className={styles.centerBody}>{t('live.connectionLostBody')}</p>
          <div className={styles.centerActions}>
            <Btn variant="primary" onClick={() => void enterRoom({ isRejoin: true })} disabled={busy}>{t('live.rejoin')}</Btn>
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

  // WP-63a: publish the camera, keep it a local preview (GoApply, or the
  // server said so), or leave it off (voice, or it failed in the check).
  const camPlan = cameraPlan({
    mode: connection.mode,
    cameraPublish: (connection as IEConnection & { cameraPublish?: boolean }).cameraPublish,
    market: brand.market,
    deviceOk: devicePlan === null || devicePlan.camera === 'ok',
  });
  const wantCamera = camPlan.publish;
  const initialCamera: DeviceState =
    connection.mode !== 'video'
      ? 'off'
      : devicePlan && isDeviceFailure(devicePlan.camera)
        ? devicePlan.camera
        : 'off';

  if (connection.transport === 'parley' && connection.parley) {
    // Parley pilot: the browser talks to Parley directly — no LiveKit room.
    // The rejoin flow (roomKey bump) remounts the stage onto the same Parley
    // session; a server-side end routes to the report like ROOM_DELETED does.
    return (
      <div className={`iv-live ${styles.room}`}>
        <ParleyStage
          key={roomKey}
          join={connection.parley}
          session={session}
          connection={connection}
          interviewer={interviewer}
          // Parley's camera is a local self-view already.
          wantCamera={camPlan.publish || camPlan.previewStartsOn}
          initialCamera={initialCamera}
          transcript={transcript}
          onSegments={addCaptionSegments}
          agentJoined={agentJoined}
          onAgentJoined={markAgentJoined}
          onEnd={() => requestExit('report')}
          onBack={() => requestExit('setup')}
          onEnded={() => finish(true, false)}
          onLost={() => handleDisconnected(undefined)}
          onEvent={trackEvent}
        />
        {exitIntent && (
          <ExitConfirmDialog
            intent={exitIntent}
            onCancel={cancelExit}
            onConfirm={confirmExit}
          />
        )}
      </div>
    );
  }

  return (
    <LiveKitRoom
      key={roomKey}
      serverUrl={connection.url}
      token={connection.token}
      connect
      // Devices are NOT handed to LiveKitRoom: its publish step reports a
      // denied or busy camera through onError, which used to end the whole
      // interview. RoomStage enables each device itself after Connected.
      audio={false}
      video={false}
      options={ROOM_OPTIONS}
      onDisconnected={handleDisconnected}
      onError={handleRoomError}
      onMediaDeviceFailure={handleDeviceFailure}
      className={`iv-live ${styles.room}`}
    >
      <RoomAudioRenderer />
      <RoomStage
        session={session}
        connection={connection}
        interviewer={interviewer}
        wantCamera={wantCamera}
        localPreview={camPlan.localPreview}
        previewStartsOn={camPlan.previewStartsOn}
        initialCamera={initialCamera}
        transcript={transcript}
        onSegments={addSegments}
        agentJoined={agentJoined}
        onAgentJoined={markAgentJoined}
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

/** The microphone failed inside the room. Blocking, with the plain fix, a
 *  Retry that re-opens the mic in place (no rejoin), and a way out. */
function MicBlockedDialog({
  fix, busy, onRetry, onEnd,
}: {
  fix: string;
  busy: boolean;
  onRetry: () => void;
  onEnd: () => void;
}) {
  const t = useTranslations('practice');
  const actionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => actionRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      previousFocus?.focus();
    };
  }, []);

  return (
    <div className={styles.audioOverlay}>
      <div
        className={styles.audioDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="practice-mic-title"
        aria-describedby="practice-mic-description"
      >
        <div className={styles.audioIcon} aria-hidden>
          <IconMicOff size={24} />
        </div>
        <h2 id="practice-mic-title">{t('live.micBlocked.title')}</h2>
        <p id="practice-mic-description">{fix}</p>
        <div className={styles.micActions}>
          <button
            ref={actionRef}
            type="button"
            onClick={onRetry}
            disabled={busy}
            className={`btn primary ${styles.audioButton}`}
          >
            {t('live.micRetry')}
          </button>
          <button type="button" onClick={onEnd} className={`btn ${styles.audioButton}`}>
            {t('live.endInterview')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Connection quality indicator ──────────────────────────────────────────

// good stays visually quiet (no alarm during a healthy interview); fair warns,
// poor alarms.
const QUALITY_TONE: Record<QualityLevel, { bar: string; text: string; border: string; bg: string }> = {
  good: { bar: 'var(--ok)', text: 'var(--text-2)', border: 'var(--rule)', bg: 'var(--surface)' },
  fair: { bar: 'var(--warn)', text: 'var(--warn)', border: 'var(--warn)', bg: 'var(--warn-subtle)' },
  poor: { bar: 'var(--danger)', text: 'var(--danger)', border: 'var(--danger)', bg: 'var(--danger-subtle)' },
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

// Audio-ready handshake with the interview worker (contract C7). The worker
// holds its opening greeting until it sees the candidate is ready, so the
// greeting is never spoken into a browser output the autoplay policy has
// muted. Readiness is sent two ways, and the worker accepts either:
//   - the participant attribute `ie.client_ready = '1'` — STATE, so a worker
//     that joins later reads it on join;
//   - the reliable data message {type:'client_ready'} on topic 'ie' — sent
//     once after connect and AGAIN whenever an agent participant connects,
//     because a data packet only reaches participants present at send time
//     and the candidate usually joins before the interviewer does.
// Both only fire once the browser can actually play audio.
const IE_DATA_TOPIC = 'ie';
const READY_ATTRIBUTE = 'ie.client_ready';
const READY_PACKET = new TextEncoder().encode(JSON.stringify({ type: 'client_ready' }));

function RoomStage({
  session, connection, interviewer, wantCamera, localPreview, previewStartsOn, initialCamera,
  transcript, onSegments, agentJoined, onAgentJoined, onEnd, onBack, onEvent,
}: {
  session: IESessionDetail;
  connection: IEConnection;
  interviewer: RAMockInterviewer;
  /** Publish the camera once connected (video mode, and it worked in the check). */
  wantCamera: boolean;
  /** Show the camera to the candidate only; it is never published (GoApply). */
  localPreview: boolean;
  /** The local preview starts on (the camera worked in the device check). */
  previewStartsOn: boolean;
  /** Why the camera is off when it is not wanted (the device-check result). */
  initialCamera: DeviceState;
  transcript: LiveTurn[];
  onSegments: (segments: TranscriptionSegment[], who: RAMockTurn['who']) => void;
  agentJoined: boolean;
  onAgentJoined: () => void;
  onEnd: () => void;
  onBack: () => void;
  onEvent: (type: string, data?: Record<string, unknown>) => void;
}) {
  const t = useTranslations('practice');
  const { localizeRole, localizeType } = useMockRoleLabels();
  const { user } = useAuth();
  const room = useRoomContext();
  const { state, agent, videoTrack: agentVideo } = useVoiceAssistant();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();

  const video = connection.mode === 'video';
  const [agentSlow, setAgentSlow] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // Persistent 3-level indicator for the LOCAL uplink, plus a separate flag for
  // the interviewer's (remote agent's) side — a struggling agent sounds like
  // "the app broke" unless it's labeled as a connection problem.
  const [localQuality, setLocalQuality] = useState<QualityLevel | null>(null);
  const [agentDegraded, setAgentDegraded] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  // The side rail holds the coach meters and the running transcript. It is
  // CLOSED by default: this is eye-contact practice, and a candidate reading
  // their own transcript is not practising the thing they came to practise.
  // The candidate's own tile is NOT in here — it is pinned to the stage, the
  // way it is in every real call.
  const [railTab, setRailTab] = useState<'coach' | 'transcript' | null>(null);

  // ── Devices. Published here, after Connected, one at a time and each with
  // its own error handling — a camera failure must never take the mic (or
  // the interview) down with it.
  const [micState, setMicState] = useState<DeviceState>('checking');
  const [camState, setCamState] = useState<DeviceState>(video && wantCamera ? 'checking' : initialCamera);
  const [camNoticeOpen, setCamNoticeOpen] = useState(video && isDeviceFailure(initialCamera));
  // GoApply: a local self-view straight from getUserMedia, never handed to the room.
  const preview = useLocalCameraPreview(video && localPreview && previewStartsOn, initialCamera);
  // Only a failure of a preview that was asked for (the device-check result
  // the preview starts with is already on screen).
  const previewFailed = localPreview && preview.tried && isDeviceFailure(preview.state);
  useEffect(() => {
    if (previewFailed) {
      setCamNoticeOpen(true);
      onEvent('camera_preview_failed', { state: preview.state });
    }
  }, [previewFailed, preview.state, onEvent]);

  const enableMic = useCallback(async () => {
    setMicState('checking');
    try {
      await localParticipant.setMicrophoneEnabled(true);
      setMicState('ok');
    } catch (err) {
      const s = classifyMediaError(err);
      setMicState(isDeviceFailure(s) ? s : 'error');
      onEvent('mic_failed', { state: s });
    }
  }, [localParticipant, onEvent]);

  const enableCamera = useCallback(async () => {
    // A local-only camera (GoApply) is never published, whatever asks.
    if (localPreview) return;
    setCamState('checking');
    try {
      await localParticipant.setCameraEnabled(true);
      setCamState('ok');
      setCamNoticeOpen(false);
    } catch (err) {
      const s = classifyMediaError(err);
      setCamState(isDeviceFailure(s) ? s : 'error');
      setCamNoticeOpen(true);
      onEvent('camera_failed', { state: s });
    }
  }, [localParticipant, onEvent, localPreview]);

  const publishedRef = useRef(false);
  useEffect(() => {
    const start = () => {
      if (publishedRef.current || room.state !== ConnectionState.Connected) return;
      publishedRef.current = true;
      void enableMic();
      if (video && wantCamera) void enableCamera();
    };
    start();
    room.on(RoomEvent.Connected, start);
    return () => { room.off(RoomEvent.Connected, start); };
  }, [room, video, wantCamera, enableMic, enableCamera]);

  const toggleMic = useCallback(async () => {
    if (isMicrophoneEnabled) {
      try { await localParticipant.setMicrophoneEnabled(false); } catch { /* stays on */ }
      return;
    }
    await enableMic();
  }, [isMicrophoneEnabled, localParticipant, enableMic]);

  const toggleCamera = useCallback(async () => {
    if (localPreview) {
      if (preview.on) preview.stop();
      else preview.start();
      return;
    }
    if (isCameraEnabled) {
      try {
        await localParticipant.setCameraEnabled(false);
        setCamState('off');
      } catch { /* stays on */ }
      return;
    }
    await enableCamera();
  }, [isCameraEnabled, localParticipant, enableCamera, localPreview, preview]);

  const toggleRail = useCallback((tab: 'coach' | 'transcript') => {
    setRailTab((current) => (current === tab ? null : tab));
  }, []);
  useEffect(() => {
    if (!railTab) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRailTab(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [railTab]);

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
  const coach = useLiveCoach({
    sessionId: session.id,
    transcript,
    session,
    enabled: coachOn,
    agentSpeaking: state === 'speaking',
  });
  useEffect(() => {
    if (!coachOn) setRailTab((current) => (current === 'coach' ? null : current));
  }, [coachOn]);

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

  // ── Audio unlock + client_ready handshake (see the note at the top).
  // (1) proactively call room.startAudio() — a no-op grant where the browser
  //     already allows playback, so the common case unlocks with zero delay;
  // (2) once playback is CONFIRMED unlocked, set the ready attribute and
  //     publish the ready message. A blocked browser shows the enable-audio
  //     overlay, whose tap both unlocks AND signals.
  const readySentRef = useRef(false);
  const readyAttrRef = useRef(false);
  const signalReady = useCallback((why: string, force = false) => {
    if (room.state !== ConnectionState.Connected || !room.canPlaybackAudio) return;
    if (!readyAttrRef.current) {
      readyAttrRef.current = true;
      // An older API mints tokens without canUpdateOwnMetadata, so this can be
      // refused — the data message below still carries readiness.
      Promise.resolve()
        .then(() => room.localParticipant.setAttributes({ [READY_ATTRIBUTE]: '1' }))
        .then(() => onEvent('client_ready_attr'))
        .catch(() => { readyAttrRef.current = false; onEvent('client_ready_attr_failed'); });
    }
    if (readySentRef.current && !force) return;
    readySentRef.current = true;
    room.localParticipant
      .publishData(READY_PACKET, { reliable: true, topic: IE_DATA_TOPIC })
      .then(() => onEvent('client_ready', { why }))
      .catch(() => { readySentRef.current = false; /* not ready yet — a later event retries */ });
  }, [room, onEvent]);
  useEffect(() => {
    let wasBlocked: boolean | null = null;
    const sync = () => {
      const blocked = !room.canPlaybackAudio;
      setAudioBlocked(blocked);
      if (blocked) {
        if (wasBlocked !== true) onEvent('audio_blocked');
      } else {
        signalReady('connected');
      }
      wasBlocked = blocked;
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
      .then(() => { setAudioBlocked(false); onEvent('audio_unlocked'); signalReady('audio_unlocked', true); })
      .catch(() => { /* keep the overlay — the next tap retries */ });
  }, [room, onEvent, signalReady]);

  // An interviewer that joins AFTER the candidate missed the first message:
  // send it again the moment an agent participant connects.
  useEffect(() => {
    const onJoin = (participant: RemoteParticipant) => {
      if (participant.kind !== ParticipantKind.AGENT) return;
      onEvent('agent_connected', { identity: participant.identity });
      signalReady('agent_joined', true);
    };
    room.on(RoomEvent.ParticipantConnected, onJoin);
    return () => { room.off(RoomEvent.ParticipantConnected, onJoin); };
  }, [room, onEvent, signalReady]);
  // Belt and braces: the first time the voice-assistant hook sees the agent.
  const agentIdentity = agent?.identity;
  useEffect(() => {
    if (agentIdentity) signalReady('agent_seen', true);
  }, [agentIdentity, signalReady]);

  // Agent-joined detection: voice-assistant state leaves connecting/disconnected
  // once the worker is in the room and talking/listening. Kept above this
  // subtree (onAgentJoined) so a rejoin does not bring the banner back.
  const joinStartRef = useRef(Date.now());
  useEffect(() => {
    if (agentJoined) return;
    if (state === 'listening' || state === 'speaking' || state === 'thinking') {
      onEvent('agent_join_ms', { ms: Date.now() - joinStartRef.current });
      onAgentJoined();
    }
  }, [state, agentJoined, onAgentJoined, onEvent]);

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

  // Live transcript from LiveKit's transcription stream, stored above this
  // subtree so it survives a rejoin.
  useEffect(() => {
    const onTr = (segments: TranscriptionSegment[], participant?: Participant) => {
      const isCandidate = participant ? participant.identity === connection.identity || participant.isLocal : false;
      onSegments(segments, isCandidate ? 'you' : 'them');
    };
    room.on(RoomEvent.TranscriptionReceived, onTr);
    return () => { room.off(RoomEvent.TranscriptionReceived, onTr); };
  }, [room, connection.identity, onSegments]);

  const cameraTracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  const localCamera = cameraTracks.find((tr) => tr.participant.isLocal);
  // Turning the camera off MUTES the publication rather than removing it, so
  // "a publication exists" is not "the camera is on" — that rendered a black
  // tile. Show the feed only for a live, unmuted track.
  const cameraLive = Boolean(
    isCameraEnabled && localCamera?.publication?.track && !localCamera.publication.isMuted,
  );
  const shownCamState: DeviceState = localPreview ? preview.state : camState;
  // Requested copy (practice.live.cam.localOnlyShort); nothing until it exists.
  const localOnlyShort = localPreview ? pendingLiveCopy(t as unknown as LiveCopyTranslator, 'camLocalOnlyShort') : null;
  const camOn = localPreview ? preview.on : isCameraEnabled;
  const cameraReason = isDeviceFailure(shownCamState) ? deviceStateLabel(t, shownCamState) : null;

  const aiState: AiState =
    state === 'speaking' ? 'asking' : state === 'listening' ? 'listening' : 'thinking';

  const candidateName = user?.name?.trim() || user?.email?.split('@')[0] || t('live.you');
  const roleLabel = localizeRole(session.role);
  const typeLabel = localizeType(session.interviewType, 'label');
  const micFix = deviceFix(t, 'mic', micState);
  const camFix = video ? deviceFix(t, 'camera', shownCamState) : null;

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

      {camNoticeOpen && camFix && (
        <div role="alert" className={styles.deviceAlert}>
          <span>
            <strong>{t('live.cameraUnavailable')}</strong>
            {' '}
            {camFix}
          </span>
          <button
            type="button"
            onClick={() => setCamNoticeOpen(false)}
            aria-label={t('live.dismiss')}
          >
            <IconX size={16} />
          </button>
        </div>
      )}

      {micFix ? (
        // BLOCKING: the interviewer cannot hear a candidate without a mic, so
        // carrying on would be a one-way interview that still bills.
        <MicBlockedDialog
          fix={micFix}
          busy={micState === 'checking'}
          onRetry={() => void enableMic()}
          onEnd={onEnd}
        />
      ) : audioBlocked ? (
        // BLOCKING overlay, not a small pill: while the browser autoplay policy
        // has audio muted the candidate would otherwise see the interviewer
        // animate to "speaking" and hear nothing (the avatar state tracks the
        // agent, not local playback), masking the failure. Covering the stage
        // forces the one tap that unlocks audio AND signals the worker to greet.
        <AudioUnlockDialog onUnlock={unlockAudio} />
      ) : null}

      <div className={styles.stage} data-rail={railTab ? 'open' : 'closed'}>
        <div className={styles.stageMain}>
          <div className={styles.frame} data-mode={video ? 'video' : 'voice'}>
            <InterviewerTile
              interviewer={interviewer}
              aiState={aiState}
              video={video}
              media={video && agentVideo ? (
                <VideoTrack trackRef={agentVideo} className={styles.agentFeed} />
              ) : undefined}
            />

            {/* The candidate's own tile is PINNED, not tucked behind a
                disclosure: seeing yourself is half of what video practice is
                for. It only OVERLAYS in video mode — there is nothing to
                overlay in voice, where it would just cover the interviewer's
                name, so it sits below the stage as its own row. */}
            {video ? (
              <div className={`${styles.selfTile} ${styles.selfTileVideo}`}>
                {localPreview && preview.on && preview.stream ? (
                  <>
                    <LocalVideo stream={preview.stream} className={styles.selfFeed} />
                    {localOnlyShort ? <span className={styles.selfLocalOnly}>{localOnlyShort}</span> : null}
                  </>
                ) : !localPreview && cameraLive && localCamera ? (
                  <VideoTrack trackRef={localCamera} className={styles.selfFeed} />
                ) : (
                  <div className={styles.selfOff}>
                    <IconCameraOff size={18} aria-hidden />
                    <span>{t('live.cameraOff')}</span>
                    {cameraReason ? <span className={styles.selfOffReason}>{cameraReason}</span> : null}
                  </div>
                )}
                <span className={styles.selfName}>
                  {isMicrophoneEnabled ? <IconMic size={12} /> : <IconMicOff size={12} />}
                  {t('live.you')}
                </span>
              </div>
            ) : null}

            {/* Reconnecting cover — the interviewer tile tracks the AGENT, so
                without this it would sit on a confident "Thinking…" while the
                connection is actually down. */}
            {reconnecting && (
              <div role="status" className={styles.reconnectOverlay}>
                <span>{t('live.reconnecting')}</span>
              </div>
            )}
          </div>

          {!video && (
            <div className={styles.selfRow}>
              <YourTile
                name={candidateName}
                role={roleLabel}
                initials={initialsOf(candidateName)}
                active={state === 'listening'}
                video={false}
                camOn={false}
                onCamChange={() => undefined}
              />
            </div>
          )}

          {!agentJoined && (
            <p role="status" className={styles.agentStatus}>
              {agentSlow ? t('live.agentSlow') : t('live.agentJoining')}
            </p>
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

          {coachOn && coach.nudge && (
            <LiveCoachNudge tip={coach.nudge} onDismiss={coach.dismissNudge} />
          )}
        </div>

        {railTab ? (
          <aside className={styles.rail} aria-label={t('live.rail.title')}>
            <div className={styles.railTabs} role="tablist" aria-label={t('live.rail.title')}>
              {(coachOn ? (['coach', 'transcript'] as const) : (['transcript'] as const)).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`practice-rail-tab-${tab}`}
                  aria-selected={railTab === tab}
                  aria-controls="practice-rail-panel"
                  className={railTab === tab ? styles.railTabOn : undefined}
                  onClick={() => setRailTab(tab)}
                >
                  {tab === 'coach' ? t('live.coach.coachMode') : t('live.transcript')}
                </button>
              ))}
              <button
                type="button"
                className={styles.railClose}
                aria-label={t('live.rail.close')}
                onClick={() => setRailTab(null)}
              >
                <IconX size={16} />
              </button>
            </div>

            <div
              className={styles.railBody}
              id="practice-rail-panel"
              role="tabpanel"
              aria-labelledby={`practice-rail-tab-${railTab}`}
              tabIndex={0}
            >
              {railTab === 'coach'
                ? <CoachMeters metrics={coach.metrics} listeningFor={coach.listeningFor} />
                : <LiveTranscript turns={transcript} interviewerName={interviewer.name} typing={state === 'thinking'} />}
            </div>
          </aside>
        ) : null}
      </div>

      {/* Call controls — the vocabulary of every video call the candidate has
          ever been in, because this is the moment to be invisible. */}
      <div className={styles.controlBar}>
        <div className={styles.controlGroup}>
          <ControlButton
            tone="device"
            on={isMicrophoneEnabled}
            label={isMicrophoneEnabled ? t('live.muteMic') : t('live.unmuteMic')}
            icon={isMicrophoneEnabled ? <IconMic size={19} /> : <IconMicOff size={19} />}
            onClick={() => void toggleMic()}
          />
          {video && (
            <ControlButton
              tone="device"
              on={camOn}
              label={camOn ? t('live.stopCam') : t('live.startCam')}
              icon={camOn ? <IconCamera size={19} /> : <IconCameraOff size={19} />}
              onClick={() => void toggleCamera()}
            />
          )}
          <ControlButton
            tone="panel"
            on={coachOn}
            label={t('live.coach.coachMode')}
            icon={<IconSparkle size={19} />}
            onClick={toggleCoach}
          />
          <ControlButton
            tone="panel"
            on={railTab === 'transcript'}
            label={t('live.transcript')}
            icon={<IconTranscript size={19} />}
            onClick={() => toggleRail('transcript')}
          />
        </div>

        <button
          type="button"
          className={styles.endButton}
          aria-label={t('live.endInterview')}
          onClick={onEnd}
        >
          <IconEndCall size={18} aria-hidden />
          {/* The label collapses on a phone, where the red handset is the
              universally read affordance and the bar has no room to spare. */}
          <span className={styles.endLabel}>{t('live.endInterview')}</span>
        </button>
      </div>
    </>
  );
}

/**
 * The live stage on the Parley pilot transport (INTERVIEW_ENGINE_PARLEY_PILOT).
 * Same screen as RoomStage — a deliberate copy of its layout so the LiveKit
 * path stays untouched while the pilot runs — driven by useParleyCall instead
 * of LiveKit hooks. Differences: Parley reports no connection quality (no
 * pills), the interviewer has no video, and the camera is a local self-view
 * that is never sent anywhere.
 */
function ParleyStage({
  join, session, connection, interviewer, wantCamera, initialCamera,
  transcript, onSegments, agentJoined, onAgentJoined, onEnd, onBack, onEnded, onLost, onEvent,
}: {
  join: IEParleyJoin;
  session: IESessionDetail;
  connection: IEConnection;
  interviewer: RAMockInterviewer;
  wantCamera: boolean;
  initialCamera: DeviceState;
  transcript: LiveTurn[];
  onSegments: (segments: CaptionSegment[]) => void;
  agentJoined: boolean;
  onAgentJoined: () => void;
  onEnd: () => void;
  onBack: () => void;
  /** Parley ended the interview (time up): go to the report. */
  onEnded: () => void;
  /** Parley gave up reconnecting: the page's rejoin flow takes over. */
  onLost: () => void;
  onEvent: (type: string, data?: Record<string, unknown>) => void;
}) {
  const t = useTranslations('practice');
  const { localizeRole, localizeType } = useMockRoleLabels();
  const { user } = useAuth();
  const video = connection.mode === 'video';

  // agent_join_ms once per interview, not per remount.
  const joinedRef = useRef(agentJoined);
  const joinStartRef = useRef(Date.now());
  const handleAgentJoined = useCallback(() => {
    if (!joinedRef.current) {
      joinedRef.current = true;
      onEvent('agent_join_ms', { ms: Date.now() - joinStartRef.current });
    }
    onAgentJoined();
  }, [onAgentJoined, onEvent]);

  const call = useParleyCall({
    join,
    wantCamera: video && wantCamera,
    onSegments,
    onAgentJoined: handleAgentJoined,
    onEnded,
    onLost,
    onEvent,
  });
  const reconnecting = call.status === 'reconnecting';

  const [agentSlow, setAgentSlow] = useState(false);
  useEffect(() => {
    if (agentJoined) { setAgentSlow(false); return; }
    const h = window.setTimeout(() => {
      setAgentSlow(true);
      onEvent('agent_slow_15s');
    }, 15000);
    return () => window.clearTimeout(h);
  }, [agentJoined, onEvent]);

  // Camera: the device-check verdict until the call opens it, then live state.
  const camState: DeviceState = video && wantCamera ? call.camState : initialCamera;
  const [camNoticeOpen, setCamNoticeOpen] = useState(video && isDeviceFailure(initialCamera));
  useEffect(() => {
    if (video && isDeviceFailure(call.camState)) setCamNoticeOpen(true);
    if (call.camState === 'ok') setCamNoticeOpen(false);
  }, [video, call.camState]);

  const [railTab, setRailTab] = useState<'coach' | 'transcript' | null>(null);
  const toggleRail = useCallback((tab: 'coach' | 'transcript') => {
    setRailTab((current) => (current === tab ? null : tab));
  }, []);
  useEffect(() => {
    if (!railTab) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRailTab(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [railTab]);

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
  const coach = useLiveCoach({
    sessionId: session.id,
    transcript,
    session,
    enabled: coachOn,
    agentSpeaking: call.agentState === 'speaking',
  });
  useEffect(() => {
    if (!coachOn) setRailTab((current) => (current === 'coach' ? null : current));
  }, [coachOn]);

  // Timer from the server's startedAt; frozen while reconnecting (see RoomStage).
  const startedMs = session.startedAt ? Date.parse(session.startedAt) : NaN;
  const baseMsRef = useRef(Number.isFinite(startedMs) ? startedMs : Date.now());
  useEffect(() => {
    if (Number.isFinite(startedMs)) baseMsRef.current = startedMs;
  }, [startedMs]);
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - baseMsRef.current) / 1000)));
  useEffect(() => {
    if (reconnecting) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - baseMsRef.current) / 1000)));
    tick();
    const h = window.setInterval(tick, 1000);
    return () => window.clearInterval(h);
  }, [reconnecting, startedMs]);

  const aiState: AiState =
    call.agentState === 'speaking' ? 'asking' : call.agentState === 'listening' ? 'listening' : 'thinking';
  const cameraReason = isDeviceFailure(camState) ? deviceStateLabel(t, camState) : null;
  const candidateName = user?.name?.trim() || user?.email?.split('@')[0] || t('live.you');
  const roleLabel = localizeRole(session.role);
  const typeLabel = localizeType(session.interviewType, 'label');
  const micFix = deviceFix(t, 'mic', call.micState);
  const camFix = video ? deviceFix(t, 'camera', camState) : null;

  return (
    <>
      <LiveBar
        role={roleLabel}
        typeLabel={typeLabel}
        format={connection.mode}
        elapsedSec={elapsed}
        currentIndex={0}
        total={0}
        onBack={onBack}
        className={styles.header}
      />

      {camNoticeOpen && camFix && (
        <div role="alert" className={styles.deviceAlert}>
          <span>
            <strong>{t('live.cameraUnavailable')}</strong>
            {' '}
            {camFix}
          </span>
          <button
            type="button"
            onClick={() => setCamNoticeOpen(false)}
            aria-label={t('live.dismiss')}
          >
            <IconX size={16} />
          </button>
        </div>
      )}

      {micFix ? (
        <MicBlockedDialog
          fix={micFix}
          busy={call.micState === 'checking'}
          onRetry={call.retryMic}
          onEnd={onEnd}
        />
      ) : call.audioBlocked ? (
        <AudioUnlockDialog onUnlock={call.unlockAudio} />
      ) : null}

      <div className={styles.stage} data-rail={railTab ? 'open' : 'closed'}>
        <div className={styles.stageMain}>
          <div className={styles.frame} data-mode={video ? 'video' : 'voice'}>
            <InterviewerTile interviewer={interviewer} aiState={aiState} video={video} />

            {video ? (
              <div className={`${styles.selfTile} ${styles.selfTileVideo}`}>
                {call.cameraStream ? (
                  <LocalVideo stream={call.cameraStream} className={styles.selfFeed} />
                ) : (
                  <div className={styles.selfOff}>
                    <IconCameraOff size={18} aria-hidden />
                    <span>{t('live.cameraOff')}</span>
                    {cameraReason ? <span className={styles.selfOffReason}>{cameraReason}</span> : null}
                  </div>
                )}
                <span className={styles.selfName}>
                  {call.micOn ? <IconMic size={12} /> : <IconMicOff size={12} />}
                  {t('live.you')}
                </span>
              </div>
            ) : null}

            {reconnecting && (
              <div role="status" className={styles.reconnectOverlay}>
                <span>{t('live.reconnecting')}</span>
              </div>
            )}
          </div>

          {!video && (
            <div className={styles.selfRow}>
              <YourTile
                name={candidateName}
                role={roleLabel}
                initials={initialsOf(candidateName)}
                active={call.agentState === 'listening'}
                video={false}
                camOn={false}
                onCamChange={() => undefined}
              />
            </div>
          )}

          {!agentJoined && (
            <p role="status" className={styles.agentStatus}>
              {agentSlow ? t('live.agentSlow') : t('live.agentJoining')}
            </p>
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

          {coachOn && coach.nudge && (
            <LiveCoachNudge tip={coach.nudge} onDismiss={coach.dismissNudge} />
          )}
        </div>

        {railTab ? (
          <aside className={styles.rail} aria-label={t('live.rail.title')}>
            <div className={styles.railTabs} role="tablist" aria-label={t('live.rail.title')}>
              {(coachOn ? (['coach', 'transcript'] as const) : (['transcript'] as const)).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`practice-rail-tab-${tab}`}
                  aria-selected={railTab === tab}
                  aria-controls="practice-rail-panel"
                  className={railTab === tab ? styles.railTabOn : undefined}
                  onClick={() => setRailTab(tab)}
                >
                  {tab === 'coach' ? t('live.coach.coachMode') : t('live.transcript')}
                </button>
              ))}
              <button
                type="button"
                className={styles.railClose}
                aria-label={t('live.rail.close')}
                onClick={() => setRailTab(null)}
              >
                <IconX size={16} />
              </button>
            </div>

            <div
              className={styles.railBody}
              id="practice-rail-panel"
              role="tabpanel"
              aria-labelledby={`practice-rail-tab-${railTab}`}
              tabIndex={0}
            >
              {railTab === 'coach'
                ? <CoachMeters metrics={coach.metrics} listeningFor={coach.listeningFor} />
                : <LiveTranscript turns={transcript} interviewerName={interviewer.name} typing={call.agentState === 'thinking'} />}
            </div>
          </aside>
        ) : null}
      </div>

      <div className={styles.controlBar}>
        <div className={styles.controlGroup}>
          <ControlButton
            tone="device"
            on={call.micOn}
            label={call.micOn ? t('live.muteMic') : t('live.unmuteMic')}
            icon={call.micOn ? <IconMic size={19} /> : <IconMicOff size={19} />}
            onClick={call.toggleMic}
          />
          {video && (
            <ControlButton
              tone="device"
              on={call.camOn}
              label={call.camOn ? t('live.stopCam') : t('live.startCam')}
              icon={call.camOn ? <IconCamera size={19} /> : <IconCameraOff size={19} />}
              onClick={call.toggleCamera}
            />
          )}
          <ControlButton
            tone="panel"
            on={coachOn}
            label={t('live.coach.coachMode')}
            icon={<IconSparkle size={19} />}
            onClick={toggleCoach}
          />
          <ControlButton
            tone="panel"
            on={railTab === 'transcript'}
            label={t('live.transcript')}
            icon={<IconTranscript size={19} />}
            onClick={() => toggleRail('transcript')}
          />
        </div>

        <button
          type="button"
          className={styles.endButton}
          aria-label={t('live.endInterview')}
          onClick={onEnd}
        >
          <IconEndCall size={18} aria-hidden />
          <span className={styles.endLabel}>{t('live.endInterview')}</span>
        </button>
      </div>
    </>
  );
}

/** One round call-control button: icon, an always-visible label, and a real
 *  pressed state.
 *
 *  Two tones, because "on" means opposite things here. A live mic and a running
 *  camera are the NORMAL state of an interview, so they stay quiet and turn red
 *  only when switched off — the one state a candidate must never misread. The
 *  coach and the transcript are optional panels, so they carry the accent while
 *  they are open. */
function ControlButton({
  tone, on, label, icon, onClick,
}: {
  tone: 'device' | 'panel';
  on: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  const state = tone === 'device'
    ? (on ? '' : styles.controlDanger)
    : (on ? styles.controlOn : '');
  return (
    <button
      type="button"
      className={`${styles.control} ${state}`}
      aria-pressed={on}
      onClick={onClick}
    >
      <span className={styles.controlIcon} aria-hidden>{icon}</span>
      <span className={styles.controlLabel}>{label}</span>
    </button>
  );
}
