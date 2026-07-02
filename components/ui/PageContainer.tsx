// Standard page padding wrapper. Mobile-first: 16px page padding by
// default, scales up at the `md` and `lg` breakpoints. `maxWidth` lets
// individual pages opt into a narrower content column.

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface Props {
  children: ReactNode;
  maxWidth?: 'narrow' | 'content' | 'wide' | 'full';
  className?: string;
}

const WIDTHS: Record<NonNullable<Props['maxWidth']>, string> = {
  narrow: 'max-w-[560px]',
  content: 'max-w-[920px]',
  wide: 'max-w-[1200px]',
  full: '',
};

export function PageContainer({
  children,
  maxWidth = 'content',
  className,
}: Props) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-4 py-6 md:px-8 md:py-10 lg:px-12 lg:py-12',
        WIDTHS[maxWidth],
        className,
      )}
    >
      {children}
    </div>
  );
}
