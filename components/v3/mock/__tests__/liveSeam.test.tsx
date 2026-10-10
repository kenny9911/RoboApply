// WP-63a: the live room's per-brand pieces — the camera plan (GoApply keeps
// the camera a local preview), the local preview hook, the connection check
// (RTT / jitter → "practice in writing instead") and the device check's
// local-only note.
// Run: npx vitest run components/v3/mock/__tests__/liveSeam.test.tsx

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

// `has` mirrors next-intl's translator: the requested live-room keys are not
// in the practice namespace yet (intl.has = false) or have landed (true).
const intl = vi.hoisted(() => ({ has: true }));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((key: string) => key, { has: () => intl.has }),
}));

import { cameraPlan } from '../liveConnection';
import { useLocalCameraPreview } from '../YourTile';
import { DeviceCheck } from '../DeviceCheck';
import { NetworkPrecheck, assessNetwork, measureNetwork, NETWORK_THRESHOLDS } from '../../../features/practice/NetworkPrecheck';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  intl.has = true;
});

function fakeMedia() {
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const getUserMedia = vi.fn(async () => {
    const stop = vi.fn();
    stops.push(stop);
    return { getTracks: () => [{ stop }] } as unknown as MediaStream;
  });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  return { getUserMedia, stops };
}

describe('cameraPlan', () => {
  const LOCAL_ON = { publish: false, localPreview: true, previewStartsOn: true };
  it('GoApply video: local preview only, never published', () => {
    expect(cameraPlan({ mode: 'video', market: 'cn', deviceOk: true })).toEqual(LOCAL_ON);
    expect(cameraPlan({ mode: 'video', market: 'cn', cameraPublish: true, deviceOk: true })).toEqual(LOCAL_ON);
  });
  it('GoApply: a camera that failed the check stays local-only, starting off', () => {
    expect(cameraPlan({ mode: 'video', market: 'cn', deviceOk: false })).toEqual({ publish: false, localPreview: true, previewStartsOn: false });
    expect(cameraPlan({ mode: 'video', market: 'intl', cameraPublish: false, deviceOk: false })).toEqual({ publish: false, localPreview: true, previewStartsOn: false });
  });
  it('follows the server when it says the camera stays local', () => {
    expect(cameraPlan({ mode: 'video', market: 'intl', cameraPublish: false, deviceOk: true })).toEqual(LOCAL_ON);
  });
  it('RoboApply video publishes as in Wave 0 (also against an older API)', () => {
    const PUBLISH = { publish: true, localPreview: false, previewStartsOn: false };
    expect(cameraPlan({ mode: 'video', market: 'intl', cameraPublish: true, deviceOk: true })).toEqual(PUBLISH);
    expect(cameraPlan({ mode: 'video', market: 'intl', deviceOk: true })).toEqual(PUBLISH);
    expect(cameraPlan({ mode: 'video', market: 'intl', deviceOk: false })).toEqual({ publish: false, localPreview: false, previewStartsOn: false });
  });
  it('voice mode uses no camera at all', () => {
    const NONE = { publish: false, localPreview: false, previewStartsOn: false };
    expect(cameraPlan({ mode: 'voice', market: 'intl', deviceOk: true })).toEqual(NONE);
    expect(cameraPlan({ mode: 'voice', market: 'cn', deviceOk: true })).toEqual(NONE);
  });
});

describe('useLocalCameraPreview', () => {
  it('opens a local stream, stops it on toggle and on unmount', async () => {
    const { getUserMedia, stops } = fakeMedia();
    const { result, unmount } = renderHook(() => useLocalCameraPreview(true));
    await waitFor(() => expect(result.current.on).toBe(true));
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false, video: expect.anything() }));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.on).toBe(false));
    expect(stops[0]).toHaveBeenCalled();
    expect(result.current.state).toBe('off');
    act(() => result.current.start());
    await waitFor(() => expect(result.current.on).toBe(true));
    unmount();
    expect(stops[1]).toHaveBeenCalled();
  });

  it('reports a blocked camera without throwing', async () => {
    const err = Object.assign(new Error('no'), { name: 'NotAllowedError' });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => { throw err; }) } });
    const { result } = renderHook(() => useLocalCameraPreview(true));
    await waitFor(() => expect(result.current.state).toBe('denied'));
    expect(result.current.on).toBe(false);
  });

  it('stays off until asked', () => {
    const { getUserMedia } = fakeMedia();
    const { result } = renderHook(() => useLocalCameraPreview(false));
    expect(result.current.state).toBe('off');
    expect(result.current.tried).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('starting off, keeps the device-check reason until asked again', async () => {
    const { getUserMedia } = fakeMedia();
    const { result } = renderHook(() => useLocalCameraPreview(false, 'denied'));
    expect(result.current.state).toBe('denied');
    expect(getUserMedia).not.toHaveBeenCalled();
    act(() => result.current.start());
    await waitFor(() => expect(result.current.on).toBe(true));
    expect(result.current.tried).toBe(true);
  });
});

describe('assessNetwork', () => {
  const t = NETWORK_THRESHOLDS;
  it('rates steady, quick round trips as good', () => {
    expect(assessNetwork([80, 90, 85, 95, 88])).toMatchObject({ level: 'good', rttMs: 88, failures: 0 });
  });
  it('rates slow or jittery round trips as fair', () => {
    expect(assessNetwork([t.fairRttMs + 50, t.fairRttMs + 60, t.fairRttMs + 40]).level).toBe('fair');
    expect(assessNetwork([50, 50 + t.fairJitterMs + 20, 50, 50 + t.fairJitterMs + 20]).level).toBe('fair');
    expect(assessNetwork([80, null, 85, 90, 82]).level).toBe('fair');
  });
  it('rates very slow, very jittery or failing round trips as poor', () => {
    expect(assessNetwork([t.poorRttMs + 100, t.poorRttMs + 200, t.poorRttMs]).level).toBe('poor');
    expect(assessNetwork([60, 60 + t.poorJitterMs + 50, 60, 60 + t.poorJitterMs + 50]).level).toBe('poor');
    expect(assessNetwork([80, null, null, 90]).level).toBe('poor');
    expect(assessNetwork([null, null, null])).toMatchObject({ level: 'poor', rttMs: null, jitterMs: null, failures: 3 });
  });
  it('lets the browser estimate make the rating worse, never better', () => {
    expect(assessNetwork([80, 85], { effectiveType: '2g' }).level).toBe('poor');
    expect(assessNetwork([80, 85], { effectiveType: '3g' }).level).toBe('fair');
    expect(assessNetwork([80, 85], { rtt: 1500 }).level).toBe('poor');
    expect(assessNetwork([t.poorRttMs + 10], { effectiveType: '4g' }).level).toBe('poor');
  });
  it('measures probes one after another', async () => {
    const probe = vi.fn(async () => undefined);
    const r = await measureNetwork(probe, 3);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(r?.level).toBe('good');
    expect(await measureNetwork(probe, 3, () => false)).toBeNull();
  });
});

describe('NetworkPrecheck', () => {
  const inList = (ui: React.ReactElement) => render(<ul>{ui}</ul>);

  it('says the connection is good and offers nothing else', async () => {
    inList(<NetworkPrecheck probe={async () => undefined} probes={2} onSwitchToText={vi.fn()} />);
    expect(screen.getByText('live.network.checking')).toBeTruthy();
    await screen.findByText('live.network.good');
    expect(screen.queryByText('live.network.switchToText')).toBeNull();
  });

  it('on a weak connection offers the written practice and a re-check', async () => {
    const onSwitch = vi.fn();
    const onResult = vi.fn();
    let fail = true;
    const probe = vi.fn(async () => { if (fail) throw new TypeError('Failed to fetch'); });
    inList(<NetworkPrecheck probe={probe} probes={2} onSwitchToText={onSwitch} onResult={onResult} />);
    await screen.findByText('live.network.poor');
    expect(screen.getByRole('alert').textContent).toBe('live.network.poorBody');
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ level: 'poor', failures: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'live.network.switchToText' }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'live.network.retry' }));
    await screen.findByText('live.network.good');
  });

  it('without a text fallback, only offers the re-check', async () => {
    inList(<NetworkPrecheck probe={async () => { throw new Error('x'); }} probes={2} />);
    await screen.findByText('live.network.poor');
    expect(screen.queryByRole('button', { name: 'live.network.switchToText' })).toBeNull();
    expect(screen.getByRole('button', { name: 'live.network.retry' })).toBeTruthy();
  });

  it('before its own copy lands, uses existing practice copy and never a missing key path', async () => {
    intl.has = false;
    let fail = true;
    const probe = vi.fn(async () => { if (fail) throw new TypeError('Failed to fetch'); });
    const { container } = inList(<NetworkPrecheck probe={probe} probes={2} onSwitchToText={vi.fn()} />);
    expect(screen.getByText('live.device.state.checking')).toBeTruthy();
    await screen.findByText('live.quality.poor');
    expect(screen.getByRole('button', { name: 'gate.startText' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.textContent).not.toMatch(/live\.network\./);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'live.device.retry' }));
    await screen.findByText('live.quality.good');
  });
});

describe('DeviceCheck per brand', () => {
  it('GoApply video: says the camera is shown to the candidate only', () => {
    fakeMedia();
    render(<DeviceCheck mode="video" cameraLocalOnly onJoin={() => undefined} onBack={() => undefined} />);
    expect(screen.getByText('live.cam.localOnly')).toBeTruthy();
  });

  it('GoApply video before the note’s copy lands: shows nothing rather than the key path', () => {
    intl.has = false;
    fakeMedia();
    const { container } = render(<DeviceCheck mode="video" cameraLocalOnly onJoin={() => undefined} onBack={() => undefined} />);
    expect(container.textContent).not.toMatch(/live\.cam\./);
  });

  it('RoboApply (and voice mode) carry no such note; no connection row without a probe', () => {
    fakeMedia();
    const { unmount } = render(<DeviceCheck mode="video" onJoin={() => undefined} onBack={() => undefined} />);
    expect(screen.queryByText('live.cam.localOnly')).toBeNull();
    expect(screen.queryByText('live.network.label')).toBeNull();
    unmount();
    render(<DeviceCheck mode="voice" cameraLocalOnly onJoin={() => undefined} onBack={() => undefined} />);
    expect(screen.queryByText('live.cam.localOnly')).toBeNull();
  });

  it('adds the connection row with a probe, and Join stays available on a weak connection', async () => {
    fakeMedia();
    const onSwitch = vi.fn();
    render(
      <DeviceCheck
        mode="voice"
        onJoin={() => undefined}
        onBack={() => undefined}
        networkProbe={async () => { throw new TypeError('Failed to fetch'); }}
        onSwitchToText={onSwitch}
      />,
    );
    await screen.findByText('live.network.poor', undefined, { timeout: 3000 });
    const join = screen.getByRole('button', { name: 'live.device.join' }) as HTMLButtonElement;
    await waitFor(() => expect(join.disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'live.network.switchToText' }));
    expect(onSwitch).toHaveBeenCalled();
  });
});
