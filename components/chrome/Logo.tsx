'use client';

// Logo — the RoboApply wordmark. PNG mark + wordmark.
// Used in left rail (top), public header, onboarding header.

import Image from 'next/image';
import Link from 'next/link';
import { cn } from '../../lib/utils';

interface Props {
  size?: 'sm' | 'md';
  href?: string;
  className?: string;
}

const SIZES: Record<NonNullable<Props['size']>, { mark: string; px: number; text: string }> = {
  sm: { mark: 'h-6 w-6', px: 24, text: 'text-base' },
  md: { mark: 'h-8 w-8', px: 32, text: 'text-lg' },
};

export function Logo({ size = 'md', href = '/', className }: Props) {
  const sz = SIZES[size];
  const inner = (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <Image
        src="/roboapply-logo.png"
        alt="RoboApply"
        width={sz.px}
        height={sz.px}
        priority
        className={cn('object-contain', sz.mark)}
      />
      <span
        className={cn('font-bold tracking-tight text-ink-900', sz.text)}
        style={{ letterSpacing: '-0.02em' }}
      >
        RoboApply
      </span>
    </span>
  );
  if (!href) return inner;
  return <Link href={href}>{inner}</Link>;
}
