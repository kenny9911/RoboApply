'use client';

// CustomizePanel — the editor's Customize tab: how the resume looks, beside
// the live preview (resume.io's Customize tab). The controls that sat folded
// in the preview column, now open as cards:
//   Template and layout          LayoutPanel (WP-36b): template, page, font, spacing,
//                                alignment, heading color, dates, bullets, …
//   Section order                SectionOrderPanel (WP-65): the text is unchanged
//   Photo and personal details   ResumeDetailsPanel, only where the brand offers them
//                                (GoApply: 籍贯 / 政治面貌 and the device photo)
// Every change saves exactly as before (PATCH /:id/layout, or the editor's
// autosave for the section order) and the preview follows.

import { useId, type ComponentProps } from 'react';
import { useTranslations } from 'next-intl';

import { ResumeDetailsPanel, SectionOrderPanel } from '../EditorTools';
import { LayoutPanel } from '../LayoutPanel';
import type { ResolvedLayout } from '../layout';
import type { ResumeLayout, ResumePage } from '../../../../lib/api/resumes';
import type { StructuredResume } from '../../../../lib/resumeStructure';
import styles from './EditorTabs.module.css';

type DetailsProps = ComponentProps<typeof ResumeDetailsPanel>;

export interface CustomizePanelProps {
  /** The resolved layout the preview uses. */
  layout: ResolvedLayout;
  /** The page size the server picked for this visitor's country. */
  defaultPage: ResumePage;
  /** A layout change is being saved / the last one failed. */
  saving: boolean;
  error: boolean;
  onLayoutChange: (change: Partial<ResolvedLayout>) => void;
  /** The resume being edited (for the section order). */
  resume: StructuredResume;
  onResumeChange: (next: StructuredResume) => void;
  /** The stored layout (personal details live there). */
  storedLayout: ResumeLayout | null | undefined;
  /** The brand's personal details; empty → none. */
  personalFields: DetailsProps['personalFields'];
  photoOffered: boolean;
  photo: DetailsProps['photo'];
  onDetailsPatch: (patch: Partial<ResumeLayout>) => void;
}

export function CustomizePanel({
  layout,
  defaultPage,
  saving,
  error,
  onLayoutChange,
  resume,
  onResumeChange,
  storedLayout,
  personalFields,
  photoOffered,
  photo,
  onDetailsPatch,
}: CustomizePanelProps) {
  const t = useTranslations('resume');
  const tb = useTranslations('resumeBuilder.editor');
  const id = useId();
  const showDetails = personalFields.length > 0 || photoOffered;

  return (
    <div className={styles.stack} data-panel="customize">
      <section className={styles.card} aria-labelledby={`${id}-layout`}>
        <h2 className={styles.cardTitle} id={`${id}-layout`}>
          {t('layout.title')}
        </h2>
        <LayoutPanel value={layout} defaultPage={defaultPage} saving={saving} error={error} onChange={onLayoutChange} />
      </section>

      <section className={styles.card} aria-labelledby={`${id}-order`}>
        <h2 className={styles.cardTitle} id={`${id}-order`}>
          {tb('order')}
        </h2>
        <SectionOrderPanel resume={resume} onChange={onResumeChange} />
      </section>

      {showDetails ? (
        <section className={styles.card} aria-labelledby={`${id}-details`}>
          <h2 className={styles.cardTitle} id={`${id}-details`}>
            {tb('details')}
          </h2>
          <ResumeDetailsPanel
            layout={storedLayout}
            personalFields={personalFields}
            photoOffered={photoOffered}
            photo={photo}
            saving={saving}
            onPatch={onDetailsPatch}
          />
        </section>
      ) : null}
    </div>
  );
}
