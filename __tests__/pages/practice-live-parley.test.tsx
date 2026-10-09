// __tests__/pages/practice-live-parley.test.tsx
//
// /practice/[id] on the Parley pilot transport (connection.transport ===
// 'parley'), with the Parley call hook mocked out. Pinned here:
//   - a Parley connection renders the Parley stage, never a LiveKit room, and
//     hands the hook the join block from the server
//   - captions from the transport land in the transcript rail
//   - blocked audio shows the unlock overlay; the tap goes to the transport
//   - a failed mic blocks with the fix and Try again re-acquires it
//   - Parley ending the interview (time up) goes to the report
//   - Parley giving up reconnecting runs the page's one automatic rejoin
//   - End works exactly as on LiveKit (keepalive end + report)

import { Suspense, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import MockLivePage from '../../app/(auth)/practice/[id]/page';
import type { IEConnection, IESessionDetail } from '../../lib/api/interviewEngine';
import type { UseParleyCallOptions, ParleyCall } from '../../components/v3/mock/parley/useParleyCall';
import type { DeviceState } from '../../components/v3/mock/deviceState';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState } from '../utils/mockAuth';

// ── Parley call hook (the transport) ──────────────────────────────────────

const pc = vi.hoisted(() => ({
  opts: null as UseParleyCallOptions | null,
  mounts: 0,
  call: {} as Record<string, unknown>,
}));

vi.mock('../../components/v3/mock/parley/useParleyCall', async () => {
  const { useEffect } = await import('react');
  return {
    useParleyCall: (opts: UseParleyCallOptions) => {
      pc.opts = opts;
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useEffect(() => { pc.mounts += 1; }, []);
      return pc.call;
    },
  };
});

function setCall(over: Partial<ParleyCall> = {}) {
  pc.call = {
    status: 'connected',
    agentState: 'listening',
    audioBlocked: false,
    unlockAudio: vi.fn(),
    micState: 'ok' as DeviceState,
    micOn: true,
    toggleMic: vi.fn(),
    retryMic: vi.fn(),
    camState: 'off' as DeviceState,
    camOn: false,
    toggleCamera: vi.fn(),
    cameraStream: null,
    ...over,
  };
}

// LiveKit must never mount on this path.
const lkMounted = vi.hoisted(() => ({ count: 0 }));
vi.mock('@livekit/components-styles', () => ({}));
vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: () => { lkMounted.count += 1; return <div data-testid="lk-room" />; },
  RoomAudioRenderer: () => null,
  VideoTrack: () => null,
  useRoomContext: () => null,
  useVoiceAssistant: () => ({}),
  useLocalParticipant: () => ({}),
  useTracks: () => [],
}));

// ── API + app mocks (as in practice-live.test.tsx) ────────────────────────

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
    interviewType: 'behavioral', personaId: 'maya', mode: 'voice', language: 'en',
    durationMinutes: 20, overall: null, externalRef: null, error: null,
    createdAt: '2026-10-09T00:00:00.000Z', startedAt: null, endedAt: null,
    candidateName: null, characteristics: null, voice: null, questions: [],
    webSources: [], interviewerBrief: null, requirements: null, breakdown: null,
    strengths: [], gaps: [], summary: null, recommendations: null,
    questionAnalysis: null, recordingAvailable: false, transcriptAvailable: false,
    ...overrides,
  };
}

const JOIN = {
  baseUrl: 'http://parley.test', sessionId: 'ses_1', clientToken: 'ct_1',
  expiresAt: '2026-10-09T01:00:00.000Z', iceServers: [],
};
const CONNECTION: IEConnection = {
  sessionId: 's1', url: '', token: '', roomName: 'r1',
  identity: 'candidate-s1', mode: 'voice', language: 'en',
  voice: { provider: 'x', model: 'y', voiceId: 'z', languageCode: 'en' },
  expiresAt: JOIN.expiresAt, agentDispatched: true, recording: false,
  transport: 'parley', parley: JOIN,
};

function stubMedia() {
  const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
}

async function joinParley(session: Partial<IESessionDetail> = {}) {
  api.get.mockResolvedValue({ session: makeSession(session) });
  await act(async () => {
    renderWithProviders(
      <Suspense fallback={<p>suspended</p>}>
        <MockLivePage params={Promise.resolve({ id: 's1' })} />
      </Suspense>,
    );
  });
  const join = await screen.findByRole('button', { name: 'Join the interview' });
  await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { fireEvent.click(join); });
  await waitFor(() => expect(pc.opts).not.toBeNull());
}

beforeEach(() => {
  pc.opts = null;
  pc.mounts = 0;
  lkMounted.count = 0;
  setCall();
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

describe('/practice/[id] on Parley', () => {
  it('renders the Parley stage with the server join block, never a LiveKit room', async () => {
    await joinParley();
    expect(pc.opts!.join).toEqual(JOIN);
    expect(pc.opts!.wantCamera).toBe(false);
    expect(lkMounted.count).toBe(0);
    expect(screen.queryByTestId('lk-room')).toBeNull();
    expect(screen.getByRole('button', { name: 'End the interview' })).toBeInTheDocument();
  });

  it('video mode shows the local camera as the self-view (and asks the hook for it)', async () => {
    api.connection.mockResolvedValue({ connection: { ...CONNECTION, mode: 'video' } });
    setCall({ cameraStream: {} as MediaStream, camOn: true, camState: 'ok' });
    await joinParley({ mode: 'video' });
    expect(pc.opts!.wantCamera).toBe(true);
    expect(document.querySelector('video')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Stop camera' })).toBeInTheDocument();
  });

  it('shows transport captions in the transcript rail', async () => {
    await joinParley();
    await act(async () => {
      pc.opts!.onAgentJoined();
      pc.opts!.onSegments([
        { id: 'parley-them-1', who: 'them', text: 'Tell me about a hard bug.', final: true },
        { id: 'parley-you-0', who: 'you', text: 'We had a race in checkout', final: false },
      ]);
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Live transcript' })); });
    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getByText('Tell me about a hard bug.')).toBeInTheDocument();
    expect(within(panel).getByText(/We had a race in checkout/)).toBeInTheDocument();
  });

  it('blocked audio shows the unlock overlay and the tap goes to the transport', async () => {
    setCall({ audioBlocked: true });
    await joinParley();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tap to turn on sound' })); });
    expect(pc.call.unlockAudio).toHaveBeenCalledTimes(1);
  });

  it('a failed mic blocks with the fix, and Try again re-acquires it', async () => {
    setCall({ micState: 'denied' });
    await joinParley();
    expect(await screen.findByRole('alertdialog', { name: "Your microphone isn't working" })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(pc.call.retryMic).toHaveBeenCalledTimes(1);
  });

  it('Parley ending the interview goes to the report', async () => {
    await joinParley();
    await act(async () => { pc.opts!.onEnded('time_up'); });
    expect(api.endKeepalive).toHaveBeenCalledWith('s1');
    expect(nav.push).toHaveBeenCalledWith('/practice/s1/report');
  });

  it('a lost connection gets one automatic rejoin onto the same Parley session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await joinParley();
    expect(api.connection).toHaveBeenCalledTimes(1);
    const mountsBefore = pc.mounts;
    await act(async () => { pc.opts!.onLost(); });
    expect(await screen.findByText('Connection lost — reconnecting')).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(2_000); });
    await waitFor(() => expect(api.connection).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(pc.mounts).toBe(mountsBefore + 1));
    expect(api.endKeepalive).not.toHaveBeenCalled();
  });

  it('End fires the keepalive end and goes straight to the report', async () => {
    await joinParley();
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
