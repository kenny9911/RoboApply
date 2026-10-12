// @vitest-environment node
//
// WP-61: public/sw.js notification clicks. The worker runs in a vm sandbox
// with a fake `self`; nothing touches a browser or the network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');
const ORIGIN = 'https://roboapply.test';

interface FakeClient {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

function client(url: string, opts: { focusFails?: boolean } = {}): FakeClient {
  const c: FakeClient = {
    url,
    focus: vi.fn(async () => {
      if (opts.focusFails) throw new Error('not allowed');
      return c;
    }),
    // Rejects like WindowClient.navigate() on a tab this worker does not control.
    navigate: vi.fn(async () => {
      throw new TypeError('not controlled');
    }),
  };
  return c;
}

function loadWorker(windows: FakeClient[]) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const openWindow = vi.fn(async () => null);
  const self = {
    location: { origin: ORIGIN },
    registration: { scope: `${ORIGIN}/`, showNotification: vi.fn(async () => undefined) },
    clients: { matchAll: vi.fn(async () => windows), openWindow, claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
  };
  vm.runInNewContext(SOURCE, { self, URL, Promise, console });
  async function click(href: string) {
    let done: Promise<unknown> = Promise.resolve();
    const notification = { close: vi.fn(), data: { href } };
    listeners.notificationclick!({ notification, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    return notification;
  }
  return { click, openWindow };
}

describe('public/sw.js notificationclick', () => {
  it('focuses a tab already on the alert’s page and never navigates any tab', async () => {
    const other = client(`${ORIGIN}/resume/r1/edit`);
    const same = client(`${ORIGIN}/jobs?src=alert`);
    const w = loadWorker([other, same]);
    const n = await w.click('/jobs?src=alert');
    expect(n.close).toHaveBeenCalled();
    expect(same.focus).toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();
    expect(other.navigate).not.toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('opens a new window instead of taking over another app tab (unsaved work stays put)', async () => {
    const editor = client(`${ORIGIN}/resume/r1/edit`);
    const w = loadWorker([editor]);
    await w.click('/jobs?src=alert');
    expect(editor.focus).not.toHaveBeenCalled();
    expect(editor.navigate).not.toHaveBeenCalled();
    expect(w.openWindow).toHaveBeenCalledWith(`${ORIGIN}/jobs?src=alert`);
  });

  it('falls back to opening the link when focusing fails, and keeps clicks same-site', async () => {
    const same = client(`${ORIGIN}/inbox`, { focusFails: true });
    const w = loadWorker([same]);
    await w.click('/inbox');
    expect(w.openWindow).toHaveBeenCalledWith(`${ORIGIN}/inbox`);

    const w2 = loadWorker([]);
    await w2.click('https://evil.example/phish');
    expect(w2.openWindow).toHaveBeenCalledWith(`${ORIGIN}/inbox`);
  });
});
