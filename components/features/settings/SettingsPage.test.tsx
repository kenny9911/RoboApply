// components/features/settings/SettingsPage.tsx — the no-empty-panel fallback.
// An area component may render nothing (its data failed to load and it has no
// state of its own). The frame then says the section did not load, after a
// short wait so a normal loading flash is not reported, and takes the line
// away the moment the section renders anything.
// (The page-level wiring is covered by __tests__/pages/settings.test.tsx.)

import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings',
}));

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { EMPTY_SECTION_DELAY_MS, SettingsPage } from './SettingsPage';

afterEach(() => window.history.replaceState(null, '', '/settings'));

describe('SettingsPage: a section that renders nothing', () => {
  it('says the section did not load, but not during a normal loading flash', async () => {
    window.history.replaceState(null, '', '/settings#account');
    renderWithBrand(<SettingsPage renderers={{ account: () => null }} />, { flags: {} });
    await waitFor(() => expect(document.querySelector('.pref')).toHaveAttribute('data-settings-section', 'account'));
    expect(screen.queryByTestId('settings-section-empty')).toBeNull();
    expect(await screen.findByTestId('settings-section-empty', {}, { timeout: EMPTY_SECTION_DELAY_MS + 2500 })).toHaveTextContent(
      'This section did not load. Reload the page to try again.',
    );
  });

  it('takes the line away as soon as the section renders something', async () => {
    window.history.replaceState(null, '', '/settings#account');
    let show!: () => void;
    function Late() {
      const [ready, setReady] = useState(false);
      show = () => setReady(true);
      return ready ? <p>Account content</p> : null;
    }
    renderWithBrand(<SettingsPage renderers={{ account: () => <Late /> }} />, { flags: {} });
    await screen.findByTestId('settings-section-empty', {}, { timeout: EMPTY_SECTION_DELAY_MS + 2500 });
    act(() => show());
    await waitFor(() => expect(screen.queryByTestId('settings-section-empty')).toBeNull());
    expect(screen.getByText('Account content')).toBeInTheDocument();
  });
});
