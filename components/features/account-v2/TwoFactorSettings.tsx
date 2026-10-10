'use client';

// TwoFactorSettings — two-step sign-in in /settings#security (F-TRUST-07;
// TASK_PLAN.md WP-79). INT mounts it in the security section.
//
//   off      "Turn on" (only when the server says it can be turned on: every
//            sign-in path checks the code and the key is set) → QR code + key
//            → first code confirms → recovery codes, shown once, with copy
//            and download → "I saved them"
//   on       since when, recovery codes left; "Make new recovery codes"
//            (needs a code); "Turn off" (a code or a recovery code)
// Nothing renders when the `totp` capability is off, or when it cannot be
// turned on and is not on (no dead control).

import { useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { accountV2Api } from '../../../lib/api/accountV2';
import type { TotpEnrolResponse } from '../../../lib/api/contracts/account-v2';
import { TWO_FACTOR_KEY, errorKey, useInvalidate, useMutation, useTwoFactorStatus } from './queries';
import styles from './accountV2.module.css';

const KNOWN = ['totp_invalid', 'totp_key_missing', 'totp_not_available'] as const;
const CODE_RE = /^\d{6}$/;
const RECOVERY_RE = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

type Mode = 'idle' | 'enrolling' | 'codes' | 'disabling' | 'regenerating';

export function TwoFactorSettings() {
  const t = useTranslations('accountV2');
  const format = useFormatter();
  const status = useTwoFactorStatus();
  const invalidate = useInvalidate(TWO_FACTOR_KEY);
  const [mode, setMode] = useState<Mode>('idle');
  const [enrol, setEnrol] = useState<TotpEnrolResponse | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => accountV2Api.enrolTwoFactor(),
    onSuccess: (res) => {
      setEnrol(res);
      setMode('enrolling');
      setError(null);
    },
    onError: (err) => setError(errorKey(err, 'twoFactor', KNOWN)),
  });

  if (!status.data && !status.isLoading && !status.isError) return null; // capability off
  if (status.isLoading) {
    return (
      <section className={styles.card} aria-busy="true">
        <p className={styles.muted}>{t('common.loading')}</p>
      </section>
    );
  }
  if (status.isError || !status.data) {
    return (
      <section className={styles.card} role="alert">
        <p className={styles.body}>{t('common.loadError')}</p>
        <div className={styles.actions}>
          <Btn onClick={() => void status.refetch()}>{t('common.retry')}</Btn>
        </div>
      </section>
    );
  }

  const s = status.data;
  if (!s.enabled && !s.available && mode === 'idle') return null;

  const done = () => {
    setMode('idle');
    setEnrol(null);
    setCodes([]);
    setError(null);
    void invalidate();
  };

  const enrolledAt = s.enrolledAt ? new Date(s.enrolledAt) : null;

  return (
    <section className={styles.card} aria-labelledby="two-factor-title" data-testid="two-factor-settings">
      <div className={styles.head}>
        <h2 className={styles.h2} id="two-factor-title">
          {t('twoFactor.title')}
        </h2>
        <span className={`${styles.status} ${s.enabled ? styles.statusOn : ''}`}>
          {s.enabled && enrolledAt ? t('twoFactor.statusOn', { date: format.dateTime(enrolledAt, { dateStyle: 'medium' }) }) : t('twoFactor.statusOff')}
        </span>
      </div>
      <p className={styles.body}>{t('twoFactor.sub')}</p>

      {mode === 'codes' ? (
        <RecoveryCodes codes={codes} onDone={done} />
      ) : mode === 'enrolling' && enrol ? (
        <EnrolStep
          enrol={enrol}
          onCancel={done}
          onEnabled={(c) => {
            setCodes(c);
            setMode('codes');
          }}
        />
      ) : mode === 'disabling' ? (
        <FactorForm
          title={t('twoFactor.disable.title')}
          sub={t('twoFactor.disable.sub')}
          submitLabel={t('twoFactor.disable.confirm')}
          allowRecovery
          onCancel={() => setMode('idle')}
          submit={async (f) => {
            await accountV2Api.disableTwoFactor(f);
            done();
          }}
        />
      ) : mode === 'regenerating' ? (
        <FactorForm
          title={t('twoFactor.regenerate.action')}
          sub={t('twoFactor.regenerate.sub')}
          submitLabel={t('twoFactor.regenerate.confirm')}
          onCancel={() => setMode('idle')}
          submit={async (f) => {
            const res = await accountV2Api.regenerateRecoveryCodes({ code: f.code! });
            setCodes(res.recoveryCodes);
            setMode('codes');
          }}
        />
      ) : s.enabled ? (
        <>
          <p className={styles.muted}>{t('twoFactor.recoveryLeft', { n: s.recoveryCodesLeft })}</p>
          {s.recoveryCodesLeft <= 3 ? <p className={styles.body}>{t('twoFactor.recoveryLow')}</p> : null}
          <div className={styles.actions}>
            <Btn onClick={() => setMode('regenerating')}>{t('twoFactor.regenerate.action')}</Btn>
            <Btn variant="ghost" onClick={() => setMode('disabling')}>
              {t('twoFactor.disable.action')}
            </Btn>
          </div>
          <p className={styles.muted}>{t('twoFactor.otherSessions')}</p>
        </>
      ) : (
        <>
          {error ? (
            <p className={styles.error} role="alert">
              {t(error)}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Btn variant="primary" disabled={start.isPending} aria-busy={start.isPending || undefined} onClick={() => start.mutate()}>
              {t('twoFactor.turnOn')}
            </Btn>
          </div>
          <p className={styles.muted}>{t('twoFactor.otherSessions')}</p>
        </>
      )}
    </section>
  );
}

function EnrolStep({ enrol, onCancel, onEnabled }: { enrol: TotpEnrolResponse; onCancel: () => void; onEnabled: (codes: string[]) => void }) {
  const t = useTranslations('accountV2');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const verify = useMutation({
    mutationFn: (c: string) => accountV2Api.verifyTwoFactor({ code: c }),
    onSuccess: (res) => onEnabled(res.recoveryCodes),
    onError: (err) => setError(errorKey(err, 'twoFactor', KNOWN)),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (CODE_RE.test(code)) verify.mutate(code);
  }

  return (
    <form className={styles.stack} onSubmit={onSubmit} data-testid="two-factor-enrol">
      <h3 className={styles.h3}>{t('twoFactor.enrol.step1')}</h3>
      {enrol.qrDataUrl ? (
        // A data URL drawn by the server; next/image adds nothing here.
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.qr} src={enrol.qrDataUrl} alt={t('twoFactor.enrol.qrAlt')} width={200} height={200} />
      ) : null}
      <p className={styles.muted}>{t('twoFactor.enrol.manual')}</p>
      <code className={styles.secret} data-testid="two-factor-secret">
        {enrol.secret.replace(/(.{4})/g, '$1 ').trim()}
      </code>
      <a className={styles.linkButton} href={enrol.otpauthUri}>
        {t('twoFactor.enrol.openApp')}
      </a>
      <h3 className={styles.h3}>{t('twoFactor.enrol.step2')}</h3>
      <CodeInput label={t('twoFactor.enrol.codeLabel')} value={code} onChange={setCode} />
      {error ? (
        <p className={styles.error} role="alert">
          {t(error)}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Btn type="submit" variant="primary" disabled={!CODE_RE.test(code) || verify.isPending} aria-busy={verify.isPending || undefined}>
          {verify.isPending ? t('twoFactor.enrol.confirming') : t('twoFactor.enrol.confirm')}
        </Btn>
        <Btn variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Btn>
      </div>
    </form>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useTranslations('accountV2');
  const [copied, setCopied] = useState(false);
  const text = `${t('twoFactor.recovery.fileHeading')}\n\n${codes.join('\n')}\n`;
  const href = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  return (
    <div className={styles.stack} data-testid="recovery-codes">
      <h3 className={styles.h3}>{t('twoFactor.recovery.title')}</h3>
      <p className={styles.body}>{t('twoFactor.recovery.sub')}</p>
      <ul className={styles.codes}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className={styles.actions}>
        <Btn
          onClick={() => {
            void navigator.clipboard?.writeText(codes.join('\n')).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? t('twoFactor.recovery.copied') : t('twoFactor.recovery.copy')}
        </Btn>
        <Btn as="a" href={href} download="recovery-codes.txt">
          {t('twoFactor.recovery.download')}
        </Btn>
        <Btn variant="primary" onClick={onDone}>
          {t('twoFactor.recovery.done')}
        </Btn>
      </div>
    </div>
  );
}

export function CodeInput({ label, value, onChange, recovery = false }: { label: string; value: string; onChange: (v: string) => void; recovery?: boolean }) {
  const id = recovery ? 'recovery-code' : 'one-time-code';
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`${styles.input} ${styles.code}`}
        value={value}
        onChange={(e) => onChange(recovery ? e.target.value.trim().toLowerCase() : e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode={recovery ? 'text' : 'numeric'}
        autoComplete={recovery ? 'off' : 'one-time-code'}
        autoCapitalize="none"
        spellCheck={false}
        maxLength={recovery ? 14 : 6}
      />
    </div>
  );
}

type Factor = { code?: string; recoveryCode?: string };

function FactorForm({
  title,
  sub,
  submitLabel,
  allowRecovery = false,
  onCancel,
  submit,
}: {
  title: string;
  sub: string;
  submitLabel: string;
  allowRecovery?: boolean;
  onCancel: () => void;
  submit: (factor: Factor) => Promise<void>;
}) {
  const t = useTranslations('accountV2');
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({ mutationFn: submit, onError: (err) => setError(errorKey(err, 'twoFactor', KNOWN)) });
  const valid = useRecovery ? RECOVERY_RE.test(value) : CODE_RE.test(value);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (valid) run.mutate(useRecovery ? { recoveryCode: value } : { code: value });
  }

  return (
    <form className={styles.stack} onSubmit={onSubmit}>
      <h3 className={styles.h3}>{title}</h3>
      <p className={styles.body}>{sub}</p>
      <CodeInput
        label={useRecovery ? t('twoFactor.recoveryLabel') : t('twoFactor.codeLabel')}
        value={value}
        onChange={setValue}
        recovery={useRecovery}
      />
      {allowRecovery ? (
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => {
            setUseRecovery((v) => !v);
            setValue('');
          }}
        >
          {useRecovery ? t('twoFactor.useCode') : t('twoFactor.useRecovery')}
        </button>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {t(error)}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Btn type="submit" variant="primary" disabled={!valid || run.isPending} aria-busy={run.isPending || undefined}>
          {submitLabel}
        </Btn>
        <Btn variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Btn>
      </div>
    </form>
  );
}

export default TwoFactorSettings;
