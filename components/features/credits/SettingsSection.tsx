'use client';

// /settings#billing and /settings#credits (TASK_PLAN.md WP-21b; PRODUCT_PLAN.md
// §3.4). One component, two sections: `billing` = plan, payment, cancel and
// the plan sheet; `credits` = today's credits per bucket with refill times.
// Wired by INT in components/features/settings/sectionComponents.ts, which
// then deletes the page's legacy billing renderer. No server parent passes the
// visitor's country here, so the plan sheet resolves it itself (plans
// response, else the `visitorCountry` server function) for the EU/UK/TW
// withdrawal acknowledgement and the Taiwan price line.

import { useSearchParams } from 'next/navigation';

import type { SettingsSectionProps } from '../settings/sectionComponents';
import { BillingView } from './BillingView';
import { CreditsUsage } from './CreditsUsage';

export function SettingsSection({ section }: SettingsSectionProps) {
  const params = useSearchParams();
  if (section === 'credits') return <CreditsUsage />;
  if (section === 'billing') return <BillingView requestedPlan={params?.get('plan') ?? null} />;
  return null;
}

export default SettingsSection;
