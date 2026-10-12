// Profile UI (WP-19): sections per brand, Missing markers, the completion
// card, saving, the resume review, the nav badge and the #sensitive section.
// lib/api/profile is mocked; nothing touches the network.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import type { ProfileView, SensitiveAnswersView, SyncFromResumeResponse } from '../../../lib/api/contracts/profile';
import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { RoboApiError } from '../../../lib/api/client';

const api = vi.hoisted(() => ({
  getProfile: vi.fn(),
  patchProfile: vi.fn(),
  addEducation: vi.fn(),
  updateEducation: vi.fn(),
  deleteEducation: vi.fn(),
  addExperience: vi.fn(),
  updateExperience: vi.fn(),
  deleteExperience: vi.fn(),
  putSkills: vi.fn(),
  getSensitiveAnswers: vi.fn(),
  putSensitiveAnswers: vi.fn(),
  previewSyncFromResume: vi.fn(),
  applySyncFromResume: vi.fn(),
}));
vi.mock('../../../lib/api/profile', () => api);

const resumes = vi.hoisted(() => ({ list: [] as Array<{ id: string; name: string; kind: string }> }));
vi.mock('../../../hooks/useResumes', () => ({
  useResumeList: () => ({ data: { resumes: resumes.list }, isLoading: false }),
}));

import { ProfileCompletionCard, ProfilePage, ProfileSettingsSection } from './index';
import { visibleSections } from './ProfilePage';
import * as opts from './options';
import { useProfileBadge } from '../../../hooks/profile/useProfileBadge';
import * as tw from '../../../server/src/features/tw/index';
import * as contract from '../../../server/src/features/profile/contract';
import * as cnContract from '../../../server/src/features/onboarding-cn/contract';

function view(over: Partial<ProfileView> = {}): ProfileView {
  return {
    userId: 'u1',
    firstName: null,
    middleName: null,
    lastName: null,
    headline: null,
    contactEmail: null,
    phoneE164: null,
    phoneType: null,
    addressLine1: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
    links: {},
    summary: null,
    skills: [],
    languages: [],
    workAuth: [],
    cnFields: null,
    twFields: null,
    education: [],
    experience: [],
    completeness: 0,
    missing: [
      { key: 'firstName', label: 'profile.missing.firstName', section: 'personal' },
      { key: 'education', label: 'profile.missing.education', section: 'education' },
      { key: 'workAuth', label: 'profile.missing.workAuth', section: 'workAuth' },
    ],
    availability: { market: 'intl', twFields: false, eeo: true, cnSensitive: false, cnPhoto: false },
    syncedFromVariantId: null,
    updatedAt: null,
    ...over,
  };
}

const sensitive = (over: Partial<SensitiveAnswersView> = {}): SensitiveAnswersView => ({
  answers: {},
  configured: true,
  availability: { market: 'intl', eeo: true, cnSensitive: false, cnPhoto: false },
  updatedAt: null,
  unreadable: false,
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  resumes.list = [];
  api.getSensitiveAnswers.mockResolvedValue(sensitive());
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

const sectionIds = () => [...document.querySelectorAll('section[id]')].map((el) => el.id);

describe('mirrors match the server constants', () => {
  it('Taiwan, EEO and GoApply option lists', () => {
    expect([...opts.TW_COUNTIES]).toEqual([...tw.TW_COUNTIES]);
    expect([...opts.TW_WORK_PERMIT_STATUSES]).toEqual([...tw.TW_WORK_PERMIT_STATUSES]);
    expect(opts.EEO_OPTIONS).toEqual(contract.EEO_OPTIONS);
    expect([...opts.CN_IDENTITIES]).toEqual([...cnContract.CN_IDENTITIES]);
    expect([...opts.CN_DEGREE_OPTIONS]).toEqual([...cnContract.CN_DEGREE_OPTIONS]);
    expect([...opts.CN_JOB_SEARCH_STATUS]).toEqual([...cnContract.CN_JOB_SEARCH_STATUS]);
    expect(opts.CN_CLASS_YEAR_RANGE).toEqual(cnContract.CN_CLASS_YEAR_RANGE);
  });

  it.each(['https://www.linkedin.com/in/ada', 'https://www.linkedin.com/company/x', 'https://evil.test/linkedin.com/in/a'])('LinkedIn check %s', (url) => {
    expect(opts.isLinkedInProfileUrl(url)).toBe(contract.isLinkedInProfileUrl(url));
  });

  it('Taiwan relevance matches the server rule', () => {
    const cases = [
      { country: 'TW', workAuth: [], locale: 'en' },
      { country: 'US', workAuth: [{ country: 'TW', authorized: null, sponsorship: null }], locale: 'en' },
      { country: 'US', workAuth: [], locale: 'zh-TW' },
      { country: 'US', workAuth: [], locale: 'en' },
    ] as const;
    for (const c of cases) {
      const p = view({ country: c.country, workAuth: [...c.workAuth] });
      expect(opts.isTaiwanRelevant(p, c.locale)).toBe(tw.isTaiwanRelevant({ market: 'intl', country: c.country, workAuthCountries: c.workAuth.map((w) => w.country), locale: c.locale }));
    }
  });
});

describe('sections per brand', () => {
  it('RoboApply: work authorization, no GoApply basics; EEO only for US targets; Taiwan only when relevant', () => {
    expect(visibleSections(view(), 'en')).toEqual(['personal', 'education', 'work', 'skills', 'links', 'workAuth', 'answers']);
    expect(visibleSections(view({ country: 'US' }), 'en')).toContain('eeo');
    expect(visibleSections(view({ country: 'US', availability: { ...view().availability, eeo: false } }), 'en')).not.toContain('eeo');
    expect(visibleSections(view({ workAuth: [{ country: 'TW', authorized: true, sponsorship: null }] }), 'en')).toContain('taiwan');
    // Answers stored earlier keep the section (delete only), even without a US target or the flag.
    expect(visibleSections(view({ country: 'GB', availability: { ...view().availability, eeo: false } }), 'en', { storedEeo: true })).toContain('eeo');
  });

  it('RoboApply, no US target but EEO answers stored: the profile offers only to delete them', async () => {
    api.getProfile.mockResolvedValue(view({ country: 'GB' }));
    api.getSensitiveAnswers.mockResolvedValue(sensitive({ answers: { eeo: { gender: 'female' } }, updatedAt: '2026-10-10T00:00:00Z' }));
    api.putSensitiveAnswers.mockResolvedValue(sensitive());
    renderWithBrand(<ProfilePage />);
    const section = await screen.findByRole('region', { name: 'Equal-opportunity answers' });
    expect(within(section).queryByLabelText('Gender')).toBeNull();
    fireEvent.click(await within(section).findByRole('button', { name: 'Delete these answers' }));
    await waitFor(() => expect(api.putSensitiveAnswers).toHaveBeenCalledWith({}));
  });

  it('GoApply: basics, no work authorization, no Taiwan, no EEO', () => {
    const go = view({ country: 'US', availability: { market: 'cn', twFields: false, eeo: false, cnSensitive: true, cnPhoto: false } });
    expect(visibleSections(go, 'zh-TW')).toEqual(['personal', 'basics', 'education', 'work', 'skills', 'links', 'answers']);
  });

  it('renders the page with Missing markers and the completion card', async () => {
    api.getProfile.mockResolvedValue(view());
    renderWithBrand(<ProfilePage />);
    expect(await screen.findByRole('heading', { name: 'Your profile' })).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'Complete your profile' });
    expect(sectionIds()).toEqual(['sync', 'personal', 'education', 'work', 'skills', 'links', 'workAuth', 'answers']);
    const personal = document.getElementById('personal')!;
    expect(within(personal).getByText('First name').closest('label')).toHaveTextContent('Missing');
    expect(within(personal).getByText('Last name').closest('label')).not.toHaveTextContent('Missing');
    // No LinkedIn field on GoApply, present here.
    expect(within(document.getElementById('links')!).getByLabelText(/LinkedIn profile/)).toBeInTheDocument();
  });

  it('GoApply renders 基本信息 with the optional encrypted details and no LinkedIn or photo upload', async () => {
    api.getProfile.mockResolvedValue(view({ availability: { market: 'cn', twFields: false, eeo: false, cnSensitive: true, cnPhoto: false }, missing: [] }));
    api.getSensitiveAnswers.mockResolvedValue(sensitive({ availability: { market: 'cn', eeo: false, cnSensitive: true, cnPhoto: false } }));
    renderWithBrand(<ProfilePage />, { brand: 'goapply' });
    const basics = await screen.findByRole('region', { name: 'Basic information' });
    expect(await within(basics).findByLabelText('Place of family origin')).toBeInTheDocument();
    expect(within(basics).getByText(/Photos aren't stored on this version of/)).toBeInTheDocument();
    expect(within(document.getElementById('links')!).queryByLabelText(/LinkedIn/)).toBeNull();
    expect(document.getElementById('workAuth')).toBeNull();
  });

  it('says so, with a retry, while the profile area is not live yet', async () => {
    api.getProfile.mockRejectedValue(new RoboApiError('x', { status: 501, payload: { code: 'not_implemented' } }));
    renderWithBrand(<ProfilePage />);
    expect(await screen.findByText("Your profile isn't available yet. Please try again later.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('ProfileCompletionCard', () => {
  it('lists the sections with what is missing and links to them', () => {
    renderWithBrand(<ProfileCompletionCard profile={view({ completeness: 40 })} linkBase="/profile" />);
    expect(screen.getByRole('progressbar', { name: 'Profile completeness' })).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText('40% complete')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Go to Personal/ });
    expect(link).toHaveAttribute('href', '/profile#personal');
    expect(screen.getByRole('link', { name: /Go to Work authorization/ })).toHaveAttribute('href', '/profile#workAuth');
    expect(screen.queryByRole('link', { name: /Go to Skills/ })).toBeNull();
    expect(screen.queryByText('Basic information')).toBeNull();
  });

  it('renders nothing once nothing is missing (unless asked)', () => {
    const { container } = renderWithBrand(<ProfileCompletionCard profile={view({ missing: [], completeness: 100 })} />);
    expect(container).toBeEmptyDOMElement();
    renderWithBrand(<ProfileCompletionCard profile={view({ missing: [], completeness: 100 })} showWhenComplete />);
    expect(screen.getByText('Your profile has everything forms usually ask for.')).toBeInTheDocument();
  });
});

describe('saving', () => {
  it('Personal sends one PATCH with the phone in international form; a bad phone is refused locally', async () => {
    api.getProfile.mockResolvedValue(view());
    api.patchProfile.mockImplementation(async (body: Record<string, unknown>) => view({ ...(body as Partial<ProfileView>), missing: [] }));
    renderWithBrand(<ProfilePage />);
    const personal = await screen.findByRole('region', { name: 'Personal' });
    fireEvent.change(within(personal).getByLabelText(/^First name/), { target: { value: 'Ada' } });
    fireEvent.change(within(personal).getByLabelText(/^Phone$/), { target: { value: '415-555' } });
    fireEvent.click(within(personal).getByRole('button', { name: 'Save' }));
    expect(await within(personal).findAllByText('Enter the number with its country code, starting with +.')).not.toHaveLength(0);
    expect(api.patchProfile).not.toHaveBeenCalled();

    fireEvent.change(within(personal).getByLabelText(/^Phone$/), { target: { value: '+1 (415) 555-0100' } });
    fireEvent.click(within(personal).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patchProfile).toHaveBeenCalledTimes(1));
    expect(api.patchProfile.mock.calls[0]![0]).toMatchObject({ firstName: 'Ada', phoneE164: '+14155550100', contactEmail: null, country: null });
    expect(await within(personal).findByText('Saved')).toBeInTheDocument();
  });

  it('adds a school', async () => {
    api.getProfile.mockResolvedValue(view());
    api.addEducation.mockResolvedValue({ id: 'e1' });
    renderWithBrand(<ProfilePage />);
    const edu = await screen.findByRole('region', { name: 'Education' });
    fireEvent.click(within(edu).getByRole('button', { name: 'Add a school' }));
    fireEvent.change(within(edu).getByLabelText('School'), { target: { value: 'Rice' } });
    fireEvent.change(within(edu).getByLabelText('Start'), { target: { value: '2018-08' } });
    fireEvent.click(within(edu).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.addEducation).toHaveBeenCalledTimes(1));
    expect(api.addEducation.mock.calls[0]![0]).toMatchObject({ school: 'Rice', startDate: '2018-08', endDate: null, current: false });
  });

  it('GoApply basics: an unanswered full-time question is sent as null, never as "no"', async () => {
    const go = { market: 'cn' as const, twFields: false, eeo: false, cnSensitive: true, cnPhoto: false };
    api.getProfile.mockResolvedValue(view({ availability: go, missing: [], cnFields: { identity: 'yingjie', graduationClass: 2026 } }));
    api.getSensitiveAnswers.mockResolvedValue(sensitive({ availability: { market: 'cn', eeo: false, cnSensitive: true, cnPhoto: false } }));
    api.patchProfile.mockImplementation(async () => view({ availability: go, missing: [] }));
    renderWithBrand(<ProfilePage />, { brand: 'goapply' });
    const basics = await screen.findByRole('region', { name: 'Basic information' });
    expect(within(basics).getByLabelText('Full-time program')).toHaveValue('');
    fireEvent.change(within(basics).getByLabelText('Major'), { target: { value: 'CS' } });
    fireEvent.click(within(basics).getAllByRole('button', { name: 'Save' })[0]!);
    await waitFor(() => expect(api.patchProfile).toHaveBeenCalledTimes(1));
    expect(api.patchProfile.mock.calls[0]![0].cnFields).toMatchObject({ identity: 'yingjie', graduationClass: 2026, major: 'CS', isFullTimeProgram: null });

    fireEvent.change(within(basics).getByLabelText('Full-time program'), { target: { value: 'no' } });
    fireEvent.click(within(basics).getAllByRole('button', { name: 'Save' })[0]!);
    await waitFor(() => expect(api.patchProfile).toHaveBeenCalledTimes(2));
    expect(api.patchProfile.mock.calls[1]![0].cnFields).toMatchObject({ isFullTimeProgram: false });
  });

  it('saving Taiwan preferences keeps the stored job categories (no input for them yet)', async () => {
    const twProfile = view({
      availability: { ...view().availability, twFields: true },
      workAuth: [{ country: 'TW', authorized: true, sponsorship: null }],
      twFields: { desiredTitles: ['PM'], desiredCategoryIds: ['role_pm'] },
    });
    api.getProfile.mockResolvedValue(twProfile);
    api.patchProfile.mockResolvedValue(twProfile);
    renderWithBrand(<ProfilePage />);
    const section = await screen.findByRole('region', { name: 'Taiwan job preferences' });
    fireEvent.change(within(section).getByLabelText('Expected pay'), { target: { value: 'negotiable' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patchProfile).toHaveBeenCalledTimes(1));
    expect(api.patchProfile.mock.calls[0]![0]).toEqual({
      twFields: { desiredTitles: ['PM'], desiredLocations: [], desiredPay: { kind: 'negotiable' }, desiredCategoryIds: ['role_pm'] },
    });
  });

  it('work authorization is asked per country, with the Taiwan permit question for Taiwan', async () => {
    api.getProfile.mockResolvedValue(view({ workAuth: [{ country: 'TW', authorized: null, sponsorship: null }] }));
    api.patchProfile.mockImplementation(async () => view());
    renderWithBrand(<ProfilePage />);
    const wa = await screen.findByRole('region', { name: 'Work authorization' });
    const group = within(wa).getByRole('group', { name: /allowed to work in Taiwan/ });
    fireEvent.click(within(group).getByLabelText('No'));
    fireEvent.change(within(wa).getByLabelText('Work permit in Taiwan'), { target: { value: 'gold_card' } });
    fireEvent.click(within(wa).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patchProfile).toHaveBeenCalled());
    expect(api.patchProfile.mock.calls[0]![0]).toEqual({ workAuth: [{ country: 'TW', authorized: false, sponsorship: null, permit: 'gold_card' }] });
  });
});

describe('Update from a resume', () => {
  const diff: SyncFromResumeResponse = {
    variantId: 'v1',
    parsed: true,
    diff: [
      { path: 'firstName', section: 'personal', current: null, proposed: 'Ada', kind: 'add' },
      { path: 'contactEmail', section: 'personal', current: 'old@example.test', proposed: 'new@example.test', kind: 'change' },
      { path: 'education[1a2b3c4d]', section: 'education', current: null, proposed: { school: 'Rice', degree: 'MS', major: null, startDate: '2018-08', endDate: '2020-05', current: false }, kind: 'add' },
    ],
  };

  it('shows the field-by-field review and applies only the ticked changes', async () => {
    resumes.list = [{ id: 'v1', name: 'Main resume', kind: 'base' }];
    api.getProfile.mockResolvedValue(view());
    api.previewSyncFromResume.mockResolvedValue(diff);
    api.applySyncFromResume.mockResolvedValue(view({ firstName: 'Ada' }));
    renderWithBrand(<ProfilePage />);
    const panel = await screen.findByRole('region', { name: 'Update from a resume' });
    fireEvent.change(within(panel).getByLabelText('Resume'), { target: { value: 'v1' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Compare' }));
    expect(await within(panel).findByText('new@example.test')).toBeInTheDocument();
    expect(within(panel).getByText('Rice · MS · 2018-08 – 2020-05')).toBeInTheDocument();
    expect(api.applySyncFromResume).not.toHaveBeenCalled();

    // Additions start ticked; a change that would overwrite what the person entered starts unticked.
    expect(within(panel).getByRole('checkbox', { name: /First name/ })).toBeChecked();
    expect(within(panel).getByRole('checkbox', { name: /School/ })).toBeChecked();
    expect(within(panel).getByRole('checkbox', { name: /Email/ })).not.toBeChecked();
    fireEvent.click(within(panel).getByRole('button', { name: 'Update my profile (2)' }));
    await waitFor(() => expect(api.applySyncFromResume).toHaveBeenCalledTimes(1));
    expect(api.applySyncFromResume.mock.calls[0]![0]).toEqual({ variantId: 'v1', accept: ['firstName', 'education[1a2b3c4d]'] });
    expect(await within(panel).findByText('Your profile is updated.')).toBeInTheDocument();
  });

  it('says so when comparing or updating fails', async () => {
    resumes.list = [{ id: 'v1', name: 'Main resume', kind: 'base' }];
    api.getProfile.mockResolvedValue(view());
    api.previewSyncFromResume.mockRejectedValueOnce(new RoboApiError('down', { status: 500, payload: { code: 'internal_error' } }));
    renderWithBrand(<ProfilePage />);
    const panel = await screen.findByRole('region', { name: 'Update from a resume' });
    fireEvent.change(within(panel).getByLabelText('Resume'), { target: { value: 'v1' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Compare' }));
    expect(await within(panel).findByText("We couldn't do that right now. Please try again.")).toBeInTheDocument();

    api.previewSyncFromResume.mockRejectedValueOnce(new RoboApiError('gone', { status: 404, payload: { code: 'not_found' } }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Compare' }));
    expect(await within(panel).findByText('This resume was deleted. Choose another one.')).toBeInTheDocument();

    api.previewSyncFromResume.mockResolvedValueOnce(diff);
    api.applySyncFromResume.mockRejectedValueOnce(new Error('network'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Compare' }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Update my profile (2)' }));
    expect(await within(panel).findByText("We couldn't do that right now. Please try again.")).toBeInTheDocument();
  });
});

describe('useProfileBadge', () => {
  function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  it('is a dot while a required field is missing, nothing when complete or on error', async () => {
    api.getProfile.mockResolvedValueOnce(view());
    const a = renderHook(() => useProfileBadge(), { wrapper });
    expect(a.result.current).toBeNull();
    await waitFor(() => expect(a.result.current).toEqual({ kind: 'dot' }));

    api.getProfile.mockResolvedValueOnce(view({ missing: [] }));
    const b = renderHook(() => useProfileBadge(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(b.result.current).toBeNull();

    api.getProfile.mockRejectedValueOnce(new RoboApiError('down', { status: 404, payload: { code: 'not_found' } }));
    const c = renderHook(() => useProfileBadge(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(c.result.current).toBeNull();
  });
});

describe('/settings#sensitive', () => {
  it('RoboApply, US target: the equal-opportunity form; saving keeps nothing else and deletes on request', async () => {
    api.getProfile.mockResolvedValue(view({ country: 'US' }));
    api.getSensitiveAnswers.mockResolvedValue(sensitive({ answers: { eeo: { gender: 'decline' } }, updatedAt: '2026-10-10T00:00:00Z' }));
    api.putSensitiveAnswers.mockImplementation(async (body: unknown) => sensitive({ answers: body as SensitiveAnswersView['answers'] }));
    renderWithBrand(<ProfileSettingsSection section="sensitive" />);
    const gender = await screen.findByLabelText('Gender');
    await waitFor(() => expect(gender).toHaveValue('decline'));
    fireEvent.change(screen.getByLabelText('Veteran status'), { target: { value: 'not_veteran' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.putSensitiveAnswers).toHaveBeenCalledTimes(1));
    expect(api.putSensitiveAnswers.mock.calls[0]![0]).toEqual({ eeo: { gender: 'decline', veteranStatus: 'not_veteran' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete these answers' }));
    await waitFor(() => expect(api.putSensitiveAnswers).toHaveBeenCalledTimes(2));
    expect(api.putSensitiveAnswers.mock.calls[1]![0]).toEqual({});
  });

  it('RoboApply, no US target and nothing stored: nothing to answer here', async () => {
    api.getProfile.mockResolvedValue(view({ country: 'GB' }));
    renderWithBrand(<ProfileSettingsSection section="sensitive" />);
    expect(await screen.findByText('There are no sensitive questions to answer here.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Gender')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete these answers' })).toBeNull();
  });

  it.each([
    ['no US target', view({ country: 'GB' })],
    ['the eeoAnswers flag is off', view({ country: 'US', availability: { ...view().availability, eeo: false } })],
  ])('RoboApply, EEO answers stored but %s: they can still be deleted', async (_case, profile) => {
    api.getProfile.mockResolvedValue(profile);
    api.getSensitiveAnswers.mockResolvedValue(sensitive({ answers: { eeo: { gender: 'female' } }, updatedAt: '2026-10-10T00:00:00Z' }));
    api.putSensitiveAnswers.mockResolvedValue(sensitive());
    renderWithBrand(<ProfileSettingsSection section="sensitive" />);
    expect(await screen.findByText(/You saved answers to these questions earlier/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Gender')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete these answers' }));
    await waitFor(() => expect(api.putSensitiveAnswers).toHaveBeenCalledTimes(1));
    expect(api.putSensitiveAnswers.mock.calls[0]![0]).toEqual({});
  });

  it('answers that can no longer be read: says so, and they can be re-entered or deleted', async () => {
    api.getProfile.mockResolvedValue(view({ country: 'US' }));
    api.getSensitiveAnswers.mockResolvedValue(sensitive({ unreadable: true, updatedAt: '2026-10-10T00:00:00Z' }));
    api.putSensitiveAnswers.mockResolvedValue(sensitive());
    renderWithBrand(<ProfileSettingsSection section="sensitive" />);
    expect(await screen.findByText(/can't be read anymore/)).toBeInTheDocument();
    expect(screen.getByLabelText('Gender')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Delete these answers' }));
    await waitFor(() => expect(api.putSensitiveAnswers).toHaveBeenCalledWith({}));
  });

  it('says so when answers cannot be saved on this deployment', async () => {
    api.getProfile.mockResolvedValue(view({ country: 'US' }));
    api.getSensitiveAnswers.mockResolvedValue(sensitive({ configured: false }));
    renderWithBrand(<ProfileSettingsSection section="sensitive" />);
    expect(await screen.findByText("These answers can't be saved right now. Please try again later.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
