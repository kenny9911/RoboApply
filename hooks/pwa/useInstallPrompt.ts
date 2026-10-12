'use client';

// hooks/pwa/useInstallPrompt.ts — the PWA install prompt's state (F-MOB-03; WP-61).
//
//   const { eligible, platform, install, markShown } = useInstallPrompt({ enabled });
//
// Captures `beforeinstallprompt` (Chromium) so the browser's own mini-infobar
// stays quiet and we can offer it once, at a calm moment; counts sessions;
// reads the account-level "already shown" from ui-state. Nothing here shows
// UI or asks the popup gate: components/features/pwa/InstallPrompt.tsx does.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { dismiss, getUiState } from '../../lib/api/uiState';
import { UI_STATE_QUERY_KEY } from '../../lib/ui/popupGate';
import {
  PWA_INSTALL_DISMISSAL,
  countSession,
  installPlatform,
  installPromptEligible,
  markShownOnDevice,
  shownOnDevice,
  type InstallPlatform,
  type KeyValueStore,
} from './installPrompt';

/** The non-standard Chromium event (not in lib.dom). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
}

function storage(kind: 'localStorage' | 'sessionStorage'): KeyValueStore | null {
  try {
    return typeof window === 'undefined' ? null : window[kind];
  } catch {
    return null;
  }
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  let media = false;
  try {
    media = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    media = false;
  }
  return media || nav.standalone === true;
}

export interface InstallPromptState {
  eligible: boolean;
  platform: InstallPlatform;
  /** Show the browser's install dialog (Chromium). Resolves with the person's answer. */
  install(): Promise<'accepted' | 'dismissed' | 'unavailable'>;
  /** Record that the prompt was shown (device + account), so it never shows again. */
  markShown(): void;
}

export function useInstallPrompt({ enabled = true }: { enabled?: boolean } = {}): InstallPromptState {
  const client = useQueryClient();
  const deferred = useRef<BeforeInstallPromptEvent | null>(null);
  const [promptAvailable, setPromptAvailable] = useState(false);
  const [sessions, setSessions] = useState(0);
  const [env, setEnv] = useState<{ userAgent: string; standalone: boolean } | null>(null);
  const [shownLocal, setShownLocal] = useState(true);

  useEffect(() => {
    setSessions(countSession(storage('localStorage'), storage('sessionStorage')));
    setShownLocal(shownOnDevice(storage('localStorage')));
    setEnv({ userAgent: window.navigator.userAgent ?? '', standalone: isStandalone() });
    const onPrompt = (e: Event) => {
      e.preventDefault();
      deferred.current = e as BeforeInstallPromptEvent;
      setPromptAvailable(true);
    };
    const onInstalled = () => {
      deferred.current = null;
      setPromptAvailable(false);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const uiState = useQuery({
    queryKey: UI_STATE_QUERY_KEY,
    queryFn: ({ signal }) => getUiState({ signal }),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const shownOnAccount = uiState.data ? Boolean(uiState.data.state.dismissals[PWA_INSTALL_DISMISSAL]) : null;

  const platform = env ? installPlatform({ ...env, promptAvailable }) : null;
  const eligible = enabled && installPromptEligible({ sessions, platform, shownOnDevice: shownLocal, shownOnAccount });

  const install = useCallback(async () => {
    const ev = deferred.current;
    if (!ev) return 'unavailable' as const;
    deferred.current = null;
    setPromptAvailable(false);
    try {
      await ev.prompt();
      const choice = await ev.userChoice;
      return choice.outcome;
    } catch {
      return 'unavailable' as const;
    }
  }, []);

  const markShown = useCallback(() => {
    markShownOnDevice(storage('localStorage'));
    setShownLocal(true);
    void dismiss([PWA_INSTALL_DISMISSAL])
      .then((next) => client.setQueryData(UI_STATE_QUERY_KEY, next))
      .catch(() => undefined);
  }, [client]);

  return { eligible, platform, install, markShown };
}
