'use client';

// QuarterlySuggestion — the one "pay every 3 months" suggestion
// (PRODUCT_PLAN.md §6.4 "Monthly subscriber after 30 days"; F-BILL-06;
// TASK_PLAN.md WP-79). Rules:
//   - inline in /settings#billing only: never a popup, never on other pages;
//   - only for a monthly plan that will renew, at least 30 days after we
//     first saw it as monthly (ui-state `billing.monthlySeenAt`, recorded the
//     first time this view sees the plan; it can only be later than the real
//     start, so the suggestion never comes early);
//   - the saving is computed from the two real prices (rounded down) and
//     shown with both amounts, in the currency the subscription is charged
//     in (a TWD subscriber sees TWD, as the switch is charged in TWD);
//     nothing when the quarterly plan is not on sale in that currency or the
//     currency is unknown;
//   - shown once, ever: the first render stamps `shownAt`; "No thanks"
//     dismisses it for good. Both live in ui-state, so they follow the user.
// "See what changes" opens the plan sheet on the quarterly plan, where the
// switch quote shows the amount today before anything is charged.

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Btn } from '../../v3/primitives/Btn';
import { getUiState, patchUiState } from '../../../lib/api/uiState';
import { QUARTERLY_SUGGESTION_KEYS, QUARTERLY_SWITCH, quarterlySuggestion } from '../../../lib/pricing';
import { usePlans } from '../../../hooks/credits/usePlans';
import { useSubscriptionState } from '../../../hooks/credits/useSubscriptionState';
import { useBillingPlan } from '../../../hooks/useAccount';
import { money } from './labels';
import styles from './credits.module.css';

const UI_STATE_KEY = ['ui-state', 'billing-suggestions'] as const;

export interface QuarterlySuggestionProps {
  /** Clock (tests). */
  now?: () => Date;
}

export function QuarterlySuggestion({ now = () => new Date() }: QuarterlySuggestionProps) {
  const t = useTranslations('accountV2.quarterly');
  const locale = useLocale();
  const sub = useSubscriptionState();
  const plans = usePlans();
  const billing = useBillingPlan();
  const subscriptionCurrency = billing.data?.current?.currency ?? null;
  const qc = useQueryClient();
  const onMonthly = sub.status === 'ready' && !!sub.planKey && !!QUARTERLY_SWITCH[sub.planKey] && sub.willRenew && !sub.legacy;
  const ui = useQuery({ queryKey: UI_STATE_KEY, queryFn: () => getUiState(), enabled: onMonthly, staleTime: 60_000 });
  const [hidden, setHidden] = useState(false);
  const stamped = useRef(false);
  const seenRecorded = useRef(false);

  const values = ui.data?.state.values ?? {};
  const monthlySeenAt = typeof values[QUARTERLY_SUGGESTION_KEYS.monthlySeenAt] === 'string' ? (values[QUARTERLY_SUGGESTION_KEYS.monthlySeenAt] as string) : null;
  const shownAt = typeof values[QUARTERLY_SUGGESTION_KEYS.shownAt] === 'string' ? (values[QUARTERLY_SUGGESTION_KEYS.shownAt] as string) : null;
  const dismissed = Boolean(ui.data?.state.dismissals?.[QUARTERLY_SUGGESTION_KEYS.dismissal]);

  // Decided once per page view: the `shownAt` stamp must not hide the card that caused it.
  const [suggestion, setSuggestion] = useState<ReturnType<typeof quarterlySuggestion>>(null);
  const decided = useRef(false);

  useEffect(() => {
    if (!onMonthly || !ui.data) return;
    // First sighting on a monthly plan: remember when (only ever later than the real start).
    if (!monthlySeenAt && !seenRecorded.current) {
      seenRecorded.current = true;
      void patchUiState({ values: { [QUARTERLY_SUGGESTION_KEYS.monthlySeenAt]: now().toISOString() } }).catch(() => undefined);
    }
    if (decided.current || !plans.data || !billing.data) return;
    decided.current = true;
    const candidate = quarterlySuggestion({
      planKey: sub.planKey,
      willRenew: sub.willRenew,
      legacy: sub.legacy,
      monthlySeenAt,
      shownAt,
      dismissed,
      now: now(),
      subscriptionCurrency,
      plans: plans.data.plans,
    });
    setSuggestion(candidate);
    if (candidate && !stamped.current) {
      stamped.current = true;
      void patchUiState({ values: { [QUARTERLY_SUGGESTION_KEYS.shownAt]: now().toISOString() } })
        .then((res) => qc.setQueryData(UI_STATE_KEY, res))
        .catch(() => undefined);
    }
  }, [onMonthly, ui.data, plans.data, billing.data, subscriptionCurrency, monthlySeenAt, shownAt, dismissed, sub.planKey, sub.willRenew, sub.legacy, now, qc]);

  if (!onMonthly || hidden || !suggestion) return null;

  const quarterly = money(locale, suggestion.quarterlyMinor, suggestion.currency);
  const threeMonths = money(locale, suggestion.threeMonthsMinor, suggestion.currency);
  return (
    <section className={styles.card} aria-labelledby="quarterly-suggestion" data-testid="quarterly-suggestion">
      <h2 className={styles.h2} id="quarterly-suggestion">
        {t('title', { pct: suggestion.savingsPercent })}
      </h2>
      <p className={styles.body}>{t('body', { quarterly, threeMonths })}</p>
      <div className={styles.actions}>
        <Btn as="a" href={`/settings/billing?plan=${encodeURIComponent(suggestion.targetKey)}#plans`}>
          {t('cta')}
        </Btn>
        <Btn
          variant="ghost"
          onClick={() => {
            setHidden(true);
            void patchUiState({ dismiss: [QUARTERLY_SUGGESTION_KEYS.dismissal] }).catch(() => undefined);
          }}
        >
          {t('dismiss')}
        </Btn>
      </div>
      <p className={styles.muted}>{t('once')}</p>
    </section>
  );
}

export default QuarterlySuggestion;
