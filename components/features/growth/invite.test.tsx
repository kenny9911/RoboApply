// WP-60 web: /invite, the /r/[code] landing and the #referrals settings
// section. lib/api/growth is mocked and fetch is spied on: nothing leaves the
// test, and no component sends a message to anyone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('../../../lib/api/growth', () => ({
  sendEvents: vi.fn(async () => ({ accepted: 0, rejected: 0 })),
  sendEventsBeacon: vi.fn(() => true),
  getInvites: vi.fn(),
  markInviteShared: vi.fn(async () => ({ ok: true })),
  getChecklist: vi.fn(),
  dismissChecklist: vi.fn(),
}));

const auth = { status: 'unauthenticated' as 'loading' | 'authenticated' | 'unauthenticated' };
vi.mock('../../../lib/auth/useAuth', () => ({ useAuth: () => auth }));

import * as api from '../../../lib/api/growth';
import { __resetAnalyticsForTests } from '../../../lib/analytics';
import type { InvitesResponse } from '../../../lib/api/contracts/growth';
import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { INVITE_REWARD_BRANDS, inviteLinkFor } from '../../../hooks/growth/useInvites';
import { INVITE_SIGNUP_WIRED_BRANDS } from '../../../server/src/features/growth/contract';
import { InviteFriends } from './InviteFriends';
import { InviteLinkBox } from './InviteLinkBox';
import { InviteLanding, normalizeInviteCode, signupHrefFor } from './InviteLanding';
import { SettingsSection } from './SettingsSection';
import { normalizeReferralCode } from '../../../server/src/features/growth/referralCodes';
import { sanitizeEventPath } from '../../../server/src/features/growth/events';
import InvitePage from '../../../app/(auth)/invite/page';
import { loadLegalDocForPage } from '../../../app/legal/legalSource';

const getInvites = vi.mocked(api.getInvites);
const markInviteShared = vi.mocked(api.markInviteShared);

function view(over: Partial<InvitesResponse> = {}): InvitesResponse {
  return {
    eligibility: 'ok',
    code: 'ABCD2345',
    path: '/r/ABCD2345',
    link: 'https://www.roboapply.io/r/ABCD2345',
    reward: { bucket: 'practice', credits: 1 },
    invites: [],
    rewards: { granted: 0, capPerYear: 10, year: 2026 },
    ...over,
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetAnalyticsForTests();
  vi.clearAllMocks();
  auth.status = 'unauthenticated';
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  __resetAnalyticsForTests();
});

describe('/invite', () => {
  it('the route renders the invite page', async () => {
    getInvites.mockResolvedValue(view());
    renderWithBrand(<InvitePage />, { flags: { invites: true } });
    expect(await screen.findByTestId('invite-page')).toBeTruthy();
  });

  it('shows the link on this origin, how it works, the yearly limit and the terms link', async () => {
    getInvites.mockResolvedValue(view({ rewards: { granted: 3, capPerYear: 10, year: 2026 } }));
    renderWithBrand(<InviteFriends />, { flags: { invites: true } });
    const input = (await screen.findByTestId('invite-link')) as HTMLInputElement;
    expect(input.value).toBe(`${window.location.origin}/r/ABCD2345`);
    expect(screen.getAllByText(/you each get 1 practice interview credit/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('3 of 10 this year')).toBeTruthy();
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('3');
    expect(screen.getByText(/no cash value/i)).toBeTruthy();
    expect(screen.getByTestId('invite-terms').getAttribute('href')).toBe('/legal/referral-terms');
    expect(screen.getByText('No one has joined with your link yet.')).toBeTruthy();
    // Email opens the person's own mail app; nothing is sent by the product.
    const email = screen.getByText('Email').closest('a')!;
    expect(email.getAttribute('href')).toMatch(/^mailto:\?subject=/);
    expect(decodeURIComponent(email.getAttribute('href')!)).toContain('/r/ABCD2345');
    expect(screen.queryByTestId('invite-wechat')).toBeNull();
  });

  it('lists friends by date and status only', async () => {
    getInvites.mockResolvedValue(
      view({
        invites: [
          { status: 'checking', at: '2026-10-09T10:00:00.000Z' },
          { status: 'rewarded', at: '2026-10-01T10:00:00.000Z' },
          { status: 'over_limit', at: '2026-09-01T10:00:00.000Z' },
        ],
      }),
    );
    renderWithBrand(<InviteFriends />, { flags: { invites: true } });
    const list = await screen.findByTestId('invite-friends');
    expect(list.querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByText('Being checked')).toBeTruthy();
    expect(screen.getByText('Credit added')).toBeTruthy();
    expect(screen.getByText("Over this year's limit")).toBeTruthy();
    expect(screen.getAllByText(/^Friend joined /)).toHaveLength(3);
    expect(screen.getByText("We don't show who your friends are.")).toBeTruthy();
  });

  it('asks an unverified person to verify instead of showing a link', async () => {
    getInvites.mockResolvedValue(view({ eligibility: 'verify_account', code: null, path: null, link: null }));
    renderWithBrand(<InviteFriends />, { flags: { invites: true } });
    expect(await screen.findByTestId('invite-verify')).toBeTruthy();
    expect(screen.queryByTestId('invite-link')).toBeNull();
    expect(screen.getByText('Go to account settings').closest('a')!.getAttribute('href')).toBe('/settings#account');
    // RoboApply's own sign-in methods only (no WeChat or phone sign-in there).
    expect(screen.getByText(/sign in with Google or LINE/)).toBeTruthy();
    expect(screen.queryByText(/WeChat/)).toBeNull();
  });

  it('makes no timing promise for invites being checked', async () => {
    getInvites.mockResolvedValue(view({ invites: [{ status: 'checking', at: '2026-10-01T00:00:00.000Z' }] }));
    renderWithBrand(<InviteFriends />, { flags: { invites: true } });
    expect(await screen.findByText('Some invites are checked by a person before credits are added.')).toBeTruthy();
    expect(screen.queryByText(/days/)).toBeNull();
    expect(screen.getByText(/If your account has an email address, we email you/)).toBeTruthy();
    expect(screen.getByText(/confirms it \(email, Google or LINE\)/)).toBeTruthy();
  });

  it('copies the link and notes the share', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    getInvites.mockResolvedValue(view());
    renderWithBrand(<InviteFriends />, { flags: { invites: true } });
    await screen.findByTestId('invite-link');
    await act(async () => {
      fireEvent.click(screen.getByText('Copy link'));
    });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/r/ABCD2345`);
    expect(await screen.findByText('Link copied')).toBeTruthy();
    await waitFor(() => expect(markInviteShared).toHaveBeenCalledWith({ channel: 'copy' }));
  });

  it('on GoApply stays hidden (no reward promise, no request) until phone/WeChat sign-ups attach invites (R-60-3)', () => {
    expect([...INVITE_REWARD_BRANDS]).toEqual([...INVITE_SIGNUP_WIRED_BRANDS]);
    renderWithBrand(<InviteFriends />, { brand: 'goapply', flags: { invites: true } });
    expect(screen.getByText("Invites aren't available here right now.")).toBeTruthy();
    expect(getInvites).not.toHaveBeenCalled();
  });

  it('says invites are unavailable when the server answers not_available', async () => {
    getInvites.mockResolvedValue(view({ eligibility: 'not_available', code: null, path: null, link: null }));
    renderWithBrand(<InviteFriends />, { flags: { invites: true } });
    expect(await screen.findByText("Invites aren't available here right now.")).toBeTruthy();
    expect(screen.queryByText(/practice interview credit/)).toBeNull();
  });

  it('the GoApply link box offers a WeChat message to paste and lists GoApply sign-in methods', () => {
    renderWithBrand(<InviteLinkBox view={view({ link: 'https://www.goapply.top/r/ABCD2345' })} from="invite_page" />, { brand: 'goapply', flags: { invites: true } });
    const box = screen.getByTestId('invite-wechat');
    expect(box.querySelector('textarea')!.value).toContain('/r/ABCD2345');
    expect(screen.getByText('Copy message')).toBeTruthy();
    const { container } = renderWithBrand(<InviteLinkBox view={view({ eligibility: 'verify_account', code: null, path: null, link: null })} from="invite_page" />, {
      brand: 'goapply',
      flags: { invites: true },
    });
    expect(container.textContent).toMatch(/Add a phone number, sign in with WeChat or confirm your email address/);
    expect(container.textContent).not.toMatch(/Google|LINE/);
  });

  it('says invites are unavailable when the capability is off, and asks nothing', () => {
    renderWithBrand(<InviteFriends />, { flags: { invites: false } });
    expect(screen.getByText("Invites aren't available here right now.")).toBeTruthy();
    expect(getInvites).not.toHaveBeenCalled();
  });

  it('offers a retry when loading fails', async () => {
    getInvites.mockRejectedValue(new Error('offline'));
    renderWithBrand(<InviteFriends />, { flags: { invites: true } });
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});

describe('/settings#referrals', () => {
  it('shows the link, the yearly count and a link to /invite', async () => {
    getInvites.mockResolvedValue(view({ rewards: { granted: 2, capPerYear: 10, year: 2026 } }));
    renderWithBrand(<SettingsSection section="referrals" />, { flags: { invites: true } });
    expect(await screen.findByTestId('invite-settings')).toBeTruthy();
    expect(screen.getByText('2 of 10 rewards used this year')).toBeTruthy();
    expect(screen.getByText('See your invites').closest('a')!.getAttribute('href')).toBe('/invite');
    expect(screen.queryByText('Email')).toBeNull();
  });

  it('renders nothing with the capability off, or on GoApply until its sign-ups attach invites', () => {
    const { container } = renderWithBrand(<SettingsSection section="referrals" />, { flags: { invites: false } });
    expect(container.textContent).toBe('');
    const go = renderWithBrand(<SettingsSection section="referrals" />, { brand: 'goapply', flags: { invites: true } });
    expect(go.container.textContent).toBe('');
    expect(getInvites).not.toHaveBeenCalled();
  });
});

describe('/r/[code] landing', () => {
  it('sends a new visitor to signup with the code and links the terms', () => {
    renderWithBrand(<InviteLanding code="abcd-2345" />, { flags: { invites: true } });
    expect(screen.getByTestId('invite-landing')).toBeTruthy();
    expect(screen.getByText('Create your account').closest('a')!.getAttribute('href')).toBe('/signup?ref=ABCD2345&from=invite');
    expect(screen.getByText('I already have an account').closest('a')!.getAttribute('href')).toBe('/login?ref=ABCD2345&from=invite');
    expect(screen.getByText('Invite terms').closest('a')!.getAttribute('href')).toBe('/legal/referral-terms');
    expect(screen.getByText(/new accounts only/)).toBeTruthy();
    // The code is not looked up first: no claim that a friend is behind it.
    expect(screen.getByText(/If the link is still active/)).toBeTruthy();
    expect(screen.queryByText(/A friend invited you/)).toBeNull();
  });

  it('promises nothing when the invite programme is off, or on GoApply until its sign-ups attach invites', () => {
    const off = renderWithBrand(<InviteLanding code="ABCD2345" />, { flags: { invites: false } });
    expect(screen.getByTestId('invite-landing-plain')).toBeTruthy();
    expect(off.container.textContent).not.toMatch(/credit|invite/i);
    expect(screen.getByText('Create an account').closest('a')!.getAttribute('href')).toBe('/signup');
    off.unmount();
    const go = renderWithBrand(<InviteLanding code="ABCD2345" />, { brand: 'goapply', flags: { invites: true } });
    expect(screen.getByTestId('invite-landing-plain')).toBeTruthy();
    expect(go.container.textContent).not.toMatch(/credit/i);
  });

  it('points a signed-in visitor to their own invites', () => {
    auth.status = 'authenticated';
    renderWithBrand(<InviteLanding code="ABCD2345" />, { flags: { invites: true } });
    expect(screen.getByTestId('invite-landing-signed-in')).toBeTruthy();
    expect(screen.getByText('Invite friends').closest('a')!.getAttribute('href')).toBe('/invite');
  });

  it('explains a malformed link and still offers signup without it', () => {
    renderWithBrand(<InviteLanding code="<script>" />, { flags: { invites: true } });
    expect(screen.getByTestId('invite-landing-invalid')).toBeTruthy();
    expect(screen.queryByText(/script/)).toBeNull();
    expect(screen.getByText('Create an account').closest('a')!.getAttribute('href')).toBe('/signup');
  });

  it('reads codes exactly like the server', () => {
    for (const raw of ['abcd-2345', 'ABCDEFGO', 'abcdefgl', 'ABCDEFGU', 'x', ' 0123 4567 ']) {
      expect(normalizeInviteCode(raw)).toBe(normalizeReferralCode(raw));
    }
    expect(signupHrefFor('ABCD2345')).toBe('/signup?ref=ABCD2345&from=invite');
  });

  it('the server never stores the invite code in event paths', () => {
    expect(sanitizeEventPath('/r/ABCD2345')).toBe('/r/:code');
    expect(sanitizeEventPath('/jobs/r/x')).toBe('/jobs/r/x');
  });
});

describe('inviteLinkFor', () => {
  it('uses the current origin and falls back to the server link', () => {
    expect(inviteLinkFor(view(), 'http://goapply.localhost:3621')).toBe('http://goapply.localhost:3621/r/ABCD2345');
    expect(inviteLinkFor({ path: null, link: 'https://x/r/1' })).toBe('https://x/r/1');
    expect(inviteLinkFor(null)).toBeNull();
  });
});

describe('/legal/referral-terms', () => {
  it('renders the DRAFT skeleton on both brands in development, placeholders filled', () => {
    for (const brand of [
      { id: 'roboapply' as const, market: 'intl' as const, name: 'RoboApply', replyTo: 'support@roboapply.io' },
      { id: 'goapply' as const, market: 'cn' as const, name: 'GoApply', replyTo: 'support@goapply.top' },
    ]) {
      const res = loadLegalDocForPage(brand, 'referral-terms', { NODE_ENV: 'development' });
      expect(res.kind).toBe('doc');
      if (res.kind !== 'doc') continue;
      expect(res.doc.draft).toBe(true);
      expect(res.doc.body).toMatch(/DRAFT/);
      expect(res.doc.body).not.toMatch(/\{\{|%BRAND%/);
      expect(res.doc.body).toContain(brand.name);
      expect(res.doc.body).toMatch(brand.market === 'cn' ? /10 次/ : /up to 10 invite rewards/);
    }
  });

  it('is not served on production GoApply while it is a draft', () => {
    const res = loadLegalDocForPage({ id: 'goapply', market: 'cn', name: 'GoApply', replyTo: 'x@y.z' }, 'referral-terms', { NODE_ENV: 'production', CN_LEGAL_DOCS_VERSION: '2026-11' });
    expect(res.kind).toBe('not_found');
  });
});
