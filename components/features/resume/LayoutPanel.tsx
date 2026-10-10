'use client';

// LayoutPanel — the editor's template and formatting controls (WP-36b;
// PRODUCT_PLAN.md F-RES-13): five templates (Standard recommended; Two-column
// carries a warning), Letter / A4 (default by country), font, spacing,
// accent, header alignment and date format. Controlled: the editor saves each
// change through PATCH /:id/layout (usePatchResumeLayoutMutation) and the
// preview follows the cache. Native radio groups and a select; 44 px targets.
//
// WP-65: the Campus template (A4 new-grad layout), justify, bullet mark,
// education order, skills layout, and the section-title language of the
// downloaded file (zh/en bilingual export — the user's text stays as written).

import { useId } from 'react';
import { useTranslations } from 'next-intl';

import {
  ACCENTS,
  BULLETS,
  DATE_FORMATS,
  EDU_ORDERS,
  FONTS,
  HEADING_LANGUAGES,
  SKILLS_LAYOUTS,
  RECOMMENDED_TEMPLATE,
  SPACING_KEYS,
  TEMPLATES,
  WARN_TEMPLATES,
  type ResolvedLayout,
} from './layout';
import type { ResumePage } from '../../../lib/api/resumes';
import styles from './ResumeHub.module.css';

export interface LayoutPanelProps {
  value: ResolvedLayout;
  /** The page size the server picked for this visitor's country. */
  defaultPage: ResumePage;
  onChange: (change: Partial<ResolvedLayout>) => void;
  saving?: boolean;
  error?: boolean;
}

function Choice<T extends string>({
  name,
  value,
  current,
  label,
  onPick,
  swatch,
}: {
  name: string;
  value: T;
  current: T;
  label: string;
  onPick: (v: T) => void;
  swatch?: string;
}) {
  return (
    <label className={styles.choice} data-checked={value === current || undefined}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={value === current}
        onChange={() => onPick(value)}
        className={styles.choiceInput}
      />
      {swatch ? <span className={styles.swatch} style={{ background: swatch }} aria-hidden="true" /> : null}
      <span className={swatch ? styles.srOnly : undefined}>{label}</span>
    </label>
  );
}

export function LayoutPanel({ value, defaultPage, onChange, saving, error }: LayoutPanelProps) {
  const t = useTranslations('resume.layout');
  const tb = useTranslations('resumeBuilder.layout');
  const base = useId();
  const warn = WARN_TEMPLATES.includes(value.template);

  return (
    <div className={styles.layoutPanel} aria-busy={saving || undefined}>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('template.label')}</legend>
        <div className={styles.templateGrid}>
          {TEMPLATES.map((tpl) => (
            <label key={tpl} className={styles.templateCard} data-checked={tpl === value.template || undefined}>
              <input
                type="radio"
                name={`${base}-template`}
                value={tpl}
                checked={tpl === value.template}
                onChange={() => onChange({ template: tpl })}
                className={styles.choiceInput}
              />
              <span className={styles.templateName}>{tpl === 'campus' ? tb('campus.name') : t(`template.${tpl}.name`)}</span>
              <span className={styles.templateDesc}>{tpl === 'campus' ? tb('campus.desc') : t(`template.${tpl}.desc`)}</span>
              {tpl === RECOMMENDED_TEMPLATE ? <span className={styles.recommended}>{t('template.recommended')}</span> : null}
            </label>
          ))}
        </div>
        {warn ? (
          <p className={styles.warning} role="note">
            {t('template.two_column.warning')}
          </p>
        ) : null}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('page.label')}</legend>
        <div className={styles.choiceRow}>
          {(['letter', 'a4'] as const).map((p) => (
            <Choice key={p} name={`${base}-page`} value={p} current={value.page} label={t(`page.${p}`)} onPick={(page) => onChange({ page })} />
          ))}
        </div>
        <p className={styles.hint}>{t('page.default', { page: t(`page.${defaultPage}`) })}</p>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('font.label')}</legend>
        <div className={styles.choiceRow}>
          {FONTS.map((f) => (
            <Choice key={f} name={`${base}-font`} value={f} current={value.font} label={t(`font.${f}`)} onPick={(font) => onChange({ font })} />
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('spacing.label')}</legend>
        <div className={styles.choiceRow}>
          {SPACING_KEYS.map((s) => (
            <Choice key={s} name={`${base}-spacing`} value={s} current={value.spacing} label={t(`spacing.${s}`)} onPick={(spacing) => onChange({ spacing })} />
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('align.label')}</legend>
        <div className={styles.choiceRow}>
          {(['left', 'center'] as const).map((a) => (
            <Choice key={a} name={`${base}-align`} value={a} current={value.headerAlign} label={t(`align.${a}`)} onPick={(headerAlign) => onChange({ headerAlign })} />
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('accent.label')}</legend>
        <div className={styles.choiceRow}>
          {ACCENTS.map((hex, i) => (
            <Choice
              key={hex}
              name={`${base}-accent`}
              value={hex}
              current={value.accent}
              label={t(`accent.option${i + 1}`)}
              swatch={hex}
              onPick={(accent) => onChange({ accent })}
            />
          ))}
        </div>
      </fieldset>

      <div className={styles.fieldset}>
        <label className={styles.legend} htmlFor={`${base}-date`}>
          {t('date.label')}
        </label>
        <select
          id={`${base}-date`}
          className={styles.select}
          value={value.dateFormat}
          onChange={(e) => onChange({ dateFormat: e.target.value as ResolvedLayout['dateFormat'] })}
        >
          {DATE_FORMATS.map((d) => (
            <option key={d} value={d}>
              {t(`date.${d === 'as_written' ? 'as_written' : d === 'MM/YYYY' ? 'numeric' : d === 'Mon YYYY' ? 'month' : 'year'}`)}
            </option>
          ))}
        </select>
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{tb('bullet.label')}</legend>
        <div className={styles.choiceRow}>
          {BULLETS.map((b) => (
            <Choice key={b} name={`${base}-bullet`} value={b} current={value.bullet} label={tb(`bullet.${b}`)} onPick={(bullet) => onChange({ bullet })} />
          ))}
        </div>
      </fieldset>

      <div className={styles.fieldset}>
        <label className={styles.choice} data-checked={value.justify || undefined}>
          <input type="checkbox" checked={value.justify} onChange={(e) => onChange({ justify: e.target.checked })} className={styles.choiceInput} />
          <span>{tb('justify')}</span>
        </label>
      </div>

      <div className={styles.fieldset}>
        <label className={styles.legend} htmlFor={`${base}-edu`}>
          {tb('eduOrder.label')}
        </label>
        <select id={`${base}-edu`} className={styles.select} value={value.eduOrder} onChange={(e) => onChange({ eduOrder: e.target.value as ResolvedLayout['eduOrder'] })}>
          {EDU_ORDERS.map((o) => (
            <option key={o} value={o}>
              {tb(`eduOrder.${o}`)}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.fieldset}>
        <label className={styles.legend} htmlFor={`${base}-skills`}>
          {tb('skillsLayout.label')}
        </label>
        <select id={`${base}-skills`} className={styles.select} value={value.skillsLayout} onChange={(e) => onChange({ skillsLayout: e.target.value as ResolvedLayout['skillsLayout'] })}>
          {SKILLS_LAYOUTS.map((o) => (
            <option key={o} value={o}>
              {tb(`skillsLayout.${o}`)}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.fieldset}>
        <label className={styles.legend} htmlFor={`${base}-headings`}>
          {tb('headingLanguage.label')}
        </label>
        <select id={`${base}-headings`} className={styles.select} value={value.headingLanguage} onChange={(e) => onChange({ headingLanguage: e.target.value as ResolvedLayout['headingLanguage'] })}>
          {HEADING_LANGUAGES.map((o) => (
            <option key={o} value={o}>
              {tb(`headingLanguage.${o === 'zh-TW' ? 'zhTW' : o}`)}
            </option>
          ))}
        </select>
        <p className={styles.hint}>{tb('headingLanguage.hint')}</p>
      </div>

      <p className={styles.status} role="status" aria-live="polite">
        {error ? t('status.error') : saving ? t('status.saving') : t('status.note')}
      </p>
    </div>
  );
}
