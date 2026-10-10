// WP-31 web: GoApply onboarding steps G1–G5, the cn confirm page, the resume
// AI-consent gate and the first-value prompt. Requests are injected through
// CnOnboardingApiProvider (no network). Rendered at 375px (the phone layout).
// INT-08: the default open-jobs request goes to the cn snapshot route (every
// role and city in one count) and dates the campus count with the programme
// list's own as-of time; `CnFirstValueScreen` reads the tour's props for the
// signed-in user.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ getMarketSnapshot: vi.fn(), getCnMarketSnapshot: vi.fn(), listCampusEvents: vi.fn() }));
vi.mock('../../../../lib/api/onboarding', async (orig) => ({ ...(await orig<object>()), getMarketSnapshot: wire.getMarketSnapshot }));
vi.mock('../../../../lib/api/onboardingCn', async (orig) => ({ ...(await orig<object>()), getCnMarketSnapshot: wire.getCnMarketSnapshot }));
vi.mock('../../../../lib/api/campus', async (orig) => ({ ...(await orig<object>()), listCampusEvents: wire.listCampusEvents }));

import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import * as serverContract from '../../../../server/src/features/onboarding-cn/contract';
import * as serverClass from '../../../../server/src/features/onboarding-cn/classYear';
import * as serverSalary from '../../../../server/src/features/onboarding-cn/salary';
import {
  CN_ONBOARDING_STEP_COMPONENTS,
  CnConfirmStep,
  CnFirstValueScreen,
  CnFirstValueTour,
  CnOnboardingApiProvider,
  CnResumeGate,
  ConsentStep,
  EducationStep,
  IdentityStep,
  INITIAL_CONSENT_STATE,
  IntentStep,
  TagsStep,
  classOfProgram,
  intentBody,
  intentProblems,
  type CnOnboardingApi,
  type IntentForm,
} from '..';
import * as logic from '../logic';
import { campusOpenFrom, defaultCnOnboardingApi, payFromOnboarding, snapshotScope } from '../api';
import { cnSnapshotQuery } from '../../../../lib/api/onboardingCn';
import { tourCards } from '../CnFirstValueTour';
import { consentFormFromLedger } from '../ConsentStep';
import { filterSchools, loadCnPlaceData } from '../places';

const PROSE_VERSION = '2026-10-10.wp13.v1';
const consentItem = (type: string, over: Record<string, unknown> = {}) => ({
  type,
  required: ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'].includes(type),
  stage: 'signup' as const,
  control: type === 'personalized_recommendation' ? ('two_option' as const) : type.startsWith('pipl') || type === 'age_16_plus' ? ('checkbox' as const) : ('toggle' as const),
  withdrawable: true,
  onWithdraw: 'none' as const,
  defaultGranted: false as const,
  prose: `prose:${type}`,
  proseVersion: PROSE_VERSION,
  proseHash: 'h',
  proseLocale: 'en',
  granted: null,
  answeredAt: null,
  ...over,
});
const CN0_CONSENTS = ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border', 'ai_resume_parsing', 'personalized_recommendation', 'marketing_email'].map((t) => consentItem(t));

function makeApi(over: Partial<CnOnboardingApi> = {}) {
  const api = {
    getState: vi.fn(async () => ({ stage: 'consent', nextRoute: '/onboarding/consent', branch: null, answers: {}, entry: null })),
    saveStep: vi.fn(async (step: string) => ({ stage: step, nextStage: 'identity', nextRoute: '/onboarding/identity' })),
    getConsents: vi.fn(async () => CN0_CONSENTS),
    getMyConsents: vi.fn(async () => CN0_CONSENTS),
    recordConsent: vi.fn(async (i: { type: string; granted: boolean }) => ({ type: i.type, granted: i.granted, proseVersion: PROSE_VERSION, proseHash: 'h', at: '', accountClosing: false })),
    suggestRoles: vi.fn(async () => [{ taxonomyId: 'product_manager', label: '产品经理', context: '产品' }]),
    marketSnapshot: vi.fn(async () => ({
      jobs: { value: 128, asOf: '2026-10-10T00:00:00Z', scope: { complete: true, role: '产品经理', city: null } },
      campusOpen: { value: 7, more: false, asOf: null },
      pay: null,
    })),
    campusPrograms: vi.fn(async () => ({ items: [] as never[], more: false })),
    subscribeProgram: vi.fn(async () => undefined),
    ...over,
  };
  return api as typeof api & CnOnboardingApi;
}

function render(ui: React.ReactElement, api: Partial<CnOnboardingApi>, flags: Record<string, boolean> = {}) {
  return renderWithBrand(<CnOnboardingApiProvider api={api}>{ui}</CnOnboardingApiProvider>, { brand: 'goapply', flags });
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
});
afterEach(() => {
  vi.useRealTimers();
});

// ── Mirrors stay equal to the server ──────────────────────────────────────

describe('client mirrors of the server rules', () => {
  it('option lists and limits', () => {
    for (const key of [
      'CN_IDENTITIES',
      'CN_YEARS_EXPERIENCE',
      'CN_JOB_SEARCH_STATUS',
      'CN_DEGREE_OPTIONS',
      'CN_WORK_TYPES',
      'CN_INTERN_MONTHS',
      'CN_START_DATES',
      'CN_EMPLOYER_TYPES',
      'CN_HEARD_FROM',
      'CN_INDUSTRY_CODES',
      'CN_SALARY_K_OPTIONS',
      'CN_SALARY_MONTHS_OPTIONS',
      'CN_INTERN_DAILY_OPTIONS',
      'CN_INTERN_DAYS_OPTIONS',
      'CN_CLASS_YEAR_RANGE',
      'CN_MAX_ROLES',
      'CN_MAX_CITIES',
      'CN_MAX_INDUSTRIES',
      'CN_ANY_CITY',
    ] as const) {
      expect((logic as Record<string, unknown>)[key], key).toEqual((serverContract as Record<string, unknown>)[key]);
    }
    expect(logic.CN_DEFAULT_GRADUATION_MONTH).toBe(serverClass.CN_DEFAULT_GRADUATION_MONTH);
    expect(logic.CAMPUS_SEASON_ROLLOVER_MONTH).toBe(serverClass.CAMPUS_SEASON_ROLLOVER_MONTH);
  });

  it('届别 defaults and the K/月·N薪 display form', () => {
    for (const iso of ['2026-10-10T00:00:00Z', '2026-06-30T15:59:00Z', '2026-06-30T16:00:00Z', '2029-12-31T00:00:00Z']) {
      const d = new Date(iso);
      expect(logic.defaultGraduationClass('yingjie', d)).toBe(serverClass.defaultGraduationClass('yingjie', d));
      expect(logic.defaultGraduationClass('zaixiao', d)).toBe(serverClass.defaultGraduationClass('zaixiao', d));
    }
    expect(logic.formatMonthlyK({ min: 15, max: 25 }, 13)).toBe(serverSalary.formatMonthlyK({ min: 15, max: 25 }, 13));
    expect(logic.formatMonthlyK({ min: 20, max: 20 })).toBe(serverSalary.formatMonthlyK({ min: 20, max: 20 }));
    expect(logic.yuanToK(18500)).toBe('18.5K');
  });

  it('toggleMulti caps and keeps the exclusive value alone', () => {
    expect(logic.toggleMulti(['any'], '上海', { max: 5, exclusive: 'any' })).toEqual(['上海']);
    expect(logic.toggleMulti(['上海'], 'any', { max: 5, exclusive: 'any' })).toEqual(['any']);
    expect(logic.toggleMulti(['a', 'b', 'c'], 'd', { max: 3 })).toEqual(['a', 'b', 'c']);
  });

  it('the school list loads from the sourced data file', async () => {
    const data = await loadCnPlaceData();
    expect(data.schools).toHaveLength(147);
    // Compiled, not yet checked against the official files: no "as of" date.
    expect(data.schoolsSource).toMatchObject({ verified: false, asOf: null });
    expect(data.schoolsSource.compiledAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(filterSchools(data.schools, '复旦').map((s) => s.name)).toEqual(['复旦大学']);
    expect(data.provinces.some((p) => /一线/.test(JSON.stringify(p)))).toBe(false);
  });

  it('maps every GoApply screen to a real component', () => {
    for (const C of Object.values(CN_ONBOARDING_STEP_COMPONENTS)) expect((C as { name?: string }).name).not.toBe('stubStep');
  });
});

// ── G1 ────────────────────────────────────────────────────────────────────

describe('G1 ConsentStep', () => {
  it('starts with nothing checked and no 个性化推荐 choice', async () => {
    expect(INITIAL_CONSENT_STATE).toEqual({ agreement: false, age: false, crossBorder: false, aiProcessing: false, personalizedRecommendation: null, marketing: false });
    render(<ConsentStep step="consent" onDone={vi.fn()} />, makeApi());
    await screen.findByText('prose:pipl_cross_border');
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
    for (const sw of screen.getAllByRole('switch')) expect(sw).not.toBeChecked();
    const radios = within(screen.getByRole('radiogroup', { name: 'Rank jobs using my profile' })).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    for (const r of radios) expect(r).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('下一步 stays disabled until the required boxes are ticked AND 开启/关闭 is chosen', async () => {
    const api = makeApi();
    const onDone = vi.fn();
    render(<ConsentStep step="consent" onDone={onDone} />, api);
    await screen.findByText('prose:pipl_basic_processing');
    fireEvent.click(screen.getByRole('checkbox', { name: 'prose:pipl_basic_processing' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'prose:age_16_plus' }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'prose:pipl_cross_border' }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByText('Choose On or Off for ranking to continue.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeEnabled();
    fireEvent.click(next);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.saveStep).toHaveBeenCalledWith('consent', {
      agreement: true,
      crossBorder: true,
      aiProcessing: false,
      personalizedRecommendation: false,
      marketing: false,
      proseVersion: PROSE_VERSION,
    });
  });

  it('on a mainland deployment there is no cross-border box', async () => {
    const api = makeApi({ getConsents: vi.fn(async () => CN0_CONSENTS.filter((c) => c.type !== 'pipl_cross_border')) });
    render(<ConsentStep step="consent" onDone={vi.fn()} />, api);
    await screen.findByText('prose:age_16_plus');
    expect(screen.queryByText('prose:pipl_cross_border')).toBeNull();
    expect(screen.queryByText(/outside mainland China, with the providers/)).toBeNull();
  });

  it('shows a retry when the consent text cannot load', async () => {
    const api = makeApi({ getConsents: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(CN0_CONSENTS) });
    render(<ConsentStep step="consent" onDone={vi.fn()} />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByText('prose:age_16_plus');
  });

  it('coming back restores the optional answers from the consent ledger, not stale step answers', async () => {
    // Stored G1 answers say AI off; the resume gate turned it on since.
    const api = makeApi({
      getState: vi.fn(async () => ({
        stage: 'identity',
        nextRoute: null,
        branch: null,
        entry: null,
        answers: { consent: { agreement: true, crossBorder: true, aiProcessing: false, personalizedRecommendation: false, marketing: false } },
      })) as never,
      getMyConsents: vi.fn(async () =>
        CN0_CONSENTS.map((c) => (c.type === 'ai_resume_parsing' ? { ...c, granted: true } : c.type === 'personalized_recommendation' ? { ...c, granted: true } : c.required ? { ...c, granted: true } : c)),
      ) as never,
    });
    render(<ConsentStep step="consent" onDone={vi.fn()} />, api);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Use AI to read my resume and prepare materials' })).toBeChecked());
    expect(screen.getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.saveStep).toHaveBeenCalledWith('consent', expect.objectContaining({ aiProcessing: true, personalizedRecommendation: true })));
  });

  it('coming back: 下一步 stays disabled while the ledger cannot be read', async () => {
    const api = makeApi({
      getState: vi.fn(async () => ({ stage: 'identity', nextRoute: null, branch: null, entry: null, answers: { consent: { agreement: true, crossBorder: true, personalizedRecommendation: false } } })) as never,
      getMyConsents: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(CN0_CONSENTS) as never,
    });
    render(<ConsentStep step="consent" onDone={vi.fn()} />, api);
    expect(await screen.findByText("We couldn't load your current choices. Try again before saving.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('consentFormFromLedger: never answered stays unset', () => {
    expect(consentFormFromLedger(CN0_CONSENTS, { crossBorder: true })).toEqual({ agreement: true, age: true, crossBorder: true, aiProcessing: false, personalizedRecommendation: null, marketing: false });
  });
});

// ── G2 ────────────────────────────────────────────────────────────────────

describe('G2 IdentityStep', () => {
  it('应届 defaults to the current campus class (Oct 2026 → 2027) and month 6', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T04:00:00Z'));
    const api = makeApi();
    render(<IdentityStep step="identity" onDone={vi.fn()} />, api);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Graduating soon/ }));
    expect(screen.getByLabelText('Graduation class')).toHaveValue('2027');
    expect(screen.getByLabelText('Graduation month')).toHaveValue('6');
    fireEvent.click(screen.getByRole('radio', { name: /Still in school/ }));
    expect(screen.getByLabelText('Graduation class')).toHaveValue('2028');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.saveStep).toHaveBeenCalledWith('identity', { cnIdentity: 'zaixiao', graduationClass: 2028, graduationMonth: 6 }));
  });

  it('社招 needs years and status', async () => {
    const api = makeApi();
    render(<IdentityStep step="identity" onDone={vi.fn()} />, api);
    fireEvent.click(screen.getByRole('radio', { name: /Experienced/ }));
    expect(screen.queryByLabelText('Graduation class')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: '3–5 years' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Working, open to offers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.saveStep).toHaveBeenCalledWith('identity', { cnIdentity: 'shezhao', yearsExperience: '3-5', jobSearchStatus: 'employed_open' }));
  });

  it('shows a server issue as plain copy', async () => {
    const { RoboApiError } = await import('../../../../lib/api/client');
    const err = new RoboApiError('invalid', { code: 'invalid_request', status: 422, payload: { code: 'invalid_request', details: { issues: [{ path: ['graduationClass'], message: 'required' }] } } });
    const api = makeApi({ saveStep: vi.fn().mockRejectedValue(err) });
    render(<IdentityStep step="identity" onDone={vi.fn()} />, api);
    fireEvent.click(screen.getByRole('radio', { name: /Graduating soon/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Fill in the required fields.');
  });
});

// ── G3 ────────────────────────────────────────────────────────────────────

describe('G3 EducationStep', () => {
  const asStudent = () => makeApi({ getState: vi.fn(async () => ({ stage: 'education', nextRoute: null, branch: null, answers: { identity: { cnIdentity: 'yingjie' } }, entry: null })) as never });

  it('school typeahead over the MOE lists shows marks as information; free text allowed', async () => {
    const api = asStudent();
    render(<EducationStep step="education" onDone={vi.fn()} />, api);
    await waitFor(() => expect(api.getState).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: "Bachelor's" }));
    fireEvent.change(screen.getByRole('combobox', { name: /School/ }), { target: { value: '复旦' } });
    const option = await screen.findByRole('button', { name: /复旦大学/ });
    expect(within(option).getByText('985')).toBeInTheDocument();
    fireEvent.click(option);
    expect(await screen.findByText(/never changes how jobs are ranked/)).toBeInTheDocument();
    expect(screen.getByText(/School marks come only from the 985, 211 and Double First-Class lists\. This copy hasn't been checked/)).toBeInTheDocument();
    expect(screen.queryByText(/as of/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(api.saveStep).toHaveBeenCalledWith('education', { degree: 'bachelor', fullTime: true, overseas: false, school: '复旦大学', schoolId: '复旦大学' }),
    );
  });

  it('下一步 waits for the stored answers (the 应届/在校 rule is not known before)', async () => {
    const api = makeApi({ getState: vi.fn(() => new Promise(() => undefined)) as never });
    render(<EducationStep step="education" onDone={vi.fn()} />, api);
    fireEvent.click(screen.getByRole('radio', { name: "Bachelor's" }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('students get no Skip; 社招 can skip', async () => {
    const student = asStudent();
    const { unmount } = render(<EducationStep step="education" onDone={vi.fn()} />, student);
    await waitFor(() => expect(student.getState).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    unmount();
    const pro = makeApi({ getState: vi.fn(async () => ({ stage: 'education', nextRoute: null, branch: null, answers: { identity: { cnIdentity: 'shezhao' } }, entry: null })) as never });
    render(<EducationStep step="education" onDone={vi.fn()} />, pro);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(pro.saveStep).toHaveBeenCalledWith('education', { skip: true }));
  });
});

// ── G4 ────────────────────────────────────────────────────────────────────

describe('G4 IntentStep', () => {
  const zaixiao = () =>
    makeApi({ getState: vi.fn(async () => ({ stage: 'intent', nextRoute: null, branch: null, answers: { identity: { cnIdentity: 'zaixiao', graduationClass: 2028 } }, entry: null })) as never });

  it('在校 defaults to 实习 (4 days, 3 months); the panel shows real counts with their source', async () => {
    const api = zaixiao();
    render(<IntentStep step="intent" onDone={vi.fn()} />, api);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Internship' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('radio', { name: '4 days' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '3 months' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Add a role to see how many jobs are open.')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /Roles/ }), { target: { value: '产品' } });
    fireEvent.click(await screen.findByRole('button', { name: /产品经理/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Anywhere' }));
    expect(await screen.findByText('128 open jobs in our index', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText('7 campus programs taking applications')).toBeInTheDocument();
    expect(screen.getByText('Not enough posts list pay yet to show a typical figure.')).toBeInTheDocument();
    expect(screen.getByText(/From job posts in .*'s index/)).toBeInTheDocument();
    expect(api.marketSnapshot).toHaveBeenLastCalledWith({ roles: [{ taxonomyId: 'product_manager', label: '产品经理' }], cities: ['any'], classYear: 2028 });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(api.saveStep).toHaveBeenCalledWith('intent', {
        targetRoles: [{ taxonomyId: 'product_manager', label: '产品经理' }],
        cities: ['any'],
        workType: 'internship',
        internDailyPay: 'any',
        internDaysPerWeek: 4,
        internMonths: '3',
        startDate: 'anytime',
        acceptReassignment: false,
      }),
    );
  });

  it('shows pay only at ≥ 20 postings, with N', async () => {
    const api = zaixiao();
    api.marketSnapshot = vi.fn(async () => ({
      jobs: { value: 60, asOf: '2026-10-10T00:00:00Z', scope: { complete: true, role: '运营', city: null } },
      campusOpen: null,
      pay: { kind: 'iqr' as const, median: 18500, low: 15000, high: 22000, listedCount: 24, sampleSize: 24, asOf: '2026-10-10T00:00:00Z' },
    }));
    render(<IntentStep step="intent" onDone={vi.fn()} />, api);
    fireEvent.change(await screen.findByRole('textbox', { name: /Roles/ }), { target: { value: '运营' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: /Roles/ }), { key: 'Enter' });
    expect(
      await screen.findByText(/Typical monthly pay: 18.5K\. Middle half of monthly pay: 15K–22K\. Pay listed on 24 of 60 posts\./, {}, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Campus program counts aren't available yet.")).toBeInTheDocument();
  });

  it("WP-30's pay figures are shown as a plain range, never as the middle half", async () => {
    const api = zaixiao();
    api.marketSnapshot = vi.fn(async () => ({
      jobs: { value: 60, asOf: '2026-10-10T00:00:00Z', scope: { complete: true, role: '运营', city: null } },
      campusOpen: null,
      pay: { kind: 'range' as const, low: 12000, high: 20000, listedCount: 24, sampleSize: 24, asOf: '2026-10-10T00:00:00Z' },
    }));
    render(<IntentStep step="intent" onDone={vi.fn()} />, api);
    fireEvent.change(await screen.findByRole('textbox', { name: /Roles/ }), { target: { value: '运营' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: /Roles/ }), { key: 'Enter' });
    expect(await screen.findByText(/Monthly pay on these posts: 12K–20K\./, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryByText(/Middle half/)).toBeNull();
  });

  it('body and problems for 全职 pay', () => {
    const base: IntentForm = {
      roles: [{ label: '产品经理' }],
      cities: ['上海'],
      industries: ['I'],
      workType: 'full_time',
      negotiable: false,
      salaryMin: 15,
      salaryMax: 25,
      salaryMonths: 13,
      dailyMin: null,
      dailyMax: null,
      days: 4,
      months: '3',
      startDate: 'anytime',
      startDateValue: '',
      acceptReassignment: true,
    };
    expect(intentBody(base, true)).toEqual({
      targetRoles: [{ label: '产品经理' }],
      cities: ['上海'],
      industries: ['I'],
      workType: 'full_time',
      salaryMonthlyK: { min: 15, max: 25 },
      salaryMonths: 13,
      startDate: 'anytime',
      acceptReassignment: true,
    });
    expect(intentBody({ ...base, negotiable: true }, false)).toMatchObject({ salaryMonthlyK: 'negotiable' });
    expect(intentBody(base, false)).not.toHaveProperty('acceptReassignment');
    expect(intentProblems({ ...base, salaryMin: 30, salaryMax: 20 })).toEqual(['salaryOrder']);
    expect(intentProblems({ ...base, roles: [], cities: [] })).toEqual(['roles', 'cities']);
    expect(intentProblems({ ...base, startDate: 'date' })).toEqual(['date']);
  });
});

// ── G5, G7 ────────────────────────────────────────────────────────────────

describe('G5 TagsStep', () => {
  it('都可以 by default, stands alone; Skip saves a skip', async () => {
    const api = makeApi();
    render(<TagsStep step="tags" onDone={vi.fn()} />, api);
    expect(screen.getByRole('button', { name: 'Any' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'State-owned' }));
    expect(screen.getByRole('button', { name: 'Any' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('switch', { name: /hukou/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.saveStep).toHaveBeenCalledWith('tags', { employerTypes: ['soe'], wantsHukou: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(api.saveStep).toHaveBeenCalledWith('tags', { skip: true }));
  });
});

describe('G7 CnConfirmStep', () => {
  const state = (personalizedRecommendation: boolean) => ({
    stage: 'confirm',
    nextRoute: null,
    branch: null,
    entry: null,
    answers: {
      consent: { personalizedRecommendation },
      identity: { cnIdentity: 'yingjie', graduationClass: 2027 },
      intent: { targetRoles: [{ label: '产品经理', taxonomyId: 'product_manager' }], cities: ['上海'] },
    },
  });
  const programs = [
    { id: 'e1', companyName: '某公司', title: '2027届校园招聘', graduationClass: '2027届', kind: 'application', applyOpensAt: null, applyClosesAt: '2026-10-31T00:00:00Z', stages: [], cities: [], roles: [], officialUrl: 'https://example.com/jobs', sourceName: '某公司招聘官网', verifiedAt: '2026-10-08T00:00:00Z', needsReverify: false, subscribed: false },
    { id: 'e2', companyName: '另一家', title: '2028届实习', graduationClass: '2028届', kind: 'application', applyOpensAt: null, applyClosesAt: null, stages: [], cities: [], roles: [], officialUrl: 'https://example.org/c', sourceName: null, verifiedAt: '2026-10-01T00:00:00Z', needsReverify: false, subscribed: false },
  ];

  it('real counts, 届别 eligibility, official links; sorted-by-date notice when personalisation is off', async () => {
    const api = makeApi({ getState: vi.fn(async () => state(false)) as never, campusPrograms: vi.fn(async () => ({ items: programs, more: false })) as never });
    render(<CnConfirmStep step="confirm" onDone={vi.fn()} matchSummary={{ jobCount: 42 }} />, api, { 'jobs.feed': true });
    expect(await screen.findByText('42 jobs at Good fit or better for your search')).toBeInTheDocument();
    expect(await screen.findByText('2 campus programs taking applications')).toBeInTheDocument();
    expect(screen.getByText('For the class of 2027, same as you')).toBeInTheDocument();
    expect(screen.getByText('For the class of 2028')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Official page' })[0]).toHaveAttribute('href', 'https://example.com/jobs');
    expect(screen.getByText(/sorted by date posted/)).toBeInTheDocument();
    expect(api.marketSnapshot).not.toHaveBeenCalled();
    expect(api.campusPrograms).toHaveBeenCalledWith({ classYear: 2027, cities: ['上海'] });
  });

  it('a programme list with more pages says "at least"; the ledger decides the sort notice', async () => {
    const api = makeApi({
      getState: vi.fn(async () => state(true)) as never,
      // Turned off in Settings after G1: the ledger wins over the stored answer.
      getMyConsents: vi.fn(async () => CN0_CONSENTS.map((c) => (c.type === 'personalized_recommendation' ? { ...c, granted: false } : c))) as never,
      campusPrograms: vi.fn(async () => ({ items: programs, more: true })) as never,
    });
    render(<CnConfirmStep step="confirm" onDone={vi.fn()} matchSummary={{ jobCount: 5 }} />, api, { 'jobs.feed': true });
    expect(await screen.findByText('2+ campus programs taking applications')).toBeInTheDocument();
    expect(await screen.findByText(/sorted by date posted/)).toBeInTheDocument();
  });

  it('an index count for one of several roles names that role and city', async () => {
    const api = makeApi({
      getState: vi.fn(async () => state(true)) as never,
      marketSnapshot: vi.fn(async () => ({ jobs: { value: 31, asOf: '2026-10-10T00:00:00Z', scope: { complete: false, role: '产品经理', city: '上海' } }, campusOpen: null, pay: null })) as never,
    });
    render(<CnConfirmStep step="confirm" onDone={vi.fn()} />, api, { 'jobs.feed': true });
    expect(await screen.findByText('31 open 产品经理 jobs in 上海 in our index')).toBeInTheDocument();
    expect(screen.getByText(/This count covers one of your choices/)).toBeInTheDocument();
    expect(screen.queryByText(/for your search/)).toBeNull();
  });

  it('without a matching count it shows the index count; with the feed off only programmes', async () => {
    const rankingOn = vi.fn(async () => CN0_CONSENTS.map((c) => (c.type === 'personalized_recommendation' ? { ...c, granted: true } : c)));
    const api = makeApi({ getState: vi.fn(async () => state(true)) as never, getMyConsents: rankingOn as never });
    const { unmount } = render(<CnConfirmStep step="confirm" onDone={vi.fn()} />, api, { 'jobs.feed': true });
    expect(await screen.findByText('128 open jobs in our index for your search')).toBeInTheDocument();
    expect(screen.queryByText(/sorted by date posted/)).toBeNull();
    unmount();
    const off = makeApi({ getState: vi.fn(async () => state(true)) as never });
    render(<CnConfirmStep step="confirm" onDone={vi.fn()} matchSummary={{ jobCount: 9 }} />, off, { 'jobs.feed': false });
    expect(await screen.findByText('No campus programs taking applications right now')).toBeInTheDocument();
    expect(screen.queryByText(/We found/)).toBeNull();
  });

  it('saves the optional source and extra roles', async () => {
    const api = makeApi({
      getState: vi.fn(async () => state(true)) as never,
      suggestRoles: vi.fn(async () => [{ taxonomyId: 'product_manager', label: '产品经理', context: null }, { taxonomyId: 'product_ops', label: '产品运营', context: null }]) as never,
    });
    const onDone = vi.fn();
    render(<CnConfirmStep step="confirm" onDone={onDone} matchSummary={{ jobCount: 3 }} />, api, { 'jobs.feed': true });
    fireEvent.click(await screen.findByRole('button', { name: '产品运营' }));
    fireEvent.change(screen.getByLabelText(/How did you hear about us/), { target: { value: 'xiaohongshu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.saveStep).toHaveBeenCalledWith('confirm', { extraRoles: [{ taxonomyId: 'product_ops', label: '产品运营' }], heardFrom: 'xiaohongshu' }));
    expect(onDone).toHaveBeenCalled();
    expect(classOfProgram({ graduationClass: '2027届' })).toBe(2027);
  });
});

// ── Snapshot honesty in the default requests (D3) ─────────────────────────

describe('defaultCnOnboardingApi snapshot', () => {
  const cnSnap = (pay: unknown = null) => ({
    jobCount: { value: 40, source: 'index', asOf: '2026-10-09T00:00:00Z' },
    // The route also counts programmes; the panel shows the programme list's count instead (see below).
    campusOpenCount: { value: 99, source: 'campus_calendar', asOf: '2026-10-09T00:00:00Z' },
    pay,
    windowDays: 30,
  });

  beforeEach(() => {
    wire.getCnMarketSnapshot.mockReset();
    wire.getMarketSnapshot.mockReset();
    wire.listCampusEvents.mockReset();
  });

  it('several roles and cities: one request for the whole search, and the count covers all of it', async () => {
    wire.getCnMarketSnapshot.mockResolvedValueOnce(cnSnap());
    wire.listCampusEvents.mockImplementation(async (q: { city?: string }) => ({
      items: [{ id: q.city === '北京' ? 'b' : 'shared' }],
      cursor: q.city === '深圳' ? 'next' : null,
      asOf: q.city === '北京' ? '2026-10-10T08:00:00.000Z' : '2026-10-10T08:00:05.000Z',
    }));
    const view = await defaultCnOnboardingApi.marketSnapshot({
      roles: [{ taxonomyId: 'product_manager', label: '产品经理' }, { taxonomyId: 'data_analyst', label: '数据分析' }, { label: '运营' }],
      cities: ['上海', '北京', '深圳'],
      classYear: 2027,
    });
    expect(wire.getCnMarketSnapshot).toHaveBeenCalledTimes(1);
    expect(wire.getCnMarketSnapshot).toHaveBeenCalledWith({ taxonomyIds: 'product_manager,data_analyst', roles: '运营', cities: '上海,北京,深圳', class: 2027 });
    // WP-30's single-role route is no longer used for the panel.
    expect(wire.getMarketSnapshot).not.toHaveBeenCalled();
    expect(view!.jobs).toEqual({ value: 40, asOf: '2026-10-09T00:00:00Z', scope: { complete: true, role: '产品经理', city: null } });
    // The campus count is the programme list's: every chosen city asked, duplicates merged, a further
    // page means "at least", and it is dated with the list's own as-of (the oldest page), never the browser clock.
    expect(wire.listCampusEvents).toHaveBeenCalledTimes(3);
    expect(view!.campusOpen).toEqual({ value: 2, more: true, asOf: '2026-10-10T08:00:00.000Z' });
  });

  it('one role, 不限: no city is sent; the median and the middle half come from the cn route', async () => {
    wire.getCnMarketSnapshot.mockResolvedValueOnce(cnSnap({ medianMonthly: 15000, p25Monthly: 12000, p75Monthly: 20000, listedCount: 25, sampleSize: 25, currency: 'CNY', period: 'month', source: 'index', asOf: '2026-10-09T00:00:00Z' }));
    wire.listCampusEvents.mockResolvedValue({ items: [], cursor: null, asOf: '2026-10-10T08:00:00.000Z' });
    const view = await defaultCnOnboardingApi.marketSnapshot({ roles: [{ taxonomyId: 'product_manager', label: '产品经理' }], cities: ['any'] });
    expect(wire.getCnMarketSnapshot).toHaveBeenCalledWith({ taxonomyIds: 'product_manager' });
    expect(view!.jobs.scope).toEqual({ complete: true, role: '产品经理', city: null });
    expect(view!.pay).toEqual({ kind: 'iqr', median: 15000, low: 12000, high: 20000, listedCount: 25, sampleSize: 25, asOf: '2026-10-09T00:00:00Z' });
    expect(view!.campusOpen).toEqual({ value: 0, more: false, asOf: '2026-10-10T08:00:00.000Z' });
    expect(snapshotScope({ roles: [{ label: '运营' }], cities: [] })).toBeNull();
  });

  it('with the campus calendar off (the list is refused) no campus count is shown, whatever the snapshot route counted', async () => {
    wire.getCnMarketSnapshot.mockResolvedValueOnce(cnSnap());
    wire.listCampusEvents.mockRejectedValue(new Error('feature_disabled'));
    const view = await defaultCnOnboardingApi.marketSnapshot({ roles: [{ label: '运营' }], cities: [] });
    expect(wire.getCnMarketSnapshot).toHaveBeenCalledWith({ roles: '运营' });
    expect(view!.jobs.value).toBe(40);
    expect(view!.campusOpen).toBeNull();
    expect(campusOpenFrom(null)).toBeNull();
    // A list that states no as-of time shows none.
    expect(campusOpenFrom({ items: [], more: false })).toEqual({ value: 0, more: false, asOf: null });
  });

  it('shows no count rather than a partial one: no roles, a failed request, or a role the route cannot take', async () => {
    wire.listCampusEvents.mockResolvedValue({ items: [], cursor: null, asOf: '2026-10-10T08:00:00.000Z' });
    expect(await defaultCnOnboardingApi.marketSnapshot({ roles: [], cities: ['上海'] })).toBeNull();
    expect(await defaultCnOnboardingApi.marketSnapshot({ roles: [{ label: 'Manager, Sales' }, { label: '运营' }], cities: [] })).toBeNull();
    expect(wire.getCnMarketSnapshot).not.toHaveBeenCalled();
    wire.getCnMarketSnapshot.mockRejectedValueOnce(new Error('down'));
    expect(await defaultCnOnboardingApi.marketSnapshot({ roles: [{ label: '运营' }], cities: [] })).toBeNull();
  });

  it('cnSnapshotQuery: ids and labels apart, duplicates and 不限 dropped, commas make it inexact', () => {
    expect(cnSnapshotQuery({ roles: [{ taxonomyId: 'a', label: 'A' }, { taxonomyId: 'a', label: 'A again' }, { label: ' 运营 ' }, { label: '运营' }], cities: ['any', '上海', '上海'], classYear: null })).toEqual({
      query: { taxonomyIds: 'a', roles: '运营', cities: '上海' },
      exact: true,
    });
    expect(cnSnapshotQuery({ roles: [{ label: '运营' }], cities: ['A,B'] }).exact).toBe(false);
    expect(cnSnapshotQuery({ roles: [], cities: [] })).toEqual({ query: {}, exact: false });
  });

  it('pay only for monthly CNY, and never called "the middle half" from WP-30\'s figures', () => {
    const base = { listedCount: 25, sampleSize: 25, low: 10000, high: 20000, source: 'index' as const, asOf: '2026-10-09T00:00:00Z' };
    expect(payFromOnboarding({ ...base, currency: 'CNY', period: 'month' })).toEqual({ kind: 'range', low: 10000, high: 20000, listedCount: 25, sampleSize: 25, asOf: base.asOf });
    expect(payFromOnboarding({ ...base, currency: 'CNY', period: 'year' })).toBeNull();
    expect(payFromOnboarding({ ...base, currency: 'USD', period: 'month' })).toBeNull();
    expect(payFromOnboarding(null)).toBeNull();
  });
});

// ── Resume gate (manual mode) and first value ─────────────────────────────

describe('CnResumeGate', () => {
  it('with AI consent off: no upload screen, 手动填写 offered, no parse or AI call', async () => {
    const upload = vi.fn();
    const onManual = vi.fn();
    const api = makeApi();
    render(
      <CnResumeGate onManual={onManual}>
        <button type="button" onClick={upload}>
          Upload resume
        </button>
      </CnResumeGate>,
      api,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in my profile by hand' }));
    expect(onManual).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Upload resume' })).toBeNull();
    expect(screen.getByText(/never use them to recommend jobs/)).toBeInTheDocument();
    expect(api.recordConsent).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('turning AI processing on records the consent with the prose shown, then shows the upload', async () => {
    const api = makeApi();
    render(
      <CnResumeGate onManual={vi.fn()}>
        <span>Upload resume</span>
      </CnResumeGate>,
      api,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on AI processing' }));
    await waitFor(() => expect(api.recordConsent).toHaveBeenCalled());
    expect(api.recordConsent).toHaveBeenCalledWith({ type: 'ai_resume_parsing', granted: true, proseVersion: PROSE_VERSION, locale: 'en' });
    expect(await screen.findByText('Upload resume')).toBeInTheDocument();
  });

  it('with AI consent on, renders the upload screen directly', async () => {
    const api = makeApi({ getMyConsents: vi.fn(async () => CN0_CONSENTS.map((c) => (c.type === 'ai_resume_parsing' ? { ...c, granted: true } : c))) as never });
    render(
      <CnResumeGate onManual={vi.fn()}>
        <span>Upload resume</span>
      </CnResumeGate>,
      api,
    );
    expect(await screen.findByText('Upload resume')).toBeInTheDocument();
  });
});

describe('CnFirstValueTour', () => {
  it('subscribes only to the programmes the user ticks, then shows the 3-card tour', async () => {
    const api = makeApi({
      campusPrograms: vi.fn(async () => ({
        items: [
          { id: 'e1', companyName: 'A', title: 'P1', graduationClass: '2027届', applyClosesAt: '2026-10-31T00:00:00Z', subscribed: false },
          { id: 'e2', companyName: 'B', title: 'P2', graduationClass: '2027届', applyClosesAt: null, subscribed: false },
        ],
        more: false,
      })) as never,
    });
    const onFinish = vi.fn();
    render(<CnFirstValueTour classYear={2027} cities={['上海']} campusCalendar aiAllowed onFinish={onFinish} />, api);
    expect(screen.getByRole('heading', { name: 'Get application deadline reminders' })).toBeInTheDocument();
    const boxes = await screen.findAllByRole('checkbox');
    for (const b of boxes) expect(b).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Remind me' })).toBeDisabled();
    fireEvent.click(boxes[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Remind me' }));
    expect(await screen.findByText('Reminder set for 1 program.')).toBeInTheDocument();
    expect(api.subscribeProgram).toHaveBeenCalledTimes(1);
    expect(api.subscribeProgram).toHaveBeenCalledWith('e2');
    expect(api.campusPrograms).toHaveBeenCalledWith({ classYear: 2027, cities: ['上海'] });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Campus calendar' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tailored resume' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Interview practice' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onFinish).toHaveBeenCalled();
  });

  it('with the campus calendar off: no reminder prompt and no calendar card (R-04)', () => {
    render(<CnFirstValueTour campusCalendar={false} aiAllowed onFinish={vi.fn()} />, makeApi());
    expect(screen.getByRole('heading', { name: "Here's what you can do" })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Campus calendar' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Tailored resume' })).toBeInTheDocument();
  });

  it('with AI consent off: no AI features advertised, the manual card instead', () => {
    render(<CnFirstValueTour campusCalendar={false} aiAllowed={false} onFinish={vi.fn()} />, makeApi());
    expect(screen.queryByRole('heading', { name: 'Tailored resume' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Interview practice' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Fill in your profile' })).toBeInTheDocument();
    expect(tourCards({ campusCalendar: true, aiAllowed: false })).toEqual(['calendar', 'manual']);
    expect(tourCards({ campusCalendar: true, aiAllowed: true })).toEqual(['calendar', 'tailor', 'practice']);
  });
});

// ── zh (GoApply's primary language) ───────────────────────────────────────

describe('CnFirstValueScreen (the tour, wired for the signed-in user)', () => {
  const stored = { identity: { cnIdentity: 'yingjie', graduationClass: 2027 }, intent: { cities: ['上海', '杭州'] } };
  const granted = (v: boolean | null) => [consentItem('ai_resume_parsing', { granted: v })];

  it('passes the stored 届别 and cities, the campus capability and the AI consent', async () => {
    const api = makeApi({
      getState: vi.fn(async () => ({ stage: 'tour', nextRoute: '/campus', branch: null, answers: stored, entry: null })) as never,
      getMyConsents: vi.fn(async () => granted(true)) as never,
    });
    render(<CnFirstValueScreen onFinish={() => undefined} />, api, { 'jobs.campusCalendar': true, 'ai.text': true });
    expect(await screen.findByRole('heading', { name: 'Get application deadline reminders' })).toBeInTheDocument();
    expect(api.campusPrograms).toHaveBeenCalledWith({ classYear: 2027, cities: ['上海', '杭州'] });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    for (const card of ['Campus calendar', 'Tailored resume', 'Interview practice']) expect(screen.getByRole('heading', { name: card })).toBeInTheDocument();
  });

  it('AI consent off, never answered, or unreadable: no AI feature is advertised', async () => {
    const cases = [async () => granted(false), async () => granted(null), async () => Promise.reject(new Error('down'))];
    for (const read of cases) {
      const { unmount } = render(<CnFirstValueScreen onFinish={() => undefined} />, makeApi({ getMyConsents: vi.fn(read) as never }), { 'ai.text': true });
      expect(await screen.findByRole('heading', { name: 'Fill in your profile' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Tailored resume' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Interview practice' })).toBeNull();
      unmount();
    }
  });

  it('finishing calls back once; a finish problem is shown under the tour', async () => {
    const onFinish = vi.fn();
    const first = render(<CnFirstValueScreen onFinish={onFinish} />, makeApi({ getMyConsents: vi.fn(async () => granted(true)) as never }), { 'ai.text': true });
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    first.unmount();
    render(<CnFirstValueScreen onFinish={onFinish} error="Something went wrong." />, makeApi(), {});
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
  });
});

describe('zh bundle', () => {
  type Tree = { [k: string]: string | Tree };
  const leaves = (t: Tree, pre = ''): string[] =>
    Object.entries(t).flatMap(([k, v]) => (typeof v === 'string' ? [`${pre}${k}`] : leaves(v, `${pre}${k}.`)));

  it('has every English key, and the same %BRAND% count per key', async () => {
    const en = (await import('../../../../i18n/staging/onboardingCn.en.json')).default as unknown as { onboardingCn: Tree };
    const zh = (await import('../../../../i18n/staging/onboardingCn.zh.json')).default as unknown as { onboardingCn: Tree };
    expect(leaves(zh.onboardingCn).sort()).toEqual(leaves(en.onboardingCn).sort());
    const get = (t: Tree, path: string) => path.split('.').reduce<Tree | string>((n, k) => (n as Tree)[k]!, t) as string;
    for (const key of leaves(en.onboardingCn)) {
      expect(get(zh.onboardingCn, key).split('%BRAND%').length, key).toBe(get(en.onboardingCn, key).split('%BRAND%').length);
    }
    expect(get(zh.onboardingCn, 'tags.hukouHint')).toBe('只在官方信息注明可落户时显示该标签。');
  });

  it('renders G2 in Chinese with 届别 options', async () => {
    const en = (await import('../../../../i18n/staging/onboardingCn.en.json')).default;
    const zh = (await import('../../../../i18n/staging/onboardingCn.zh.json')).default;
    const { renderWithProviders } = await import('../../../../__tests__/utils/renderWithProviders');
    const { BrandProvider } = await import('../../../../lib/brand/BrandProvider');
    const { clientBrandFor } = await import('../../../../lib/brand/client');
    expect(en).toBeTruthy();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T04:00:00Z'));
    renderWithProviders(
      <BrandProvider brand={clientBrandFor('goapply')} initialCapabilities={null}>
        <CnOnboardingApiProvider api={makeApi()}>
          <IdentityStep step="identity" onDone={vi.fn()} />
        </CnOnboardingApiProvider>
      </BrandProvider>,
      { intlLocale: 'zh', intlMessages: zh as never },
    );
    expect(screen.getByRole('heading', { name: '你的身份' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /应届生/ }));
    expect(screen.getByRole('option', { name: '2027届' })).toBeInTheDocument();
    expect(screen.getByLabelText('届别')).toHaveValue('2027');
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled();
  });
});
