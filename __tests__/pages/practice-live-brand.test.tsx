// __tests__/pages/practice-live-brand.test.tsx
//
// /practice/[id] per brand (WP-63a), with LiveKit mocked out:
//   - GoApply: the camera is a LOCAL preview only — no video track is ever
//     published, not even when the camera failed the device check and is
//     started later; the requested "only you can see it" copy is not in the
//     bundles yet, so no key path is ever shown in its place
//   - a connection the server marks `cameraPublish: false` is honoured on
//     RoboApply too; RoboApply video otherwise publishes as in Wave 0
//   - a weak network in the device check offers the written practice, which
//     ends the unstarted live session and runs the written practice in place

import { Suspense, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { ConnectionState } from 'livekit-client';

import MockLivePage from '../../app/(auth)/practice/[id]/page';
import { BrandProvider } from '../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../lib/brand/client';
import type { IEConnection, IESessionDetail } from '../../lib/api/interviewEngine';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState } from '../utils/mockAuth';

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
  assistant: { state: 'listening', agent: undefined, videoTrack: undefined } as Record<string, unknown>,
}));

vi.mock('@livekit/components-styles', () => ({}));
vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: (props: { children?: ReactNode }) => <div data-testid="lk-room">{props.children}</div>,
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

const api = vi.hoisted(() => ({
  get: vi.fn(),
  prepare: vi.fn(),
  connection: vi.fn(),
  endKeepalive: vi.fn(),
  coach: vi.fn(async () => ({ coach: null })),
}));
const practice = vi.hoisted(() => ({ info: vi.fn(), textStart: vi.fn() }));

vi.mock('../../lib/api/interviewEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/interviewEngine')>();
  return {
    ...actual,
    interviewEngineApi: api,
    postClientEvents: vi.fn(),
    practiceApi: { ...actual.practiceApi, info: practice.info },
    textPracticeApi: { ...actual.textPracticeApi, start: practice.textStart },
  };
});

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => {
  const router = { push: nav.push, replace: nav.replace, refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() };
  return { useRouter: () => router, useSearchParams: () => new URLSearchParams(), usePathname: () => '/practice/s1' };
});
vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockAuthState.value,
}));
vi.mock('../../hooks/useMockV3', () => ({ useMockCatalog: () => ({ data: undefined }) }));

function makeSession(overrides: Partial<IESessionDetail> = {}): IESessionDetail {
  return {
    id: 's1', status: 'created', source: 'roboapply', role: 'Backend Engineer',
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

function connection(extra: Partial<IEConnection> & { cameraPublish?: boolean } = {}): IEConnection {
  return {
    sessionId: 's1', url: 'wss://lk.example', token: 'tok', roomName: 'r1',
    identity: 'candidate-s1', mode: 'video', language: 'en',
    voice: { provider: 'x', model: 'y', voiceId: 'z', languageCode: 'en' },
    expiresAt: '2026-10-09T01:00:00.000Z', agentDispatched: true, recording: false,
    ...extra,
  } as IEConnection;
}

function stubMedia() {
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  return getUserMedia;
}

async function renderLive(brand: 'roboapply' | 'goapply') {
  await act(async () => {
    renderWithProviders(
      <BrandProvider brand={clientBrandFor(brand)}>
        <Suspense fallback={<p>suspended</p>}>
          <MockLivePage params={Promise.resolve({ id: 's1' })} />
        </Suspense>
      </BrandProvider>,
    );
  });
}

const localSelfView = () => document.querySelector('video:not([data-testid="video-track"])');
const noKeyPaths = () => expect(document.body.textContent ?? '').not.toMatch(/live\.(cam|network)\./);

async function join(name = 'Join the interview') {
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { fireEvent.click(button); });
  await screen.findByTestId('lk-room');
}

let getUserMedia: ReturnType<typeof stubMedia>;

beforeEach(() => {
  lk.room = makeFakeRoom();
  for (const fn of Object.values(api)) fn.mockReset();
  practice.info.mockReset();
  practice.textStart.mockReset();
  api.coach.mockResolvedValue({ coach: null });
  api.get.mockResolvedValue({ session: makeSession() });
  nav.push.mockReset();
  nav.replace.mockReset();
  getUserMedia = stubMedia();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
});

describe('GoApply: the camera is a local preview only', () => {
  it('never publishes a video track, shows the camera to the candidate alone, says so', async () => {
    api.connection.mockResolvedValue({ connection: connection({ cameraPublish: false }) });
    await renderLive('goapply');
    await screen.findByRole('button', { name: 'Join the interview' });
    noKeyPaths();
    await join();

    await waitFor(() => expect(lk.room!.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true));
    await waitFor(() => expect(localSelfView()).not.toBeNull());
    // The self-view came from a local getUserMedia (video only), not from the room.
    expect(getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ audio: false, video: expect.anything() }));
    expect(screen.queryByTestId('video-track')).toBeNull();
    noKeyPaths();

    // Toggling the camera only stops/starts the local preview.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop camera' })); });
    await waitFor(() => expect(localSelfView()).toBeNull());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start camera' })); });
    await waitFor(() => expect(localSelfView()).not.toBeNull());
    expect(lk.room!.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });

  it('a camera that failed the device check, started later, is still only a local preview', async () => {
    let cameraBlocked = true;
    getUserMedia.mockImplementation((async (constraints?: MediaStreamConstraints) => {
      if (constraints?.video && cameraBlocked) throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    }) as never);
    api.connection.mockResolvedValue({ connection: connection({ cameraPublish: false }) });
    await renderLive('goapply');
    await join('Join with voice only');
    await waitFor(() => expect(lk.room!.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true));
    expect(localSelfView()).toBeNull();

    cameraBlocked = false;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start camera' })); });
    await waitFor(() => expect(localSelfView()).not.toBeNull());
    expect(lk.room!.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });

  it('holds even against an older API that sends no cameraPublish', async () => {
    api.connection.mockResolvedValue({ connection: connection() });
    await renderLive('goapply');
    await join();
    await waitFor(() => expect(lk.room!.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true));
    await waitFor(() => expect(localSelfView()).not.toBeNull());
    expect(lk.room!.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });
});

describe('RoboApply', () => {
  it('video publishes the camera as in Wave 0, with no local-only note', async () => {
    api.connection.mockResolvedValue({ connection: connection({ cameraPublish: true }) });
    await renderLive('roboapply');
    await join();
    await waitFor(() => expect(lk.room!.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true));
    expect(localSelfView()).toBeNull();
  });

  it('honours a server that keeps the camera local', async () => {
    api.connection.mockResolvedValue({ connection: connection({ cameraPublish: false }) });
    await renderLive('roboapply');
    await join();
    await waitFor(() => expect(localSelfView()).not.toBeNull());
    expect(lk.room!.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });
});

describe('network pre-check', () => {
  it('a good connection says so and offers nothing else', async () => {
    await renderLive('roboapply');
    expect(await screen.findByText('Good connection', undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start the written practice' })).toBeNull();
    noKeyPaths();
  });

  it('a weak connection offers the written practice, which ends the live session and runs here', async () => {
    let loaded = false;
    api.get.mockImplementation(async () => {
      if (!loaded) { loaded = true; return { session: makeSession({ mode: 'voice' }) }; }
      throw new TypeError('Failed to fetch');
    });
    practice.info.mockResolvedValue({ practice: { sessionId: 's1', status: 'created', job: { id: 'job1', title: 'x', companyName: 'y' }, recording: { consented: false, video: false, available: false }, completedAt: null } });
    practice.textStart.mockResolvedValue({ sessionId: 't1', questions: [{ q: 'Tell me about a project.', hint: '', coachTip: null }], jobId: 'job1' });
    await renderLive('goapply');

    expect(await screen.findByText('Poor connection', undefined, { timeout: 4000 })).toBeInTheDocument();
    noKeyPaths();
    // Joining by voice stays possible.
    expect((screen.getByRole('button', { name: 'Join the interview' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start the written practice' })); });

    expect(api.endKeepalive).toHaveBeenCalledWith('s1');
    expect(await screen.findByText('Tell me about a project.')).toBeInTheDocument();
    expect(practice.textStart).toHaveBeenCalledWith(expect.objectContaining({
      role: 'Backend Engineer', interviewerId: 'maya', typeId: 'behavioral', jobId: 'job1',
    }));
    expect(api.connection).not.toHaveBeenCalled();
  });

  it('is not offered once the interview has started (a rejoin)', async () => {
    let loaded = false;
    api.get.mockImplementation(async () => {
      if (!loaded) { loaded = true; return { session: makeSession({ status: 'live', startedAt: '2026-10-09T00:01:00.000Z' }) }; }
      throw new TypeError('Failed to fetch');
    });
    await renderLive('roboapply');
    expect(await screen.findByText('Poor connection', undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start the written practice' })).toBeNull();
  });
});
