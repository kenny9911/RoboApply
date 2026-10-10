// WP-31 web: GoApply onboarding steps G1–G5, the cn confirm page, the resume
// AI-consent gate and the first-value prompt. Requests are injected through
// CnOnboardingApiProvider (no network). Rendered at 375px (the phone layout).
// INT-08: the default open-jobs request goes to the cn snapshot route (every
// role and city in one count) and dates the campus count with the programme
// list's own as-of time; `CnFirstValueScreen` reads the tour's props for the
// signed-in user.
// FIX-8: consents given at sign-up are shown as given on G1 (not asked twice);
// 手动填写资料 opens a real form; 统招 has no preselection; every screen
// carries "Step N of 8"; the confirm screen lists the user's choices.

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
  CN_ONBOARDING_SCREENS,
  ConsentStep,
  EducationStep,
  IdentityStep,
  INITIAL_CONSENT_STATE,
  IntentStep,
  TagsStep,
  classOfProgram,
  cnStepPosition,
  confirmSummaryRows,
  consentsAlreadyGiven,
  consentsGivenToEarlierText,
  intentBody,
  intentProblems,
  manualProfileParts,
  manualProfileProblems,
  normalizeMonth,
  parseSkills,
  EMPTY_MANUAL_PROFILE,
  type CnOnboardingApi,
  type IntentForm,
} from '..';
import * as logic from '../logic';
import { campusOpenFrom, defaultCnOnboardingApi, payFromOnboarding, snapshotScope } from '../api';
import { cnSnapshotQuery } from '../../../../lib/api/onboardingCn';
import { tourCards } from '../CnFirstValueTour';
import { consentFormFromLedger } from '../ConsentStep';
import { filterSchools, loadCnPlaceData } from '../places';
import { ONBOARDING_SCREEN_STAGES } from '../../onboarding/flow';

const PROSE_VERSION = '2026-10-11.fix8.v2';
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

/** A new account's profile: nothing filled in. */
const EMPTY_PROFILE = { firstName: null, lastName: null, education: [], experience: [], skills: [] } as never;
/** The ledger right after the GoApply sign-up form: the three required consents granted, nothing else answered. */
const SIGNED_UP_AT = '2026-10-11T02:00:00.000Z';
const AFTER_SIGNUP = CN0_CONSENTS.map((c) => (c.required ? { ...c, granted: true, answeredAt: SIGNED_UP_AT } : c));

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
    getProfile: vi.fn(async () => EMPTY_PROFILE),
    patchProfile: vi.fn(async () => ({})),
    addEducation: vi.fn(async () => ({})),
    addExperience: vi.fn(async () => ({})),
    putSkills: vi.fn(async () => ({})),
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

  it('the province picker has all 34 provincial-level divisions: 台湾 as well as 香港 and 澳门', async () => {
    const { provinces } = await loadCnPlaceData();
    expect(provinces).toHaveLength(34);
    expect(provinces.map((p) => p.name)).toEqual(expect.arrayContaining(['台湾', '香港', '澳门']));
    expect(provinces.find((p) => p.name === '台湾')).toMatchObject({ code: '71', cities: ['台湾'] });
  });

  it('the progress line counts over the same eight screens as the shared onboarding flow', () => {
    expect([...CN_ONBOARDING_SCREENS]).toEqual([...ONBOARDING_SCREEN_STAGES.goapply]);
    expect(cnStepPosition('consent')).toEqual({ current: 1, total: 8 });
    expect(cnStepPosition('resume')).toEqual({ current: 6, total: 8 });
    expect(cnStepPosition('confirm')).toEqual({ current: 8, total: 8 });
    expect(cnStepPosition('tour')).toBeNull();
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

  it('consents given on the sign-up form are shown as given, not asked a second time; G1 asks only for the optional choices', async () => {
    // Repro: tick the three boxes on /signup, verify the code, land on /onboarding/consent.
    const api = makeApi({ getMyConsents: vi.fn(async () => AFTER_SIGNUP) as never });
    const onDone = vi.fn();
    render(<ConsentStep step="consent" onDone={onDone} />, api);
    await screen.findByText('prose:pipl_cross_border');
    // No required box is left to tick, and nothing blocks 下一步 but the 开启/关闭 choice.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    for (const type of ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border']) {
      const row = document.querySelector(`[data-consent="${type}"]`)!;
      expect(row).toHaveAttribute('data-state', 'given');
      expect(within(row as HTMLElement).getByText(`prose:${type}`)).toBeInTheDocument();
      expect(within(row as HTMLElement).getByText(/^You agreed to this on .*2026/)).toBeInTheDocument();
    }
    expect(screen.getByText("You agreed to these when you signed up, so we don't ask again.")).toBeInTheDocument();
    expect(screen.queryByText('Tick the required boxes to continue.')).toBeNull();
    expect(screen.getByText('Choose On or Off for ranking to continue.')).toBeInTheDocument();
    // The optional choices are still unanswered: nothing is switched on for the user.
    for (const sw of screen.getAllByRole('switch')) expect(sw).not.toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
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

  it('a required consent the ledger does not hold is still a box to tick (only that one)', async () => {
    const api = makeApi({ getMyConsents: vi.fn(async () => AFTER_SIGNUP.map((c) => (c.type === 'pipl_cross_border' ? { ...c, granted: null, answeredAt: null } : c))) as never });
    render(<ConsentStep step="consent" onDone={vi.fn()} />, api);
    const box = await screen.findByRole('checkbox', { name: 'prose:pipl_cross_border' });
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(box);
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(consentsAlreadyGiven(AFTER_SIGNUP)).toEqual(new Map([['pipl_basic_processing', SIGNED_UP_AT], ['age_16_plus', SIGNED_UP_AT], ['pipl_cross_border', SIGNED_UP_AT]]));
    expect(consentsAlreadyGiven(CN0_CONSENTS).size).toBe(0);
  });

  // Review finding: every existing account agreed to the OLD cross-border text; G1 printed the new
  // text with "You agreed to this on {date}" — words the user never saw, shown as words they agreed to.
  it('a consent given under an earlier text is not shown as agreed to the new one: it is asked again, with when the earlier version was agreed', async () => {
    const ledger = AFTER_SIGNUP.map((c) =>
      c.type === 'pipl_cross_border' ? { ...c, answeredProseVersion: '2026-10-10.wp13.v1', answeredTextCurrent: false } : c.required ? { ...c, answeredProseVersion: '2026-10-10.wp13.v1', answeredTextCurrent: true } : c,
    );
    const api = makeApi({ getMyConsents: vi.fn(async () => ledger) as never });
    const onDone = vi.fn();
    render(<ConsentStep step="consent" onDone={onDone} />, api);
    // The two whose words are unchanged stay "given"; the cross-border text is a box again, unticked.
    const box = await screen.findByRole('checkbox', { name: 'prose:pipl_cross_border' });
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(box).not.toBeChecked();
    for (const type of ['pipl_basic_processing', 'age_16_plus']) expect(document.querySelector(`[data-consent="${type}"]`)).toHaveAttribute('data-state', 'given');
    const row = document.querySelector('[data-consent="pipl_cross_border"]')!;
    expect(row).toHaveAttribute('data-state', 'changed');
    expect(within(row as HTMLElement).queryByText(/^You agreed to this/)).toBeNull();
    const note = document.querySelector('[data-consent-note="pipl_cross_border"]')!;
    expect(note.textContent).toMatch(/^You agreed to an earlier version of this text on .*2026\. The text has changed, so please read it and tick the box again\.$/);
    expect(box).toHaveAccessibleDescription(note.textContent!);
    expect(screen.queryByText("You agreed to these when you signed up, so we don't ask again.")).toBeNull();
    // Nothing goes on until it is ticked again.
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByText('Tick the required boxes to continue.')).toBeInTheDocument();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.saveStep).toHaveBeenCalledWith('consent', expect.objectContaining({ crossBorder: true, proseVersion: PROSE_VERSION }));

    expect(consentsAlreadyGiven(ledger)).toEqual(new Map([['pipl_basic_processing', SIGNED_UP_AT], ['age_16_plus', SIGNED_UP_AT]]));
    expect(consentsGivenToEarlierText(ledger)).toEqual(new Map([['pipl_cross_border', SIGNED_UP_AT]]));
    expect(consentFormFromLedger(ledger)).toMatchObject({ agreement: true, age: true, crossBorder: false });
    // A ledger that does not say which text was answered is read as before.
    expect(consentsGivenToEarlierText(AFTER_SIGNUP).size).toBe(0);
  });

  it('says nothing of its own about where AI runs or who processes data: that is in the server prose (one statement, shared with /legal)', async () => {
    const aiProse = '使用 AI 读取我的简历并准备求职材料。AI 请求只发送到中国大陆境内的 AI 服务。';
    const crossProse = '在当前内测阶段，你的个人信息在中国大陆境外处理和存储。境外处理方：数据库 Neon（美国，us-west-2）。';
    const list = CN0_CONSENTS.map((c) => (c.type === 'ai_resume_parsing' ? { ...c, prose: aiProse } : c.type === 'pipl_cross_border' ? { ...c, prose: crossProse } : c));
    render(<ConsentStep step="consent" onDone={vi.fn()} />, makeApi({ getConsents: vi.fn(async () => list) as never }));
    expect(await screen.findByText(aiProse)).toBeInTheDocument();
    expect(screen.getByText(crossProse)).toBeInTheDocument();
    // The old note contradicted the legal page ("AI processing also happens outside mainland China, with the providers listed above").
    expect(screen.queryByText(/AI processing also happens outside mainland China/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/providers listed above|处理方见上方列表/);
  });

  it('shows its place in the eight screens', async () => {
    render(<ConsentStep step="consent" onDone={vi.fn()} />, makeApi());
    expect(await screen.findByText('Step 1 of 8')).toBeInTheDocument();
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

  it('consentFormFromLedger: nothing is assumed — never answered stays unticked and unset', () => {
    expect(consentFormFromLedger(CN0_CONSENTS)).toEqual({ ...INITIAL_CONSENT_STATE });
    expect(consentFormFromLedger(AFTER_SIGNUP)).toEqual({ agreement: true, age: true, crossBorder: true, aiProcessing: false, personalizedRecommendation: null, marketing: false });
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
      // 统招 was not answered, so no answer is sent (it used to be sent as `true` without the user saying so).
      expect(api.saveStep).toHaveBeenCalledWith('education', { degree: 'bachelor', overseas: false, school: '复旦大学', schoolId: '复旦大学' }),
    );
  });

  it('统招 starts unanswered; yes or no is sent only when chosen, and a second press clears it', async () => {
    const api = asStudent();
    render(<EducationStep step="education" onDone={vi.fn()} />, api);
    await waitFor(() => expect(api.getState).toHaveBeenCalled());
    expect(screen.getByText('Step 3 of 8')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: /Full-time program/ });
    const yes = within(group).getByRole('button', { name: 'Yes' });
    const no = within(group).getByRole('button', { name: 'No' });
    expect(yes).toHaveAttribute('aria-pressed', 'false');
    expect(no).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('switch', { name: /Full-time program/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: "Bachelor's" }));
    fireEvent.change(screen.getByRole('combobox', { name: /School/ }), { target: { value: '某某学院' } });
    fireEvent.click(no);
    expect(no).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.saveStep).toHaveBeenLastCalledWith('education', { degree: 'bachelor', fullTime: false, overseas: false, school: '某某学院' }));
    fireEvent.click(no);
    expect(no).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.saveStep).toHaveBeenLastCalledWith('education', { degree: 'bachelor', overseas: false, school: '某某学院' }));
  });

  it('a stored 统招 answer comes back as chosen', async () => {
    const api = makeApi({
      getState: vi.fn(async () => ({ stage: 'education', nextRoute: null, branch: null, entry: null, answers: { identity: { cnIdentity: 'yingjie' }, education: { degree: 'master', fullTime: true, school: '复旦大学', overseas: false } } })) as never,
    });
    render(<EducationStep step="education" onDone={vi.fn()} />, api);
    await waitFor(() => expect(within(screen.getByRole('group', { name: /Full-time program/ })).getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'true'));
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

  it('"Check your setup" lists the settings the user chose, each with a way back to its screen', async () => {
    const answers = {
      consent: { personalizedRecommendation: false },
      identity: { cnIdentity: 'yingjie', graduationClass: 2027, graduationMonth: 6 },
      education: { degree: 'bachelor', school: '复旦大学', major: '统计学', fullTime: false, overseas: false },
      intent: { targetRoles: [{ label: '产品经理', taxonomyId: 'product_manager' }, { label: '数据分析' }], cities: ['上海', '杭州'], workType: 'full_time', salaryMonthlyK: { min: 15, max: 25 }, salaryMonths: 13, startDate: 'anytime' },
      tags: { employerTypes: ['soe', 'foreign'], wantsHukou: true },
      resume: { skip: true },
    };
    const api = makeApi({
      getState: vi.fn(async () => ({ stage: 'confirm', nextRoute: null, branch: null, entry: null, answers })) as never,
      getMyConsents: vi.fn(async () => CN0_CONSENTS.map((c) => (c.type === 'personalized_recommendation' || c.type === 'ai_resume_parsing' ? { ...c, granted: false } : c))) as never,
    });
    render(<CnConfirmStep step="confirm" onDone={vi.fn()} matchSummary={{ jobCount: 3 }} />, api, { 'jobs.feed': true });
    const summary = await screen.findByTestId('cn-confirm-summary');
    expect(within(summary).getByRole('heading', { name: 'Your choices' })).toBeInTheDocument();
    const row = (id: string) => (summary.querySelector(`[data-row="${id}"]`) as HTMLElement).textContent;
    expect(row('identity')).toContain('Graduating soon · Class of 2027');
    expect(row('education')).toContain("Bachelor's · 复旦大学 · 统计学 · Full-time program: no");
    expect(row('roles')).toContain('产品经理 · 数据分析');
    expect(row('cities')).toContain('上海 · 杭州');
    expect(row('workType')).toContain('Full-time');
    expect(row('pay')).toContain('15-25K·13薪');
    expect(row('employer')).toContain('State-owned · Foreign company');
    expect(row('resume')).toContain('Not added. You can fill in your profile by hand.');
    // The consent rows come from the ledger once it is read.
    await waitFor(() => expect(row('ai')).toContain('Off'));
    expect(row('ranking')).toContain('Off');
    expect(within(summary).getByRole('link', { name: 'Change Roles' })).toHaveAttribute('href', '/onboarding/intent');
    expect(within(summary).getByRole('link', { name: 'Change Education' })).toHaveAttribute('href', '/onboarding/education');
    expect(within(summary).getByRole('link', { name: 'Change AI processing' })).toHaveAttribute('href', '/onboarding/consent');
    expect(screen.getByText('Step 8 of 8')).toBeInTheDocument();
  });

  it('the summary fills in nothing for the user: a skipped step says so, an unanswered question says "Not filled in"', () => {
    const t = ((key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key)) as never;
    const rows = confirmSummaryRows({ identity: { cnIdentity: 'shezhao', yearsExperience: '3-5', jobSearchStatus: 'employed_open' }, education: { skip: true }, intent: { targetRoles: [{ label: '会计' }], cities: ['any'], workType: 'full_time' }, tags: { skip: true } }, null, t);
    const value = (id: string) => rows.find((r) => r.id === id)?.value;
    expect(value('identity')).toBe('identity.option.shezhao.title · identity.years.y3to5 · identity.status.employed_open');
    expect(value('education')).toBe('confirm.skipped');
    expect(value('cities')).toBe('intent.anyCity');
    expect(value('pay')).toBe('confirm.notSet');
    expect(value('employer')).toBe('confirm.skipped');
    expect(value('resume')).toBe('confirm.resumeNone');
    // 统招 is not mentioned when it was not answered; the consent rows wait for the ledger.
    expect(confirmSummaryRows({ education: { degree: 'bachelor', school: 'X' } }, null, t).find((r) => r.id === 'education')!.value).toBe('education.degree.bachelor · X');
    expect(rows.some((r) => r.id === 'ai' || r.id === 'ranking')).toBe(false);
    const withLedger = confirmSummaryRows({}, { aiProcessing: null, personalized: true }, t);
    expect(withLedger.find((r) => r.id === 'ai')!.value).toBe('confirm.notChosen');
    expect(withLedger.find((r) => r.id === 'ranking')!.value).toBe('consent.rankOn');
    expect(withLedger.find((r) => r.id === 'identity')!.value).toBe('confirm.notSet');
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
  it('with AI consent off: no upload screen; 手动填写资料 opens the manual form (it does not skip ahead)', async () => {
    const upload = vi.fn();
    const onManual = vi.fn();
    const api = makeApi({
      getState: vi.fn(async () => ({ stage: 'resume', nextRoute: null, branch: null, entry: null, answers: { identity: { cnIdentity: 'yingjie' }, education: { degree: 'bachelor', school: '南京大学', major: '统计学' } } })) as never,
    });
    render(
      <CnResumeGate onManual={onManual}>
        <button type="button" onClick={upload}>
          Upload resume
        </button>
      </CnResumeGate>,
      api,
    );
    expect(await screen.findByText('Step 6 of 8')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in my profile by hand' }));
    // Repro of the bug: this used to call onManual at once, so the user went to "Finding jobs" with no form.
    expect(onManual).not.toHaveBeenCalled();
    const form = await screen.findByTestId('cn-manual-profile');
    expect(within(form).getByRole('heading', { name: 'Fill in your profile by hand' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload resume' })).toBeNull();
    expect(screen.getByText(/never use them to recommend jobs/)).toBeInTheDocument();
    // The G3 answers are offered as an education row (the profile has none yet); nothing else is prefilled.
    await waitFor(() => expect(screen.getByLabelText('School')).toHaveValue('南京大学'));
    expect(screen.getByLabelText('Highest degree')).toHaveValue("Bachelor's");
    expect(screen.getByLabelText('Company')).toHaveValue('');
    for (const k of ['Internship', 'Job']) expect(screen.getByRole('button', { name: k })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.change(screen.getByLabelText('Family name'), { target: { value: '林' } });
    fireEvent.change(screen.getByLabelText('Given name'), { target: { value: '知远' } });
    fireEvent.click(screen.getByRole('button', { name: 'Internship' }));
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: '某科技公司' } });
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: '数据分析实习生' } });
    fireEvent.change(screen.getByLabelText('Start month'), { target: { value: '2026-06' } });
    fireEvent.change(screen.getByLabelText('End month'), { target: { value: '2026-09' } });
    fireEvent.change(screen.getByLabelText('Separate skills with commas'), { target: { value: 'Python、SQL, python' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(onManual).toHaveBeenCalledTimes(1));
    expect(api.patchProfile).toHaveBeenCalledWith({ lastName: '林', firstName: '知远' });
    expect(api.addEducation).toHaveBeenCalledWith({ school: '南京大学', degree: "Bachelor's", major: '统计学' });
    expect(api.addExperience).toHaveBeenCalledWith({ company: '某科技公司', title: '数据分析实习生', kind: 'internship', startDate: '2026-06', endDate: '2026-09' });
    expect(api.putSkills).toHaveBeenCalledWith({ skills: [{ name: 'Python', confirmed: true }, { name: 'SQL', confirmed: true }] });
    // Manual mode: no consent is recorded and nothing is uploaded or parsed.
    expect(api.recordConsent).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('manual form: nothing typed cannot be saved; 稍后填写 continues without saving; Back returns to the notice', async () => {
    const onManual = vi.fn();
    const api = makeApi();
    render(
      <CnResumeGate onManual={onManual}>
        <span>Upload resume</span>
      </CnResumeGate>,
      api,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in my profile by hand' }));
    const save = await screen.findByRole('button', { name: 'Save and continue' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByText('Fill in at least one item, or choose Fill in later.')).toBeInTheDocument();
    expect(onManual).not.toHaveBeenCalled();
    // An experience that was started needs its company, title and type.
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: '某公司' } });
    fireEvent.click(save);
    expect(await screen.findByText('Add the company, the job title and the type for this experience.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('button', { name: 'Fill in my profile by hand' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fill in my profile by hand' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in later' }));
    expect(onManual).toHaveBeenCalledTimes(1);
    expect(api.patchProfile).not.toHaveBeenCalled();
    expect(api.addExperience).not.toHaveBeenCalled();
  });

  it('manual form: a retry after a failed save does not add a saved row a second time', async () => {
    const onManual = vi.fn();
    const api = makeApi({ putSkills: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({}) as never });
    render(
      <CnResumeGate onManual={onManual}>
        <span>Upload resume</span>
      </CnResumeGate>,
      api,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in my profile by hand' }));
    await screen.findByTestId('cn-manual-profile');
    fireEvent.click(screen.getByRole('button', { name: 'Job' }));
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: '某公司' } });
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: '会计' } });
    fireEvent.click(screen.getByRole('switch', { name: 'I still work here' }));
    fireEvent.change(screen.getByLabelText('Separate skills with commas'), { target: { value: 'Excel' } });
    const save = screen.getByRole('button', { name: 'Save and continue' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByText(/Some of this wasn't saved/)).toBeInTheDocument();
    expect(onManual).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(onManual).toHaveBeenCalledTimes(1));
    expect(api.addExperience).toHaveBeenCalledTimes(1);
    expect(api.addExperience).toHaveBeenCalledWith({ company: '某公司', title: '会计', kind: 'work', current: true });
    expect(api.putSkills).toHaveBeenCalledTimes(2);
  });

  it('manual form: a profile that already has an education row and skills keeps them (no second school, skills merged)', async () => {
    const onManual = vi.fn();
    const profile = { firstName: '知远', lastName: '林', education: [{ id: 'e1', school: '南京大学' }], experience: [], skills: [{ name: 'Excel', confirmed: true }] };
    const api = makeApi({
      getProfile: vi.fn(async () => profile) as never,
      getState: vi.fn(async () => ({ stage: 'resume', nextRoute: null, branch: null, entry: null, answers: { education: { degree: 'bachelor', school: '南京大学' } } })) as never,
    });
    render(
      <CnResumeGate onManual={onManual}>
        <span>Upload resume</span>
      </CnResumeGate>,
      api,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in my profile by hand' }));
    await waitFor(() => expect(screen.getByLabelText('Family name')).toHaveValue('林'));
    // The education group is not offered again.
    expect(screen.queryByLabelText('School')).toBeNull();
    fireEvent.change(screen.getByLabelText('Separate skills with commas'), { target: { value: 'excel, SQL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(onManual).toHaveBeenCalledTimes(1));
    expect(api.addEducation).not.toHaveBeenCalled();
    expect(api.putSkills).toHaveBeenCalledWith({ skills: [{ name: 'Excel', confirmed: true }, { name: 'SQL', confirmed: true }] });
  });

  it('manual form rules: skills are split and de-duplicated; no education row when the profile has one; dates in order', () => {
    expect(parseSkills('Python、SQL, python；Excel\n ')).toEqual(['Python', 'SQL', 'Excel']);
    const f = { ...EMPTY_MANUAL_PROFILE, school: '南京大学', degree: '本科' };
    expect(manualProfileParts(f, true).education).toEqual({ school: '南京大学', degree: '本科' });
    expect(manualProfileParts(f, false).education).toBeNull();
    expect(manualProfileProblems({ ...EMPTY_MANUAL_PROFILE }, true)).toEqual(['empty']);
    expect(manualProfileProblems({ ...EMPTY_MANUAL_PROFILE, lastName: '林' }, true)).toEqual([]);
    expect(manualProfileProblems({ ...EMPTY_MANUAL_PROFILE, kind: 'work', company: 'A', title: 'B', start: '2026-05', end: '2026-01' }, true)).toEqual(['dates']);
    expect(manualProfileProblems({ ...EMPTY_MANUAL_PROFILE, title: 'B' }, true)).toEqual(['experience']);
  });

  // Review finding: Firefox and Safari on desktop show <input type="month"> as a plain text box. A month
  // typed as "2024/03" or "2024年3月" was dropped without a word and the experience saved with no dates.
  it('a month typed by hand is understood in the usual spellings, and one that is not is refused — never dropped silently', () => {
    for (const typed of ['2024-03', '2024-3', '2024/03', '2024/3', '2024.03', '2024年3月', '2024年03月', ' 2024 年 3 月 ', '202403']) expect(normalizeMonth(typed), typed).toBe('2024-03');
    for (const typed of ['', '  ', '2024', '03/2024', '2024-13', '2024-00', '24-03', 'March 2024', '2024-03-15', '20243']) expect(normalizeMonth(typed), typed).toBeNull();
    const exp = { ...EMPTY_MANUAL_PROFILE, kind: 'work' as const, company: 'A', title: 'B' };
    // Typed by hand: saved as the month it means.
    expect(manualProfileParts({ ...exp, start: '2024/03', end: '2025年1月' }, true).experience).toMatchObject({ startDate: '2024-03', endDate: '2025-01' });
    expect(manualProfileProblems({ ...exp, start: '2024/03', end: '2025年1月' }, true)).toEqual([]);
    // Not a month: a problem, for either field.
    expect(manualProfileProblems({ ...exp, start: 'March 2024' }, true)).toEqual(['dateFormat']);
    expect(manualProfileProblems({ ...exp, start: '2024-03', end: 'now' }, true)).toEqual(['dateFormat']);
    // "I work here now" clears and disables the end month, so it is not checked.
    expect(manualProfileProblems({ ...exp, start: '2024-03', end: 'now', current: true }, true)).toEqual([]);
    // The order check reads the typed spellings too.
    expect(manualProfileProblems({ ...exp, start: '2026/5', end: '2026年1月' }, true)).toEqual(['dates']);
  });

  it('where the browser has no month picker, a month it cannot read stops the save and says how to write it', async () => {
    const api = makeApi();
    const onManual = vi.fn();
    render(
      <CnResumeGate onManual={onManual}>
        <span>Upload resume</span>
      </CnResumeGate>,
      api,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in my profile by hand' }));
    await screen.findByTestId('cn-manual-profile');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save and continue' })).toBeEnabled());
    const start = screen.getByLabelText('Start month') as HTMLInputElement;
    const end = screen.getByLabelText('End month') as HTMLInputElement;
    // The text-box fallback shows how to write a month.
    expect(start).toHaveAttribute('placeholder', 'YYYY-MM');
    expect(end).toHaveAttribute('placeholder', 'YYYY-MM');
    // What Firefox and Safari on desktop do with type="month": a plain text box that takes any text
    // (jsdom, like Chromium, empties a month input that is given anything but YYYY-MM).
    const typeInto = (input: HTMLInputElement, value: string) => {
      input.setAttribute('type', 'text');
      fireEvent.change(input, { target: { value } });
    };
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: '某公司' } });
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: '产品实习生' } });
    fireEvent.click(screen.getByRole('button', { name: 'Internship' }));
    typeInto(start, 'March 2024');
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write each month as year and month, like 2024-03.');
    expect(api.addExperience).not.toHaveBeenCalled();
    expect(onManual).not.toHaveBeenCalled();
    // Written the way people write it: saved as that month.
    typeInto(start, '2024/03');
    typeInto(end, '2024年9月');
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(onManual).toHaveBeenCalledTimes(1));
    expect(api.addExperience).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2024-03', endDate: '2024-09' }));
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
    // WP-91 merged the staged onboardingCn strings into the en and zh bundles.
    const en = (await import('../../../../i18n/messages/en.json')).default as unknown as { onboardingCn: Tree };
    const zh = (await import('../../../../i18n/messages/zh.json')).default as unknown as { onboardingCn: Tree };
    expect(leaves(en.onboardingCn).length).toBeGreaterThan(100);
    expect(leaves(zh.onboardingCn).sort()).toEqual(leaves(en.onboardingCn).sort());
    const get = (t: Tree, path: string) => path.split('.').reduce<Tree | string>((n, k) => (n as Tree)[k]!, t) as string;
    for (const key of leaves(en.onboardingCn)) {
      expect(get(zh.onboardingCn, key).split('%BRAND%').length, key).toBe(get(en.onboardingCn, key).split('%BRAND%').length);
    }
    expect(get(zh.onboardingCn, 'tags.hukouHint')).toBe('只在官方信息注明可落户时显示该标签。');
  });

  it('renders G2 in Chinese with 届别 options', async () => {
    const en = { onboardingCn: (await import('../../../../i18n/messages/en.json')).default.onboardingCn };
    const zh = { onboardingCn: (await import('../../../../i18n/messages/zh.json')).default.onboardingCn };
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
