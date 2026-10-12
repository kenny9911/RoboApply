'use client';

// InviteLinkBox — the person's invite link with Copy, Share (the device share
// sheet) and Email (their own mail app, via mailto:), plus on GoApply a ready
// WeChat message to paste into a chat (WP-60; F-GROW-01 cn "WeChat share
// card"). Everything is sent by the person from their own apps; %BRAND% never
// messages anyone. Before the person's own account is verified it shows how
// to verify instead of a link (no links from throwaway accounts).

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { inviteLinkFor, useShareInvite } from '../../../hooks/growth/useInvites';
import type { InviteShareChannel, InvitesResponse } from '../../../lib/api/contracts/growth';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { Btn } from '../../v3/primitives/Btn';
import styles from './invite.module.css';

export interface InviteLinkBoxProps {
  view: InvitesResponse;
  from: 'invite_page' | 'settings';
  /** Show Share/Email/WeChat (the full page) or Copy only (settings). */
  compact?: boolean;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}

export function InviteLinkBox({ view, from, compact = false }: InviteLinkBoxProps) {
  const t = useTranslations('invite');
  const brand = useBrand();
  const share = useShareInvite(from);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  if (view.eligibility === 'not_available') return null;
  if (view.eligibility !== 'ok') {
    return (
      <div className={styles.row} data-testid="invite-verify">
        <div className={styles.itemText}>
          <p className={styles.itemTitle}>{t('link.verifyTitle')}</p>
          <p className={styles.body}>{t('link.verifyBody', { market: brand.market })}</p>
        </div>
        <Link className={`btn ${styles.btn}`} href="/settings#account">
          {t('link.verifyAction')}
        </Link>
      </div>
    );
  }

  const link = inviteLinkFor(view) ?? '';
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const cn = brand.market === 'cn';
  const wechatText = t('wechat.text', { link });
  const mailto = `mailto:?subject=${encodeURIComponent(t('link.emailSubject'))}&body=${encodeURIComponent(t('link.emailBody', { link }))}`;

  const note = (channel: InviteShareChannel) => share.mutate(channel);

  const onCopy = async (text: string, channel: InviteShareChannel, okKey: 'link.copied' | 'wechat.copied') => {
    if (await copyText(text)) {
      setStatus({ ok: true, text: t(okKey) });
      note(channel);
    } else {
      setStatus({ ok: false, text: t('link.copyFailed') });
    }
  };

  const onShare = async () => {
    try {
      await navigator.share({ title: t('link.emailSubject'), text: t('link.shareText'), url: link });
      note('share');
    } catch {
      // The person closed the share sheet: nothing to do.
    }
  };

  return (
    <div className={styles.section} aria-label={t('link.regionLabel')} role="group">
      <label className={styles.label} htmlFor={`invite-link-${from}`}>
        {t('link.label')}
      </label>
      <div className={styles.linkRow}>
        <input
          id={`invite-link-${from}`}
          className={styles.linkInput}
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          data-testid="invite-link"
        />
        <Btn variant="primary" className={styles.btn} onClick={() => void onCopy(link, 'copy', 'link.copied')}>
          {t('link.copy')}
        </Btn>
      </div>
      {compact ? null : (
        <div className={styles.actions}>
          {canShare ? (
            <Btn className={styles.btn} onClick={() => void onShare()}>
              {t('link.share')}
            </Btn>
          ) : null}
          <Btn as="a" href={mailto} className={styles.btn} onClick={() => note('email')}>
            {t('link.email')}
          </Btn>
        </div>
      )}
      {!compact && cn ? (
        <div className={styles.section} data-testid="invite-wechat">
          <p className={styles.itemTitle}>{t('wechat.title')}</p>
          <p className={styles.muted}>{t('wechat.help')}</p>
          <textarea className={styles.textArea} readOnly value={wechatText} aria-label={t('wechat.title')} onFocus={(e) => e.currentTarget.select()} />
          <div className={styles.actions}>
            <Btn className={styles.btn} onClick={() => void onCopy(wechatText, 'wechat', 'wechat.copied')}>
              {t('wechat.copy')}
            </Btn>
          </div>
        </div>
      ) : null}
      <p className={status && !status.ok ? styles.error : styles.status} role="status" aria-live="polite">
        {status?.text ?? ''}
      </p>
      {compact ? null : <p className={styles.muted}>{t('link.selfSend')}</p>}
    </div>
  );
}

export default InviteLinkBox;
