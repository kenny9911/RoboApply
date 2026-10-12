// FIX-8: /cancel on GoApply. Passes are paid once and never renew, and there
// is no email cancel link on the mainland brand, so the page says there is
// nothing to cancel instead of showing RoboApply's "enter your email" form.

import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ status: 'unauthenticated' as 'loading' | 'authenticated' | 'unauthenticated' }));
vi.mock('../../../../lib/auth/useAuth', () => ({ useAuth: () => ({ status: auth.status }) }));

import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { getBrand } from '../../../../lib/brand/registry.generated';
import { NoRenewalNotice, brandHasRenewingPlans } from '..';

describe('GoApply /cancel: nothing to cancel', () => {
  it('only the mainland brand has no renewing plan', () => {
    expect(brandHasRenewingPlans(getBrand('roboapply'))).toBe(true);
    expect(brandHasRenewingPlans(getBrand('goapply'))).toBe(false);
  });

  it('says passes never renew; no email field, no "send cancel link"', () => {
    auth.status = 'unauthenticated';
    renderWithBrand(<NoRenewalNotice />, { brand: 'goapply' });
    expect(screen.getByRole('heading', { name: 'Nothing to cancel' })).toBeInTheDocument();
    expect(screen.getByText(/They never renew and nothing is charged again/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.body.textContent).not.toMatch(/cancel link|Cancel a subscription/i);
    expect(screen.getByRole('link', { name: 'See prices' })).toHaveAttribute('href', '/pricing');
    // The billing settings link is for a signed-in user only.
    expect(screen.queryByRole('link', { name: 'Open plan and billing settings' })).toBeNull();
  });

  it('a signed-in user also gets the way to their own pass', () => {
    auth.status = 'authenticated';
    renderWithBrand(<NoRenewalNotice />, { brand: 'goapply' });
    expect(screen.getByRole('link', { name: 'Open plan and billing settings' })).toHaveAttribute('href', '/settings#billing');
  });
});
