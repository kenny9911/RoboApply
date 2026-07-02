'use client';

// components/v3/admin/panels.tsx
//
// The larger composed admin surfaces:
//   - ProfitabilitySummary  the drill-down hero (one mono sentence + MarginBar
//                           + plan side with the admin "Set plan" button)
//   - SetPlanModal          admin-action grammar: tier radio cards + optional
//                           custom price + REQUIRED reason textarea
//   - RateCardPanel         read-mostly LLM / speech / media rate reference
//
// All follow the project modal rule (literal #181923 panel via the Modal
// primitive) and the i18n rule (every string via t()).

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '../primitives/Modal';
import { Btn } from '../primitives/Btn';
import { TierBadge, MarginBar, EstimatedMarker } from './badges';
import { fmtSignedCurrency, fmtCurrency, fmtPercent, fmtLongDate } from './format';
import type {
  AdminTier,
  AdminRateCard,
  AdminSetPlanBody,
} from '../../../lib/api/admin';

// ── ProfitabilitySummary ────────────────────────────────────────────────

export function ProfitabilitySummary({
  cost,
  revenue,
  marginPct,
  profitable,
  tier,
  renewsAt,
  currency = 'USD',
  locale,
  onSetPlan,
}: {
  cost: number;
  revenue: number;
  marginPct: number | null;
  profitable: boolean | null;
  tier: string;
  renewsAt: string | null;
  currency?: string;
  locale: string;
  onSetPlan: () => void;
}) {
  const t = useTranslations('admin');
  const margin = revenue - cost;
  const pos = margin >= 0;
  return (
    <div
      style={{
        border: '1px solid var(--rule)',
        background: 'var(--surface)',
        borderRadius: 14,
        padding: 24,
        display: 'flex',
        justifyContent: 'space-between',
        gap: 24,
        alignItems: 'center',
        marginBottom: 18,
        position: 'relative',
        overflow: 'hidden',
        flexWrap: 'wrap',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: pos ? 'var(--ok)' : 'var(--danger)',
        }}
      />
      <div style={{ minWidth: 280, flex: 1 }}>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 20,
            letterSpacing: '-0.01em',
            color: 'var(--text-2)',
            lineHeight: 1.5,
          }}
        >
          {/* The summary sentence stays text-2; the MarginBar below carries
              the green/red profitability signal. */}
          {t('detail.summary', {
            cost: fmtCurrency(cost, locale, currency),
            revenue: fmtCurrency(revenue, locale, currency),
            margin: fmtSignedCurrency(margin, locale, currency),
            pct: fmtPercent(marginPct, locale),
          })}
        </div>
        <MarginBar revenue={revenue} cost={cost} currency={currency} locale={locale} />
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <TierBadge tier={tier} />
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', margin: '10px 0 14px' }}>
          {renewsAt ? t('detail.renews', { date: fmtLongDate(renewsAt, locale) }) : '—'}
        </div>
        <Btn variant="violet" onClick={onSetPlan}>
          {t('detail.setPlan')}
        </Btn>
      </div>
      {/* `profitable` is part of the contract; surfaced via the bar/sign. */}
      <span hidden>{String(profitable)}</span>
    </div>
  );
}

// ── SetPlanModal ────────────────────────────────────────────────────────

const TIER_OPTIONS: AdminTier[] = ['free', 'premium', 'premium_plus'];

export function SetPlanModal({
  open,
  currentTier,
  currency = 'USD',
  onClose,
  onConfirm,
  submitting,
  errorMessage,
}: {
  open: boolean;
  currentTier: string;
  currency?: string;
  onClose: () => void;
  onConfirm: (body: AdminSetPlanBody) => void;
  submitting?: boolean;
  errorMessage?: string | null;
}) {
  const t = useTranslations('admin');
  const [tier, setTier] = useState<AdminTier>('premium');
  const [customPrice, setCustomPrice] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      const initial =
        currentTier === 'premium' || currentTier === 'premium_plus'
          ? (currentTier as AdminTier)
          : 'free';
      setTier(initial);
      setCustomPrice('');
      setReason('');
      setTouched(false);
    }
  }, [open, currentTier]);

  const tierLabel = (tr: AdminTier) =>
    tr === 'premium_plus'
      ? t('users.filter.premiumPlus')
      : tr === 'premium'
        ? t('users.filter.premium')
        : t('users.filter.free');

  function submit() {
    setTouched(true);
    if (!reason.trim()) return;
    const body: AdminSetPlanBody = { tier, reason: reason.trim() };
    const priceNum = Number(customPrice);
    if (customPrice && Number.isFinite(priceNum) && priceNum >= 0) {
      body.amountMinor = Math.round(priceNum * 100);
      body.currency = currency;
    }
    onConfirm(body);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('setPlan.title')}
      maxWidth="md"
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={submitting}>
            {t('setPlan.cancel')}
          </Btn>
          <Btn variant="violet" onClick={submit} disabled={submitting || !reason.trim()}>
            {t('setPlan.confirm')}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={GROUP_LABEL}>{t('setPlan.tier')}</legend>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
            {TIER_OPTIONS.map((tr) => {
              const on = tier === tr;
              return (
                <button
                  key={tr}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setTier(tr)}
                  style={{
                    flex: '1 1 120px',
                    textAlign: 'left',
                    background: on ? 'var(--violet-soft)' : 'var(--bg-2)',
                    border: `1px solid ${on ? 'var(--violet)' : 'var(--rule)'}`,
                    borderRadius: 10,
                    padding: '12px 14px',
                    cursor: 'pointer',
                    color: 'var(--text)',
                  }}
                >
                  <TierBadge tier={tr} size="sm" />
                  <div style={{ marginTop: 8, fontSize: 13, fontWeight: 500 }}>{tierLabel(tr)}</div>
                </button>
              );
            })}
          </div>
        </fieldset>

        <label style={GROUP_LABEL_BLOCK}>
          {t('setPlan.customPrice')}
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={customPrice}
            onChange={(e) => setCustomPrice(e.target.value)}
            style={TEXT_INPUT}
            placeholder="—"
          />
        </label>

        <label style={GROUP_LABEL_BLOCK}>
          {t('setPlan.reason')}
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            required
            aria-required="true"
            style={{ ...TEXT_INPUT, resize: 'vertical', fontFamily: 'var(--sans)' }}
          />
          {touched && !reason.trim() ? (
            <span style={{ color: 'var(--danger)', fontSize: 12, fontFamily: 'var(--mono)' }}>
              {t('setPlan.reasonRequired')}
            </span>
          ) : null}
        </label>

        {errorMessage ? (
          <p role="alert" style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>
            {errorMessage}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

const GROUP_LABEL = {
  fontFamily: 'var(--mono)',
  fontSize: '11px',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.1em',
  color: 'var(--muted)',
  fontWeight: 600,
  padding: 0,
};

const GROUP_LABEL_BLOCK = {
  ...GROUP_LABEL,
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 7,
};

const TEXT_INPUT = {
  background: 'var(--bg-2)',
  border: '1px solid var(--rule)',
  borderRadius: 9,
  padding: '10px 12px',
  color: 'var(--text)',
  fontFamily: 'var(--mono)',
  fontSize: '14px',
  width: '100%',
  colorScheme: 'dark' as const,
};

// ── RateCardPanel ──────────────────────────────────────────────────────────

export function RateCardPanel({
  card,
  source,
  locale,
}: {
  card: AdminRateCard;
  source: 'db' | 'env';
  locale: string;
}) {
  const t = useTranslations('admin');
  const fmt = (n: number, decimals = 2) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: decimals,
      maximumFractionDigits: Math.max(decimals, 4),
    }).format(n);

  const llmRows = Object.entries(card.llm ?? {});

  return (
    <div>
      <div
        style={{
          border: '1px solid var(--rule)',
          background: 'var(--surface)',
          borderRadius: 14,
          padding: 16,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)' }}>
          {t('rateCard.note')} · {source.toUpperCase()}
        </span>
        <Btn variant="ghost" disabled>
          {t('rateCard.editSoon')}
        </Btn>
      </div>

      <SubHeading>{t('rateCard.llm')}</SubHeading>
      <RateTable
        head={[t('rateCard.col.model'), t('rateCard.col.inputRate'), t('rateCard.col.outputRate')]}
        aligns={['left', 'right', 'right']}
        rows={
          llmRows.length > 0
            ? llmRows.map(([model, rate]) => [model, fmt(rate.input, 2), fmt(rate.output, 2)])
            : [['default', fmt(card.llmDefault.input, 2), fmt(card.llmDefault.output, 2)]]
        }
      />

      <SubHeading aside={<EstimatedMarker>~ {t('estimated')}</EstimatedMarker>}>
        {t('rateCard.speech')}
      </SubHeading>
      <RateTable
        head={[t('session.col.stage'), t('rateCard.col.perMin')]}
        aligns={['left', 'right']}
        rows={[
          [t('modality.stt'), `${fmt(card.stt.default, 4)} / ${t('rateCard.col.perMin')}`],
          [t('modality.tts'), `${fmt(card.tts.usdPerMin, 4)} / ${t('rateCard.col.perMin')}`],
        ]}
      />

      <SubHeading aside={<EstimatedMarker>~ {t('estimated')}</EstimatedMarker>}>
        {t('rateCard.media')}
      </SubHeading>
      <RateTable
        head={[t('session.col.stage'), t('rateCard.col.perGb')]}
        aligns={['left', 'right']}
        rows={[
          [t('modality.egress'), `${fmt(card.egress.usdPerGb, 4)} / ${t('rateCard.col.perGb')}`],
          [`${t('modality.image')} · ${t('rateCard.col.perImage')}`, fmt(card.storage.usdPerGbMonth, 4)],
        ]}
      />
    </div>
  );
}

function SubHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: 'var(--muted)',
        fontWeight: 600,
        margin: '24px 0 12px',
      }}
    >
      {children}
      {aside}
    </div>
  );
}

function RateTable({
  head,
  aligns,
  rows,
}: {
  head: string[];
  aligns: ('left' | 'right')[];
  rows: ReactNode[][];
}) {
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        border: '1px solid var(--rule)',
        borderRadius: 14,
        overflow: 'hidden',
        background: 'var(--surface)',
      }}
    >
      <thead>
        <tr>
          {head.map((h, i) => (
            <th
              key={i}
              scope="col"
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--muted)',
                fontWeight: 600,
                textAlign: aligns[i],
                padding: '13px 16px',
                borderBottom: '1px solid var(--rule)',
                background: 'var(--bg-2)',
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri}>
            {r.map((cell, ci) => (
              <td
                key={ci}
                style={{
                  padding: '13px 16px',
                  borderBottom: ri === rows.length - 1 ? 0 : '1px solid var(--rule-soft)',
                  fontSize: 13,
                  textAlign: aligns[ci],
                  fontFamily: aligns[ci] === 'right' ? 'var(--mono)' : undefined,
                  fontVariantNumeric: aligns[ci] === 'right' ? 'tabular-nums' : undefined,
                  color: 'var(--text)',
                }}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
