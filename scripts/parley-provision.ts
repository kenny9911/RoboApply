/**
 * Provision a running Parley instance for the RoboApply practice-interview
 * pilot, then print the PARLEY_* lines to add to RoboApply's .env.
 *
 * Creates or updates (through Parley's admin API, matched by name, so re-runs
 * are safe): one credential per vendor, STT / LLM profiles, one TTS profile per
 * language Parley has a default voice for, an interviewer ("agent") whose
 * prompt and opening RoboApply overrides per session, and a fresh API key whose
 * webhook points at RoboApply (older keys with the same name are revoked).
 * Vendor keys come from the environment (RoboApply's .env); nothing is written
 * to disk.
 *
 *   npx tsx --env-file=.env scripts/parley-provision.ts \
 *     --parley http://localhost:8080 --admin-password dev \
 *     --webhook http://localhost:4611/api/v1/interview-engine/parley/webhook
 *
 * Defaults: STT ElevenLabs Scribe v2 realtime, TTS ElevenLabs Flash v2.5, LLM
 * via OpenRouter on the model RoboApply's LiveKit interviews use
 * (LLM_INTERVIEW_LIVE_MODEL / LLM_INTERVIEW_MODEL), so the pilot compares
 * transports rather than models. STT language is left empty so Parley uses
 * each session's language; RoboApply picks the TTS profile per session
 * language from PARLEY_TTS_PROFILES.
 */
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    parley: { type: 'string', default: process.env.PARLEY_URL ?? 'http://localhost:8080' },
    'admin-password': { type: 'string', default: process.env.PARLEY_ADMIN_PASSWORD ?? '' },
    webhook: { type: 'string', default: `http://localhost:${process.env.PORT ?? '4611'}/api/v1/interview-engine/parley/webhook` },
    stt: { type: 'string', default: 'elevenlabs-scribe' },
    tts: { type: 'string', default: 'elevenlabs' },
    llm: { type: 'string', default: 'openrouter' },
    'llm-model': { type: 'string' },
    name: { type: 'string', default: 'RoboApply practice' },
  },
});

const BASE = args.parley!.replace(/\/+$/, '');

const vendorKeys: Record<string, () => Record<string, string> | null> = {
  elevenlabs: () => (process.env.ELEVENLABS_API_KEY ? { apiKey: process.env.ELEVENLABS_API_KEY } : null),
  openrouter: () => (process.env.OPENROUTER_API_KEY ? { apiKey: process.env.OPENROUTER_API_KEY } : null),
  deepseek: () => (process.env.DEEPSEEK_API_KEY ? { apiKey: process.env.DEEPSEEK_API_KEY } : null),
  openai: () => (process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : null),
  deepgram: () => (process.env.DEEPGRAM_API_KEY ? { apiKey: process.env.DEEPGRAM_API_KEY } : null),
  dashscope: () => (process.env.DASHSCOPE_API_KEY ? { apiKey: process.env.DASHSCOPE_API_KEY } : null),
  cartesia: () => (process.env.CARTESIA_API_KEY ? { apiKey: process.env.CARTESIA_API_KEY } : null),
};

/** RoboApply model ids carry an outer `openrouter/` routing prefix; Parley's
 *  OpenRouter profile wants the bare OpenRouter slug. */
function defaultLlmModel(): string | undefined {
  const raw = (process.env.LLM_INTERVIEW_LIVE_MODEL || process.env.LLM_INTERVIEW_MODEL || '').trim();
  return raw ? raw.replace(/^openrouter\//, '') : undefined;
}

let cookie = '';
async function admin<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/admin/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

type ProviderMeta = { id: string; vendor: string; defaultModel: string; defaultVoices?: Record<string, string> };
type Named = { id: string; name: string };

/** Update the item with this name, or create it (re-runs never duplicate). */
async function upsert(collection: string, name: string, body: Record<string, unknown>): Promise<Named> {
  const existing = (await admin<Named[]>('GET', `/${collection}`)).find((x) => x.name === name);
  return existing
    ? admin<Named>('PUT', `/${collection}/${existing.id}`, { ...body, name })
    : admin<Named>('POST', `/${collection}`, { ...body, name });
}

async function main() {
  if (!args['admin-password']) throw new Error('pass --admin-password (or set PARLEY_ADMIN_PASSWORD)');
  await admin('POST', '/login', { password: args['admin-password'] });
  const catalog = await admin<Record<'stt' | 'llm' | 'tts', ProviderMeta[]>>('GET', '/catalog');
  const find = (kind: 'stt' | 'llm' | 'tts', id: string) => {
    const def = catalog[kind].find((p) => p.id === id);
    if (!def) throw new Error(`Parley has no ${kind} provider "${id}"`);
    if (!vendorKeys[def.vendor]?.()) throw new Error(`no API key in the environment for vendor "${def.vendor}" (${kind} ${id})`);
    return def;
  };
  const stt = find('stt', args.stt!);
  const llm = find('llm', args.llm!);
  const tts = find('tts', args.tts!);

  const creds = new Map<string, string>();
  for (const vendor of new Set([stt.vendor, llm.vendor, tts.vendor])) {
    const c = await upsert('credentials', `${vendor} (${args.name})`, { vendor, data: vendorKeys[vendor]!() });
    creds.set(vendor, c.id);
  }

  const llmModel = args['llm-model'] ?? (llm.id === 'openrouter' ? defaultLlmModel() : undefined) ?? llm.defaultModel;
  const sttProfile = await upsert('stt-profiles', `${args.name} STT`, {
    provider: stt.id, credentialId: creds.get(stt.vendor), model: stt.defaultModel, language: '', params: {},
  });
  const llmProfile = await upsert('llm-profiles', `${args.name} LLM`, {
    provider: llm.id, credentialId: creds.get(llm.vendor), model: llmModel, temperature: 0.6, maxTokens: 300, extraBody: {},
  });
  // One voice per language Parley ships a default for; RoboApply maps the
  // session language onto these (PARLEY_TTS_PROFILES) and falls back to the
  // agent's profile (the first one) for every other language.
  const voices = Object.entries(tts.defaultVoices ?? {});
  if (!voices.length) throw new Error(`TTS provider ${tts.id} has no default voices; create its profiles in the console`);
  const ttsProfiles: Array<[string, Named]> = [];
  for (const [lang, voice] of voices) {
    ttsProfiles.push([lang, await upsert('tts-profiles', `${args.name} TTS (${lang})`, {
      provider: tts.id, credentialId: creds.get(tts.vendor), model: tts.defaultModel,
      voice, language: lang, speed: 1, sampleRate: 24000, params: {},
    })]);
  }

  const probe = await admin<{ text: string; firstTokenMs: number }>('POST', '/llm/test', {
    provider: llm.id, credentialId: creds.get(llm.vendor), model: llmModel, temperature: 0.6, maxTokens: 40, extraBody: {},
    prompt: 'Reply with one short sentence.',
  }).catch((err: Error) => ({ text: `(probe failed: ${err.message})`, firstTokenMs: -1 }));

  // RoboApply sends the real prompt, opening, language, duration and the
  // recording switch with every session; these are only fallbacks for the
  // Parley console's playground.
  const agent = await upsert('agents', args.name!, {
    language: 'en',
    sttProfileId: sttProfile.id,
    llmProfileId: llmProfile.id,
    ttsProfileId: (ttsProfiles.find(([lang]) => lang === 'en') ?? ttsProfiles[0])[1].id,
    recording: false,
  });

  for (const k of await admin<Array<Named & { revokedAt?: string }>>('GET', '/api-keys')) {
    if (k.name === args.name && !k.revokedAt) await admin('DELETE', `/api-keys/${k.id}`);
  }
  const key = await admin<{ secret: string; webhookSecret: string }>('POST', '/api-keys', { name: args.name, webhookUrl: args.webhook });

  console.log(`# Parley stack: stt=${stt.id}/${stt.defaultModel} llm=${llm.id}/${llmModel} tts=${tts.id}/${tts.defaultModel}`);
  console.log(`# LLM probe: first token ${probe.firstTokenMs} ms — "${probe.text.slice(0, 60)}"`);
  console.log('# Add to RoboApply .env (the pilot stays off until INTERVIEW_ENGINE_PARLEY_PILOT is set):');
  console.log(`PARLEY_URL=${BASE}`);
  console.log(`PARLEY_API_KEY=${key.secret}`);
  console.log(`PARLEY_WEBHOOK_SECRET=${key.webhookSecret}`);
  console.log(`PARLEY_AGENT_ID=${agent.id}`);
  console.log(`PARLEY_TTS_PROFILES=${ttsProfiles.map(([lang, p]) => `${lang}:${p.id}`).join(',')}`);
}

main().catch((err) => {
  console.error(`parley-provision: ${(err as Error).message}`);
  process.exit(1);
});
