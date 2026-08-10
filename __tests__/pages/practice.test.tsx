// __tests__/pages/practice.test.tsx
//
// The recent-sessions strip on /practice — the one place on the setup page that
// renders SERVER data (past interview sessions) rather than catalog chrome.
//
// It used to leak three English strings into every locale: the catalog's raw
// English type label, a hardcoded 'Interviewer' fallback for a persona the
// catalog no longer carries, and a hand-rolled "2d ago" builder. This test
// renders the page in zh and pins all three to their localized output.

import type { ReactNode } from 'react';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { AbstractIntlMessages } from 'next-intl';

import PracticePage from '../../app/(auth)/practice/page';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState } from '../utils/mockAuth';
import enMessages from '../../i18n/messages/en.json';
import zhMessages from '../../i18n/messages/zh.json';

beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

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

describe('/practice recent sessions', () => {
  it('localizes the type label, the missing-persona fallback and the timestamp', async () => {
    const { container } = renderWithProviders(<PracticePage />, {
      intlLocale: 'zh',
      intlMessages: zh,
    });

    // Both cards land once the catalog + recent fetches resolve.
    await waitFor(() =>
      expect(container.querySelectorAll('.iv-recent-title')).toHaveLength(2),
    );

    // Type label off practice.setup.types.behavioral.label, not the catalog's
    // English "Behavioral (STAR)".
    const titles = [...container.querySelectorAll('.iv-recent-title')].map((e) => e.textContent ?? '');
    expect(titles[0]).toContain('过往经历');
    expect(titles.join(' ')).not.toMatch(/Behavioral/i);

    // Known persona keeps its proper name inside the localized template;
    // an unknown one falls back to the localized noun, not 'Interviewer'.
    expect(screen.getByText('面试官：Maya')).toBeTruthy();
    expect(screen.getByText('面试官：未知')).toBeTruthy();
    expect(screen.queryByText(/Interviewer/)).toBeNull();

    // Intl.RelativeTimeFormat('zh'), not "2d ago".
    expect(screen.getByText('前天')).toBeTruthy();
    expect(screen.getByText('3天前')).toBeTruthy();
    expect(screen.queryByText(/\d+[dhm] ago/)).toBeNull();
  });
});
