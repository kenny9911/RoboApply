'use client';

// components/v3/admin/AdminGate.tsx — renders its children for admins only.
// The page checks the role for the UI; every API call is admin-only on the
// server as well (requireAdmin), so this is presentation, not security.

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '../../../lib/auth/useAuth';
import { EmptyState } from '../primitives/EmptyState';

export function AdminGate({ children }: { children: ReactNode }) {
  const t = useTranslations('admin');
  const { user, status } = useAuth();
  if (status === 'loading') return <p aria-busy="true">{t('loading')}</p>;
  if (user?.role !== 'admin') {
    return <EmptyState title={`${t('notAuthorized.title')} ${t('notAuthorized.titleAccent')}`} sub={t('notAuthorized.sub')} />;
  }
  return <>{children}</>;
}
