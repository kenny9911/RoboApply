// useParleyCall — the Parley pilot's call lifecycle, against a fake client:
// the interview starts only once audio is confirmed playable AND Parley is
// ready; blocked autoplay surfaces the overlay and the tap starts it; captions
// and the end are forwarded; unmount DISCONNECTS (never hangs up).

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  clients: [] as Array<{
    opts: Record<string, unknown>;
    handlers: Map<string, Set<(ev: unknown) => void>>;
    audio: { play: ReturnType<typeof vi.fn> };
    start: ReturnType<typeof vi.fn>;
    mute: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    fire: (type: string, ev: unknown) => void;
  }>,
  play: null as null | (() => Promise<void>),
}));

vi.mock('../parley/parleyClient', () => ({
  ParleyClient: {
    create(opts: Record<string, unknown>) {
      const handlers = new Map<string, Set<(ev: unknown) => void>>();
      const client = {
        opts,
        handlers,
        audio: { play: vi.fn(() => (fake.play ? fake.play() : Promise.resolve())) },
        start: vi.fn(),
        mute: vi.fn(),
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(),
        close: vi.fn(),
        on(type: string, fn: (ev: unknown) => void) {
          if (!handlers.has(type)) handlers.set(type, new Set());
          handlers.get(type)!.add(fn);
          return () => handlers.get(type)!.delete(fn);
        },
        fire(type: string, ev: unknown) {
          for (const fn of handlers.get(type) ?? []) fn(ev);
        },
      };
      fake.clients.push(client);
      return client;
    },
  },
}));

const { useParleyCall } = await import('../parley/useParleyCall');

const JOIN = { baseUrl: 'http://parley.test', sessionId: 'ses_1', clientToken: 'ct', expiresAt: '', iceServers: [] };

function setup() {
  const opts = {
    join: JOIN,
    wantCamera: false,
    onSegments: vi.fn(),
    onAgentJoined: vi.fn(),
    onEnded: vi.fn(),
    onLost: vi.fn(),
    onEvent: vi.fn(),
  };
  const hook = renderHook(() => useParleyCall(opts));
  return { opts, hook };
}

async function connected() {
  await waitFor(() => expect(fake.clients.length).toBe(1));
  return fake.clients[0];
}

beforeEach(() => {
  fake.clients = [];
  fake.play = null;
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
});

describe('useParleyCall', () => {
  it('connects with the join block and the mic stream', async () => {
    setup();
    const client = await connected();
    expect(client.opts).toMatchObject({ sessionId: 'ses_1', token: 'ct', baseUrl: 'http://parley.test' });
    expect(client.opts.stream).toBeTruthy();
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('starts only when audio plays AND Parley is ready', async () => {
    const { opts } = setup();
    const client = await connected();
    await act(async () => { client.fire('state', { state: 'ready' }); });
    expect(client.start).not.toHaveBeenCalled(); // no audio track yet
    await act(async () => { client.fire('track', { stream: {} }); });
    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1));
    expect(opts.onEvent).toHaveBeenCalledWith('parley_start');
    // A second ready (reconnect) never re-sends start.
    await act(async () => { client.fire('state', { state: 'ready' }); });
    expect(client.start).toHaveBeenCalledTimes(1);
  });

  it('blocked autoplay shows the overlay; the unlock tap plays and starts', async () => {
    let allow = false;
    fake.play = () => (allow ? Promise.resolve() : Promise.reject(new Error('NotAllowedError')));
    const { hook } = setup();
    const client = await connected();
    await act(async () => {
      client.fire('state', { state: 'ready' });
      client.fire('track', { stream: {} });
    });
    await waitFor(() => expect(hook.result.current.audioBlocked).toBe(true));
    expect(client.start).not.toHaveBeenCalled();
    allow = true;
    await act(async () => { hook.result.current.unlockAudio(); });
    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1));
    expect(hook.result.current.audioBlocked).toBe(false);
  });

  it('maps engine states, reports the join once, forwards captions and the end', async () => {
    const { opts, hook } = setup();
    const client = await connected();
    await act(async () => { client.fire('state', { state: 'greeting' }); });
    expect(hook.result.current.agentState).toBe('speaking');
    await act(async () => { client.fire('state', { state: 'listening' }); });
    expect(hook.result.current.agentState).toBe('listening');
    expect(opts.onAgentJoined).toHaveBeenCalledTimes(1);

    await act(async () => {
      client.fire('agent.segment', { turnId: 'a1', index: 0, text: 'Hi.' });
      client.fire('user.final', { turnId: 'u1', text: 'Hello.' });
    });
    expect(opts.onSegments).toHaveBeenCalledWith([{ id: 'parley-them-a1', who: 'them', text: 'Hi.', final: false }]);
    expect(opts.onSegments).toHaveBeenCalledWith([expect.objectContaining({ who: 'you', text: 'Hello.', final: true })]);

    await act(async () => { client.fire('state', { state: 'reconnecting' }); });
    expect(hook.result.current.status).toBe('reconnecting');
    await act(async () => { client.fire('ended', { reason: 'time_up' }); });
    expect(opts.onEnded).toHaveBeenCalledWith('time_up');
    await act(async () => { client.fire('state', { state: 'failed' }); });
    expect(opts.onLost).toHaveBeenCalledTimes(1);
  });

  it('mutes through the client', async () => {
    const { hook } = setup();
    const client = await connected();
    await act(async () => { hook.result.current.toggleMic(); });
    expect(client.mute).toHaveBeenLastCalledWith(true);
    expect(hook.result.current.micOn).toBe(false);
    await act(async () => { hook.result.current.toggleMic(); });
    expect(client.mute).toHaveBeenLastCalledWith(false);
  });

  it('a denied mic reports the device state instead of connecting', async () => {
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw err; }) },
    });
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.micState).toBe('denied'));
    expect(fake.clients.length).toBe(0);
  });

  it('unmount disconnects (the Parley session survives for a rejoin) — never hangs up', async () => {
    const { hook } = setup();
    const client = await connected();
    hook.unmount();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
  });
});
