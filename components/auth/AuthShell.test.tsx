// components/auth/AuthShell.tsx — the auth pages' chrome (FIX-2, browser
// verification):
//   • the brand panel promised "Practice interviews that talk back" on GoApply,
//     where the spoken interview is off: the line follows `ai.interviewVoice`;
//   • the theme button used the landing's toggle (icon = the appearance a press
//     switches to) while the app header shows the current one. One convention.

import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/signup',
}));
vi.mock('../../hooks/auth/useAuthAccount', () => ({ useEntryJob: () => null }));

import { renderWithBrand } from '../../__tests__/shell/helpers';
import { renderWithProviders } from '../../__tests__/utils/renderWithProviders';
import { ThemeToggle as AppThemeToggle } from '../v3/shell/ThemeToggle';
import { AuthBrandPanel, AuthUtilities } from './AuthShell';

describe('auth brand panel: brand-true claims', () => {
  it('says the interview talks back only where the spoken interview is on', () => {
    const on = renderWithBrand(<AuthBrandPanel />, { brand: 'roboapply', flags: { 'ai.interviewVoice': true } });
    expect(screen.getByText('Practice interviews that talk back')).toBeInTheDocument();
    on.unmount();

    renderWithBrand(<AuthBrandPanel />, { brand: 'goapply', flags: { 'ai.interviewVoice': false } });
    expect(screen.queryByText('Practice interviews that talk back')).toBeNull();
    expect(screen.getByText('Practice interviews for the job you want')).toBeInTheDocument();
  });

  it('fails closed while the capabilities are unknown', () => {
    renderWithBrand(<AuthBrandPanel />, { brand: 'roboapply', flags: {} });
    expect(screen.queryByText('Practice interviews that talk back')).toBeNull();
  });
});

describe('auth theme button: the same convention as the app header', () => {
  it('renders the app shell toggle: same label and same icon for the same appearance', () => {
    const auth = renderWithBrand(<AuthUtilities />, { flags: {} });
    const authButton = screen.getByRole('button', { name: 'Switch to dark' });
    const authIcon = authButton.querySelector('svg')!.innerHTML;
    auth.unmount();

    renderWithProviders(<AppThemeToggle />);
    const appButton = screen.getByRole('button', { name: 'Switch to dark' });
    expect(appButton.querySelector('svg')!.innerHTML).toBe(authIcon);
  });
});
