'use client';

// Drawer — a side panel over the page (FND-6a; ARCHITECTURE.md §10.2 rule 3).
// The Assistant rail, the filters drawer, the message center and the job
// detail on narrow screens all use it, so no two areas build their own.
//
//   <Drawer open={open} onClose={close} title="Filters" side="right">…</Drawer>
//
// Right side by default; full width below 760px. Focus moves in on open, is
// kept inside, and returns on close; Escape and the scrim close it.

import { cn } from '../../../lib/utils';
import { Overlay, type OverlayBaseProps } from './Overlay';
import styles from './primitives.module.css';

export interface DrawerProps extends OverlayBaseProps {
  side?: 'right' | 'left';
  /** 'wide' = 640px instead of 440px (job detail). */
  size?: 'default' | 'wide';
}

export function Drawer({ side = 'right', size = 'default', ...props }: DrawerProps) {
  return (
    <Overlay
      {...props}
      panelClassName={cn(side === 'left' ? styles.drawerLeft : styles.drawerRight, size === 'wide' && styles.drawerWide)}
      testId="drawer"
    />
  );
}
