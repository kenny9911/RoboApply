// FND-6b — seam stubs (TASK_PLAN.md §4.1.e).
//
// Acceptance: every stub exports the props contract its consumer needs (type
// test — `expectTypeOf` lines are checked by `npm run typecheck:web`, which
// compiles __tests__), renders nothing (or, for a wrapper, its children), and
// is reachable through its area's index.ts (§2.1 rule 4). MarketJobMeta's
// per-market dispatch is real and tested here.
//
// Owners fill these files without touching this one: the props contracts
// stay valid after a fill, and the render-nothing checks run only while the
// component's file still carries its `STUB (FND…)` header (a filled component
// is tested by its owner).

import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import { renderWithBrand } from '../shell/helpers';
import { mockAuthState, buildAuthValue } from '../utils/mockAuth';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const slots = vi.hoisted(() => ({ cn: [] as unknown[], tw: [] as unknown[] }));
vi.mock('../../components/features/market/cn', () => ({
  JobMetaCn: (p: unknown) => {
    slots.cn.push(p);
    return <i data-testid="meta-cn" />;
  },
}));
vi.mock('../../components/features/market/tw', () => ({
  JobMetaTw: (p: unknown) => {
    slots.tw.push(p);
    return <i data-testid="meta-tw" />;
  },
}));

import * as job from '../../components/features/job';
import * as network from '../../components/features/network';
import * as offers from '../../components/features/offers';
import * as visitor from '../../components/features/visitor';
import * as growth from '../../components/features/growth';
import * as credits from '../../components/features/credits';
import * as market from '../../components/features/market';
import * as authCn from '../../components/features/auth-cn';
import * as extension from '../../components/features/extension';
import * as coaching from '../../components/features/coaching';
import * as notifyCn from '../../components/features/notify-cn';
import * as practiceCn from '../../components/features/practice-cn';
import * as onboardingCn from '../../components/features/onboarding-cn';
import * as auth from '../../components/features/auth';
import * as search from '../../components/features/search';
import * as notifications from '../../components/features/notifications';
import * as compliance from '../../components/features/compliance';
import * as brand from '../../components/features/brand';
import * as copilot from '../../components/features/copilot';
import * as profile from '../../components/features/profile';
import { AUTH_METHOD_COMPONENTS, type AuthMethodProps } from '../../components/auth/methods/registry';
import { EmailMethod } from '../../components/auth/methods/EmailMethod';
import { GoogleMethod } from '../../components/auth/methods/GoogleMethod';
import { LineMethod } from '../../components/auth/methods/LineMethod';
import { SECTION_COMPONENTS } from '../../components/features/settings/sectionComponents';
import type { SettingsSectionId } from '../../components/features/settings/registry';
import type { SettingsSectionProps } from '../../components/features/settings/sectionComponents';
import type { PublicFeedItem } from '../../lib/api/contracts/feed';
import type { StepResponse as OnboardingStepResponse } from '../../lib/api/contracts/onboarding';
import { GOAPPLY_ONBOARDING_STAGES } from '../../server/src/features/onboarding/contract';

/** True while the file still carries its FND stub header. */
function stillStub(rel: string): boolean {
  return /\bSTUB(?: SEAM)? \(FND/.test(readFileSync(join(process.cwd(), rel), 'utf8'));
}

beforeEach(() => {
  slots.cn = [];
  slots.tw = [];
  mockAuthState.value = buildAuthValue();
});

describe('props contracts (compile-time)', () => {
  it('job, people, offers, extension, coaching, practice', () => {
    expectTypeOf<ComponentProps<typeof job.JobDetailPanel>>().toEqualTypeOf<job.JobDetailPanelProps>();
    expectTypeOf<job.JobDetailPanelProps>().toEqualTypeOf<{ jobId: string; mode: 'split' | 'page'; onClose?: () => void }>();
    expectTypeOf<network.PeoplePanelProps>().toEqualTypeOf<{ jobId: string; companyId: string | null; companyName: string }>();
    expectTypeOf<offers.OfferSectionProps>().toEqualTypeOf<{ trackerEntryId: string; onChange?: () => void }>();
    expectTypeOf<offers.OfferComparisonProps>().toEqualTypeOf<{ trackerEntryIds?: readonly string[] }>();
    expectTypeOf<extension.FillWithExtensionButtonProps>().toEqualTypeOf<{ jobId: string; applyUrl: string | null }>();
    expectTypeOf<coaching.PracticeReportCoachLineProps>().toEqualTypeOf<{ sessionId: string; jobId?: string | null }>();
    expectTypeOf<practiceCn.CnReportProps>().toEqualTypeOf<{ sessionId: string }>();
  });

  it('visitor, growth, credits', () => {
    expectTypeOf<visitor.VisitorFeedProps['from']>().toEqualTypeOf<string>();
    expectTypeOf<visitor.VisitorFeedProps['initialItems']>().toEqualTypeOf<readonly PublicFeedItem[] | undefined>();
    expectTypeOf<visitor.VisitorFeedQuery>().toEqualTypeOf<{ role?: string; city?: string; country?: string }>();
    expectTypeOf<growth.GettingStartedChecklistProps>().toEqualTypeOf<{ variant?: 'card' | 'compact' }>();
    // Mounted once with no props; reads useOutOfCredits().
    expectTypeOf<credits.OutOfCreditsSheetProps>().toEqualTypeOf<Record<string, never>>();
  });

  it('market slots', () => {
    expectTypeOf<market.MarketJobMetaProps>().toEqualTypeOf<{
      jobId: string;
      meta: market.MarketCardMeta | null | undefined;
      variant: 'card' | 'detail';
    }>();
    expectTypeOf<market.LegalFooterProps>().toEqualTypeOf<{ variant?: 'marketing' | 'app' }>();
    expectTypeOf<market.AiGeneratedBadgeProps>().toEqualTypeOf<{ kind?: 'text' | 'document' | 'audio' }>();
    expectTypeOf<market.PriceReferenceProps>().toEqualTypeOf<{ amountMinor: number; currency: 'USD' }>();
  });

  it('sign-in methods take AuthMethodProps; settings sections take SettingsSectionProps', () => {
    for (const Method of [authCn.PhoneMethod, authCn.WechatMethod, EmailMethod, GoogleMethod, LineMethod]) {
      expectTypeOf(Method).toMatchTypeOf<ComponentType<AuthMethodProps>>();
    }
    for (const Section of [
      auth.AuthSettingsSection,
      search.SearchSettingsSection,
      notifications.NotificationsSettingsSection,
      credits.CreditsSettingsSection,
      compliance.ComplianceSettingsSection,
      brand.BrandSettingsSection,
      copilot.CopilotSettingsSection,
      extension.ExtensionSettingsSection,
      network.NetworkSettingsSection,
      growth.GrowthSettingsSection,
      profile.ProfileSettingsSection,
    ]) {
      expectTypeOf(Section).toMatchTypeOf<ComponentType<SettingsSectionProps>>();
    }
  });

  it('GoApply onboarding steps', () => {
    expectTypeOf<onboardingCn.CnOnboardingStepProps['onDone']>().toEqualTypeOf<(response: OnboardingStepResponse) => void>();
    expectTypeOf(onboardingCn.CN_ONBOARDING_STEP_COMPONENTS).toEqualTypeOf<
      Readonly<Record<onboardingCn.CnOnboardingStep, ComponentType<onboardingCn.CnOnboardingStepProps>>>
    >();
    expectTypeOf<notifyCn.SubscribeOnTapProps>().toEqualTypeOf<{ template: notifyCn.SubscribeTemplate; children: ReactNode }>();
  });
});

describe('stubs render nothing (while still stubs)', () => {
  const noop = () => {};
  const F = 'components/features';
  const cases: Array<[string, string, () => ReactNode]> = [
    ['JobDetailPanel split', `${F}/job/JobDetailPanel.tsx`, () => <job.JobDetailPanel jobId="cm1" mode="split" onClose={noop} />],
    ['JobDetailPanel page', `${F}/job/JobDetailPanel.tsx`, () => <job.JobDetailPanel jobId="cm1" mode="page" />],
    ['PeoplePanel', `${F}/network/PeoplePanel.tsx`, () => <network.PeoplePanel jobId="cm1" companyId={null} companyName="Acme" />],
    ['OfferSection', `${F}/offers/OfferSection.tsx`, () => <offers.OfferSection trackerEntryId="t1" />],
    ['OfferComparison', `${F}/offers/OfferComparison.tsx`, () => <offers.OfferComparison />],
    ['VisitorFeed', `${F}/visitor/VisitorFeed.tsx`, () => <visitor.VisitorFeed from="browse" query={{ role: 'data-analyst' }} />],
    ['GettingStartedChecklist', `${F}/growth/GettingStartedChecklist.tsx`, () => <growth.GettingStartedChecklist />],
    ['OutOfCreditsSheet', `${F}/credits/OutOfCreditsSheet.tsx`, () => <credits.OutOfCreditsSheet />],
    ['LegalFooter', `${F}/market/LegalFooter.tsx`, () => <market.LegalFooter />],
    ['AiGeneratedBadge', `${F}/market/AiGeneratedBadge.tsx`, () => <market.AiGeneratedBadge kind="text" />],
    ['PriceReference', `${F}/market/PriceReference.tsx`, () => <market.PriceReference amountMinor={1999} currency="USD" />],
    ['PhoneMethod', `${F}/auth-cn/PhoneMethod.tsx`, () => <authCn.PhoneMethod mode="login" />],
    ['WechatMethod', `${F}/auth-cn/WechatMethod.tsx`, () => <authCn.WechatMethod mode="signup" next="/jobs" />],
    ['EmailMethod', 'components/auth/methods/EmailMethod.tsx', () => <EmailMethod mode="login" />],
    ['GoogleMethod', 'components/auth/methods/GoogleMethod.tsx', () => <GoogleMethod mode="login" startUrl="/api/v1/roboapply/auth/oauth/google/start" />],
    ['LineMethod', 'components/auth/methods/LineMethod.tsx', () => <LineMethod mode="signup" />],
    ['FillWithExtensionButton', `${F}/extension/FillWithExtensionButton.tsx`, () => <extension.FillWithExtensionButton jobId="cm1" applyUrl="https://example.com/apply" />],
    ['PracticeReportCoachLine', `${F}/coaching/PracticeReportCoachLine.tsx`, () => <coaching.PracticeReportCoachLine sessionId="s1" />],
    ['CnReport', `${F}/practice-cn/CnReport.tsx`, () => <practiceCn.CnReport sessionId="s1" />],
  ];
  it.each(cases)('%s', (_name, file, make) => {
    if (!stillStub(file)) return;
    const { container } = renderWithBrand(<>{make()}</>, { flags: {} });
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['account', 'auth', auth.AuthSettingsSection],
    ['search', 'search', search.SearchSettingsSection],
    ['notifications', 'notifications', notifications.NotificationsSettingsSection],
    ['credits', 'credits', credits.CreditsSettingsSection],
    ['consents', 'compliance', compliance.ComplianceSettingsSection],
    ['appearance', 'brand', brand.BrandSettingsSection],
    ['assistant', 'copilot', copilot.CopilotSettingsSection],
    ['devices', 'extension', extension.ExtensionSettingsSection],
    ['connections', 'network', network.NetworkSettingsSection],
    ['referrals', 'growth', growth.GrowthSettingsSection],
    ['sensitive', 'profile', profile.ProfileSettingsSection],
  ] as Array<[SettingsSectionId, string, ComponentType<SettingsSectionProps>]>)('SettingsSection #%s', (section, area, Section) => {
    if (!stillStub(`${F}/${area}/SettingsSection.tsx`)) return;
    const { container } = render(<Section section={section} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('every GoApply step component that is still the stub', () => {
    for (const step of onboardingCn.CN_ONBOARDING_STEPS) {
      const Step = onboardingCn.CN_ONBOARDING_STEP_COMPONENTS[step];
      if ((Step as { name?: string }).name !== 'stubStep') continue;
      const { container, unmount } = render(<Step step={step} onDone={() => {}} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});

describe('seams are wired before their owners fill them (no hot-file edit needed later)', () => {
  it('every sign-in method has its component registered', () => {
    expect(AUTH_METHOD_COMPONENTS).toEqual({
      email_password: EmailMethod,
      google: GoogleMethod,
      line: LineMethod,
      phone_otp: authCn.PhoneMethod,
      wechat: authCn.WechatMethod,
    });
  });

  it('the six area-owned settings sections are registered', () => {
    expect(SECTION_COMPONENTS).toMatchObject({
      consents: compliance.ComplianceSettingsSection,
      assistant: copilot.CopilotSettingsSection,
      devices: extension.ExtensionSettingsSection,
      connections: network.NetworkSettingsSection,
      referrals: growth.GrowthSettingsSection,
      sensitive: profile.ProfileSettingsSection,
    });
  });
});

describe('SubscribeOnTap is a pass-through until WP-73 fills it', () => {
  it('renders the wrapped control unchanged', () => {
    if (!stillStub('components/features/notify-cn/SubscribeOnTap.tsx')) return;
    const onClick = vi.fn();
    render(
      <notifyCn.SubscribeOnTap template="deadline_reminder">
        <button type="button" onClick={onClick}>
          remind
        </button>
      </notifyCn.SubscribeOnTap>,
    );
    screen.getByRole('button', { name: 'remind' }).click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('MarketJobMeta dispatches by brand market', () => {
  const meta = { cn: { classYears: [2027] }, ats_public: { board: '104' } };

  it('GoApply (market cn) → market/cn', () => {
    renderWithBrand(<market.MarketJobMeta jobId="cm1" meta={meta} variant="card" />, { brand: 'goapply', flags: {} });
    expect(screen.getByTestId('meta-cn')).toBeInTheDocument();
    expect(screen.queryByTestId('meta-tw')).toBeNull();
    expect(slots.cn).toEqual([{ jobId: 'cm1', meta, variant: 'card' }]);
  });

  it('RoboApply (market intl) → market/tw, which decides per job', () => {
    renderWithBrand(<market.MarketJobMeta jobId="cm2" meta={null} variant="detail" />, { brand: 'roboapply', flags: {} });
    expect(screen.getByTestId('meta-tw')).toBeInTheDocument();
    expect(screen.queryByTestId('meta-cn')).toBeNull();
    expect(slots.tw).toEqual([{ jobId: 'cm2', meta: null, variant: 'detail' }]);
  });
});

describe('GoApply onboarding step map', () => {
  it('covers exactly the GoApply-only screens, all real GoApply stages', () => {
    expect([...onboardingCn.CN_ONBOARDING_STEPS]).toEqual(['consent', 'identity', 'education', 'intent', 'tags', 'confirm']);
    for (const step of onboardingCn.CN_ONBOARDING_STEPS) {
      expect(GOAPPLY_ONBOARDING_STAGES).toContain(step);
      expect(onboardingCn.isCnOnboardingStep(step)).toBe(true);
    }
    expect(Object.keys(onboardingCn.CN_ONBOARDING_STEP_COMPONENTS).sort()).toEqual([...onboardingCn.CN_ONBOARDING_STEPS].sort());
    // Shared stages stay with WP-30.
    for (const shared of ['resume', 'matching', 'situation', 'goal']) expect(onboardingCn.isCnOnboardingStep(shared)).toBe(false);
  });
});

describe('area index files expose the seams (TASK_PLAN.md §2.1 rule 4)', () => {
  it.each([
    ['job', job, ['JobDetailPanel']],
    ['network', network, ['PeoplePanel', 'NetworkSettingsSection']],
    ['offers', offers, ['OfferSection', 'OfferComparison']],
    ['visitor', visitor, ['VisitorFeed']],
    ['growth', growth, ['AnalyticsConsent', 'GettingStartedChecklist', 'GrowthSettingsSection']],
    ['credits', credits, ['PlanBadge', 'OutOfCreditsSheet', 'CreditsSettingsSection']],
    ['market', market, ['MarketJobMeta', 'LegalFooter', 'AiGeneratedBadge', 'PriceReference']],
    ['auth-cn', authCn, ['PhoneMethod', 'WechatMethod']],
    ['extension', extension, ['InstallPrompt', 'FillWithExtensionButton', 'ExtensionSettingsSection']],
    ['coaching', coaching, ['PracticeReportCoachLine']],
    ['notify-cn', notifyCn, ['SubscribeOnTap']],
    ['practice-cn', practiceCn, ['CnReport']],
    ['onboarding-cn', onboardingCn, ['CN_ONBOARDING_STEPS', 'CN_ONBOARDING_STEP_COMPONENTS', 'isCnOnboardingStep']],
    ['auth', auth, ['AuthSettingsSection']],
    ['search', search, ['SearchSettingsSection']],
    ['notifications', notifications, ['MessageCenterButton', 'AnnouncementModal', 'NotificationsSettingsSection']],
    ['compliance', compliance, ['ComplianceSettingsSection']],
    ['brand', brand, ['WrongBrandNudge', 'BrandSettingsSection']],
    ['copilot', copilot, ['CopilotRail', 'CopilotSettingsSection']],
    ['profile', profile, ['ProfileSettingsSection']],
  ] as Array<[string, Record<string, unknown>, string[]]>)('%s', (_area, mod, names) => {
    for (const name of names) expect(mod[name], name).toBeDefined();
  });
});
