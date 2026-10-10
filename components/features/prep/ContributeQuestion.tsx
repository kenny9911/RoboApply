'use client';

// ContributeQuestion — "Share a question you were asked" (F-INT-03; WP-59).
// A dialog with company, role, the month and the question. Nothing shows to
// anyone until staff check it; the form says what not to share (test or
// assessment content under an NDA, copied material, anyone's contact details).
// GoApply needs a bound phone (403 → PhoneBindingNotice).

import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { Modal } from '../../v3/primitives/Modal';
import { useContributeQuestion } from '../../../hooks/prep/usePrep';
import { apiErrorReason } from '../../../lib/api/contracts/wire';
import { PhoneBindingNotice } from '../auth-cn';
import { prepErrorKey } from './errors';
import styles from './prep.module.css';

// The local month: the server accepts any month that has started somewhere
// (it compares with UTC+14), so a user east of UTC can pick it right away.
function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export interface ContributeQuestionProps {
  /**
   * Prefill the company (e.g. on a company page). Follows the prop until the
   * user edits the field, so a name that loads later replaces the first value.
   */
  company?: string;
}

export function ContributeQuestion({ company: initialCompany = '' }: ContributeQuestionProps) {
  const t = useTranslations('practiceQuestions.share');
  const tErr = useTranslations('practiceQuestions.errors');
  const contribute = useContributeQuestion();
  const [open, setOpen] = useState(false);
  const [company, setCompany] = useState(initialCompany);
  const [companyEdited, setCompanyEdited] = useState(false);
  useEffect(() => {
    if (!companyEdited) setCompany(initialCompany);
  }, [initialCompany, companyEdited]);
  const [role, setRole] = useState('');
  const [period, setPeriod] = useState(currentMonth());
  const [question, setQuestion] = useState('');
  const base = useId();
  const max = currentMonth();

  const close = () => {
    setOpen(false);
    if (contribute.isSuccess) {
      contribute.reset();
      setQuestion('');
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    contribute.mutate({ company: company.trim(), question: question.trim(), period, ...(role.trim() ? { role: role.trim() } : {}) });
  };

  const errKey = contribute.isError ? prepErrorKey(contribute.error) : null;
  const errReason = contribute.isError ? apiErrorReason(contribute.error) : null;
  const canSend = company.trim().length > 0 && question.trim().length >= 10 && /^\d{4}-\d{2}$/.test(period) && period <= max;

  return (
    <>
      <Btn onClick={() => setOpen(true)}>{t('open')}</Btn>
      <Modal open={open} onClose={close} title={t('title')} description={t('intro')} maxWidth="lg">
        {contribute.isSuccess ? (
          <div className={styles.form}>
            <p className={styles.success} role="status">
              {t('sent')}
            </p>
            <div className={styles.actions}>
              <Btn variant="primary" onClick={close}>
                {t('done')}
              </Btn>
            </div>
          </div>
        ) : (
          <form className={styles.form} onSubmit={submit}>
            <p className={styles.note}>{t('rules')}</p>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${base}-company`}>
                {t('company')}
              </label>
              <input
                id={`${base}-company`}
                className={styles.input}
                value={company}
                maxLength={120}
                required
                onChange={(e) => {
                  setCompanyEdited(true);
                  setCompany(e.target.value);
                }}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${base}-role`}>
                {t('role')}
              </label>
              <input id={`${base}-role`} className={styles.input} value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${base}-period`}>
                {t('period')}
              </label>
              <input id={`${base}-period`} className={styles.input} type="month" value={period} max={max} required onChange={(e) => setPeriod(e.target.value)} />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${base}-question`}>
                {t('question')}
              </label>
              <textarea
                id={`${base}-question`}
                className={styles.textarea}
                value={question}
                minLength={10}
                maxLength={2000}
                required
                aria-describedby={`${base}-question-hint`}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <p className={styles.muted} id={`${base}-question-hint`}>
                {t('questionHint')}
              </p>
            </div>
            {errKey === 'phone' ? <PhoneBindingNotice error={contribute.error} /> : null}
            {errKey && errKey !== 'phone' ? (
              <p className={styles.error} role="alert">
                {errKey === 'limit' ? tErr('shareLimit') : errReason === 'invalid_period' ? t('periodError') : errReason === 'company_required' ? t('companyError') : t('error')}
              </p>
            ) : null}
            <div className={styles.actions}>
              <Btn type="submit" variant="primary" disabled={!canSend || contribute.isPending}>
                {t('submit')}
              </Btn>
              <Btn onClick={close}>{t('cancel')}</Btn>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
