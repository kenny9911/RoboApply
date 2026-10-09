// server/src/features/auth/devices.ts
//
// New-device sign-in email (F-TRUST-01). A "device" is the browser family ×
// operating system family of the sign-in, read from the User-Agent. Version
// numbers are ignored so a browser update does not look like a new device,
// and no cookie or fingerprint is stored on the client. The mark is a
// `RAAuthToken(kind 'known_device')` row whose hash binds user + device;
// it expires 180 days after the last sign-in from that device.
//
// The first device an account ever signs in from (or the first one seen after
// this shipped) is recorded silently: only a later, different device emails.

export interface DeviceInfo {
  browser: string;
  os: string;
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/MicroMessenger\//, 'WeChat'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/Windows NT/, 'Windows'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/** Coarse browser and OS family; "Unknown" when the header is missing or unrecognised. */
export function parseDevice(userAgent: string | null | undefined): DeviceInfo {
  const ua = userAgent ?? '';
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? 'Unknown';
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? 'Unknown';
  return { browser, os };
}

/** The raw value whose hash is the known-device mark for this user. */
export function deviceMarkRaw(userId: string, device: DeviceInfo): string {
  return `known_device:${userId}:${device.browser}:${device.os}`;
}
