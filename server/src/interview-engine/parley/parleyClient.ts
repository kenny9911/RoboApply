// backend/src/interview-engine/parley/parleyClient.ts
//
// Server-to-server calls to a Parley node (see parleyConfig.ts) plus webhook
// signature verification. Parley's contract (its docs/api.md):
//   POST /v1/sessions            → { id, clientToken, expiresAt, rtc: { offerUrl, iceServers } }
//   POST /v1/sessions/:id/end    → the interviewer says the closing line, then ends
//   GET  /v1/sessions/:id        → status + transcript (reconciliation)
//   webhooks: X-Parley-Signature: t=<unix s>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ParleyConfig } from './parleyConfig.js';

const REQUEST_TIMEOUT_MS = 15_000;
/** Reject webhook signatures older/newer than this (replay window). */
const SIGNATURE_TOLERANCE_SEC = 5 * 60;

export class ParleyApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ParleyApiError';
  }
}

export interface ParleyCreateSessionInput {
  language: string;
  systemPrompt: string;
  openingLine?: string;
  closingLine?: string;
  maxDurationSec: number;
  recording: boolean;
  /** Voice for this session (a TTS profile of the Parley node); default = the agent's. */
  ttsProfileId?: string;
  externalRef: string;
  metadata?: Record<string, unknown>;
  webhookUrl: string;
}

export interface ParleyCreatedSession {
  id: string;
  clientToken: string;
  expiresAt: string;
  rtc: { offerUrl: string; iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> };
}

/** One transcript turn as Parley reports it (atMs = ms since the interview started). */
export interface ParleyTurnRecord {
  turnId: string;
  role: 'user' | 'agent';
  text: string;
  atMs: number;
  interrupted?: boolean;
  metrics?: Record<string, number | undefined>;
}

export interface ParleySessionInfo {
  id: string;
  status: 'created' | 'connecting' | 'live' | 'ended' | 'failed';
  externalRef?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  endReason?: string;
  transcript: ParleyTurnRecord[];
  metrics?: Record<string, number | undefined>;
}

async function call<T>(cfg: ParleyConfig, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ParleyApiError(0, 'unreachable', `Parley unreachable at ${cfg.baseUrl}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ParleyApiError(res.status, e?.code ?? 'http_error', e?.message ?? `Parley ${method} ${path} → ${res.status}`);
  }
  return json as T;
}

export function createParleySession(cfg: ParleyConfig, input: ParleyCreateSessionInput): Promise<ParleyCreatedSession> {
  return call<ParleyCreatedSession>(cfg, 'POST', '/v1/sessions', { agentId: cfg.agentId, ...input });
}

/** End a live Parley session and wait until it is finalized (its transcript
 *  is then complete). `closing: false` skips the closing line. False if the
 *  session was no longer live. */
export async function endParleySession(
  cfg: ParleyConfig,
  parleySessionId: string,
  opts: { closing?: boolean } = {},
): Promise<boolean> {
  const res = await call<{ ok: boolean; wasLive: boolean }>(
    cfg,
    'POST',
    `/v1/sessions/${encodeURIComponent(parleySessionId)}/end`,
    opts.closing === undefined ? undefined : { closing: opts.closing },
  );
  return res.wasLive;
}

export function getParleySession(cfg: ParleyConfig, parleySessionId: string): Promise<ParleySessionInfo> {
  return call<ParleySessionInfo>(cfg, 'GET', `/v1/sessions/${encodeURIComponent(parleySessionId)}`);
}

/**
 * Verify `X-Parley-Signature: t=<unix seconds>,v1=<hex>` over the RAW request
 * body. Constant-time compare; rejects stale timestamps (replays).
 */
export function verifyParleySignature(
  header: string | undefined,
  rawBody: string | Buffer,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || !secret) return false;
  const parts = new Map(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const sig = parts.get('v1');
  if (!Number.isFinite(t) || !sig || !/^[0-9a-f]+$/i.test(sig)) return false;
  if (Math.abs(nowSec - t) > SIGNATURE_TOLERANCE_SEC) return false;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
