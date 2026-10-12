'use client';

// WechatReturn — /auth/callback/wechat, where the API sends the browser after
// a WeChat round trip (WECHAT_RETURN_PATH in the auth-cn contract):
//   result=ok&bind=1   → /bind-phone?next=… (AI features need a verified number)
//   result=ok          → `next`
//   result=ok&reverify → keeps the one-time token for the phone change in
//                        sessionStorage (never in a URL we build) → `next`
//   result=error&code  → the message and a way back to sign in.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useAuth } from '../../../lib/auth/AuthProvider';
import { codeMessage, safeNextPath } from './shared';
import styles from './AuthCn.module.css';

export const REVERIFY_STORAGE_KEY = 'authCn.wechatReverify';

export interface WechatReturnProps {
  params: { result?: string | null; code?: string | null; next?: string | null; bind?: string | null; reverify?: string | null };
}

export function WechatReturn({ params }: WechatReturnProps) {
  const t = useTranslations('authCn');
  const router = useRouter();
  const { refresh } = useAuth();
  const [failed, setFailed] = useState<string | null>(params.result === 'ok' ? null : codeMessage(params.code, t));

  useEffect(() => {
    if (params.result !== 'ok') return;
    const next = safeNextPath(params.next) ?? '/resume';
    let cancelled = false;
    (async () => {
      if (params.reverify) {
        try {
          sessionStorage.setItem(REVERIFY_STORAGE_KEY, params.reverify);
        } catch {
          // Storage blocked: the change form falls back to the other proofs.
        }
        router.replace(next);
        return;
      }
      const me = await refresh();
      if (cancelled) return;
      if (!me) {
        setFailed(t('errors.unauthorized'));
        return;
      }
      router.replace(params.bind === '1' ? `/bind-phone?next=${encodeURIComponent(next)}` : next);
    })();
    return () => {
      cancelled = true;
    };
    // Runs once per return visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) {
    return (
      <div className={styles.center} role="alert">
        <p className={styles.step}>{t('callback.failedTitle')}</p>
        <p className={styles.hint}>{failed}</p>
        <Link href="/login" className={styles.linkBtn}>
          {t('callback.retry')}
        </Link>
      </div>
    );
  }
  return (
    <div className={styles.center} aria-busy="true">
      <p>{t('callback.working')}</p>
    </div>
  );
}
