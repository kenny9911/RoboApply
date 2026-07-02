// PreferenceTray — confirmed captured fields render as chips; fields in the
// `unconfirmed` list are SUPPRESSED until confirmed (design-review fix R7);
// tapping a chip hands the localized field label to the composer pre-fill.

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

import { renderWithProviders } from '../utils/renderWithProviders';
import { PreferenceTray } from '../../components/v3/onboarding/PreferenceTray';
import type { OnboardingDraftPreferences } from '../../lib/api/v2/types';

const DRAFT: OnboardingDraftPreferences = {
  targetRoles: ['Senior Backend Engineer'],
  workModes: ['remote'],
  salary: { min: 150000, currency: 'USD', period: 'year' },
};

describe('PreferenceTray', () => {
  it('renders chips for confirmed captured fields', () => {
    renderWithProviders(
      <PreferenceTray
        draft={DRAFT}
        captured={['targetRoles', 'workModes']}
        unconfirmed={[]}
        onEditField={() => {}}
      />,
    );
    expect(screen.getByText(/Senior Backend Engineer/)).toBeInTheDocument();
    // Enum values are localized (en bundle: remote → "Remote").
    expect(screen.getByText(/Remote/)).toBeInTheDocument();
  });

  it('suppresses fields listed as unconfirmed (R7)', () => {
    renderWithProviders(
      <PreferenceTray
        draft={DRAFT}
        captured={['targetRoles', 'salary']}
        unconfirmed={['salary']}
        onEditField={() => {}}
      />,
    );
    expect(screen.getByText(/Senior Backend Engineer/)).toBeInTheDocument();
    // The inferred USD salary must NOT appear until confirmed.
    expect(screen.queryByText(/150,000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/USD/)).not.toBeInTheDocument();
  });

  it('shows the salary chip once a later prefs-update confirms it', () => {
    renderWithProviders(
      <PreferenceTray
        draft={DRAFT}
        captured={['targetRoles', 'salary']}
        unconfirmed={[]}
        onEditField={() => {}}
      />,
    );
    expect(screen.getByText(/USD 150,000\+/)).toBeInTheDocument();
  });

  it('renders nothing when no confirmed field has a value', () => {
    const { container } = renderWithProviders(
      <PreferenceTray
        draft={DRAFT}
        captured={['salary']}
        unconfirmed={['salary']}
        onEditField={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('tap hands the localized field label to the composer pre-fill', () => {
    const onEditField = vi.fn();
    renderWithProviders(
      <PreferenceTray
        draft={DRAFT}
        captured={['workModes']}
        unconfirmed={[]}
        onEditField={onEditField}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Work mode/ }));
    expect(onEditField).toHaveBeenCalledWith('Work mode');
  });
});
