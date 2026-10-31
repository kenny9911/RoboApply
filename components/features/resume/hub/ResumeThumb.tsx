'use client';

// ResumeThumb — the resume itself, small: the editor's ResumePaper drawn from
// the saved text and layout (template, accent, page size), scaled into a
// library card. It replaces the drawn placeholder lines, which looked the same
// for every resume. Decorative (aria-hidden, inert): the card's title link
// opens the resume. It reads the editor's own detail query, so opening the
// editor afterwards starts from the cache.

import { useMemo } from 'react';

import { useResume } from '../../../../hooks/useResumes';
import { parseResumeMarkdown } from '../../../../lib/resumeStructure';
import { ResumePaper } from '../../../v3/resume-editor/ResumePaper';
import { resolveLayout } from '../layout';
import styles from './Hub.module.css';

export function ResumeThumb({ resumeId }: { resumeId: string }) {
  const { data } = useResume(resumeId);
  const markdown = data?.resumeMarkdown;
  const structured = useMemo(() => (typeof markdown === 'string' ? parseResumeMarkdown(markdown) : null), [markdown]);
  const layout = useMemo(() => resolveLayout(data?.layout ?? null, data?.defaultPage), [data?.layout, data?.defaultPage]);

  return (
    <div className={styles.thumb} aria-hidden="true" inert>
      {structured ? (
        <div className={styles.thumbSheet}>
          <ResumePaper resume={structured} layout={layout} />
        </div>
      ) : (
        <div className={styles.thumbBlank} />
      )}
    </div>
  );
}
