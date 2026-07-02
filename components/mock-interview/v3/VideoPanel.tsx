'use client';

// VideoPanel — the candidate's live tile. Sits opposite the InterviewerWell.
//
// Wires `getUserMedia` on demand when `cameraOn` flips true. The red glow
// border is always on while the session is live (matches the screenshot —
// it's the "you're being recorded" signal, not a mic indicator). Falls back
// gracefully when the user denies camera access — shows initials in a
// gradient blob so the layout doesn't shift.
//
// Vertical waveform bars are stacked along the right inner edge of the
// video tile and only animate when the mic is open.

import { useEffect, useRef, useState } from 'react';
import { VideoCameraSlashIcon } from '@heroicons/react/24/outline';
import { cn } from '../../../lib/utils';

interface Props {
  /** Candidate display name (overlay bottom-left). */
  name: string;
  /** Role line shown under the name. */
  role: string;
  /** Mic open → drives the vertical waveform animation + MIC OPEN badge. */
  micOpen: boolean;
  /** Camera on → requests + binds getUserMedia. */
  cameraOn: boolean;
}

const BAR_COUNT = 14;

export function VideoPanel({ name, role, micOpen, cameraOn }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [streamState, setStreamState] = useState<'idle' | 'live' | 'denied' | 'off'>(
    cameraOn ? 'idle' : 'off',
  );

  useEffect(() => {
    if (!cameraOn) {
      // Stop any current track.
      const v = videoRef.current;
      const stream = (v?.srcObject as MediaStream | null) ?? null;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        if (v) v.srcObject = null;
      }
      setStreamState('off');
      return;
    }
    let cancelled = false;
    setStreamState('idle');
    (async () => {
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('no-mediaDevices');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          v.play().catch(() => undefined);
        }
        setStreamState('live');
      } catch {
        if (!cancelled) setStreamState('denied');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cameraOn]);

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  return (
    <div
      className="relative aspect-[16/10] w-full overflow-hidden rounded-[24px]"
      style={{
        // Persistent red glow border — matches the screenshot's "live"
        // recording cue. Outer halo + inner ring.
        boxShadow:
          '0 0 0 1.5px rgba(239,68,68,0.85), 0 0 36px -4px rgba(239,68,68,0.55), 0 24px 60px -28px rgba(239,68,68,0.45)',
      }}
    >
      {/* Stream / fallback */}
      <div className="absolute inset-0">
        {streamState === 'live' ? (
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center"
            style={{
              background:
                streamState === 'denied'
                  ? 'radial-gradient(circle at 30% 20%, #2a1410, #0a0510 70%)'
                  : 'radial-gradient(circle at 30% 30%, #1a1622, #050508 75%)',
            }}
          >
            <div className="flex flex-col items-center gap-3">
              <span
                aria-hidden="true"
                className="inline-flex h-24 w-24 items-center justify-center rounded-full text-[26px] font-bold text-white shadow-2xl"
                style={{
                  background:
                    'linear-gradient(135deg, var(--dc-accent), var(--dc-secondary))',
                  boxShadow:
                    '0 0 40px -4px color-mix(in srgb, var(--dc-accent) 50%, transparent)',
                }}
              >
                {initials || '·'}
              </span>
              {streamState === 'denied' || streamState === 'off' ? (
                <p className="dc-mono inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-white/60">
                  <VideoCameraSlashIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  Camera off
                </p>
              ) : (
                <p className="dc-mono text-[10px] uppercase tracking-[0.16em] text-white/60">
                  Connecting…
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Top-left: MIC OPEN */}
      <span
        className="dc-mono absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] backdrop-blur"
        style={{
          background: 'rgba(0,0,0,0.55)',
          color: micOpen ? '#ef4444' : 'rgba(255,255,255,0.6)',
        }}
      >
        <span
          aria-hidden="true"
          className="relative inline-flex h-1.5 w-1.5 items-center justify-center rounded-full"
          style={{ background: micOpen ? '#ef4444' : 'rgba(255,255,255,0.4)' }}
        >
          {micOpen ? (
            <span className="dc-tick absolute inset-0 rounded-full" style={{ background: '#ef4444' }} />
          ) : null}
        </span>
        {micOpen ? 'MIC OPEN' : 'MIC OFF'}
      </span>

      {/* Top-right: YOU */}
      <span
        className="dc-mono absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] backdrop-blur"
        style={{
          background: 'rgba(0,0,0,0.55)',
          color: 'var(--dc-accent, #c6ff3a)',
        }}
      >
        <span
          aria-hidden="true"
          className="inline-flex h-1.5 w-1.5 rounded-full"
          style={{ background: 'var(--dc-accent, #c6ff3a)', boxShadow: '0 0 6px var(--dc-accent, #c6ff3a)' }}
        />
        You
      </span>

      {/* Bottom-left: name plate */}
      <div
        className="absolute bottom-3 left-3 max-w-[60%] rounded-xl px-3 py-2 backdrop-blur"
        style={{ background: 'rgba(0,0,0,0.55)' }}
      >
        <p className="text-[15px] font-semibold text-white">{name}</p>
        <p className="dc-mono mt-0.5 text-[10px] uppercase tracking-[0.16em] text-white/65">
          {role} · You
        </p>
      </div>

      {/* Bottom-right: vertical waveform */}
      <div
        className="absolute bottom-3 right-3 flex h-12 items-end gap-[3px] rounded-xl px-2 py-1.5 backdrop-blur"
        style={{ background: 'rgba(0,0,0,0.45)' }}
        role="img"
        aria-label={micOpen ? 'Mic is open and listening' : 'Mic is muted'}
      >
        {Array.from({ length: BAR_COUNT }, (_, i) => {
          const baseScale = 0.25 + 0.7 * Math.sin(((i + 1) / (BAR_COUNT + 1)) * Math.PI);
          return (
            <span
              key={i}
              style={{
                display: 'block',
                width: 2.5,
                height: '100%',
                borderRadius: 9999,
                background:
                  'linear-gradient(180deg, var(--dc-accent), color-mix(in srgb, var(--dc-accent) 60%, var(--dc-secondary)))',
                transform: micOpen ? undefined : `scaleY(${baseScale * 0.2})`,
                opacity: 0.95,
                animationName: micOpen ? 'dc-wave-bounce' : undefined,
                animationDuration: '0.85s',
                animationTimingFunction: 'ease-in-out',
                animationIterationCount: 'infinite',
                animationDelay: `${(i * 70) % 700}ms`,
                boxShadow: micOpen ? '0 0 8px -2px var(--dc-accent)' : undefined,
                transformOrigin: 'bottom',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
