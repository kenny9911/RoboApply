'use client';

// SignupConsents — the G0 agreement box (user agreement + privacy policy +
// age 16, required, unchecked by default) and, in CN-0, the separate
// cross-border box naming every offshore processor (PIPL; TASK_PLAN.md H6).
// Neither box is ever pre-checked. The values live in the shared store
// (shared.ts) so the phone form and the WeChat button use one set.

import { useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand/BrandProvider';
import type { SignupPolicyResponse } from '../../../lib/api/contracts/auth-cn';
import { needsCrossBorder, useSignupInputs } from './shared';
import styles from './AuthCn.module.css';

export function SignupConsents({ policy }: { policy: SignupPolicyResponse | undefined }) {
  const t = useTranslations('authCn');
  const brand = useBrand();
  const [value, set] = useSignupInputs();
  const terms = policy?.legal.termsPath ?? brand.legal.termsPath;
  const privacy = policy?.legal.privacyPath ?? brand.legal.privacyPath;
  return (
    <div className={styles.checks}>
      <label className={styles.check}>
        <input type="checkbox" checked={value.agreed} onChange={(e) => set({ agreed: e.target.checked })} required />
        <span>
          {t.rich('consent.agreement', {
            terms: (chunks) => (
              <a href={terms} target="_blank" rel="noopener">
                {chunks}
              </a>
            ),
            privacy: (chunks) => (
              <a href={privacy} target="_blank" rel="noopener">
                {chunks}
              </a>
            ),
          })}
        </span>
      </label>
      {needsCrossBorder(policy) ? (
        <label className={styles.check}>
          <input type="checkbox" checked={value.crossBorder} onChange={(e) => set({ crossBorder: e.target.checked })} required />
          <span>{t('consent.crossBorder')}</span>
        </label>
      ) : null}
    </div>
  );
}

export function InviteCodeField({ id }: { id: string }) {
  const t = useTranslations('authCn');
  const [value, set] = useSignupInputs();
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {t('invite.label')}
      </label>
      <div className={styles.inputWrap}>
        <input
          id={id}
          className={styles.input}
          value={value.invite}
          onChange={(e) => set({ invite: e.target.value.toUpperCase() })}
          placeholder={t('invite.placeholder')}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={32}
          aria-describedby={`${id}-hint`}
        />
      </div>
      <p id={`${id}-hint`} className={styles.hint}>
        {t('invite.hint')}
      </p>
    </div>
  );
}
