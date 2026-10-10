'use client';

// SignupConsents — the G0 boxes a new GoApply account must tick: one box per
// required consent of the sign-up policy (the agreement to the user agreement
// and privacy policy, the age confirmation and, in CN-0, the separate
// cross-border consent naming every offshore processor; PIPL, TASK_PLAN.md
// H6). No box is ever pre-ticked.
//
// The text beside each box is the text the server serves for that consent
// (`prose.text`, the compliance catalog prose in the page's language) and is
// rendered verbatim: the consent record stores the hash of this exact string
// (INT-01). The names of the two documents inside the text are turned into
// links; that changes no character of the text. Nothing is rendered until the
// policy and its texts have loaded.
//
// The values live in the shared store (shared.ts) so the phone form, the
// WeChat button and the email form use one set.

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand/BrandProvider';
import type { SignupPolicyResponse } from '../../../lib/api/contracts/auth-cn';
import { consentKey, shownConsents, useSignupInputs } from './shared';
import styles from './AuthCn.module.css';

/** How the consent texts name the two documents (Chinese, English). */
const DOCUMENT_NAMES: ReadonlyArray<{ doc: 'terms' | 'privacy'; name: string }> = [
  { doc: 'terms', name: '《用户协议》' },
  { doc: 'privacy', name: '《隐私政策》' },
  { doc: 'terms', name: 'User Agreement' },
  { doc: 'privacy', name: 'Privacy Policy' },
];

/** `text` with each document name wrapped in a link to that document. The characters are unchanged. */
export function linkDocuments(text: string, paths: { terms: string; privacy: string }): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    let first: { at: number; doc: 'terms' | 'privacy'; name: string } | null = null;
    for (const d of DOCUMENT_NAMES) {
      const at = rest.indexOf(d.name);
      if (at >= 0 && (!first || at < first.at)) first = { at, ...d };
    }
    if (!first) break;
    if (first.at > 0) out.push(rest.slice(0, first.at));
    out.push(
      <a key={key++} href={paths[first.doc]} target="_blank" rel="noopener">
        {first.name}
      </a>,
    );
    rest = rest.slice(first.at + first.name.length);
  }
  if (rest) out.push(rest);
  return out;
}

export function SignupConsents({ policy }: { policy: SignupPolicyResponse | undefined }) {
  const brand = useBrand();
  const [value, set] = useSignupInputs();
  const consents = shownConsents(policy);
  if (!consents.length) return null;
  const paths = {
    terms: policy?.legal.termsPath ?? brand.legal.termsPath,
    privacy: policy?.legal.privacyPath ?? brand.legal.privacyPath,
  };
  return (
    <div className={styles.checks}>
      {consents.map((consent) => {
        const key = consentKey(consent);
        const prose = consent.prose!;
        return (
          <label key={key} className={styles.check}>
            <input
              type="checkbox"
              checked={value.granted[key] === true}
              onChange={(e) => set({ granted: { ...value.granted, [key]: e.target.checked } })}
              required
              data-consent={consent.type}
            />
            <span lang={prose.locale} data-consent-text={consent.type}>
              {linkDocuments(prose.text, paths)}
            </span>
          </label>
        );
      })}
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
