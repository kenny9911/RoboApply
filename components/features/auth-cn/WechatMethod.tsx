'use client';

// WechatMethod — 微信登录: the website QR sign-in on other browsers, the 公众号
// OAuth round trip inside WeChat (PRODUCT_PLAN.md §4.5 G0 #5; TASK_PLAN.md WP-11).
//
// Rendered by login/signup through components/auth/methods/registry.ts
// (`wechat`) only when `auth.wechatWeb` or `auth.wechatInApp` is on. It shows
// nothing when the usable flow for this browser is off (QR inside WeChat is
// useless; the 公众号 flow only works inside WeChat).
//
// The same G0 agreement applies: when the phone form is on the page it hosts
// the boxes (shared store), otherwise this component renders them. The
// button stays disabled until they are ticked. The ticked consents travel in
// the POST body of `startWechatSignIn` (never in a URL, so a shared link can
// never grant them); the browser then goes to the returned WeChat URL. A new
// WeChat account is sent to /bind-phone first (AI features need a verified
// number).

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { startWechatSignIn } from '../../../lib/api/authCn';
import { useCapabilities } from '../../../lib/flags';
import type { AuthMethodProps } from '../../auth/methods/registry';
import { InviteCodeField, SignupConsents } from './SignupConsents';
import {
  agreementSatisfied,
  consentsFromPolicy,
  currentSignupLinkCodes,
  errorMessage,
  prefillAccessCode,
  safeNextPath,
  signupInputs,
  useIsWechatBrowser,
  useSignupInputs,
  useSignupPolicy,
} from './shared';
import styles from './AuthCn.module.css';

function WechatGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 4C5.4 4 2 6.8 2 10.2c0 1.9 1.1 3.6 2.8 4.8L4 17.5l2.9-1.5c.8.2 1.7.3 2.6.3" />
      <path d="M22 14.6c0-2.9-2.9-5.3-6.5-5.3S9 11.7 9 14.6s2.9 5.3 6.5 5.3c.7 0 1.4-.1 2-.3L20 21l-.6-2.3c1.6-1 2.6-2.5 2.6-4.1Z" />
      <path d="M7 9h.01M12 9h.01M13.5 14h.01M17.5 14h.01" />
    </svg>
  );
}

export function WechatMethod({ mode, next }: AuthMethodProps) {
  const t = useTranslations('authCn');
  const { flags } = useCapabilities();
  const inWechat = useIsWechatBrowser();
  const policyQuery = useSignupPolicy();
  const policy = policyQuery.data;
  const [inputs] = useSignupInputs();
  const [hostsConsents, setHostsConsents] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneOn = flags?.['auth.phoneOtp'] === true;
  const flowOn = inWechat ? flags?.['auth.wechatInApp'] === true : flags?.['auth.wechatWeb'] === true;

  // Render the agreement here only when no phone form is on the page.
  useEffect(() => {
    if (phoneOn) return undefined;
    if (signupInputs.get().host === null) {
      signupInputs.set({ host: 'wechat' });
      prefillAccessCode();
      setHostsConsents(true);
      return () => signupInputs.reset();
    }
    return undefined;
  }, [phoneOn]);

  if (!flowOn) return null;

  const agreed = agreementSatisfied(inputs, policy);
  const disabled = !agreed || busy;

  async function onClick() {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      const safe = safeNextPath(next);
      const invite = inputs.invite.trim();
      // The invite-friends code from the link (`?ref=`) rides in the POST
      // body with the consents; it is used only if the WeChat account is new.
      const { ref } = currentSignupLinkCodes();
      const { url } = await startWechatSignIn({
        flow: inWechat ? 'mp' : 'web',
        consents: consentsFromPolicy(policy),
        ...(safe ? { next: safe } : {}),
        ...(invite ? { inviteCode: invite } : {}),
        ...(ref ? { ref } : {}),
      });
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err, t));
      setBusy(false);
    }
  }

  return (
    <div className={styles.form}>
      {phoneOn ? (
        <div className={styles.divider} aria-hidden="true">
          {t('wechat.or')}
        </div>
      ) : null}
      {hostsConsents && policy?.inviteRequired && mode === 'signup' ? <InviteCodeField id="authcn-wechat-invite" /> : null}
      {hostsConsents ? <SignupConsents policy={policy} /> : null}
      <button type="button" className={styles.wechatBtn} onClick={onClick} aria-disabled={disabled} aria-busy={busy}>
        <WechatGlyph />
        {inWechat ? t('wechat.inWechat') : t('wechat.button')}
      </button>
      {!agreed ? <p className={styles.hint}>{t('consent.agreeFirst')}</p> : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default WechatMethod;
