'use client';

// hooks/growth/useTrack.ts — a stable `track` for components (lib/analytics.ts).
//
//   const track = useTrack();
//   <button onClick={() => track('upgrade_clicked', { from: 'credits', planKey })}>

import { track } from '../../lib/analytics';

export function useTrack(): typeof track {
  return track;
}
