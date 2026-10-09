// DeviceCheck — a getUserMedia that resolves after it was superseded (overlapping
// opens, StrictMode's mount→cleanup→mount, unmount, Join) must stop its own
// stream instead of leaking it (the camera/mic light would stay on).

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Plain key passthrough: keeps the tree synchronous so StrictMode's
// mount → cleanup → mount effect replay actually runs.
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import { DeviceCheck } from '../DeviceCheck';

interface FakeStream {
  stop: ReturnType<typeof vi.fn>;
  stream: MediaStream;
}

function fakeStream(): FakeStream {
  const stop = vi.fn();
  return { stop, stream: { getTracks: () => [{ stop }] } as unknown as MediaStream };
}

/** getUserMedia whose answers are resolved by the test, in any order. */
function deferredMedia() {
  const pending: Array<{ kind: 'mic' | 'camera'; resolve: (s: MediaStream) => void }> = [];
  const getUserMedia = vi.fn(
    (c: MediaStreamConstraints) =>
      new Promise<MediaStream>((resolve) => {
        pending.push({ kind: c.audio ? 'mic' : 'camera', resolve });
      }),
  );
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  return { getUserMedia, pending };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DeviceCheck stream ownership', () => {
  it('stops streams from opens superseded by the StrictMode remount', async () => {
    const { pending } = deferredMedia();
    render(
      <StrictMode>
        <DeviceCheck mode="video" onJoin={() => undefined} onBack={() => undefined} />
      </StrictMode>,
    );

    // mount → cleanup → mount: two rounds of mic + camera requests.
    expect(pending.map((p) => p.kind)).toEqual(['mic', 'camera', 'mic', 'camera']);
    const streams = pending.map(() => fakeStream());

    // The first-round (stale) answers arrive LAST — the worst ordering.
    await act(async () => {
      pending[2].resolve(streams[2].stream);
      pending[3].resolve(streams[3].stream);
    });
    await act(async () => {
      pending[0].resolve(streams[0].stream);
      pending[1].resolve(streams[1].stream);
    });

    expect(streams[0].stop).toHaveBeenCalled();
    expect(streams[1].stop).toHaveBeenCalled();
    expect(streams[2].stop).not.toHaveBeenCalled();
    expect(streams[3].stop).not.toHaveBeenCalled();
  });

  it('stops a stream that resolves after unmount', async () => {
    const { pending } = deferredMedia();
    const { unmount } = render(
      <DeviceCheck mode="voice" onJoin={() => undefined} onBack={() => undefined} />,
    );
    expect(pending).toHaveLength(1);
    unmount();
    const late = fakeStream();
    await act(async () => { pending[0].resolve(late.stream); });
    expect(late.stop).toHaveBeenCalled();
  });

  it('releases every stream on Join', async () => {
    const { pending } = deferredMedia();
    const onJoin = vi.fn();
    render(<DeviceCheck mode="video" onJoin={onJoin} onBack={() => undefined} />);
    const mic = fakeStream();
    const cam = fakeStream();
    await act(async () => {
      pending[0].resolve(mic.stream);
      pending[1].resolve(cam.stream);
    });

    const buttons = screen.getAllByRole('button').filter((b) => !(b as HTMLButtonElement).disabled);
    fireEvent.click(buttons[buttons.length - 1]);

    expect(onJoin).toHaveBeenCalledWith({ mic: 'ok', camera: 'ok' });
    expect(mic.stop).toHaveBeenCalled();
    expect(cam.stop).toHaveBeenCalled();
  });
});
