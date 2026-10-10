'use client';

// The editor's side panels (WP-37; F-CL-02): Rewrite with AI, Sources and
// Versions. Props-driven: the editor owns the data and the actions.

import { useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn, CreditNotice, type CreditBucketLike } from '../../v3/primitives';
import type { CoverLetterView, LetterLength, LetterTone } from '../../../lib/api/contracts/coverletter';
import type { LetterErrorKind } from '../../../hooks/coverletter/useCoverLetters';
import { PhoneBindingNotice } from '../auth-cn';
import { LetterError } from './LetterError';
import styles from './CoverLetter.module.css';

const QUICK = ['quickOpening', 'quickSpecific', 'quickShorter', 'quickFormal'] as const;
const TONES: readonly LetterTone[] = ['plain', 'warm', 'formal'];
const LENGTHS: readonly LetterLength[] = ['short', 'standard'];

export interface RewritePanelProps {
  letter: CoverLetterView;
  pending: null | 'rewrite' | 'regenerate' | string;
  error: { kind: LetterErrorKind; cause?: unknown } | null;
  creditBucket: CreditBucketLike | null;
  onRewrite: (instruction: string) => void;
  onRegenerate: (body: { tone: LetterTone; length: LetterLength }) => void;
}

export function RewritePanel({ letter, pending, error, creditBucket, onRewrite, onRegenerate }: RewritePanelProps) {
  const t = useTranslations('coverLetter');
  const [instruction, setInstruction] = useState('');
  const [tone, setTone] = useState<LetterTone>(letter.tone);
  const [length, setLength] = useState<LetterLength>(letter.length);
  const busy = pending === 'rewrite' || pending === 'regenerate';
  const noneLeft = letter.rewritesLeftToday === 0;

  if (!letter.aiAvailable) return <p className={styles.notice}>{t('ai.off')}</p>;
  // A letter from a pasted post that was not kept cannot be rewritten (the server would answer posting_unavailable).
  if (!letter.postingAvailable) return <p className={styles.notice}>{t('rewrite.needsPost')}</p>;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = instruction.trim();
    if (text && !busy) onRewrite(text);
  };

  return (
    <div className={styles.stack}>
      <form className={styles.stack} onSubmit={submit}>
        <p className={styles.body}>{t('rewrite.intro')}</p>
        <div className={styles.field}>
          <span className={styles.label} id="cl-quick">
            {t('rewrite.quick')}
          </span>
          <div className={styles.chips} role="group" aria-labelledby="cl-quick">
            {QUICK.map((q) => {
              const text = t(`rewrite.${q}`);
              return (
                <button key={q} type="button" className={styles.chipBtn} aria-pressed={instruction === text} onClick={() => setInstruction(text)}>
                  {text}
                </button>
              );
            })}
          </div>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cl-instruction">
            {t('rewrite.instructionLabel')}
          </label>
          <textarea
            id="cl-instruction"
            className={styles.textarea}
            value={instruction}
            maxLength={1000}
            onChange={(e) => setInstruction(e.target.value)}
            aria-describedby="cl-instr-hint"
          />
          <span id="cl-instr-hint" className={styles.hint}>
            {t('rewrite.instructionHint')}
          </span>
        </div>
        <p className={styles.muted}>
          {letter.rewritesLeftToday === null ? t('rewrite.free') : `${t('rewrite.left', { count: letter.rewritesLeftToday })} · ${t('rewrite.free')}`}
        </p>
        {pending === 'rewrite' ? (
          <p className={styles.notice} role="status" aria-live="polite">
            {t('rewrite.working')}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Btn type="submit" variant="primary" disabled={!instruction.trim() || busy || noneLeft} aria-busy={pending === 'rewrite'}>
            {t('rewrite.submit')}
          </Btn>
        </div>
      </form>

      {error ? (
        <>
          <PhoneBindingNotice error={error.cause} />
          {error.kind !== 'phone_binding_required' ? <LetterError kind={error.kind} /> : null}
        </>
      ) : null}

      <section className={`${styles.cardSoft} ${styles.stack}`} aria-labelledby="cl-regen-title">
        <h3 id="cl-regen-title" className={styles.cardTitle}>
          {t('rewrite.newVersionTitle')}
        </h3>
        <p className={styles.muted}>{t('rewrite.newVersionIntro')}</p>
        <fieldset className={styles.field}>
          <legend className={styles.label}>{t('tone.label')}</legend>
          <div className={styles.choices}>
            {TONES.map((v) => (
              <label key={v} className={styles.choice}>
                <input type="radio" name="cl-regen-tone" value={v} checked={tone === v} onChange={() => setTone(v)} />
                <span>
                  <span className={styles.choiceName}>{t(`tone.${v}`)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className={styles.field}>
          <legend className={styles.label}>{t('length.label')}</legend>
          <div className={styles.choices}>
            {LENGTHS.map((v) => (
              <label key={v} className={styles.choice}>
                <input type="radio" name="cl-regen-length" value={v} checked={length === v} onChange={() => setLength(v)} />
                <span>
                  <span className={styles.choiceName}>{t(`length.${v}`)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <CreditNotice bucket={creditBucket} />
        {pending === 'regenerate' ? (
          <p className={styles.notice} role="status" aria-live="polite">
            {t('form.writing')}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Btn variant="violet" disabled={busy} aria-busy={pending === 'regenerate'} onClick={() => onRegenerate({ tone, length })}>
            {t('rewrite.newVersion')}
          </Btn>
        </div>
      </section>
    </div>
  );
}

export function SourcesPanel({ letter }: { letter: CoverLetterView }) {
  const t = useTranslations('coverLetter.sources');
  if (letter.sentences.length === 0) return <p className={styles.muted}>{t('empty')}</p>;
  const tagClass = { resume: styles.tagResume, posting: styles.tagPosting, user: styles.tagUser } as const;
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>{t('intro')}</p>
      <ol className={styles.sources}>
        {letter.sentences.map((s) => (
          <li key={s.index} className={styles.source}>
            <p className={styles.sentence}>{s.text}</p>
            {s.sources.map((src, i) => (
              <div key={`${src.source}-${i}`}>
                <span className={`${styles.sourceTag} ${tagClass[src.source]}`}>{t(src.source)}</span>
                {src.ref ? <p className={styles.quote}>{t('quote', { text: src.ref })}</p> : null}
              </div>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}

export interface VersionsPanelProps {
  letter: CoverLetterView;
  pending: boolean;
  onRestore: (index: number) => void;
}

export function VersionsPanel({ letter, pending, onRestore }: VersionsPanelProps) {
  const t = useTranslations('coverLetter.versions');
  const format = useFormatter();
  const versions = [...letter.versions].reverse();
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>{t('intro')}</p>
      <ol className={styles.versions}>
        {versions.map((v) => (
          <li key={v.index} className={`${styles.version} ${v.current ? styles.versionCurrent : ''}`}>
            <div>
              <p className={styles.body}>
                <strong>{t(v.reason)}</strong> · {format.dateTime(new Date(v.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
              </p>
              <p className={styles.preview}>{v.preview}</p>
            </div>
            {v.current ? (
              <span className={styles.muted}>{t('current')}</span>
            ) : (
              <Btn onClick={() => onRestore(v.index)} disabled={pending}>
                {t('restoreAction')}
              </Btn>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
