'use client';

// components/v3/account/security.tsx
//
//   - PasswordStrengthMeter  4-segment CSS bar (accent fill as strength rises)
//   - SecurityCard           change-password form + "sign out everywhere".
//                            OAuth-only accounts (no password) see a note.
//   - DangerZone             delete-account entry (opens the page's modal).
//
// The change-password form validates locally (match + min length) before
// hitting the mutation, then surfaces friendly errors mapped from
// RoboApiError.code (wrong_password / no_password / weak_password).

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Btn } from '../primitives/Btn';
import { IconTrash } from '../primitives/Iconset';
import { CapLabel, Panel } from './sections';

// ─────────────────────────────────────────────────────────────────────
// Password strength — a cheap heuristic (length + character classes) → 0..4.
// ─────────────────────────────────────────────────────────────────────

export function scorePassword(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score += 1;
  return Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
}

export function PasswordStrengthMeter({ password }: { password: string }) {
  const t = useTranslations('account');
  const score = scorePassword(password);

  const labels: Record<1 | 2 | 3 | 4, string> = {
    1: t('security.strength.weak'),
    2: t('security.strength.fair'),
    3: t('security.strength.good'),
    4: t('security.strength.strong'),
  };
  const fillColor = score <= 1 ? 'var(--danger)' : score === 2 ? 'var(--warn)' : 'var(--accent-text)';

  return (
    <div>
      <div style={{ display: 'flex', gap: 5, marginTop: 4 }} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            style={{
              height: 4,
              flex: 1,
              borderRadius: '99px',
              background: i < score ? fillColor : 'var(--surface-2)',
            }}
          />
        ))}
      </div>
      {score > 0 ? (
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: '10.5px',
            color: fillColor,
            marginTop: 5,
          }}
        >
          {labels[score as 1 | 2 | 3 | 4]}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Form field
// ─────────────────────────────────────────────────────────────────────

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 16, maxWidth: 420 }}>
      <label
        style={{
          fontFamily: 'var(--mono)',
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--muted)',
          fontWeight: 600,
        }}
      >
        {label}
      </label>
      <input
        type="password"
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="ra-account-input"
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--rule)',
          borderRadius: 9,
          padding: '10px 12px',
          color: 'var(--text)',
          fontFamily: 'var(--mono)',
          fontSize: '13px',
        }}
      />
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SecurityCard
// ─────────────────────────────────────────────────────────────────────

interface SecurityCardProps {
  hasPassword: boolean;
  provider: string;
  changing: boolean;
  signingOut: boolean;
  /** Friendly, already-translated error to show in the password form (or null). */
  passwordError: string | null;
  passwordSuccess: boolean;
  onChangePassword: (currentPassword: string, newPassword: string) => void;
  onSignOutEverywhere: () => void;
  /** Caller resets the form fields by bumping this key after a success. */
  resetKey: number;
}

export function SecurityCard({
  hasPassword,
  provider,
  changing,
  signingOut,
  passwordError,
  passwordSuccess,
  onChangePassword,
  onSignOutEverywhere,
  resetKey,
}: SecurityCardProps) {
  const t = useTranslations('account');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  // Reset local fields when the parent bumps resetKey (after a success).
  useEffect(() => {
    setCurrent('');
    setNext('');
    setConfirm('');
  }, [resetKey]);

  const localError = useMemo<string | null>(() => {
    if (!next && !confirm) return null;
    if (next.length > 0 && next.length < 8) return t('security.error.tooShort');
    if (confirm.length > 0 && next !== confirm) return t('security.error.mismatch');
    return null;
  }, [next, confirm, t]);

  const canSubmit =
    !changing && current.length > 0 && next.length >= 8 && next === confirm;

  const providerName =
    provider.toLowerCase().includes('google')
      ? 'Google'
      : provider.toLowerCase().includes('linkedin')
        ? 'LinkedIn'
        : provider;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onChangePassword(current, next);
  };

  return (
    <Panel>
      <div
        style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}
      >
        {/* Change password (or OAuth note) */}
        <div style={{ flex: 1, minWidth: 280 }}>
          <CapLabel style={{ display: 'block', marginBottom: 16 }}>
            {t('security.changePassword')}
          </CapLabel>

          {hasPassword ? (
            <form onSubmit={submit}>
              <PasswordField
                label={t('security.currentPassword')}
                value={current}
                onChange={setCurrent}
                autoComplete="current-password"
              />
              <PasswordField
                label={t('security.newPassword')}
                value={next}
                onChange={setNext}
                autoComplete="new-password"
              >
                <PasswordStrengthMeter password={next} />
              </PasswordField>
              <PasswordField
                label={t('security.confirmPassword')}
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
              />

              {(localError || passwordError) && (
                <p role="alert" style={{ color: 'var(--danger)', fontSize: '12.5px', margin: '0 0 12px', maxWidth: 420 }}>
                  {localError ?? passwordError}
                </p>
              )}
              {passwordSuccess && !localError && (
                <p style={{ color: 'var(--ok)', fontSize: '12.5px', margin: '0 0 12px' }}>
                  {t('security.changeSuccess')}
                </p>
              )}

              <Btn variant="primary" type="submit" disabled={!canSubmit}>
                {t('security.changePassword')}
              </Btn>
            </form>
          ) : (
            <p style={{ fontSize: '13px', color: 'var(--text-2)', maxWidth: 360 }}>
              {t('security.oauthNote', { provider: providerName })}
            </p>
          )}
        </div>

        {/* Sessions */}
        <div style={{ flex: 1, minWidth: 280 }}>
          <CapLabel style={{ display: 'block', marginBottom: 16 }}>
            {t('security.sessions')}
          </CapLabel>
          <p style={{ fontSize: '13px', color: 'var(--text-2)', maxWidth: 300, marginBottom: 14 }}>
            {t('security.signOutNote')}
          </p>
          <Btn onClick={onSignOutEverywhere} disabled={signingOut}>
            {t('security.signOutEverywhere')}
          </Btn>
        </div>
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────
// DangerZone
// ─────────────────────────────────────────────────────────────────────

export function DangerZone({ onRequestDelete }: { onRequestDelete: () => void }) {
  const t = useTranslations('account');
  return (
    <div
      style={{
        border: '1px solid var(--danger)',
        background: 'var(--danger-soft)',
        borderRadius: 'var(--r-lg)',
        padding: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 18,
        flexWrap: 'wrap',
      }}
    >
      <div>
        <div style={{ fontWeight: 600, color: 'var(--text)' }}>{t('danger.deleteAccount')}</div>
        <div style={{ fontSize: '12.5px', color: 'var(--text-2)', marginTop: 4, maxWidth: 480 }}>
          {t('danger.deleteDescription')}
        </div>
      </div>
      <Btn className="ra-btn-danger" onClick={onRequestDelete} icon={<IconTrash size={15} />}>
        {t('danger.deleteAccount')}
      </Btn>
    </div>
  );
}
