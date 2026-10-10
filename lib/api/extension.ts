// lib/api/extension.ts — Extension, web side: devices, pairing, uninstall survey.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-55a.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Device-token routes (`/ext/me`, autofill profile, page-job, save, autofill
// runs, answers, resume-for-job, files, site requests, pair-code redeem) are
// called by the extension package's own client (WP-55b) with its `rax_` token,
// never from the web app, so they are not wrapped here.
//
// Endpoints:
//   POST   /api/v1/roboapply/ext/devices
//   GET    /api/v1/roboapply/ext/devices
//   DELETE /api/v1/roboapply/ext/devices/:id
//   GET    /api/v1/roboapply/ext/status
//   POST   /api/v1/roboapply/ext/pair-codes
//   POST   /api/v1/public/ext/uninstall-survey

import { apiUrl, call, type CallOptions, type In, type Items, seg } from './contracts/wire';
import type * as E from './contracts/extension';

/** `ext.createDevice` — POST /api/v1/roboapply/ext/devices */
export function createDevice(body: In<typeof E.CreateDeviceBodySchema>, opts?: CallOptions): Promise<E.CreateDeviceResponse> {
  return call<E.CreateDeviceResponse>('POST', `/api/v1/roboapply/ext/devices`, { ...opts, body });
}

/** `ext.listDevices` — GET /api/v1/roboapply/ext/devices */
export function listDevices(opts?: CallOptions): Promise<Items<E.DeviceView>> {
  return call<Items<E.DeviceView>>('GET', `/api/v1/roboapply/ext/devices`, opts);
}

/** `ext.revokeDevice` — DELETE /api/v1/roboapply/ext/devices/:id */
export function revokeDevice(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/ext/devices/${seg(id)}`, opts);
}

/** `ext.status` — GET /api/v1/roboapply/ext/status */
export function getStatus(opts?: CallOptions): Promise<E.ExtStatusResponse> {
  return call<E.ExtStatusResponse>('GET', `/api/v1/roboapply/ext/status`, opts);
}

/** `ext.createPairCode` — POST /api/v1/roboapply/ext/pair-codes */
export function createPairCode(opts?: CallOptions): Promise<E.PairCodeResponse> {
  return call<E.PairCodeResponse>('POST', `/api/v1/roboapply/ext/pair-codes`, opts);
}

/** `ext.uninstallSurvey` — POST /api/v1/public/ext/uninstall-survey */
export function submitUninstallSurvey(body: In<typeof E.UninstallSurveyBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/public/ext/uninstall-survey`, { ...opts, body });
}

/**
 * The API origin the extension should call after pairing: the configured API
 * base in development, the page's own origin in production (same-origin /api).
 */
export function extensionApiOrigin(): string {
  const base = apiUrl('');
  if (/^https?:\/\//.test(base)) return base.replace(/\/$/, '');
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/** Every wrapper of this area, for callers that prefer one import. */
export const extensionApi = {
  createDevice,
  listDevices,
  revokeDevice,
  getStatus,
  createPairCode,
  submitUninstallSurvey,
};
