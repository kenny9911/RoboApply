'use client';

// Tag — the V3 mono pill (.tag family). Tones: default (surface), strong
// (accent), warn (amber), violet (secondary). Used on match cards, facet
// chips, type labels. Class-driven so it picks up the accent swap.

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export type TagTone = 'default' | 'strong' | 'warn' | 'violet';

const TONE_CLASS: Record<TagTone, string> = {
  default: '',
  strong: 'strong',
  warn: 'warn',
  violet: 'violet',
};

interface Props {
  tone?: TagTone;
  children: ReactNode;
  className?: string;
  title?: string;
}

export function Tag({ tone = 'default', children, className, title }: Props) {
  return (
    <span className={cn('tag', TONE_CLASS[tone], className)} title={title}>
      {children}
    </span>
  );
}
