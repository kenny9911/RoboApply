// FND-6a — lib/ui/popupGate.ts, the single arbiter for unprompted popups
// (ARCHITECTURE.md §8.5; PRODUCT_PLAN.md F-NOTIF-06).
//
// Acceptance: one prompt per page view; a 24 h gap between non-essential
// popups. Plus: priority arbitration, essential popups, the server seed and
// the localStorage mirror.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import {
  POPUP_GAP_MS,
  POPUP_STORAGE_KEY,
  __setPopupGate,
  createPopupGate,
  getPopupGate,
  notePageView,
  usePopupGate,
  type PopupGateDeps,
} from '../../lib/ui/popupGate';

vi.mock('../../lib/api/uiState', () => ({
  getUiState: vi.fn(async () => ({ state: { popupLastShownAt: null }, lastFeedVisitAt: null, updatedAt: null })),
  recordPopupShown: vi.fn(async () => ({})),
}));

function harness(startMs = Date.parse('2026-10-10T09:00:00Z')) {
  let now = startMs;
  let local: number | null = null;
  const queue: (() => void)[] = [];
  const persist = vi.fn();
  const deps: PopupGateDeps = {
    now: () => now,
    loadLocal: () => local,
    saveLocal: (ms) => {
      local = ms;
    },
    persist,
    schedule: (fn) => {
      queue.push(fn);
    },
  };
  const gate = createPopupGate(deps);
  return {
    gate,
    persist,
    advance: (ms: number) => {
      now += ms;
    },
    /** Run the pending arbitration window. */
    flush: async () => {
      while (queue.length) queue.shift()!();
      await Promise.resolve();
    },
    get local() {
      return local;
    },
  };
}

describe('createPopupGate', () => {
  it('allows ONE popup per page view', async () => {
    const h = harness();
    h.gate.notePageView('/jobs');
    const a = h.gate.request('announcement:1', 'announcement');
    await h.flush();
    expect(await a).toBe(true);

    const b = h.gate.request('survey:1', 'survey');
    await h.flush();
    expect(await b).toBe(false);
    expect(h.gate.snapshot().shownThisView).toBe('announcement:1');
  });

  it('enforces the 24 h gap between non-essential popups, across page views', async () => {
    const h = harness();
    h.gate.notePageView('/jobs');
    const first = h.gate.request('announcement:1', 'announcement');
    await h.flush();
    expect(await first).toBe(true);
    expect(h.persist).toHaveBeenCalledTimes(1);

    h.gate.notePageView('/applications');
    h.advance(POPUP_GAP_MS - 60_000);
    const tooSoon = h.gate.request('offer:1', 'offer');
    await h.flush();
    expect(await tooSoon).toBe(false);

    h.gate.notePageView('/resume');
    h.advance(60_000);
    const later = h.gate.request('offer:1', 'offer');
    await h.flush();
    expect(await later).toBe(true);
    expect(h.persist).toHaveBeenCalledTimes(2);
  });

  it('decides simultaneous requests by priority: announcement < survey < extension prompt < offer', async () => {
    const h = harness();
    h.gate.notePageView('/jobs');
    const results = [
      h.gate.request('announcement:1', 'announcement'),
      h.gate.request('offer:1', 'offer'),
      h.gate.request('ext', 'extension_prompt'),
      h.gate.request('survey:1', 'survey'),
    ];
    await h.flush();
    expect(await Promise.all(results)).toEqual([false, true, false, false]);
  });

  it('an essential popup skips the gap, takes the view slot and does not restart the gap', async () => {
    const h = harness();
    h.gate.notePageView('/jobs');
    const shown = h.gate.request('announcement:1', 'announcement');
    await h.flush();
    expect(await shown).toBe(true);
    const lastShown = h.gate.snapshot().lastShownAt;

    h.gate.notePageView('/settings');
    h.advance(60_000);
    const notice = h.gate.request('legal:terms-v2', 'announcement', { essential: true });
    await h.flush();
    expect(await notice).toBe(true);
    expect(h.gate.snapshot().lastShownAt).toBe(lastShown);
    expect(h.persist).toHaveBeenCalledTimes(1);

    // The view's slot is spent, essential or not.
    const again = h.gate.request('offer:2', 'offer', { essential: true });
    await h.flush();
    expect(await again).toBe(false);
  });

  it('denies requests that were waiting when the page view changed', async () => {
    const h = harness();
    h.gate.notePageView('/jobs');
    const pending = h.gate.request('announcement:1', 'announcement');
    h.gate.notePageView('/resume');
    await h.flush();
    expect(await pending).toBe(false);
  });

  it('the same view key twice is one view (re-renders do not free the slot)', async () => {
    const h = harness();
    h.gate.notePageView('/jobs');
    const a = h.gate.request('a', 'announcement');
    await h.flush();
    expect(await a).toBe(true);
    h.gate.notePageView('/jobs');
    const b = h.gate.request('b', 'offer', { essential: true });
    await h.flush();
    expect(await b).toBe(false);
  });

  it('the server seed holds the gap on a fresh device; the later of server and local wins', async () => {
    const h = harness();
    h.gate.seedLastShownAt(new Date(Date.parse('2026-10-10T09:00:00Z') - 60 * 60 * 1000).toISOString());
    expect(h.local).not.toBeNull();
    h.gate.notePageView('/jobs');
    const r = h.gate.request('announcement:1', 'announcement');
    await h.flush();
    expect(await r).toBe(false);

    h.gate.seedLastShownAt('2020-01-01T00:00:00Z'); // older than what we have → ignored
    expect(h.gate.snapshot().lastShownAt).toBe(h.local);
    h.gate.seedLastShownAt('garbage');
    h.gate.seedLastShownAt(null);
    expect(h.gate.snapshot().lastShownAt).toBe(h.local);
  });
});

describe('the shared gate and usePopupGate', () => {
  beforeEach(() => {
    __setPopupGate(null);
    window.localStorage.clear();
  });
  afterEach(() => {
    __setPopupGate(null);
    window.localStorage.clear();
  });

  it('mirrors the last-shown time in localStorage and honours it on the next load', async () => {
    notePageView('/jobs');
    expect(await getPopupGate().request('announcement:1', 'announcement')).toBe(true);
    expect(Number(window.localStorage.getItem(POPUP_STORAGE_KEY))).toBeGreaterThan(0);

    __setPopupGate(null); // a new page load
    notePageView('/jobs');
    expect(await getPopupGate().request('offer:1', 'offer')).toBe(false);
  });

  it('usePopupGate grants one component and refuses the second in the same view', async () => {
    notePageView('/jobs');
    function Prompt({ id }: { id: string }) {
      const { granted } = usePopupGate(id, 'extension_prompt');
      return granted ? <p>{id} shown</p> : null;
    }
    render(
      <>
        <Prompt id="first" />
        <Prompt id="second" />
      </>,
    );
    await waitFor(() => expect(screen.getByText('first shown')).toBeInTheDocument());
    expect(screen.queryByText('second shown')).not.toBeInTheDocument();
  });

  it('usePopupGate does not ask while disabled', async () => {
    notePageView('/jobs');
    function Prompt() {
      const { granted } = usePopupGate('x', 'offer', { enabled: false });
      return <p>{granted ? 'shown' : 'hidden'}</p>;
    }
    render(<Prompt />);
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.getByText('hidden')).toBeInTheDocument();
    expect(getPopupGate().snapshot().shownThisView).toBeNull();
  });
});
