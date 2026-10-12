'use client';

// hooks/extension/useExtension.ts — the extension's web side (WP-55a):
// detection of the installed extension, the devices query, pairing, revoking
// and the uninstall survey. API calls go through lib/api/extension.ts.

import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { createDevice, createPairCode, extensionApiOrigin, getStatus, revokeDevice, submitUninstallSurvey } from '../../lib/api/extension';
import { apiErrorCode, type In } from '../../lib/api/contracts/wire';
import type * as E from '../../lib/api/contracts/extension';
import { useBrandId } from '../../lib/brand/BrandProvider';
import { browserSupport, extensionIdFor, extensionStoreUrl, pingExtension, sendPairToken } from './bridge';

export const EXT_STATUS_QUERY_KEY = ['extension', 'status'] as const;

/**
 * Where the extension stands in this browser:
 *   unavailable  the brand has no published extension (nothing is advertised)
 *   mobile       a phone or tablet browser (extensions do not run there)
 *   unsupported  a desktop browser that is not Chromium-based
 *   checking     asking the extension
 *   absent       Chromium, but the extension did not answer
 *   present      installed; `version` and `paired` come from its answer
 */
export type ExtensionPresenceState = 'unavailable' | 'mobile' | 'unsupported' | 'checking' | 'absent' | 'present';

export interface ExtensionPresence {
  state: ExtensionPresenceState;
  version: string | null;
  paired: boolean;
  extensionId: string | null;
  storeUrl: string | null;
  recheck: () => void;
}

export function useExtensionPresence(options: { enabled?: boolean } = {}): ExtensionPresence {
  const brand = useBrandId();
  const enabled = options.enabled ?? true;
  const extensionId = extensionIdFor(brand);
  const storeUrl = extensionStoreUrl(brand);
  const [round, setRound] = useState(0);
  const [result, setResult] = useState<{ state: ExtensionPresenceState; version: string | null; paired: boolean }>({ state: 'checking', version: null, paired: false });

  useEffect(() => {
    if (!enabled) return;
    if (!extensionId) {
      setResult({ state: 'unavailable', version: null, paired: false });
      return;
    }
    const support = browserSupport();
    if (support !== 'chromium') {
      setResult({ state: support === 'mobile' ? 'mobile' : 'unsupported', version: null, paired: false });
      return;
    }
    let live = true;
    setResult((r) => ({ ...r, state: 'checking' }));
    void pingExtension(extensionId, brand).then((reply) => {
      if (!live) return;
      setResult(reply ? { state: 'present', version: reply.version, paired: reply.connected } : { state: 'absent', version: null, paired: false });
    });
    return () => {
      live = false;
    };
  }, [enabled, extensionId, brand, round]);

  const recheck = useCallback(() => setRound((n) => n + 1), []);
  return { ...result, extensionId, storeUrl, recheck };
}

/** Errors no retry can fix. */
const FINAL = new Set(['unauthorized', 'auth_expired', 'AUTH_REQUIRED', 'INVALID_TOKEN', 'feature_disabled', 'not_implemented', 'auth_other_brand']);

export function useExtStatus(options: { enabled?: boolean } = {}): UseQueryResult<E.ExtStatusResponse> {
  return useQuery<E.ExtStatusResponse>({
    queryKey: EXT_STATUS_QUERY_KEY,
    queryFn: ({ signal }) => getStatus({ signal }),
    staleTime: 60_000,
    retry: (count, err) => !FINAL.has(apiErrorCode(err) ?? '') && count < 1,
    enabled: options.enabled ?? true,
  });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeDevice(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: EXT_STATUS_QUERY_KEY }),
  });
}

/** A short name for this browser ("Chrome on Mac"), from the user agent only. */
export function deviceNameFromAgent(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): { name: string; browser: string } {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : 'Browser';
  const os = /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : null;
  return { name: os ? `${browser} on ${os}` : browser, browser: browser.toLowerCase() };
}

/**
 * "Connect this browser": a device token from the API goes straight to the
 * extension. When the extension cannot be messaged, the caller shows a code
 * (usePairCode) for the extension's "Enter code" screen instead.
 */
export function usePairBrowser(extensionId: string | null, extVersion: string | null) {
  const qc = useQueryClient();
  return useMutation<'paired' | 'needs_code'>({
    mutationFn: async () => {
      if (!extensionId) return 'needs_code';
      const info = deviceNameFromAgent();
      const { deviceId, token } = await createDevice({ name: info.name, browser: info.browser, ...(extVersion ? { extVersion } : {}) });
      if (await sendPairToken(extensionId, token, extensionApiOrigin())) return 'paired';
      // The token never reached the extension: drop the unused device.
      await revokeDevice(deviceId).catch(() => undefined);
      return 'needs_code';
    },
    onSettled: () => qc.invalidateQueries({ queryKey: EXT_STATUS_QUERY_KEY }),
  });
}

export function usePairCode() {
  return useMutation<E.PairCodeResponse>({ mutationFn: () => createPairCode() });
}

export function useUninstallSurvey() {
  return useMutation({ mutationFn: (body: In<typeof E.UninstallSurveyBodySchema>) => submitUninstallSurvey(body) });
}
