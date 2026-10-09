'use client';

// PhoneMethod — GoApply sign-in/sign-up with a +86 phone number and an SMS
// code (PRODUCT_PLAN.md §4.5 G0; TASK_PLAN.md WP-11).
//
// Rendered by login/signup through components/auth/methods/registry.ts
// (`phone_otp`) only when the `auth.phoneOtp` capability is on, so a missing
// SMS provider never shows a dead form.
//
// G0 rules: the agreement box is required and unchecked, and both buttons
// stay disabled until it is ticked (plus the cross-border box in CN-0);
// +86 only (`^1[3-9]\d{9}$`, "请输入正确的手机号"); 获取验证码 with a 60 s
// countdown; one flow — a new number creates an account, a known one signs
// in; invite code when sign-up is invite-only. The SMS carries only the code
// and the brand name.

import { useEffect, useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { sendPhoneCode, verifyPhoneCode } from '../../../lib/api/authCn';
import { apiErrorCode, apiErrorDetails } from '../../../lib/api/contracts/wire';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { Btn } from '../../v3/primitives/Btn';
import type { AuthMethodProps } from '../../auth/methods/registry';
import { InviteCodeField, SignupConsents } from './SignupConsents';
import {
  agreementSatisfied,
  consentsFromPolicy,
  errorMessage,
  isValidCnPhone,
  maskPhoneInput,
  normalizePhoneInput,
  OTP_RE,
  safeNextPath,
  signupInputs,
  useCountdown,
  useSignupInputs,
  useSignupPolicy,
} from './shared';
import styles from './AuthCn.module.css';

export function PhoneMethod({ mode, next, onSuccess }: AuthMethodProps) {
  const t = useTranslations('authCn');
  const router = useRouter();
  const { refresh } = useAuth();
  const ids = useId();
  const policyQuery = useSignupPolicy();
  const policy = policyQuery.data;
  const [inputs] = useSignupInputs();
  const countdown = useCountdown();

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);

  // The phone form hosts the shared agreement boxes (the WeChat button reads them).
  useEffect(() => {
    signupInputs.set({ host: 'phone' });
    return () => signupInputs.reset();
  }, []);

  const inviteMode = policy?.inviteRequired === true;
  const inviteVisible = inviteMode && (mode === 'signup' || showInvite);
  const agreed = agreementSatisfied(inputs, policy);
  const phoneOk = isValidCnPhone(phone);
  const phoneInvalid = phoneTouched && phone.length > 0 && !phoneOk;

  async function onSend() {
    setPhoneTouched(true);
    setError(null);
    if (!phoneOk || !agreed || countdown.left > 0) return;
    setSending(true);
    try {
      const res = await sendPhoneCode({ phone: normalizePhoneInput(phone), purpose: 'login' });
      countdown.start(res.resendInSec);
      setSentTo(maskPhoneInput(phone));
    } catch (err) {
      const retry = apiErrorDetails<{ retryAfterSec?: number }>(err)?.retryAfterSec;
      if (apiErrorCode(err) === 'rate_limited' && retry) countdown.start(Math.min(retry, 60));
      setError(errorMessage(err, t));
    } finally {
      setSending(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPhoneTouched(true);
    setError(null);
    if (!phoneOk) {
      setError(t('phone.invalid'));
      return;
    }
    if (!OTP_RE.test(code)) {
      setError(t('code.invalid'));
      return;
    }
    if (!agreed) {
      setError(t('consent.agreeFirst'));
      return;
    }
    setSubmitting(true);
    try {
      const safe = safeNextPath(next);
      const res = await verifyPhoneCode({
        phone: normalizePhoneInput(phone),
        code,
        consents: consentsFromPolicy(policy),
        ...(inputs.invite.trim() ? { inviteCode: inputs.invite.trim() } : {}),
        ...(safe ? { next: safe } : {}),
      });
      await refresh();
      if (onSuccess) onSuccess();
      else router.replace(res.nextRoute);
    } catch (err) {
      if (apiErrorCode(err) === 'invite_invalid') setShowInvite(true);
      setError(errorMessage(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  const sendLabel = sending ? t('code.sending') : countdown.left > 0 ? t('code.resendIn', { seconds: countdown.left }) : t('code.send');
  const phoneId = `${ids}-phone`;
  const codeId = `${ids}-code`;

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate aria-busy={submitting}>
      {policy && !policy.signupOpen ? <p className={styles.notice}>{t('signupClosed')}</p> : null}

      <div className={styles.field}>
        <label htmlFor={phoneId} className={styles.label}>
          {t('phone.label')}
        </label>
        <div className={styles.inputWrap} data-invalid={phoneInvalid ? 'true' : undefined}>
          <span className={styles.prefix} aria-hidden="true">
            {t('phone.prefix')}
          </span>
          <input
            id={phoneId}
            className={styles.input}
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={14}
            placeholder={t('phone.placeholder')}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ''))}
            onBlur={() => setPhoneTouched(true)}
            aria-invalid={phoneInvalid}
            aria-describedby={phoneInvalid ? `${phoneId}-err` : undefined}
          />
        </div>
        {phoneInvalid ? (
          <p id={`${phoneId}-err`} className={styles.hint} role="status">
            {t('phone.invalid')}
          </p>
        ) : null}
      </div>

      <div className={styles.field}>
        <label htmlFor={codeId} className={styles.label}>
          {t('code.label')}
        </label>
        <div className={styles.control}>
          <div className={styles.inputWrap}>
            <input
              id={codeId}
              className={styles.input}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              placeholder={t('code.placeholder')}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          <button type="button" className={styles.sendBtn} onClick={onSend} disabled={!agreed || !phoneOk || sending || countdown.left > 0}>
            {sendLabel}
          </button>
        </div>
        {sentTo ? (
          <p className={styles.hint} role="status">
            {t('code.sent', { phone: sentTo })}
          </p>
        ) : null}
      </div>

      {inviteVisible ? <InviteCodeField id={`${ids}-invite`} /> : null}

      <SignupConsents policy={policy} />

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <Btn type="submit" variant="primary" className={styles.submit} disabled={!agreed || submitting} aria-busy={submitting}>
        {submitting ? t('submitting') : t('submit')}
      </Btn>
    </form>
  );
}

export default PhoneMethod;
