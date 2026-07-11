'use client';

// §07 Plan & usage — current-plan headline, a usage-stat strip, the three plan
// cards, and a billing block. Per the contract: don't build real billing — show
// the tiers + a "Manage billing" link-out. `plan` is preferences-owned
// (read-mostly; mirrors the auth profile tier). The usage numbers are static
// display in the stub (the real aggregate is activity.orbStats, a different
// lane's concern).

import { useTranslations } from 'next-intl';
import { PrefHeader, PrefGroup, PrefRow } from '../controls';
import { Btn } from '../../primitives';
import type { RAPreferences } from '../../../../lib/api/v2';

export function PlanSection({
  p,
  set,
}: {
  p: RAPreferences;
  set: (path: string, value: unknown) => void;
}) {
  const t = useTranslations('preferences');

  const plans = [
    {
      id: 'free',
      name: t('plan.free_name'),
      price: '$0',
      billing: t('plan.free_billing'),
      bullets: [
        t('plan.free_b1'),
        t('plan.free_b2'),
        t('plan.free_b3'),
        t('plan.free_b4'),
      ],
    },
    {
      id: 'pro',
      name: t('plan.pro_name'),
      price: '$19',
      billing: t('plan.per_month'),
      badge: t('plan.popular'),
      bullets: [
        t('plan.pro_b1'),
        t('plan.pro_b2'),
        t('plan.pro_b3'),
        t('plan.pro_b4'),
        t('plan.pro_b5'),
      ],
    },
    {
      id: 'premium',
      name: t('plan.premium_name'),
      price: '$49',
      billing: t('plan.per_month'),
      bullets: [
        t('plan.premium_b1'),
        t('plan.premium_b2'),
        t('plan.premium_b3'),
        t('plan.premium_b4'),
      ],
    },
  ] as const;

  const planLabel =
    p.plan === 'free'
      ? t('plan.free_name')
      : p.plan === 'pro'
        ? t('plan.pro_name')
        : t('plan.premium_name');

  return (
    <>
      <PrefHeader
        eyebrow={t('plan.eyebrow')}
        title={
          <>
            {t('plan.title_before')} <em>{planLabel}</em>
            {t('plan.title_after')}
          </>
        }
        sub={t('plan.sub')}
      />

      {/* Usage strip removed for launch: the previous version displayed
          FABRICATED per-user numbers (14 apps / 11.5h saved / 3-22 replies)
          hardcoded from the design prototype — invented metrics shown as
          real. Reinstate only when fed by the real activity aggregate
          (activity.orbStats: sent / replies / hoursSavedLifetime) and the
          real credit balance. */}

      <PrefGroup label={t('plan.group_plans')}>
        <div className="pref-plans">
          {plans.map((pl) => (
            <div key={pl.id} className={`pref-plan ${p.plan === pl.id ? 'on' : ''}`}>
              {'badge' in pl && pl.badge ? (
                <div className="pref-plan-badge">{pl.badge}</div>
              ) : null}
              <div className="pref-plan-name">{pl.name}</div>
              <div className="pref-plan-price">
                <span className="num">{pl.price}</span>
                <span className="bill"> · {pl.billing}</span>
              </div>
              <ul className="pref-plan-bullets">
                {pl.bullets.map((b, i) => (
                  <li key={i}>
                    <span className="ic">+</span>
                    {b}
                  </li>
                ))}
              </ul>
              {p.plan === pl.id ? (
                <Btn disabled style={{ opacity: 0.6 }}>
                  {t('plan.current_plan')}
                </Btn>
              ) : (
                <Btn
                  variant={pl.id === 'premium' ? 'primary' : 'default'}
                  onClick={() => set('plan', pl.id)}
                >
                  {pl.id === 'free'
                    ? t('plan.downgrade')
                    : pl.id === 'premium'
                      ? t('plan.upgrade')
                      : t('plan.switch')}
                </Btn>
              )}
            </div>
          ))}
        </div>
      </PrefGroup>

      <PrefGroup label={t('plan.group_billing')}>
        <PrefRow label={t('plan.payment_label')} sub={t('plan.payment_sub')}>
          <Btn>{t('plan.update_card')}</Btn>
        </PrefRow>
        <PrefRow label={t('plan.next_bill_label')} sub={t('plan.next_bill_sub')}>
          <Btn>{t('plan.view_invoices')}</Btn>
        </PrefRow>
      </PrefGroup>
    </>
  );
}
