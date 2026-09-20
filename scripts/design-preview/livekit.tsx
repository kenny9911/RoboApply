// LiveKit stand-in for the isolated design preview.
//
// The live interview room is the one authenticated surface whose layout cannot
// be reviewed without a real WebRTC room, a dispatched voice worker and spent
// credits. This module resolves in place of `@livekit/components-react` and
// `livekit-client` inside the preview bundle only (see design-preview.mjs), so
// the room renders its real markup against a scripted conversation.
//
// It is a rendering fixture. It proves layout, states and responsive
// behaviour; it proves nothing about connection handling.

import { useEffect, useState, type ReactNode } from 'react';

export const RoomEvent = {
  ConnectionStateChanged: 'connectionStateChanged',
  ConnectionQualityChanged: 'connectionQualityChanged',
  AudioPlaybackStatusChanged: 'audioPlaybackStatusChanged',
  TranscriptionReceived: 'transcriptionReceived',
  MediaDevicesError: 'mediaDevicesError',
} as const;

export const Track = { Source: { Camera: 'camera', Microphone: 'microphone' } } as const;
export const ConnectionState = {
  Connected: 'connected',
  Reconnecting: 'reconnecting',
  SignalReconnecting: 'signalReconnecting',
  Disconnected: 'disconnected',
} as const;
export const ConnectionQuality = { Excellent: 'excellent', Good: 'good', Poor: 'poor' } as const;
export const DisconnectReason = { CLIENT_INITIATED: 1, ROOM_DELETED: 6 } as const;
export const MediaDeviceFailure = { getFailure: () => undefined };

export type TranscriptionSegment = { id: string; text: string };
export type Participant = { identity: string; isLocal: boolean };

const room = {
  state: ConnectionState.Connected,
  canPlaybackAudio: true,
  localParticipant: { publishData: async () => undefined },
  startAudio: async () => undefined,
  on: () => room,
  off: () => room,
};

export function useRoomContext() { return room as never; }

/** Cycles the interviewer through its three states so every avatar treatment
 *  and the "Thinking…" transcript typing indicator are reviewable. */
export function useVoiceAssistant() {
  const [state, setState] = useState<'speaking' | 'listening' | 'thinking'>('speaking');
  useEffect(() => {
    const order = ['speaking', 'listening', 'thinking'] as const;
    let index = 0;
    const handle = window.setInterval(() => {
      index = (index + 1) % order.length;
      setState(order[index]);
    }, 4000);
    return () => window.clearInterval(handle);
  }, []);
  return { state };
}

export function useLocalParticipant() {
  const [isMicrophoneEnabled, setMic] = useState(true);
  const [isCameraEnabled, setCam] = useState(true);
  return {
    isMicrophoneEnabled,
    isCameraEnabled,
    localParticipant: {
      setMicrophoneEnabled: (on: boolean) => setMic(on),
      setCameraEnabled: (on: boolean) => setCam(on),
    },
  };
}

export function useTracks() { return []; }

/** Mirrors the real component's one structural detail: it renders a single
 *  wrapper div and forwards `className` onto it. */
export function LiveKitRoom({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={`lk-room-container ${className ?? ''}`}>{children}</div>;
}
export function RoomAudioRenderer() { return null; }
export function VideoTrack() { return null; }
