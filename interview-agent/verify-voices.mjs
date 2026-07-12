// verify-voices.mjs — gateway TTS voice acceptance probe.
//
// WHY: the control plane resolves a NATIVE per-locale voice (voiceCatalog.ts) and
// hands the worker a `provider/model` id + provider voiceId. `inference.TTS`
// opens the gateway WS LAZILY, so an unknown/rejected voiceId does NOT fail at
// construction — it throws MID-TURN, muting that turn while the transcript still
// commits. The runtime FallbackAdapter now catches that and fails over to the
// OpenAI floor, so a session is never mute — but a locale silently falling back
// to a non-native English floor voice is still a quality regression worth
// catching. This probe synthesizes a short phrase through EACH catalog voice
// directly against the gateway and reports which voiceIds are actually accepted.
//
// Run: node verify-voices.mjs [locale ...]
//   node verify-voices.mjs            # all locales, female + male
//   node verify-voices.mjs zh zh-TW ko
//
// Needs only LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env.local
// (the same gateway creds the worker uses — no provider key). Exit 0 = all
// probed voices produced audio; exit 1 = at least one voice was rejected/silent.

import { config as loadEnv } from 'dotenv';
import { inference, tts as ttsNs, initializeLogger } from '@livekit/agents';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

// The SDK's inference client logs through a global logger the worker runtime
// (cli.runApp) normally initializes; a standalone probe must do it itself.
initializeLogger({ pretty: false, level: 'warn' });

if (!process.env.LIVEKIT_API_KEY?.trim() || !process.env.LIVEKIT_API_SECRET?.trim() || !process.env.LIVEKIT_URL?.trim()) {
  console.error('Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env.local');
  process.exit(2);
}

// MIRROR of server/src/interview-engine/voice/voiceCatalog.ts VOICE_DEFAULTS.
// Keep in sync when the catalog changes (this file can't import the server's TS).
// A short, natively-phrased line per locale so we exercise the real language path.
const MALE = { model: 'elevenlabs/eleven_turbo_v2_5', voiceId: 'JBFqnCBsd6RMkjVDRZzb' };
const VOICES = [
  { locale: 'en',    g: 'female', model: 'cartesia/sonic-3',             voiceId: '694f9389-aac1-45b6-b726-9d9369183238', lang: 'en', text: 'Hello, thanks for joining today.' },
  { locale: 'zh',    g: 'female', model: 'cartesia/sonic-3',             voiceId: 'e90c6678-f0d3-4767-9883-5d0ecf5894a8', lang: 'zh', text: '你好，感谢你今天参加面试。' },
  { locale: 'zh-TW', g: 'female', model: 'elevenlabs/eleven_turbo_v2_5', voiceId: 'fQj4gJSexpu8RDE2Ii5m',                 lang: 'zh', text: '你好，謝謝你今天來參加面試。' },
  { locale: 'ja',    g: 'female', model: 'cartesia/sonic-3',             voiceId: '2b568345-1d48-4047-b25f-7baccf842eb0', lang: 'ja', text: 'こんにちは、本日はよろしくお願いします。' },
  { locale: 'ko',    g: 'female', model: 'cartesia/sonic-3',             voiceId: '29e5f8b4-b953-4160-848f-40fae182235b', lang: 'ko', text: '안녕하세요, 오늘 참여해 주셔서 감사합니다.' },
  { locale: 'es',    g: 'female', model: 'cartesia/sonic-3',             voiceId: '694f9389-aac1-45b6-b726-9d9369183238', lang: 'es', text: 'Hola, gracias por acompañarnos hoy.' },
  { locale: 'fr',    g: 'female', model: 'cartesia/sonic-3',             voiceId: '694f9389-aac1-45b6-b726-9d9369183238', lang: 'fr', text: "Bonjour, merci d'être présent aujourd'hui." },
  { locale: 'pt',    g: 'female', model: 'cartesia/sonic-3',             voiceId: '694f9389-aac1-45b6-b726-9d9369183238', lang: 'pt', text: 'Olá, obrigado por participar hoje.' },
  { locale: 'de',    g: 'female', model: 'cartesia/sonic-3',             voiceId: '694f9389-aac1-45b6-b726-9d9369183238', lang: 'de', text: 'Hallo, danke, dass Sie heute dabei sind.' },
  // Male persona voice — one premade multilingual id serves every locale.
  { locale: 'en',    g: 'male',   model: MALE.model, voiceId: MALE.voiceId, lang: 'en', text: 'Hello, thanks for joining today.' },
  { locale: 'zh',    g: 'male',   model: MALE.model, voiceId: MALE.voiceId, lang: 'zh', text: '你好，感谢你今天参加面试。' },
];

const wanted = process.argv.slice(2).map((s) => s.trim().toLowerCase());
const targets = wanted.length ? VOICES.filter((v) => wanted.includes(v.locale.toLowerCase())) : VOICES;

const PROBE_TIMEOUT_MS = 25_000;
const NON_SILENT_PCM = 500; // amplitude clearly above the noise floor

async function probe(v) {
  const engine = new inference.TTS({ model: v.model, voice: v.voiceId, language: v.lang });
  const stream = engine.stream();
  stream.pushText(v.text);
  stream.flush();
  stream.endInput();

  let samples = 0;
  let peak = 0;
  const drain = (async () => {
    for await (const ev of stream) {
      if (ev === ttsNs.SynthesizeStream.END_OF_STREAM) break;
      const data = ev.frame?.data;
      if (!data) continue;
      samples += data.length;
      for (let i = 0; i < data.length; i += 1) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
    }
  })();

  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS); });
  try {
    await Promise.race([drain, timeout]);
  } finally {
    clearTimeout(timer);
    try { await engine.close(); } catch { /* best effort */ }
  }

  const seconds = (samples / 24000).toFixed(1); // gateway PCM is 24kHz
  const pass = samples > 0 && peak > NON_SILENT_PCM;
  return { pass, samples, seconds, peak };
}

async function main() {
  console.log(`\nProbing ${targets.length} catalog voice(s) against the LiveKit Inference gateway …\n`);
  const rows = [];
  let allPass = true;
  for (const v of targets) {
    const label = `${v.locale}/${v.g} ${v.model} ${v.voiceId}`;
    try {
      const r = await probe(v);
      allPass = allPass && r.pass;
      rows.push(`${r.pass ? '✅' : '❌'} ${label.padEnd(64)} ~${r.seconds}s peak=${r.peak}`);
      console.log(rows[rows.length - 1]);
    } catch (err) {
      allPass = false;
      rows.push(`❌ ${label.padEnd(64)} REJECTED: ${err?.message || err}`);
      console.log(rows[rows.length - 1]);
    }
  }

  console.log('\n──────── VERIFY VOICES RESULT ────────');
  console.log(allPass ? '✅ PASS — every probed voice produced audio' : '❌ FAIL — one or more voices were rejected/silent');
  console.log('   (A rejected/silent voice means the worker will fail over to the OpenAI floor for that locale —');
  console.log('    set INTERVIEW_ENGINE_VOICE_<LOCALE>[_MALE] to a gateway-accepted id to restore the native voice.)');
  console.log('──────────────────────────────────────\n');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('PROBE HARNESS ERROR:', err?.stack || err?.message || err);
  process.exit(2);
});
