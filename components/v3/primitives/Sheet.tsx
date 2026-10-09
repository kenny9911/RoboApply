'use client';

// Sheet — a bottom sheet (FND-6a). The mobile More menu, the out-of-credits
// choices and the Assistant on a phone use it.
//
//   <Sheet open={open} onClose={close} title="More">…</Sheet>
//
// Anchored to the bottom edge on phones (safe-area aware), a centred card on
// wide screens. Same focus rules as Drawer: focus in on open, kept inside,
// returned on close; Escape and the scrim close it.

import { Overlay, type OverlayBaseProps } from './Overlay';
import styles from './primitives.module.css';

export type SheetProps = OverlayBaseProps;

export function Sheet(props: SheetProps) {
  return <Overlay {...props} panelClassName={styles.sheet} grabber testId="sheet" />;
}
