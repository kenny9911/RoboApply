'use client';

// NetworkPrecheck — the connection row of the live interview's device check
// (WP-63a; CN_TW_LAUNCH_PLAN.md WP-VOICE-CN: "the client pre-check (mic +
// network RTT/jitter) suggests text mode when the network is poor"). It
// reuses the device check's row layout (DeviceCheck.module.css).
//
// It times a few small requests to our own server (`probe`, supplied by the
// page through lib/api), then reads the round-trip time and how much it
// varies (jitter). The browser's own estimate (Network Information API) can
// only make the reading worse, never better. On a weak connection it offers
// the written practice; joining by voice stays possible. No number is shown:
// the reading is a rough local check, so it is put in words.
//
// Copy: the row's own strings (`practice.live.network.*`) are requested from
// the practice namespace owner. Until they exist the row uses existing
// practice copy ("Good/Fair/Poor connection", "Checking…", "Start the written
// practice", "Try again") and leaves out the explanatory lines.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { IconGlobe } from '../../v3/primitives/Iconset';
import { pendingLiveCopy, type LiveCopyTranslator } from '../../v3/mock/liveConnection';
import styles from '../../v3/mock/DeviceCheck.module.css';

export type NetworkLevel = 'good' | 'fair' | 'poor';

/** Calibrated for a full API round trip (auth + a small read), not a bare ping. */
export const NETWORK_THRESHOLDS = Object.freeze({
  fairRttMs: 400,
  poorRttMs: 1000,
  fairJitterMs: 100,
  poorJitterMs: 250,
  /** More failed probes than this = poor. */
  maxFailures: 1,
});

export const NETWORK_PROBES = 5;
const PROBE_GAP_MS = 150;
const PROBE_TIMEOUT_MS = 4_000;

export interface NetworkHint {
  /** navigator.connection.effectiveType: 'slow-2g' | '2g' | '3g' | '4g'. */
  effectiveType?: string;
  /** navigator.connection.rtt (ms, rounded by the browser). */
  rtt?: number;
}

export interface NetworkAssessment {
  level: NetworkLevel;
  /** Median round trip of the successful probes (ms), null when all failed. */
  rttMs: number | null;
  /** Mean absolute difference between consecutive successful probes (ms). */
  jitterMs: number | null;
  failures: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const RANK: Record<NetworkLevel, number> = { good: 0, fair: 1, poor: 2 };
const worse = (a: NetworkLevel, b: NetworkLevel): NetworkLevel => (RANK[a] >= RANK[b] ? a : b);

/** Rate a set of probe timings (null = a failed probe). Pure; exported for tests. */
export function assessNetwork(samples: Array<number | null>, hint: NetworkHint = {}): NetworkAssessment {
  const ok = samples.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const failures = samples.length - ok.length;
  const rttMs = ok.length ? Math.round(median(ok)) : null;
  let jitterMs: number | null = null;
  if (ok.length >= 2) {
    let sum = 0;
    for (let i = 1; i < ok.length; i += 1) sum += Math.abs(ok[i]! - ok[i - 1]!);
    jitterMs = Math.round(sum / (ok.length - 1));
  }

  const t = NETWORK_THRESHOLDS;
  let level: NetworkLevel = 'good';
  if (rttMs === null || failures > t.maxFailures) level = 'poor';
  else {
    if (rttMs >= t.poorRttMs || (jitterMs ?? 0) >= t.poorJitterMs) level = 'poor';
    else if (rttMs >= t.fairRttMs || (jitterMs ?? 0) >= t.fairJitterMs || failures > 0) level = 'fair';
  }
  const type = (hint.effectiveType ?? '').toLowerCase();
  if (type === 'slow-2g' || type === '2g') level = worse(level, 'poor');
  else if (type === '3g') level = worse(level, 'fair');
  if (typeof hint.rtt === 'number' && hint.rtt >= t.poorRttMs) level = worse(level, 'poor');
  return { level, rttMs, jitterMs, failures };
}

function browserHint(): NetworkHint {
  if (typeof navigator === 'undefined') return {};
  const c = (navigator as Navigator & { connection?: { effectiveType?: unknown; rtt?: unknown } }).connection;
  if (!c) return {};
  return {
    ...(typeof c.effectiveType === 'string' ? { effectiveType: c.effectiveType } : {}),
    ...(typeof c.rtt === 'number' ? { rtt: c.rtt } : {}),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function timeProbe(probe: () => Promise<unknown>): Promise<number | null> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ok = await Promise.race([
      probe().then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS); }),
    ]);
    return ok ? performance.now() - started : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run the probes one after another (concurrent probes would measure the queue). */
export async function measureNetwork(
  probe: () => Promise<unknown>,
  count = NETWORK_PROBES,
  isCurrent: () => boolean = () => true,
): Promise<NetworkAssessment | null> {
  const samples: Array<number | null> = [];
  for (let i = 0; i < count; i += 1) {
    if (!isCurrent()) return null;
    samples.push(await timeProbe(probe));
    if (i < count - 1) await wait(PROBE_GAP_MS);
  }
  return isCurrent() ? assessNetwork(samples, browserHint()) : null;
}

export interface NetworkPrecheckProps {
  /** One small request to our server; resolves when it answered (any status), rejects on a network error. */
  probe: () => Promise<unknown>;
  /** Offered on a weak connection: leave voice and do this practice in writing. Omitted = not offered. */
  onSwitchToText?: () => void;
  /** The switch is in flight. */
  switching?: boolean;
  /** Told about every finished reading (telemetry). */
  onResult?: (result: NetworkAssessment) => void;
  /** Probes per check (tests). */
  probes?: number;
}

export function NetworkPrecheck({ probe, onSwitchToText, switching = false, onResult, probes = NETWORK_PROBES }: NetworkPrecheckProps) {
  const t = useTranslations('practice');
  const [result, setResult] = useState<NetworkAssessment | null>(null);
  const [run, setRun] = useState(0);
  const probeRef = useRef(probe);
  const onResultRef = useRef(onResult);
  useEffect(() => {
    probeRef.current = probe;
    onResultRef.current = onResult;
  });

  useEffect(() => {
    let current = true;
    setResult(null);
    void measureNetwork(() => probeRef.current(), probes, () => current).then((r) => {
      if (!r || !current) return;
      setResult(r);
      onResultRef.current?.(r);
    });
    return () => { current = false; };
  }, [run, probes]);

  const retry = useCallback(() => setRun((n) => n + 1), []);
  const level = result?.level ?? null;
  const tx = t as unknown as LiveCopyTranslator;
  const label = pendingLiveCopy(tx, 'networkLabel');
  const levelId = level === 'good' ? 'networkGood' : level === 'fair' ? 'networkFair' : level === 'poor' ? 'networkPoor' : 'networkChecking';
  // With its own label the state is a short word ("Good"); without it, the
  // existing whole phrase ("Good connection") stands alone.
  const stateLabel =
    (label ? pendingLiveCopy(tx, levelId) : null) ??
    (level ? t(`live.quality.${level}`) : t('live.device.state.checking'));
  const poorBody = pendingLiveCopy(tx, 'networkPoorBody');
  const fairBody = pendingLiveCopy(tx, 'networkFairBody');
  const switchLabel = pendingLiveCopy(tx, 'networkSwitchToText') ?? t('gate.startText');
  const switchingLabel = pendingLiveCopy(tx, 'networkSwitching') ?? switchLabel;
  const retryLabel = pendingLiveCopy(tx, 'networkRetry') ?? t('live.device.retry');
  const rowState = level === 'poor' ? 'error' : level === 'good' ? 'ok' : 'checking';

  return (
    <li className={styles.device} data-state={rowState} data-network={level ?? 'checking'}>
      <span className={styles.deviceIcon} aria-hidden>
        <IconGlobe size={18} />
      </span>
      <div className={styles.deviceBody}>
        <p className={styles.deviceName}>
          {label ? <span>{label}</span> : null}
          <span className={styles.deviceState} data-state={rowState} role="status" aria-live="polite">
            {stateLabel}
          </span>
        </p>
        {level === 'poor' ? (
          <>
            {poorBody ? <p className={styles.fix} role="alert">{poorBody}</p> : null}
            <div className={styles.networkActions}>
              {onSwitchToText ? (
                <Btn variant="primary" onClick={onSwitchToText} disabled={switching} aria-busy={switching || undefined}>
                  {switching ? switchingLabel : switchLabel}
                </Btn>
              ) : null}
              <Btn onClick={retry} disabled={switching}>{retryLabel}</Btn>
            </div>
          </>
        ) : null}
        {level === 'fair' && fairBody ? <p className={styles.fix}>{fairBody}</p> : null}
      </div>
    </li>
  );
}
