// server/src/features/growth/referralRisk.ts — invite-reward risk scoring
// (F-GROW-01; ARCHITECTURE.md §10.2 "credit farming"; TASK_PLAN.md WP-60).
//
// Signals are what a request carries, reduced to keyed hashes before they are
// stored (RAReferralSignal, schema request SR-60-1; kept 30 days):
//   ipHash      the client IP (IPv6 reduced to its /64)
//   uaHash      the User-Agent string
//   deviceHash  the first-party `ra_anon` browser id, when the browser has one
// Hashes are HMAC-SHA256 with REFERRAL_SIGNAL_SECRET (else a key derived from
// JWT_SECRET), so an IP cannot be recovered by hashing the IPv4 space.
//
// Rules (pure; the service supplies the rows):
//   self / same person   → never counted (decided at signup: rejectReason)
//   same device          +100  inviter and friend used the same browser (`ra_anon`)
//                               at any time in the 30 days kept: a first-party
//                               browser id is strong evidence whenever it matches
//   same network         +60   same IP within 24 h (an office or campus network
//                               a week later is not a signal)
//   same browser build   +20   same User-Agent within 24 h (only without the IP rule)
//   disposable email     +60   the friend's email domain is a throwaway inbox
//   burst                +50   ≥ 5 friends signed up on this link within 24 h
//   no signals stored    +50   the signal store is unavailable (fail closed)
//   signals missing      +50   the store works but holds no rows for the inviter
//                               or for the friend, so nothing can be compared
//                               (fail closed; the service first waits up to 7
//                               days for both to use the product)
// A score ≥ REFERRAL_HOLD_SCORE holds both rewards for a person to review.

import crypto from 'node:crypto';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { REFERRAL_HOLD_SCORE } from './contract.js';

export const SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SIGNAL_RETENTION_DAYS = 30;
export const BURST_COUNT = 5;

export const RISK_WEIGHTS = {
  same_device: 100,
  same_ip: 60,
  same_browser: 20,
  disposable_email: 60,
  burst: 50,
  signals_unavailable: 50,
  signals_missing: 50,
} as const;
export type RiskReason = keyof typeof RISK_WEIGHTS;

export interface RawSignals {
  ip?: string | null;
  userAgent?: string | null;
  /** The `ra_anon` cookie value. */
  deviceId?: string | null;
}

export interface HashedSignals {
  ipHash: string | null;
  uaHash: string | null;
  deviceHash: string | null;
}

export interface SignalRow extends HashedSignals {
  userId: string;
  createdAt: Date;
}

const DEV_KEY = 'roboapply-dev-referral-signal-key';

/** The HMAC key, or null in production when no secret is configured (then nothing is stored). */
export function signalKey(env: EnvSource = process.env): string | null {
  const direct = env.REFERRAL_SIGNAL_SECRET?.trim();
  if (direct) return direct;
  const jwt = env.JWT_SECRET?.trim();
  if (jwt) return crypto.createHmac('sha256', jwt).update('referral-signal-v1').digest('hex');
  return env.NODE_ENV === 'production' ? null : DEV_KEY;
}

/** IPv4 as is; IPv6 reduced to its first four groups (a /64, one household or phone). */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let v = ip.trim().toLowerCase();
  if (v.startsWith('::ffff:') && v.includes('.')) v = v.slice(7);
  if (!v || v === 'unknown') return null;
  if (!v.includes(':')) return /^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? v : null;
  const [head] = v.split('::');
  const groups = v.includes('::') ? (head ? head.split(':') : []) : v.split(':');
  const first = [...groups, '0', '0', '0', '0'].slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '') || '0');
  return `${first.join(':')}::/64`;
}

function hmac(key: string, kind: string, value: string): string {
  return crypto.createHmac('sha256', key).update(`${kind}:${value}`).digest('hex').slice(0, 32);
}

/** Hash what a request carries; null when nothing usable or no key. */
export function hashSignals(raw: RawSignals, env: EnvSource = process.env): HashedSignals | null {
  const key = signalKey(env);
  if (!key) return null;
  const ip = normalizeIp(raw.ip);
  const ua = raw.userAgent?.trim().slice(0, 512) || null;
  const device = raw.deviceId && /^[A-Za-z0-9_-]{8,64}$/.test(raw.deviceId) ? raw.deviceId : null;
  const out: HashedSignals = {
    ipHash: ip ? hmac(key, 'ip', ip) : null,
    uaHash: ua ? hmac(key, 'ua', ua) : null,
    deviceHash: device ? hmac(key, 'device', device) : null,
  };
  return out.ipHash || out.uaHash || out.deviceHash ? out : null;
}

/** Gmail ignores dots and anything after `+`; other providers ignore `+tags`. */
export function normalizeEmailForReferral(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return null;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (!domain || domain.endsWith('.invalid')) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0]!;
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local ? `${local}@${domain}` : null;
}

export interface RiskInput {
  inviterSignals: SignalRow[];
  inviteeSignals: SignalRow[];
  /** False when the signal store is not available: fail closed. */
  signalsAvailable: boolean;
  inviteeEmailDisposable: boolean;
  /** Friends who signed up on the same link within 24 h of this one (this one included). */
  signupsOnLinkWithin24h: number;
}

export interface RiskResult {
  score: number;
  reasons: RiskReason[];
  hold: boolean;
}

function near(a: Date, b: Date): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= SIGNAL_WINDOW_MS;
}

/** A shared value; `anyTime` ignores the 24 h window (the rows are already limited to the retention period). */
function overlaps(a: SignalRow[], b: SignalRow[], field: keyof HashedSignals, anyTime = false): boolean {
  for (const x of a) {
    const v = x[field];
    if (!v) continue;
    for (const y of b) if (y[field] === v && (anyTime || near(x.createdAt, y.createdAt))) return true;
  }
  return false;
}

export function scoreReferralRisk(input: RiskInput): RiskResult {
  const reasons: RiskReason[] = [];
  if (!input.signalsAvailable) reasons.push('signals_unavailable');
  else if (input.inviterSignals.length === 0 || input.inviteeSignals.length === 0) reasons.push('signals_missing');
  else {
    if (overlaps(input.inviterSignals, input.inviteeSignals, 'deviceHash', true)) reasons.push('same_device');
    const sameIp = overlaps(input.inviterSignals, input.inviteeSignals, 'ipHash');
    if (sameIp) reasons.push('same_ip');
    if (!sameIp && overlaps(input.inviterSignals, input.inviteeSignals, 'uaHash')) reasons.push('same_browser');
  }
  if (input.inviteeEmailDisposable) reasons.push('disposable_email');
  if (input.signupsOnLinkWithin24h >= BURST_COUNT) reasons.push('burst');
  const score = reasons.reduce((sum, r) => sum + RISK_WEIGHTS[r], 0);
  return { score, reasons, hold: score >= REFERRAL_HOLD_SCORE };
}
