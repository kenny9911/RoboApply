// Pure helpers for the pre-join device check and the in-room device state of
// the live interview (app/(auth)/practice/[id]/page.tsx).
//
// No livekit import here on purpose: the classification works on any thrown
// getUserMedia / LiveKit MediaDeviceFailure error, and stays unit-testable.

/** Where one device (mic or camera) stands.
 *  - idle      not asked yet
 *  - checking  the browser prompt / device open is in flight
 *  - ok        the device delivered a stream
 *  - denied    the user or the browser blocked access
 *  - notFound  there is no such device
 *  - inUse     another app holds the device (Zoom, Teams, OBS…)
 *  - insecure  the page is not on https, so the browser hides devices
 *  - off       the candidate chose to go without it (camera only)
 *  - error     anything else */
export type DeviceState =
  | 'idle'
  | 'checking'
  | 'ok'
  | 'denied'
  | 'notFound'
  | 'inUse'
  | 'insecure'
  | 'off'
  | 'error';

/** The states that mean "this device cannot be used right now". */
export const DEVICE_FAILURES: ReadonlySet<DeviceState> = new Set<DeviceState>([
  'denied',
  'notFound',
  'inUse',
  'insecure',
  'error',
]);

export function isDeviceFailure(state: DeviceState): boolean {
  return DEVICE_FAILURES.has(state);
}

/** True when the browser will refuse camera/mic for this page outright
 *  (plain http on anything but localhost, or no mediaDevices at all). */
export function mediaUnavailableReason(): DeviceState | null {
  if (typeof window === 'undefined') return null;
  if (window.isSecureContext === false) return 'insecure';
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'insecure';
  }
  return null;
}

/** Map a getUserMedia / LiveKit publish error onto a DeviceState.
 *  LiveKit's MediaDeviceFailure reads the same DOMException names, and its own
 *  string values ('PermissionDenied', 'NotFound', 'DeviceInUse') are handled
 *  too, so either can be passed in. */
export function classifyMediaError(err: unknown): DeviceState {
  const name =
    typeof err === 'string'
      ? err
      : err && typeof err === 'object' && 'name' in err
        ? String((err as { name?: unknown }).name ?? '')
        : '';
  const message =
    err && typeof err === 'object' && 'message' in err
      ? String((err as { message?: unknown }).message ?? '')
      : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'PermissionDenied':
      return 'denied';
    case 'SecurityError':
      return mediaUnavailableReason() === 'insecure' ? 'insecure' : 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
    case 'NotFound':
      return 'notFound';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
    case 'DeviceInUse':
      return 'inUse';
    default:
      break;
  }
  if (/permission|not allowed|denied/i.test(message)) return 'denied';
  if (/in use|could not start|not readable/i.test(message)) return 'inUse';
  if (/not found|no device|requested device/i.test(message)) return 'notFound';
  return 'error';
}

/** Root-mean-square level of a time-domain analyser frame, scaled to 0..1 so
 *  ordinary speech fills most of the meter. */
export function levelFromSamples(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.max(0, Math.min(1, rms * 4));
}
