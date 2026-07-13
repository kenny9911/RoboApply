'use client';

// /account/security — Security tab: change password, sign out everywhere, and
// the Danger zone (delete account). Data: GET /account for hasPassword/provider.
// The shared layout owns the header and tabs.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Btn } from '../../../../components/v3/primitives/Btn';
import {
  SecurityCard,
  DangerZone,
  DeleteAccountModal,
  SecLabel,
} from '../../../../components/v3/account';
import {
  useAccountProfile,
  useChangePassword,
  useSignOutAll,
} from '../../../../hooks/useAccount';
import { RoboApiError } from '../../../../lib/api/client';
import { useAuth } from '../../../../lib/auth/AuthProvider';

export default function AccountSecurityPage() {
  const t = useTranslations('account');
  const router = useRouter();
  const auth = useAuth();

  const profileQ = useAccountProfile();
  const changePassword = useChangePassword();
  const signOutAll = useSignOutAll();

  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [securityResetKey, setSecurityResetKey] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (profileQ.isError) {
    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-4 text-center"
        style={{ border: '1px solid var(--rule)', background: 'var(--surface)', borderRadius: 'var(--r-xl)', padding: '52px 32px' }}
      >
        <p style={{ fontFamily: 'var(--sans)', fontSize: '18px', fontWeight: 600, color: 'var(--text)', margin: 0 }}>
          {t('error.title')}
        </p>
        <p style={{ color: 'var(--text-2)', fontSize: '14px', maxWidth: 420, margin: 0 }}>{t('error.body')}</p>
        <Btn variant="primary" onClick={() => void profileQ.refetch()}>{t('error.retry')}</Btn>
      </div>
    );
  }

  if (profileQ.isLoading || !profileQ.data) {
    return <SecuritySkeleton label={t('loading')} />;
  }

  const profile = profileQ.data;

  const onChangePassword = (currentPassword: string, newPassword: string) => {
    setPasswordError(null);
    setPasswordSuccess(false);
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setPasswordSuccess(true);
          setSecurityResetKey((k) => k + 1);
        },
        onError: (err) => {
          const code = err instanceof RoboApiError ? err.code : undefined;
          const raw = err instanceof RoboApiError ? (err.payload as any)?.code : undefined;
          if (raw === 'wrong_password') setPasswordError(t('security.error.wrongPassword'));
          else if (raw === 'no_password') setPasswordError(t('security.error.noPassword'));
          else if (raw === 'weak_password') setPasswordError(t('security.error.weakPassword'));
          else if (code === 'rate_limited') setPasswordError(t('security.error.rateLimited'));
          else setPasswordError(t('security.error.generic'));
        },
      },
    );
  };

  const onSignOutEverywhere = () => {
    signOutAll.mutate(undefined, {
      onSuccess: () => {
        auth.clear();
        router.replace('/login');
      },
    });
  };

  return (
    <>
      <SecurityCard
        hasPassword={profile.hasPassword}
        provider={profile.provider}
        changing={changePassword.isPending}
        signingOut={signOutAll.isPending}
        passwordError={passwordError}
        passwordSuccess={passwordSuccess}
        onChangePassword={onChangePassword}
        onSignOutEverywhere={onSignOutEverywhere}
        resetKey={securityResetKey}
      />

      <SecLabel>{t('danger.title')}</SecLabel>
      <DangerZone onRequestDelete={() => setDeleteOpen(true)} />

      <DeleteAccountModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        email={profile.email}
      />
    </>
  );
}

function SecuritySkeleton({ label }: { label: string }) {
  const shimmer = (): React.CSSProperties => ({ background: 'var(--surface-2)', borderRadius: 8 });
  return (
    <div className="animate-pulse" aria-busy="true" aria-label={label}>
      <div style={{ ...shimmer(), height: 200, marginBottom: 24 }} />
      <div style={{ ...shimmer(), height: 96 }} />
    </div>
  );
}
