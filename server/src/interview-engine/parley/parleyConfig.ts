// backend/src/interview-engine/parley/parleyConfig.ts
//
// Configuration for the Parley voice-transport PILOT. Parley is a standalone
// WebRTC interview service (its own VAD/STT/LLM/TTS in one process): the
// browser connects to it directly, so practice interviews skip LiveKit Cloud,
// the agent dispatch and the interview-agent worker entirely.
//
// The pilot is OFF unless INTERVIEW_ENGINE_PARLEY_PILOT says otherwise:
//   unset / "off"          → every session uses LiveKit (today's behavior)
//   "all"                  → every new practice session uses Parley
//   "a@x.com,usr_123,…"    → only these users (email or user id) use Parley
// The choice is made once, when the session is created, and stored on the
// session — flipping the flag never moves a session that already exists.
//
// Parley itself is configured in its own admin console; RoboApply only needs:
//   PARLEY_URL             base URL the browser and the API reach Parley at
//   PARLEY_API_KEY         server-side key (pk_…) for POST /v1/sessions
//   PARLEY_WEBHOOK_SECRET  whsec_… that signs Parley's webhooks to us
//   PARLEY_AGENT_ID        interviewer profile (agt_…) — supplies STT/LLM/TTS;
//                          prompt, opening, language and duration are sent
//                          per session
//   PARLEY_TTS_PROFILES    optional "zh:tts_…,en:tts_…" — voice per interview
//                          language (exact locale, then its primary subtag);
//                          other languages use the agent's own voice
// scripts/parley-provision.ts creates all of these on a Parley node.

import { getAgentCallbackSecret } from '../config.js';

export interface ParleyConfig {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
  agentId: string;
}

/** The Parley settings, or null when any of them is missing (pilot unusable). */
export function getParleyConfig(): ParleyConfig | null {
  const baseUrl = process.env.PARLEY_URL?.trim().replace(/\/+$/, '');
  const apiKey = process.env.PARLEY_API_KEY?.trim();
  const webhookSecret = process.env.PARLEY_WEBHOOK_SECRET?.trim();
  const agentId = process.env.PARLEY_AGENT_ID?.trim();
  if (!baseUrl || !apiKey || !webhookSecret || !agentId) return null;
  return { baseUrl, apiKey, webhookSecret, agentId };
}

/** The Parley TTS profile for an interview language, if PARLEY_TTS_PROFILES maps one. */
export function resolveParleyTtsProfile(language: string): string | undefined {
  const map = new Map<string, string>();
  for (const pair of (process.env.PARLEY_TTS_PROFILES ?? '').split(',')) {
    const i = pair.indexOf(':');
    if (i <= 0) continue;
    const lang = pair.slice(0, i).trim().toLowerCase();
    const id = pair.slice(i + 1).trim();
    if (lang && id) map.set(lang, id);
  }
  const lang = language.trim().toLowerCase();
  return map.get(lang) ?? map.get(lang.split('-')[0]);
}

export type ParleyPilot = { mode: 'off' } | { mode: 'all' } | { mode: 'allowlist'; entries: Set<string> };

export function parseParleyPilot(raw: string | undefined): ParleyPilot {
  const value = raw?.trim() ?? '';
  if (!value || /^(off|false|0|no)$/i.test(value)) return { mode: 'off' };
  if (/^(all|on|true|1|yes)$/i.test(value)) return { mode: 'all' };
  const entries = new Set(
    value
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return entries.size ? { mode: 'allowlist', entries } : { mode: 'off' };
}

/**
 * Should a NEW session for this user run on Parley? False whenever the pilot
 * is off, the user isn't in the allowlist, or Parley isn't configured — so a
 * half-configured pilot degrades to LiveKit instead of failing interviews.
 * Parley outcomes are written through the worker-callback ingest, so the
 * callback secret must exist too.
 */
export function shouldUseParley(user: { id: string; email?: string | null }): boolean {
  const pilot = parseParleyPilot(process.env.INTERVIEW_ENGINE_PARLEY_PILOT);
  if (pilot.mode === 'off') return false;
  if (!getParleyConfig() || !getAgentCallbackSecret()) return false;
  if (pilot.mode === 'all') return true;
  return (
    pilot.entries.has(user.id.toLowerCase()) ||
    (!!user.email && pilot.entries.has(user.email.trim().toLowerCase()))
  );
}
