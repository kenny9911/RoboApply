'use client';

import { useEffect, useRef } from 'react';

/** The candidate's own camera, straight from a local MediaStream (the Parley
 *  pilot keeps the camera local — nothing is published). Muted: self-view only. */
export function LocalVideo({ stream, className }: { stream: MediaStream; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    return () => { el.srcObject = null; };
  }, [stream]);
  return <video ref={ref} className={className} autoPlay muted playsInline />;
}
