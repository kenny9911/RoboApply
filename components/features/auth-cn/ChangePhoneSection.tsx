'use client';

// ChangePhoneSection — the phone number block of settings #security on GoApply
// (PRODUCT_PLAN.md F-ACCT-02 cn; TASK_PLAN.md WP-11, C24).
//
// Changing the number needs two proofs: a code sent to the current number
// (or, when that number is lost, the account password or a WeChat
// re-verification) AND a code sent to the new number. Every other session is
// signed out afterwards. Accounts without a number get a link to /bind-phone.
//
// Mounted by the #security section owner (WP-10 / INT) for GoApply.

import { useEffect, useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { changePhone, getPhoneStatus, sendPhoneCode, wechatMpStartUrl, wechatQrUrl } from '../../../lib/api/authCn';
import { useCapabilities } from '../../../lib/flags';
import { Btn } from '../../v3/primitives/Btn';
import { REVERIFY_STORAGE_KEY } from './WechatReturn';
import { errorMessage, isValidCnPhone, isWechatBrowser, maskPhoneInput, normalizePhoneInput, OTP_RE, useCountdown } from './shared';
import styles from './AuthCn.module.css';

const STATUS_KEY = ['authCn', 'phoneStatus'] as const;

type Proof = 'old_code' | 'password' | 'wechat';

function readReverifyToken(): string | null {
  try {
    return sessionStorage.getItem(REVERIFY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearReverifyToken() {
  try {
    sessionStorage.removeItem(REVERIFY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function ChangePhoneSection() {
  const t = useTranslations('authCn');
  const qc = useQueryClient();
  const { flags } = useCapabilities();
  const ids = useId();
  const phoneOtp = flags?.['auth.phoneOtp'] === true;
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: () => getPhoneStatus(), retry: false, enabled: phoneOtp });
  const oldCountdown = useCountdown();
  const newCountdown = useCountdown();

  const [open, setOpen] = useState(false);
  const [proof, setProof] = useState<Proof>('old_code');
  const [oldCode, setOldCode] = useState('');
  const [password, setPassword] = useState('');
  const [wechatToken, setWechatToken] = useState<string | null>(null);
  const [oldPhone, setOldPhone] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newCode, setNewCode] = useState('');
  const [busy, setBusy] = useState<'old' | 'new' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Back from a WeChat re-verification round trip.
  useEffect(() => {
    const token = readReverifyToken();
    if (token) {
      setWechatToken(token);
      setProof('wechat');
      setOpen(true);
    }
  }, []);

  if (!phoneOtp) return null;

  const data = status.data;
  const wechatOn = flags?.['auth.wechatWeb'] === true || flags?.['auth.wechatInApp'] === true;

  if (status.isLoading) {
    return (
      <section className={styles.section} aria-busy="true">
        <h3 className={styles.sectionTitle}>{t('change.title')}</h3>
        <p className={styles.hint}>{t('change.loading')}</p>
      </section>
    );
  }
  if (status.isError || !data) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('change.title')}</h3>
        <p className={styles.error} role="alert">
          {errorMessage(status.error, t)}
        </p>
      </section>
    );
  }

  if (!data.phoneMasked) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('change.title')}</h3>
        <div className={styles.row}>
          <p className={styles.hint}>{t('change.none')}</p>
          <Btn as="a" href="/bind-phone?next=%2Fsettings%23security" variant="primary">
            {t('change.addCta')}
          </Btn>
        </div>
      </section>
    );
  }

  async function sendOld() {
    setError(null);
    if (!isValidCnPhone(oldPhone)) return setError(t('phone.invalid'));
    setBusy('old');
    try {
      // The client only knows the masked number; the person types it and the server checks it.
      const res = await sendPhoneCode({ phone: normalizePhoneInput(oldPhone), purpose: 'change_old' });
      oldCountdown.start(res.resendInSec);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }

  async function sendNew() {
    setError(null);
    if (!isValidCnPhone(newPhone)) return setError(t('phone.invalid'));
    setBusy('new');
    try {
      const res = await sendPhoneCode({ phone: normalizePhoneInput(newPhone), purpose: 'change_new' });
      newCountdown.start(res.resendInSec);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!isValidCnPhone(newPhone)) return setError(t('phone.invalid'));
    if (!OTP_RE.test(newCode)) return setError(t('code.invalid'));
    const body =
      proof === 'old_code'
        ? { oldCode }
        : proof === 'password'
          ? { identityProof: { method: 'password' as const, value: password } }
          : { identityProof: { method: 'wechat' as const, value: wechatToken ?? '' } };
    if (proof === 'old_code' && !OTP_RE.test(oldCode)) return setError(t('code.invalid'));
    setBusy('submit');
    try {
      const res = await changePhone({ ...body, newPhone: normalizePhoneInput(newPhone), newCode });
      clearReverifyToken();
      setDone(t('change.done', { phone: res.phoneMasked }));
      setOpen(false);
      setOldCode('');
      setNewCode('');
      setPassword('');
      setWechatToken(null);
      await qc.invalidateQueries({ queryKey: STATUS_KEY });
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }

  const reverifyHref = (isWechatBrowser() ? wechatMpStartUrl : wechatQrUrl)({ purpose: 'reverify', next: '/settings#security' });

  return (
    <section className={styles.section} aria-labelledby={`${ids}-title`}>
      <h3 id={`${ids}-title`} className={styles.sectionTitle}>
        {t('change.title')}
      </h3>
      <div className={styles.row}>
        <p className={styles.hint}>{t('change.current', { phone: data.phoneMasked })}</p>
        {!open ? (
          <Btn
            onClick={() => {
              setOpen(true);
              setDone(null);
            }}
          >
            {t('change.start')}
          </Btn>
        ) : null}
      </div>
      {done ? (
        <p className={styles.notice} role="status">
          {done}
        </p>
      ) : null}
      {open ? (
        <form className={styles.form} onSubmit={onSubmit} noValidate aria-busy={busy === 'submit'}>
          <p className={styles.step}>{t('change.stepOld')}</p>
          {proof === 'old_code' ? (
            <>
              <div className={styles.field}>
                <label htmlFor={`${ids}-old`} className={styles.label}>
                  {t('phone.label')}
                </label>
                <div className={styles.inputWrap}>
                  <span className={styles.prefix} aria-hidden="true">
                    {t('phone.prefix')}
                  </span>
                  <input
                    id={`${ids}-old`}
                    className={styles.input}
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    maxLength={14}
                    placeholder={data.phoneMasked}
                    value={oldPhone}
                    onChange={(e) => setOldPhone(e.target.value.replace(/[^\d+\s-]/g, ''))}
                  />
                </div>
              </div>
              <div className={styles.field}>
                <label htmlFor={`${ids}-oldcode`} className={styles.label}>
                  {t('code.label')}
                </label>
                <div className={styles.control}>
                  <div className={styles.inputWrap}>
                    <input
                      id={`${ids}-oldcode`}
                      className={styles.input}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder={t('code.placeholder')}
                      value={oldCode}
                      onChange={(e) => setOldCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    />
                  </div>
                  <button type="button" className={styles.sendBtn} onClick={sendOld} disabled={!isValidCnPhone(oldPhone) || busy === 'old' || oldCountdown.left > 0}>
                    {busy === 'old' ? t('code.sending') : oldCountdown.left > 0 ? t('code.resendIn', { seconds: oldCountdown.left }) : t('code.send')}
                  </button>
                </div>
              </div>
            </>
          ) : null}
          {proof === 'password' ? (
            <div className={styles.field}>
              <label htmlFor={`${ids}-pw`} className={styles.label}>
                {t('change.password')}
              </label>
              <div className={styles.inputWrap}>
                <input id={`${ids}-pw`} className={styles.input} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </div>
          ) : null}
          {proof === 'wechat' ? (
            wechatToken ? (
              <p className={styles.notice}>{t('change.wechatVerified')}</p>
            ) : (
              <Btn as="a" href={reverifyHref}>
                {t('change.wechatVerify')}
              </Btn>
            )
          ) : null}
          {proof === 'old_code' ? (
            data.hasPassword || (data.hasWechat && wechatOn) ? (
              <button type="button" className={styles.linkBtn} onClick={() => setProof(data.hasPassword ? 'password' : 'wechat')}>
                {t('change.lostOld')}
              </button>
            ) : (
              <p className={styles.hint}>{t('change.noOtherWay')}</p>
            )
          ) : (
            <div className={styles.row}>
              {proof === 'password' && data.hasWechat && wechatOn ? (
                <button type="button" className={styles.linkBtn} onClick={() => setProof('wechat')}>
                  {t('change.wechatVerify')}
                </button>
              ) : null}
              <button type="button" className={styles.linkBtn} onClick={() => setProof('old_code')}>
                {t('change.useOld')}
              </button>
            </div>
          )}

          <p className={styles.step}>{t('change.stepNew')}</p>
          <div className={styles.field}>
            <label htmlFor={`${ids}-new`} className={styles.label}>
              {t('change.newPhone')}
            </label>
            <div className={styles.inputWrap}>
              <span className={styles.prefix} aria-hidden="true">
                {t('phone.prefix')}
              </span>
              <input
                id={`${ids}-new`}
                className={styles.input}
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                maxLength={14}
                placeholder={t('phone.placeholder')}
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value.replace(/[^\d+\s-]/g, ''))}
              />
            </div>
          </div>
          <div className={styles.field}>
            <label htmlFor={`${ids}-newcode`} className={styles.label}>
              {t('code.label')}
            </label>
            <div className={styles.control}>
              <div className={styles.inputWrap}>
                <input
                  id={`${ids}-newcode`}
                  className={styles.input}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder={t('code.placeholder')}
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              </div>
              <button type="button" className={styles.sendBtn} onClick={sendNew} disabled={!isValidCnPhone(newPhone) || busy === 'new' || newCountdown.left > 0}>
                {busy === 'new' ? t('code.sending') : newCountdown.left > 0 ? t('code.resendIn', { seconds: newCountdown.left }) : t('code.send')}
              </button>
            </div>
            {newCountdown.left > 0 ? <p className={styles.hint}>{t('code.sent', { phone: maskPhoneInput(newPhone) })}</p> : null}
          </div>

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.row}>
            <Btn
              onClick={() => {
                setOpen(false);
                setError(null);
                clearReverifyToken();
                setWechatToken(null);
                setProof('old_code');
              }}
            >
              {t('change.cancel')}
            </Btn>
            <Btn type="submit" variant="primary" disabled={busy === 'submit'} aria-busy={busy === 'submit'}>
              {busy === 'submit' ? t('change.submitting') : t('change.submit')}
            </Btn>
          </div>
        </form>
      ) : null}
    </section>
  );
}
