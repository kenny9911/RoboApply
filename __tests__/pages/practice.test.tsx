// __tests__/pages/practice.test.tsx
//
// /practice — the one-screen interview brief.
//
// Two things are pinned here. First, the recent-practice lane: it is the only
// part of this screen that renders SERVER data, and it used to leak three
// English strings into every locale (the catalog's raw English type label, a
// hardcoded 'Interviewer' fallback for a persona the catalog no longer carries,
// and a hand-rolled "2d ago" builder).
//
// Second, the shape of the screen itself. The four-step wizard this replaced
// walked the candidate through three pre-filled steps before Start became
// reachable; the promise of the redesign is that choosing a job is the ONLY
// required act, so that is asserted directly rather than described.

import type { ReactNode } from 'react';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AbstractIntlMessages } from 'next-intl';

import PracticePage from '../../app/(auth)/practice/page';
import { interviewEngineApi } from '../../lib/api/interviewEngine';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState } from '../utils/mockAuth';
import enMessages from '../../i18n/messages/en.json';
import zhMessages from '../../i18n/messages/zh.json';

beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();
const creditState = vi.hoisted(() => ({
  data: {
    balance: 1,
    periodAllotment: 1,
    tier: 'free',
    creditMinutes: 20,
  },
}));

// Two completed sessions: one on a persona the catalog knows (maya), one on a
// persona id it doesn't (the fallback path).
const RECENT = [
  {
    id: 'ie_1', status: 'completed', source: 'app', role: 'Backend Engineer',
    interviewType: 'behavioral', personaId: 'maya', mode: 'video', language: 'zh',
    durationMinutes: 40, overall: 82, externalRef: null,
    createdAt: daysAgo(2), startedAt: daysAgo(2), endedAt: daysAgo(2),
  },
  {
    id: 'ie_2', status: 'completed', source: 'app', role: 'Backend Engineer',
    interviewType: 'behavioral', personaId: 'retired_persona', mode: 'video', language: 'zh',
    durationMinutes: 40, overall: 71, externalRef: null,
    createdAt: daysAgo(3), startedAt: daysAgo(3), endedAt: daysAgo(3),
  },
];

vi.mock('../../lib/api/interviewEngine', () => ({
  interviewEngineApi: {
    recent: vi.fn(async () => ({ sessions: RECENT })),
    remove: vi.fn(async () => ({ ok: true })),
    create: vi.fn(),
    preview: vi.fn(),
  },
}));

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockAuthState.value,
}));

vi.mock('../../hooks/useAccount', () => ({
  useCredits: () => ({ data: creditState.data }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(), replace: vi.fn(), refresh: vi.fn(),
    back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/practice',
}));

// The app deep-merges every bundle over en (lib/i18n.ts); mirror that here so a
// partially-translated bundle behaves in the test exactly as it does in prod.
const zh = {
  ...(enMessages as AbstractIntlMessages),
  ...(zhMessages as AbstractIntlMessages),
} as AbstractIntlMessages;

describe('/practice setup', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/practice');
    creditState.data = {
      balance: 1,
      periodAllotment: 1,
      tier: 'free',
      creditMinutes: 20,
    };
  });

  it('localizes the type label, the missing-persona fallback and the timestamp', async () => {
    renderWithProviders(<PracticePage />, {
      intlLocale: 'zh',
      intlMessages: zh,
    });

    // Type label off practice.setup.types.behavioral.label, not the catalog's
    // English "Behavioral (STAR)".
    expect(await screen.findByText(/过往经历 · 面试官：Maya/)).toBeTruthy();
    expect(screen.queryByText(/Behavioral/i)).toBeNull();

    // An unknown persona falls back to the localized noun, not 'Interviewer'.
    expect(screen.getByText(/过往经历 · 面试官：未知/)).toBeTruthy();
    expect(screen.queryByText(/Interviewer/)).toBeNull();

    // Intl.RelativeTimeFormat('zh'), not "2d ago".
    expect(screen.getByText('前天')).toBeTruthy();
    expect(screen.getByText('3天前')).toBeTruthy();
    expect(screen.queryByText(/\d+[dhm] ago/)).toBeNull();
  });

  it('is one click from a role to a launchable plan', async () => {
    creditState.data = { balance: 20, periodAllotment: 20, tier: 'pro', creditMinutes: 20 };

    renderWithProviders(<PracticePage />, {
      intlLocale: 'en',
      intlMessages: enMessages as AbstractIntlMessages,
    });

    // Nothing to launch until a job is named — and nothing else is asked for.
    const start = await screen.findByRole('button', { name: 'Start the interview' });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Frontend Engineer' }));

    // The recommended plan is already on screen, and Start is already live.
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole('button', { expanded: false, name: /Kai/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /Live coding/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /Video/ })).toBeTruthy();

    // Changing the role re-matches the plan to it.
    fireEvent.click(screen.getByRole('tab', { name: /Product and Design/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Product Manager' }));
    await waitFor(() => expect(screen.getByRole('button', { expanded: false, name: /Okonkwo/ })).toBeTruthy());
    expect(screen.getByRole('button', { expanded: false, name: /Product sense/ })).toBeTruthy();
  });

  it('opens a plan chip into an inline tray and applies the choice on click', async () => {
    renderWithProviders(<PracticePage />, {
      intlLocale: 'en',
      intlMessages: enMessages as AbstractIntlMessages,
    });

    fireEvent.click(await screen.findByRole('radio', { name: 'Frontend Engineer' }));

    const chip = await screen.findByRole('button', { expanded: false, name: /Kai/ });
    fireEvent.click(chip);
    expect(screen.getByRole('heading', { name: 'Pick your interviewer' })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /Maya/ }));

    // The tray closes and the chip reports the new value — no navigation.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Pick your interviewer' })).toBeNull());
    expect(screen.getByRole('button', { expanded: false, name: /Maya/ })).toBeTruthy();
  });

  it('uses the server-authored minutes-per-credit rate for preflight and the affordable duration', async () => {
    creditState.data = {
      balance: 1.5,
      periodAllotment: 1.5,
      tier: 'free',
      creditMinutes: 10,
    };

    renderWithProviders(<PracticePage />, {
      intlLocale: 'en',
      intlMessages: enMessages as AbstractIntlMessages,
    });

    fireEvent.click(await screen.findByRole('radio', { name: 'Frontend Engineer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This interview needs 5 credits and you have 1.5.');
    const startButton = screen.getByRole('button', { name: 'Start the interview' }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Use 15 min instead' }));
    await waitFor(() => expect(startButton.disabled).toBe(false));
  });

  it('prefills the previous plan when a report asks to run it again', async () => {
    window.history.replaceState(
      {},
      '',
      '/practice?role=Frontend+Engineer&interviewer=kai&type=technical&mode=voice&language=fr&duration=15',
    );

    renderWithProviders(<PracticePage />, {
      intlLocale: 'en',
      intlMessages: enMessages as AbstractIntlMessages,
    });

    const roleChoice = await screen.findByRole('radio', { name: 'Frontend Engineer' });
    await waitFor(() => expect(roleChoice).toHaveAttribute('aria-checked', 'true'));

    expect(screen.getByRole('button', { expanded: false, name: /Kai/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /Live coding/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /Voice/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /Fran\u00e7ais/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /15 min/ })).toBeTruthy();
  });

  it('restores a past session onto the brief when asked to practise it again', async () => {
    renderWithProviders(<PracticePage />, {
      intlLocale: 'en',
      intlMessages: enMessages as AbstractIntlMessages,
    });

    const again = await screen.findAllByRole('button', { name: 'Practice this again' });
    fireEvent.click(again[0]);

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Backend Engineer' })).toHaveAttribute('aria-checked', 'true'),
    );
    expect(screen.getByRole('button', { expanded: false, name: /Maya/ })).toBeTruthy();
    // Restoring a plan must never spend a credit on its own.
    expect(interviewEngineApi.create).not.toHaveBeenCalled();
  });
});
