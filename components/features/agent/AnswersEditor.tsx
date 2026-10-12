'use client';

// AnswersEditor — the common application answers (answer bank; PRODUCT
// F-AGENT-03). The review screen shows them with copy buttons, and the
// extension fills them only when the user asks (WP-55a).
//
// The questions are the server's (GET /agent/answers/questions, canonical
// keys owned by WP-52); questions.ts is the same list for while that read is
// loading or unavailable. The user writes every answer. Questions forms ask
// about work authorization, salary or notice period are answered only from
// here or the profile — never by AI. Salary expectation takes one answer per
// currency. GoApply's 家庭成员 / 政治面貌 are optional and never sent to a
// model. Clearing an answer (or removing your own question) deletes it: the
// server deletes a key saved with a blank answer.

import { useCallback, useEffect, useImperativeHandle, useMemo, useState, type Ref } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { useAnswerBank, useQuestionKeys, useSaveAnswers } from '../../../hooks/agent';
import { useBrand } from '../../../lib/brand';
import type { QuestionKeyView } from '../../../lib/api/agent';
import { ANSWER_CURRENCIES, HINT_KEYS, MULTILINE_KEYS, currencyKey, currencyVariant, customQuestionKey, isCustomKey, questionsFor } from './questions';
import styles from './ready.module.css';

interface OwnRow {
  key: string;
  question: string;
  answer: string;
}

/** What the setup wizard needs from a step form: unsaved changes, and a way to save them. */
export interface StepFormHandle {
  dirty: () => boolean;
  /** Save; true when saved (or nothing to save). */
  save: () => Promise<boolean>;
}

export interface AnswersEditorProps {
  onSaved?: () => void;
  /** Lets the wizard save unsaved answers on Continue. */
  handleRef?: Ref<StepFormHandle | null>;
}

function snapshot(answers: Record<string, string>, own: OwnRow[]): string {
  const a = Object.entries(answers)
    .filter(([, v]) => v.trim())
    .map(([k, v]) => [k, v.trim()])
    .sort(([x], [y]) => (x! < y! ? -1 : 1));
  const o = own.filter((r) => r.answer.trim()).map((r) => [r.key, r.answer.trim()]);
  return JSON.stringify([a, o]);
}

export function AnswersEditor({ onSaved, handleRef }: AnswersEditorProps) {
  const t = useTranslations('ready');
  const locale = useLocale();
  const brand = useBrand();
  const bank = useAnswerBank();
  const serverQuestions = useQuestionKeys();
  const save = useSaveAnswers();
  const questions: QuestionKeyView[] = useMemo(() => serverQuestions.data?.items ?? questionsFor(brand.market), [serverQuestions.data, brand.market]);
  const known = useMemo(() => new Set(questions.map((q) => q.key)), [questions]);

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [currencies, setCurrencies] = useState<Record<string, string[]>>({});
  const [own, setOwn] = useState<OwnRow[]>([]);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [initial, setInitial] = useState('');
  const [newQuestion, setNewQuestion] = useState('');
  const [newCurrency, setNewCurrency] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle');

  const label = useCallback(
    (q: QuestionKeyView) => {
      const path = `questions.${q.key}`;
      if (t.has(path)) return t(path);
      const lang = locale.split('-')[0] ?? 'en';
      return q.text[locale] ?? q.text[lang] ?? q.text.en ?? q.key;
    },
    [t, locale],
  );

  // Seed from the server (and again after each save).
  const items = bank.data?.items;
  useEffect(() => {
    if (!items) return;
    const a: Record<string, string> = {};
    const cur: Record<string, string[]> = {};
    const rows: OwnRow[] = [];
    for (const it of items) {
      const variant = currencyVariant(it.questionKey);
      if (variant && known.has(variant.base)) {
        a[it.questionKey] = it.answer;
        cur[variant.base] = [...(cur[variant.base] ?? []), variant.currency];
      } else if (known.has(it.questionKey)) {
        a[it.questionKey] = it.answer;
      } else {
        // The user's own questions, and any saved key this list does not
        // name: kept, editable, removable — never dropped silently.
        rows.push({ key: it.questionKey, question: it.questionText, answer: it.answer });
      }
    }
    setAnswers(a);
    setCurrencies(cur);
    setOwn(rows);
    setSaved(new Set(items.map((i) => i.questionKey)));
    setInitial(snapshot(a, rows));
  }, [items, known]);

  const dirty = useCallback(() => snapshot(answers, own) !== initial, [answers, own, initial]);

  const addQuestion = () => {
    const q = newQuestion.trim();
    if (!q) return;
    const key = customQuestionKey(q);
    if (!own.some((r) => r.key === key)) setOwn((rows) => [...rows, { key, question: q, answer: '' }]);
    setNewQuestion('');
  };

  const addCurrency = (base: string) => {
    const code = newCurrency[base] ?? '';
    if (!code) return;
    setCurrencies((c) => ((c[base] ?? []).includes(code) ? c : { ...c, [base]: [...(c[base] ?? []), code] }));
    setNewCurrency((n) => ({ ...n, [base]: '' }));
  };

  const doSave = useCallback(async (): Promise<boolean> => {
    setStatus('idle');
    const textOf = new Map<string, string>();
    for (const q of questions) {
      textOf.set(q.key, label(q));
      for (const c of currencies[q.key] ?? []) textOf.set(currencyKey(q.key, c), `${label(q)} (${c})`);
    }
    const body: Array<{ questionKey: string; questionText: string; answer: string; locale: string }> = [];
    const sent = new Set<string>();
    for (const [key, text] of textOf) {
      const answer = (answers[key] ?? '').trim();
      // A blank answer for a saved key deletes it; a blank new one is not sent.
      if (!answer && !saved.has(key)) continue;
      body.push({ questionKey: key, questionText: text, answer, locale });
      sent.add(key);
    }
    for (const r of own) {
      const answer = r.answer.trim();
      if (!answer && !saved.has(r.key)) continue;
      body.push({ questionKey: r.key, questionText: r.question, answer, locale });
      sent.add(r.key);
    }
    // Removed rows that were saved: delete them too.
    const own0 = new Map(own.map((r) => [r.key, r]));
    for (const key of saved) {
      if (sent.has(key) || own0.has(key)) continue;
      const original = items?.find((i) => i.questionKey === key);
      if (original) body.push({ questionKey: key, questionText: original.questionText, answer: '', locale });
    }
    if (body.length === 0) return true;
    try {
      await save.mutateAsync({ answers: body });
      setStatus('saved');
      onSaved?.();
      return true;
    } catch {
      setStatus('failed');
      return false;
    }
  }, [questions, currencies, answers, own, saved, items, locale, label, save, onSaved]);

  useImperativeHandle(handleRef, () => ({ dirty, save: doSave }), [dirty, doSave]);

  if (bank.isLoading) return <p className={styles.muted}>{t('loading')}</p>;

  const field = (id: string, key: string, multiline: boolean) => {
    const value = answers[key] ?? '';
    const set = (v: string) => {
      setStatus('idle');
      setAnswers((a) => ({ ...a, [key]: v }));
    };
    return multiline ? (
      <textarea id={id} className={styles.textarea} maxLength={5000} value={value} onChange={(e) => set(e.target.value)} />
    ) : (
      <input id={id} className={styles.input} maxLength={5000} value={value} onChange={(e) => set(e.target.value)} />
    );
  };

  return (
    <div className={styles.stack} data-testid="answers-editor">
      <p className={styles.body}>{t('answers.lead')}</p>
      {bank.isError ? <p className={styles.error}>{t('answers.loadFailed')}</p> : null}
      {questions.map((q) => {
        const id = `answer-${q.key}`;
        const name = label(q);
        return (
          <div key={q.key} className={styles.stack} data-question={q.key}>
            <label htmlFor={id} className={styles.label}>
              <span>
                {name}
                {q.sensitive ? <span className={styles.muted}> {t('answers.optional')}</span> : null}
              </span>
            </label>
            {HINT_KEYS.has(q.key) ? <p className={styles.muted}>{t(`answers.hints.${q.key}`)}</p> : null}
            {q.sensitive ? <p className={styles.muted}>{t('answers.sensitiveNote')}</p> : q.protectedType ? <p className={styles.muted}>{t('answers.protectedNote')}</p> : null}
            {field(id, q.key, MULTILINE_KEYS.has(q.key))}
            {q.perCurrency ? (
              <div className={styles.stack}>
                {(currencies[q.key] ?? []).map((c) => {
                  const key = currencyKey(q.key, c);
                  return (
                    <div key={key} className={styles.stack}>
                      <div className={styles.spread}>
                        <label htmlFor={`answer-${key}`} className={styles.label}>
                          {t('answers.inCurrency', { question: name, currency: c })}
                        </label>
                        <button
                          type="button"
                          className={styles.linkButton}
                          onClick={() => {
                            setAnswers((a) => ({ ...a, [key]: '' }));
                            setCurrencies((all) => ({ ...all, [q.key]: (all[q.key] ?? []).filter((x) => x !== c) }));
                          }}
                        >
                          {t('answers.remove')}
                        </button>
                      </div>
                      {field(`answer-${key}`, key, false)}
                    </div>
                  );
                })}
                <div className={styles.row}>
                  <label className={styles.label} htmlFor={`currency-${q.key}`}>
                    {t('answers.currencyLabel')}
                  </label>
                  <select
                    id={`currency-${q.key}`}
                    className={styles.select}
                    value={newCurrency[q.key] ?? ''}
                    onChange={(e) => setNewCurrency((n) => ({ ...n, [q.key]: e.target.value }))}
                  >
                    <option value="">{t('answers.currencyPick')}</option>
                    {ANSWER_CURRENCIES.filter((c) => !(currencies[q.key] ?? []).includes(c)).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <Btn onClick={() => addCurrency(q.key)} disabled={!newCurrency[q.key]}>
                    {t('answers.addCurrency')}
                  </Btn>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      {own.map((r, i) => (
        <div key={r.key} className={styles.stack}>
          <div className={styles.spread}>
            <label htmlFor={`answer-${r.key}`} className={styles.label}>
              {r.question}
            </label>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                setStatus('idle');
                setOwn((rows) => rows.filter((_, j) => j !== i));
              }}
            >
              {t('answers.remove')}
            </button>
          </div>
          <textarea
            id={`answer-${r.key}`}
            className={styles.textarea}
            maxLength={5000}
            value={r.answer}
            onChange={(e) => {
              setStatus('idle');
              setOwn((rows) => rows.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)));
            }}
          />
        </div>
      ))}

      <div className={styles.stack}>
        <label htmlFor="answer-new-question" className={styles.label}>
          {t('answers.addLabel')}
        </label>
        <div className={styles.row}>
          <input
            id="answer-new-question"
            className={styles.input}
            maxLength={500}
            value={newQuestion}
            onChange={(e) => setNewQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addQuestion();
              }
            }}
          />
          <Btn onClick={addQuestion} disabled={!newQuestion.trim()}>
            {t('answers.add')}
          </Btn>
        </div>
      </div>

      <div className={styles.row}>
        <Btn variant="primary" onClick={() => void doSave()} disabled={save.isPending} aria-busy={save.isPending}>
          {save.isPending ? t('answers.saving') : t('answers.save')}
        </Btn>
        {status === 'saved' ? (
          <p className={styles.status} role="status">
            {t('answers.saved')}
          </p>
        ) : null}
        {status === 'failed' ? (
          <p className={styles.error} role="alert">
            {t('answers.failed')}
          </p>
        ) : null}
      </div>
    </div>
  );
}
