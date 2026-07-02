'use client';

// CreateCard — one of the three "start a resume" tiles on the library page
// (.rb-create-card). Source: RoboApply_V3/resume.jsx ResumeLibrary create row.
// The `primary` source ("scratch") gets the accent gradient + top hairline; the
// icon tint switches per source via the .ic-pen / .ic-file / .ic-link classes.
//
// Pure presentation — the page owns the `onSelect(source)` handler that opens
// the ImportModal. Strings come from the parent via props (so the page can keep
// all `t()` calls co-located in one namespace lookup).

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { IconArrow } from '../primitives';

export type CreateSource = 'scratch' | 'file' | 'linkedin';

interface Props {
  source: CreateSource;
  /** Icon glyph (an Iconset node) rendered inside the tinted square. */
  icon: ReactNode;
  title: string;
  description: string;
  meta: string;
  onSelect: (source: CreateSource) => void;
}

const IC_CLASS: Record<CreateSource, string> = {
  scratch: 'ic-pen',
  file: 'ic-file',
  linkedin: 'ic-link',
};

export function CreateCard({ source, icon, title, description, meta, onSelect }: Props) {
  return (
    <button
      type="button"
      className={cn('rb-create-card', source === 'scratch' && 'primary')}
      onClick={() => onSelect(source)}
    >
      <div className={cn('rb-create-ic', IC_CLASS[source])} aria-hidden="true">
        {icon}
      </div>
      <div className="rb-create-body">
        <div className="rb-create-head">{title}</div>
        <div className="rb-create-desc">{description}</div>
        <div className="rb-create-meta">{meta}</div>
      </div>
      <div className="rb-create-arrow" aria-hidden="true">
        <IconArrow size={16} />
      </div>
    </button>
  );
}
