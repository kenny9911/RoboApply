'use client';

// One Parley call for the live practice page (pilot transport): opens the
// devices, connects the vendored client, and turns its events into the state
// the page renders — the same shape RoomStage derives from LiveKit hooks.
//
// Lifecycle rules that matter:
//   - The microphone goes to Parley; the camera stays LOCAL (self-view only —
//     nothing server-side uses it, and the pilot never records).
//   - The interview starts only once the interviewer's audio is confirmed
//     playable: play() succeeds → send `start` (Parley plays its pre-rendered
//     greeting at once). A blocked autoplay surfaces `audioBlocked`, and the
//     unlock tap both plays and starts.
//   - Unmount DISCONNECTS (keeps the Parley session for its reconnect grace)
//     rather than hanging up — a remount, rejoin or StrictMode double effect
//     must resume the same conversation. Ending is the server's job (End →
//     POST /end, which ends Parley and pulls the transcript).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IEParleyJoin } from '../../../../lib/api/interviewEngine';
import { classifyMediaError, isDeviceFailure, type DeviceState } from '../deviceState';
import { ParleyClient, type ParleyState } from './parleyClient';
import { agentStateFor, ParleyCaptions, type CaptionSegment, type ParleyAgentState } from './parleyCaptions';

export interface UseParleyCallOptions {
  join: IEParleyJoin;
  /** Open the camera for the self-view (video mode, camera passed the check). */
  wantCamera: boolean;
  onSegments: (segments: CaptionSegment[]) => void;
  /** The interviewer took the call (left 'connecting' for the first time). */
  onAgentJoined: () => void;
  /** Parley ended the interview (time up, ended elsewhere). */
  onEnded: (reason: string) => void;
  /** The client gave up reconnecting — the page's rejoin flow takes over. */
  onLost: () => void;
  onEvent: (type: string, data?: Record<string, unknown>) => void;
}

export interface ParleyCall {
  status: 'connecting' | 'connected' | 'reconnecting';
  agentState: ParleyAgentState;
  audioBlocked: boolean;
  unlockAudio: () => void;
  micState: DeviceState;
  micOn: boolean;
  toggleMic: () => void;
  retryMic: () => void;
  camState: DeviceState;
  camOn: boolean;
  toggleCamera: () => void;
  cameraStream: MediaStream | null;
}

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};
const VIDEO_CONSTRAINTS: MediaTrackConstraints = { width: 640, height: 480, frameRate: 15 };

export function useParleyCall(opts: UseParleyCallOptions): ParleyCall {
  const [status, setStatus] = useState<ParleyCall['status']>('connecting');
  const [agentState, setAgentState] = useState<ParleyAgentState>('connecting');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [micState, setMicState] = useState<DeviceState>('checking');
  const [micOn, setMicOn] = useState(true);
  const [camState, setCamState] = useState<DeviceState>(opts.wantCamera ? 'checking' : 'off');
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Callbacks change identity across renders; the connection effect must not.
  const cb = useRef(opts);
  useEffect(() => { cb.current = opts; });
  const clientRef = useRef<ParleyClient | null>(null);
  const startRef = useRef<() => void>(() => undefined);

  const { join, wantCamera } = opts;
  useEffect(() => {
    let disposed = false;
    let mic: MediaStream | null = null;
    const captions = new ParleyCaptions();
    let joined = false;
    let ready = false;
    let audioOk = false;
    let started = false;
    const emit = (seg: CaptionSegment | null) => { if (seg) cb.current.onSegments([seg]); };

    const tryStart = () => {
      const client = clientRef.current;
      if (!client || started || !ready || !audioOk) return;
      started = true;
      client.start();
      cb.current.onEvent('parley_start');
    };
    const ensureAudio = (why: string) => {
      const client = clientRef.current;
      if (!client) return;
      client.audio.play().then(() => {
        if (disposed) return;
        audioOk = true;
        setAudioBlocked(false);
        if (why === 'unlock') cb.current.onEvent('audio_unlocked');
        tryStart();
      }).catch(() => {
        if (disposed || audioOk) return;
        setAudioBlocked(true);
        cb.current.onEvent('audio_blocked');
      });
    };
    startRef.current = () => ensureAudio('unlock');

    void (async () => {
      setMicState('checking');
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      } catch (err) {
        if (disposed) return;
        const s = classifyMediaError(err);
        setMicState(isDeviceFailure(s) ? s : 'error');
        cb.current.onEvent('mic_failed', { state: s });
        return;
      }
      if (disposed) { mic.getTracks().forEach((t) => t.stop()); return; }
      setMicState('ok');
      setMicOn(true);

      const client = ParleyClient.create({
        sessionId: join.sessionId,
        token: join.clientToken,
        baseUrl: join.baseUrl,
        iceServers: join.iceServers,
        stream: mic,
      });
      clientRef.current = client;

      client.on('state', ({ state }: { state: ParleyState }) => {
        if (state === 'reconnecting') { setStatus('reconnecting'); return; }
        if (state === 'failed') { cb.current.onEvent('parley_failed'); cb.current.onLost(); return; }
        if (state === 'ended') return; // the `ended` event carries the reason
        const mapped = agentStateFor(state);
        if (!mapped) return;
        setAgentState(mapped);
        if (state === 'ready') { ready = true; tryStart(); }
        if (!joined && mapped !== 'connecting') {
          joined = true;
          cb.current.onAgentJoined();
        }
      });
      client.on('connection', ({ state, candidateType, connectMs }) => {
        if (state === 'connected') {
          setStatus('connected');
          cb.current.onEvent('parley_connected', { candidateType, connectMs });
        } else if (state === 'disconnected' || state === 'failed') {
          setStatus('reconnecting');
          cb.current.onEvent('reconnecting', { state });
        }
      });
      client.on('track', () => ensureAudio('track'));
      client.on('user.partial', ({ text }) => emit(captions.userPartial(text)));
      client.on('user.final', ({ turnId, text }) => emit(captions.userFinal(turnId, text)));
      client.on('user.retracted', ({ turnId, text }) => emit(captions.userRetracted(turnId, text)));
      client.on('agent.segment', ({ turnId, index, text }) => emit(captions.agentSegment(turnId, index, text)));
      client.on('agent.done', ({ turnId, text }) => emit(captions.agentDone(turnId, text)));
      client.on('agent.interrupted', ({ turnId, playedText }) => emit(captions.agentInterrupted(turnId, playedText)));
      client.on('metrics', (m) => cb.current.onEvent('parley_turn', { ...m }));
      client.on('error', ({ message }) => cb.current.onEvent('parley_error', { message: message.slice(0, 200) }));
      client.on('ended', ({ reason }) => { if (!disposed) cb.current.onEnded(reason); });

      try {
        await client.connect();
      } catch (err) {
        if (disposed) return;
        cb.current.onEvent('parley_connect_failed', { message: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        cb.current.onLost();
      }
    })();

    return () => {
      disposed = true;
      startRef.current = () => undefined;
      clientRef.current?.disconnect();
      clientRef.current = null;
      mic?.getTracks().forEach((t) => t.stop());
    };
  }, [join, attempt]);

  // Self-view camera, independent of the call: a camera failure never takes
  // the interview down.
  const openCamera = useCallback(async () => {
    setCamState('checking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
      setCameraStream((prev) => { prev?.getTracks().forEach((t) => t.stop()); return stream; });
      setCamState('ok');
    } catch (err) {
      const s = classifyMediaError(err);
      setCamState(isDeviceFailure(s) ? s : 'error');
      cb.current.onEvent('camera_failed', { state: s });
    }
  }, []);
  useEffect(() => {
    if (wantCamera) void openCamera();
  }, [wantCamera, openCamera]);
  useEffect(() => () => cameraStream?.getTracks().forEach((t) => t.stop()), [cameraStream]);

  const toggleMic = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    client.mute(micOn);
    setMicOn(!micOn);
  }, [micOn]);

  const toggleCamera = useCallback(() => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      setCameraStream(null);
      setCamState('off');
      return;
    }
    void openCamera();
  }, [cameraStream, openCamera]);

  return {
    status,
    agentState,
    audioBlocked,
    unlockAudio: useCallback(() => startRef.current(), []),
    micState,
    micOn,
    toggleMic,
    retryMic: useCallback(() => setAttempt((n) => n + 1), []),
    camState,
    camOn: !!cameraStream,
    toggleCamera,
    cameraStream,
  };
}
