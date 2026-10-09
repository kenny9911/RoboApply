// Parley pilot: flag parsing, config gating, the server-to-server client and
// webhook signature verification.
// Run: npx vitest run server/src/interview-engine/parley/parleyClient.test.ts

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getParleyConfig, parseParleyPilot, resolveParleyTtsProfile, shouldUseParley } from './parleyConfig.js';
import { createParleySession, endParleySession, ParleyApiError, verifyParleySignature } from './parleyClient.js';

const KEYS = [
  'PARLEY_URL', 'PARLEY_API_KEY', 'PARLEY_WEBHOOK_SECRET', 'PARLEY_AGENT_ID', 'PARLEY_TTS_PROFILES',
  'INTERVIEW_ENGINE_PARLEY_PILOT', 'LIVEKIT_AGENT_CALLBACK_SECRET',
] as const;

function configure(pilot?: string) {
  process.env.PARLEY_URL = 'http://parley.test:8080/';
  process.env.PARLEY_API_KEY = 'pk_test';
  process.env.PARLEY_WEBHOOK_SECRET = 'whsec_test';
  process.env.PARLEY_AGENT_ID = 'agt_test';
  process.env.LIVEKIT_AGENT_CALLBACK_SECRET = 'cb_secret';
  if (pilot !== undefined) process.env.INTERVIEW_ENGINE_PARLEY_PILOT = pilot;
}

describe('parley pilot flag', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('parses off / all / allowlist', () => {
    expect(parseParleyPilot(undefined)).toEqual({ mode: 'off' });
    expect(parseParleyPilot('off')).toEqual({ mode: 'off' });
    expect(parseParleyPilot(' , ')).toEqual({ mode: 'off' });
    expect(parseParleyPilot('all')).toEqual({ mode: 'all' });
    const list = parseParleyPilot('Kenny@Example.com, usr_1');
    expect(list.mode).toBe('allowlist');
    expect(list.mode === 'allowlist' && [...list.entries]).toEqual(['kenny@example.com', 'usr_1']);
  });

  it('is off by default even when Parley is configured', () => {
    configure();
    expect(shouldUseParley({ id: 'u1', email: 'a@b.c' })).toBe(false);
  });

  it('matches the allowlist by email (case-insensitive) or user id', () => {
    configure('kenny@example.com,u2');
    expect(shouldUseParley({ id: 'u1', email: 'KENNY@example.com' })).toBe(true);
    expect(shouldUseParley({ id: 'U2', email: null })).toBe(true);
    expect(shouldUseParley({ id: 'u3', email: 'other@example.com' })).toBe(false);
  });

  it('degrades to LiveKit when the pilot is on but Parley is not fully configured', () => {
    configure('all');
    delete process.env.PARLEY_WEBHOOK_SECRET;
    expect(getParleyConfig()).toBeNull();
    expect(shouldUseParley({ id: 'u1' })).toBe(false);
  });

  it('stays off without the callback secret the outcome ingest needs', () => {
    configure('all');
    delete process.env.LIVEKIT_AGENT_CALLBACK_SECRET;
    expect(shouldUseParley({ id: 'u1' })).toBe(false);
  });

  it('maps an interview language to a TTS profile (exact, then primary subtag)', () => {
    process.env.PARLEY_TTS_PROFILES = 'en:tts_en, zh:tts_zh,zh-TW:tts_tw';
    expect(resolveParleyTtsProfile('zh-TW')).toBe('tts_tw');
    expect(resolveParleyTtsProfile('zh')).toBe('tts_zh');
    expect(resolveParleyTtsProfile('en-GB')).toBe('tts_en');
    expect(resolveParleyTtsProfile('ja')).toBeUndefined();
  });

  it('normalizes the base URL', () => {
    configure();
    expect(getParleyConfig()?.baseUrl).toBe('http://parley.test:8080');
  });
});

describe('parley client', () => {
  const cfg = { baseUrl: 'http://parley.test', apiKey: 'pk_test', webhookSecret: 'whsec_test', agentId: 'agt_1' };
  afterEach(() => vi.unstubAllGlobals());

  it('creates a session with the agent id and bearer key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'ses_1', clientToken: 'ct', expiresAt: 'x', rtc: { offerUrl: 'u', iceServers: [] } }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const created = await createParleySession(cfg, {
      language: 'zh', systemPrompt: 'p', openingLine: 'o', maxDurationSec: 660, recording: false,
      externalRef: 'sess_1', webhookUrl: 'http://api.test/hook',
    });
    expect(created.id).toBe('ses_1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://parley.test/v1/sessions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer pk_test');
    expect(JSON.parse(String(init.body))).toMatchObject({ agentId: 'agt_1', recording: false, externalRef: 'sess_1' });
  });

  it('surfaces Parley error codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'agent_incomplete', message: 'missing TTS' } }), { status: 409 })));
    const err = await createParleySession(cfg, {
      language: 'en', systemPrompt: 'p', maxDurationSec: 600, recording: false, externalRef: 's', webhookUrl: 'http://h',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ParleyApiError);
    expect(err).toMatchObject({ status: 409, code: 'agent_incomplete' });
  });

  it('reports an unreachable node as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(endParleySession(cfg, 'ses_1')).rejects.toMatchObject({ status: 0, code: 'unreachable' });
  });
});

describe('parley webhook signature', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ event: 'session.ended', data: { sessionId: 'ses_1' } });
  const sign = (t: number, payload = body, key = secret) =>
    `t=${t},v1=${createHmac('sha256', key).update(`${t}.${payload}`).digest('hex')}`;

  it('accepts a fresh, correct signature', () => {
    expect(verifyParleySignature(sign(1_000), body, secret, 1_010)).toBe(true);
    expect(verifyParleySignature(sign(1_000), Buffer.from(body), secret, 1_010)).toBe(true);
  });

  it('rejects tampered bodies, wrong secrets, stale timestamps and junk', () => {
    expect(verifyParleySignature(sign(1_000), body.replace('ses_1', 'ses_2'), secret, 1_010)).toBe(false);
    expect(verifyParleySignature(sign(1_000, body, 'other'), body, secret, 1_010)).toBe(false);
    expect(verifyParleySignature(sign(1_000), body, secret, 1_000 + 301)).toBe(false);
    expect(verifyParleySignature(undefined, body, secret, 1_000)).toBe(false);
    expect(verifyParleySignature('garbage', body, secret, 1_000)).toBe(false);
    expect(verifyParleySignature(sign(1_000), body, '', 1_010)).toBe(false);
  });
});
