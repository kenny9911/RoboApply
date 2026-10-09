// __tests__/pages/practice-live.test.tsx
//
// /practice/[id] — the live interview page, with LiveKit mocked out.
//
// Pinned here (each was a shipped defect or a contract seam):
//   - preparing → created: the page runs /prepare, then shows the device check
//   - a failed plan shows a specific message, and Retry re-runs /prepare
//   - a camera that fails to publish does NOT end the interview
//   - a mic that fails blocks with a how-to-fix instead of a silent room
//   - client_ready is sent again when an agent participant connects, and the
//     ready attribute is set
//   - a duplicate identity is "open in another tab", never an auto-rejoin
//   - End fires the keepalive end and navigates to the report at once

import { Suspense, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { ConnectionState, DisconnectReason, ParticipantKind, RoomEvent } from 'livekit-client';

import MockLivePage from '../../app/(auth)/practice/[id]/page';
import { RoboApiError } from '../../lib/api/client';
import type { IEConnection, IESessionDetail } from '../../lib/api/interviewEngine';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState } from '../utils/mockAuth';

// ── Fake LiveKit room ─────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => void;

function makeFakeRoom() {
  const handlers = new Map<string, Set<Handler>>();
  const room = {
    state: ConnectionState.Connected as ConnectionState,
    canPlaybackAudio: true,
    startAudio: vi.fn(async () => undefined),
    on(event: string, fn: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
      return room;
    },
    off(event: string, fn: Handler) {
      handlers.get(event)?.delete(fn);
      return room;
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of Array.from(handlers.get(event) ?? [])) fn(...args);
    },
    localParticipant: {
      setMicrophoneEnabled: vi.fn(async (_on: boolean) => undefined as unknown),
      setCameraEnabled: vi.fn(async (_on: boolean) => undefined as unknown),
      publishData: vi.fn(async () => undefined),
      setAttributes: vi.fn(async () => undefined),
    },
  };
  return room;
}

const lk = vi.hoisted(() => ({
  room: null as ReturnType<typeof makeFakeRoom> | null,
  roomProps: null as Record<string, unknown> | null,
  assistant: { state: 'listening', agent: undefined, videoTrack: undefined } as Record<string, unknown>,
}));

vi.mock('@livekit/components-styles', () => ({}));
vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: (props: Record<string, unknown> & { children?: ReactNode }) => {
    lk.roomProps = props;
    return <div data-testid="lk-room">{props.children}</div>;
  },
  RoomAudioRenderer: () => null,
  VideoTrack: () => <video data-testid="video-track" />,
  useRoomContext: () => lk.room,
  useVoiceAssistant: () => lk.assistant,
  useLocalParticipant: () => ({
    localParticipant: lk.room!.localParticipant,
    isMicrophoneEnabled: true,
    isCameraEnabled: false,
  }),
  useTracks: () => [],
}));

// ── API + app mocks ───────────────────────────────────────────────────────

const api = vi.hoisted(() => ({
  get: vi.fn(),
  prepare: vi.fn(),
  connection: vi.fn(),
  endKeepalive: vi.fn(),
  coach: vi.fn(async () => ({ coach: null })),
}));

vi.mock('../../lib/api/interviewEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/interviewEngine')>()),
  interviewEngineApi: api,
  postClientEvents: vi.fn(),
}));

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => {
  // One router object, like Next's: a fresh identity per render would re-run
  // every effect that depends on it.
  const router = {
    push: nav.push, replace: nav.replace, refresh: vi.fn(),
    back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(),
  };
  return {
    useRouter: () => router,
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/practice/s1',
  };
});

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockAuthState.value,
}));

vi.mock('../../hooks/useMockV3', () => ({
  useMockCatalog: () => ({ data: undefined }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<IESessionDetail> = {}): IESessionDetail {
  return {
    id: 's1', status: 'created', source: 'app', role: 'Backend Engineer',
    interviewType: 'behavioral', personaId: 'maya', mode: 'video', language: 'en',
    durationMinutes: 20, overall: null, externalRef: null, error: null,
    createdAt: '2026-10-09T00:00:00.000Z', startedAt: null, endedAt: null,
    candidateName: null, characteristics: null, voice: null, questions: [],
    webSources: [], interviewerBrief: null, requirements: null, breakdown: null,
    strengths: [], gaps: [], summary: null, recommendations: null,
    questionAnalysis: null, recordingAvailable: false, transcriptAvailable: false,
    ...overrides,
  };
}

const CONNECTION: IEConnection = {
  sessionId: 's1', url: 'wss://lk.example', token: 'tok', roomName: 'r1',
  identity: 'candidate-s1', mode: 'video', language: 'en',
  voice: { provider: 'x', model: 'y', voiceId: 'z', languageCode: 'en' },
  expiresAt: '2026-10-09T01:00:00.000Z', agentDispatched: true, recording: false,
};

function stubMedia(opts: { audio?: Error | null; video?: Error | null } = {}) {
  const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
    if (c.audio && opts.audio) throw opts.audio;
    if (c.video && opts.video) throw opts.video;
    return stream;
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  return getUserMedia;
}

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

async function renderLive() {
  await act(async () => {
    renderWithProviders(
      <Suspense fallback={<p>suspended</p>}>
        <MockLivePage params={Promise.resolve({ id: 's1' })} />
      </Suspense>,
    );
  });
}

/** Load a 'created' session, pass the device check, land in the room. */
async function joinRoom() {
  api.get.mockResolvedValue({ session: makeSession() });
  await renderLive();
  const join = await screen.findByRole('button', { name: 'Join the interview' });
  await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { fireEvent.click(join); });
  await screen.findByTestId('lk-room');
}

beforeEach(() => {
  lk.room = makeFakeRoom();
  lk.roomProps = null;
  lk.assistant = { state: 'listening', agent: undefined, videoTrack: undefined };
  for (const fn of Object.values(api)) fn.mockReset();
  api.coach.mockResolvedValue({ coach: null });
  api.connection.mockResolvedValue({ connection: CONNECTION });
  nav.push.mockReset();
  nav.replace.mockReset();
  stubMedia();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('/practice/[id] preparing', () => {
  it('runs /prepare for a preparing session, then shows the device check', async () => {
    api.get.mockResolvedValue({ session: makeSession({ status: 'preparing' }) });
    let resolvePrepare: (v: unknown) => void = () => undefined;
    api.prepare.mockReturnValue(new Promise((r) => { resolvePrepare = r; }));

    await renderLive();
    expect(await screen.findByText('Getting your interview ready')).toBeInTheDocument();
    expect(api.prepare).toHaveBeenCalledWith('s1', expect.objectContaining({ retry: false }));
    // Never mints a token (which dispatches the interviewer) while preparing.
    expect(api.connection).not.toHaveBeenCalled();

    await act(async () => { resolvePrepare({ session: makeSession({ status: 'created' }) }); });
    expect(await screen.findByRole('heading', { name: 'Check your microphone and camera' })).toBeInTheDocument();
    expect(api.connection).not.toHaveBeenCalled();
  });

  it('shows the specific failure for llm_unavailable, and Retry re-runs /prepare with retry', async () => {
    api.get.mockResolvedValue({ session: makeSession({ status: 'preparing' }) });
    api.prepare.mockRejectedValueOnce(new RoboApiError('llm_unavailable', {
      status: 503,
      payload: { error: 'llm_unavailable', session: makeSession({ status: 'failed', error: 'llm_unavailable' }) },
    }));
    api.prepare.mockReturnValueOnce(new Promise(() => undefined));

    await renderLive();
    expect(await screen.findByText("The interview service isn't responding")).toBeInTheDocument();
    expect(screen.getByText(/You haven't been charged/)).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(api.prepare).toHaveBeenLastCalledWith('s1', expect.objectContaining({ retry: true }));
    expect(await screen.findByText('Getting your interview ready')).toBeInTheDocument();
  });

  it('re-issues /prepare when the request dies without a code and the session stays preparing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.get.mockResolvedValue({ session: makeSession({ status: 'preparing' }) });
    api.prepare.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    api.prepare.mockReturnValue(new Promise(() => undefined));

    await renderLive();
    expect(await screen.findByText('Getting your interview ready')).toBeInTheDocument();
    await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(1));

    // Polls inside the back-off window never re-issue.
    await act(async () => { vi.advanceTimersByTime(9_000); });
    expect(api.prepare).toHaveBeenCalledTimes(1);

    // Still 'preparing' well after the request died → one fresh /prepare.
    await act(async () => { vi.advanceTimersByTime(9_000); });
    await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(2));
    expect(api.prepare).toHaveBeenLastCalledWith('s1', expect.objectContaining({ retry: false }));

    // While the re-issued request is in flight, no further re-issues.
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(api.prepare).toHaveBeenCalledTimes(2);
  });

  it('a session that already failed to prepare offers Retry without calling /prepare first', async () => {
    api.get.mockResolvedValue({ session: makeSession({ status: 'failed', error: 'prepare_failed' }) });
    await renderLive();
    expect(await screen.findByText("This interview couldn't be planned")).toBeInTheDocument();
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('a not_ready connection sends the page back to preparing', async () => {
    api.get.mockResolvedValue({ session: makeSession() });
    api.connection.mockRejectedValue(new RoboApiError('not_ready', { status: 409, payload: { error: 'not_ready' } }));
    api.prepare.mockReturnValue(new Promise(() => undefined));
    await renderLive();
    const join = await screen.findByRole('button', { name: 'Join the interview' });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    expect(await screen.findByText('Getting your interview ready')).toBeInTheDocument();
  });
});

describe('/practice/[id] device check', () => {
  it('a blocked camera still lets the candidate join with voice only', async () => {
    stubMedia({ video: domError('NotAllowedError') });
    api.get.mockResolvedValue({ session: makeSession() });
    await renderLive();
    const join = await screen.findByRole('button', { name: 'Join with voice only' });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText(/Your browser is blocking the camera/)).toBeInTheDocument();

    await act(async () => { fireEvent.click(join); });
    await screen.findByTestId('lk-room');
    // The camera is never published when the check found it blocked.
    await waitFor(() => expect(lk.room!.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true));
    expect(lk.room!.localParticipant.setCameraEnabled).not.toHaveBeenCalledWith(true);
  });

  it('a microphone in use by another app blocks joining with a plain fix', async () => {
    stubMedia({ audio: domError('NotReadableError') });
    api.get.mockResolvedValue({ session: makeSession({ mode: 'voice' }) });
    await renderLive();
    expect(await screen.findByText(/Another app is using your microphone/)).toBeInTheDocument();
    expect((screen.getByRole('button', { name: 'Join the interview' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('/practice/[id] room', () => {
  it('does not hand devices to LiveKitRoom, and keeps stable handlers across renders', async () => {
    await joinRoom();
    expect(lk.roomProps!.audio).toBe(false);
    expect(lk.roomProps!.video).toBe(false);
    const firstOnError = lk.roomProps!.onError;
    const firstOnDisconnected = lk.roomProps!.onDisconnected;
    // Opening the End dialog re-renders the page.
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'End the interview' })[0]);
    });
    expect(lk.roomProps!.onError).toBe(firstOnError);
    expect(lk.roomProps!.onDisconnected).toBe(firstOnDisconnected);
  });

  it('a camera publish failure keeps the interview running with a Camera off tile', async () => {
    lk.room!.localParticipant.setCameraEnabled.mockRejectedValue(domError('NotReadableError'));
    await joinRoom();
    await waitFor(() => expect(lk.room!.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true));
    expect(await screen.findByText('Continuing with voice only.')).toBeInTheDocument();
    expect(screen.getByText('In use by another app')).toBeInTheDocument();
    // Still in the room — not the "session is over" screen.
    expect(screen.getByTestId('lk-room')).toBeInTheDocument();
    expect(screen.queryByText('This session is over')).toBeNull();
  });

  it('a device error reaching onError is not fatal; a connection error is', async () => {
    await joinRoom();
    const onError = lk.roomProps!.onError as (e: Error) => void;
    await act(async () => { onError(domError('NotAllowedError')); });
    expect(screen.getByTestId('lk-room')).toBeInTheDocument();
    await act(async () => { onError(domError('ConnectionError')); });
    expect(await screen.findByText("We couldn't connect you")).toBeInTheDocument();
  });

  it('a mic that fails in the room blocks with the fix and can be retried in place', async () => {
    lk.room!.localParticipant.setMicrophoneEnabled
      .mockRejectedValueOnce(domError('NotAllowedError'))
      .mockResolvedValueOnce(undefined);
    await joinRoom();
    const dialog = await screen.findByRole('alertdialog', { name: "Your microphone isn't working" });
    expect(dialog).toHaveTextContent(/Your browser is blocking the microphone/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(lk.room!.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(2);
  });

  it('sends client_ready on connect and again when an agent participant connects', async () => {
    await joinRoom();
    const publish = lk.room!.localParticipant.publishData;
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    const [payload, opts] = publish.mock.calls[0] as unknown as [Uint8Array, { topic: string; reliable: boolean }];
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual({ type: 'client_ready' });
    expect(opts).toEqual({ reliable: true, topic: 'ie' });
    expect(lk.room!.localParticipant.setAttributes).toHaveBeenCalledWith({ 'ie.client_ready': '1' });

    // A non-agent joining changes nothing.
    await act(async () => {
      lk.room!.emit(RoomEvent.ParticipantConnected, { kind: ParticipantKind.STANDARD, identity: 'other' });
    });
    expect(publish).toHaveBeenCalledTimes(1);

    await act(async () => {
      lk.room!.emit(RoomEvent.ParticipantConnected, { kind: ParticipantKind.AGENT, identity: 'agent-1' });
    });
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
  });

  it('holds client_ready while audio is blocked, and sends it on the unlock tap', async () => {
    lk.room!.canPlaybackAudio = false;
    lk.room!.startAudio.mockRejectedValueOnce(new Error('blocked'));
    await joinRoom();
    const unlock = await screen.findByRole('button', { name: 'Tap to turn on sound' });
    expect(lk.room!.localParticipant.publishData).not.toHaveBeenCalled();
    lk.room!.canPlaybackAudio = true;
    await act(async () => { fireEvent.click(unlock); });
    await waitFor(() => expect(lk.room!.localParticipant.publishData).toHaveBeenCalledTimes(1));
  });

  it('a duplicate identity shows "open in another tab" and never rejoins on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await joinRoom();
    expect(api.connection).toHaveBeenCalledTimes(1);
    const onDisconnected = lk.roomProps!.onDisconnected as (r?: DisconnectReason) => void;
    await act(async () => { onDisconnected(DisconnectReason.DUPLICATE_IDENTITY); });
    expect(await screen.findByText('This interview is open in another tab')).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(api.connection).toHaveBeenCalledTimes(1);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use this tab' })); });
    await waitFor(() => expect(api.connection).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('lk-room')).toBeInTheDocument();
  });

  it('End fires the keepalive end and goes straight to the report', async () => {
    await joinRoom();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'End the interview' })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'End and view report' }));
    });
    expect(api.endKeepalive).toHaveBeenCalledWith('s1');
    expect(nav.push).toHaveBeenCalledWith('/practice/s1/report');
  });
});
