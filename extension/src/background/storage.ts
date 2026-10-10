// extension/src/background/storage.ts — the device token, in chrome.storage.local.
//
// Who can read it: chrome.storage.local is open to the extension's own
// content scripts by default (never to the employer page, which runs in a
// different world). The service worker restricts the area to trusted contexts
// (service worker + extension pages) at startup with setAccessLevel; on a
// browser that refuses that, our content script could read the token, but it
// never does: every read and write is here, in the service worker, and the
// content script reaches the API only through runtime messages.

export interface AuthState {
  token: string;
  apiOrigin: string;
  pairedAt: string;
}

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export const AUTH_KEY = 'ra.auth';
export const RECONNECT_KEY = 'ra.needsReconnect';

/** The part of chrome.storage.StorageArea used to restrict access. */
export interface AccessLevelArea {
  setAccessLevel?: (opts: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }) => Promise<void>;
}

/**
 * Keep content scripts out of the token's storage area. Returns whether the
 * browser accepted it (false: unsupported or refused — see the note above).
 */
export async function restrictToTrustedContexts(area: AccessLevelArea | undefined): Promise<boolean> {
  if (!area?.setAccessLevel) return false;
  try {
    await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    return true;
  } catch {
    return false;
  }
}

export function chromeLocalStore(): KeyValueStore {
  return {
    async get(key) {
      const out = await chrome.storage.local.get(key);
      return out[key];
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage.local.remove(key);
    },
  };
}

export function memoryStore(initial: Record<string, unknown> = {}): KeyValueStore & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return data[key];
    },
    async set(key, value) {
      data[key] = value;
    },
    async remove(key) {
      delete data[key];
    },
  };
}

function isAuth(v: unknown): v is AuthState {
  return !!v && typeof v === 'object' && typeof (v as AuthState).token === 'string' && typeof (v as AuthState).apiOrigin === 'string';
}

export async function readAuth(store: KeyValueStore): Promise<AuthState | null> {
  const v = await store.get(AUTH_KEY);
  return isAuth(v) ? v : null;
}

export async function writeAuth(store: KeyValueStore, auth: AuthState): Promise<void> {
  await store.set(AUTH_KEY, auth);
  await store.remove(RECONNECT_KEY);
}

export async function clearAuth(store: KeyValueStore, opts: { needsReconnect: boolean }): Promise<void> {
  await store.remove(AUTH_KEY);
  if (opts.needsReconnect) await store.set(RECONNECT_KEY, true);
  else await store.remove(RECONNECT_KEY);
}

export async function needsReconnect(store: KeyValueStore): Promise<boolean> {
  return (await store.get(RECONNECT_KEY)) === true;
}
