'use client';

// components/features/marketing/HeroScene.tsx — the mount point of the home
// page's 3D scene. It renders an empty, aria-hidden layer and, once that
// layer is near the viewport, loads three.js and heroSceneRuntime.ts as
// their own chunk. Nothing is loaded on the server, in a browser without
// WebGL, or on a page that never scrolls the layer into range.

import { Fragment, useEffect, useRef } from 'react';

import type { SceneVariant } from './heroSceneRuntime';
import styles from './marketing.module.css';

export interface HeroSceneProps {
  /** `board`: the cards sort into a board (hero). `stacks`: one pile beside a call to action. */
  variant?: SceneVariant;
}

export function HeroScene({ variant = 'board' }: HeroSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    if (!('WebGLRenderingContext' in window) || !('IntersectionObserver' in window) || !('ResizeObserver' in window)) {
      return undefined;
    }
    let cancelled = false;
    let teardown: (() => void) | null = null;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        import('./heroSceneRuntime')
          .then(({ mountHeroScene }) => {
            if (cancelled) return;
            try {
              teardown = mountHeroScene(host, variant);
            } catch {
              // No WebGL context (blocked, or the GPU process is gone): the tile stays a plain colour field.
              host.dataset.scene = 'off';
            }
          })
          .catch(() => {
            host.dataset.scene = 'off';
          });
      },
      { rootMargin: '400px' },
    );
    observer.observe(host);

    return () => {
      cancelled = true;
      observer.disconnect();
      teardown?.();
    };
  }, [variant]);

  return <div ref={hostRef} className={styles.scene} data-scene-variant={variant} aria-hidden="true" />;
}

/** A headline whose words rise in one after another (CSS only; one span per word, the text unchanged). */
export function RisingWords({ text }: { text: string }) {
  const words = text.split(' ');
  return (
    <>
      {words.map((word, i) => (
        <Fragment key={`${i}-${word}`}>
          <span className={styles.word} style={{ ['--i' as string]: i }}>
            {word}
          </span>
          {i < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Cards lean toward the pointer. One listener for the page: it writes --tx/--ty
 * (−1…1) on the card under a fine pointer and clears them when it leaves.
 */
export function CardTilt() {
  useEffect(() => {
    if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const selector = `.${styles.card}`;
    let current: HTMLElement | null = null;
    const clear = () => {
      current?.style.removeProperty('--tx');
      current?.style.removeProperty('--ty');
      current = null;
    };
    const onMove = (event: PointerEvent) => {
      const card = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      if (card !== current) clear();
      if (!card) return;
      current = card;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--tx', (((event.clientX - rect.left) / rect.width) * 2 - 1).toFixed(3));
      card.style.setProperty('--ty', (((event.clientY - rect.top) / rect.height) * 2 - 1).toFixed(3));
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', clear);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', clear);
      clear();
    };
  }, []);
  return null;
}
