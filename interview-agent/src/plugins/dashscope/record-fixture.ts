// Record a DashScope websocket fixture from a live task (ops tool; needs
// DASHSCOPE_API_KEY and a mainland network path; DASHSCOPE_WS_URL and
// DASHSCOPE_WORKSPACE apply exactly as in the worker). The fixture holds the
// protocol frames only: the API key is never written, and the task id is
// replaced by a placeholder. Replay it in tests with replay.ts.
//
//   npm run build
//   node dist/plugins/dashscope/record-fixture.js stt <audio.pcm> <out.json> [model] [language]
//       audio.pcm: 16 kHz, 16-bit little-endian, mono (e.g. `ffmpeg -i a.wav -f s16le -ac 1 -ar 16000 a.pcm`)
//   node dist/plugins/dashscope/record-fixture.js tts "<text>" <out.json> [model] [voice]
//
// Keep recordings short (a sentence or two): server audio is stored base64.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AudioByteStream, initializeLogger, stt, tts } from '@livekit/agents';
import { dashscopeConnection } from '../../backends/speech.js';
import { defaultSocketFactory, type DashScopeConnection } from './protocol.js';
import { recordingFactory, type DashScopeFixture, type FixtureFrame } from './replay.js';
import { ParaformerSTT } from './stt.js';
import { CosyVoiceTTS } from './tts.js';
import { DEFAULT_COSYVOICE_MODEL, DEFAULT_PARAFORMER_MODEL, paraformerSampleRate, resolveCosyVoice } from './models.js';

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/**
 * The worker's own DashScope connection (DASHSCOPE_API_KEY, DASHSCOPE_WS_URL,
 * DASHSCOPE_WORKSPACE; mainland endpoint enforced), so a capture runs against
 * the same endpoint and workspace as production.
 */
export type RecordConnection = Omit<DashScopeConnection, 'socketFactory'>;

/**
 * `usage.duration` per final sentence next to the sentence's end_time, so the
 * owner can tell from a capture whether DashScope reports it per sentence or
 * cumulatively (stt.ts emits it per sentence_end as RECOGNITION_USAGE).
 */
export function usageTrace(frames: FixtureFrame[]): Array<{ endTimeMs: number | null; duration: number | null }> {
  const out: Array<{ endTimeMs: number | null; duration: number | null }> = [];
  for (const frame of frames) {
    if (frame.dir !== 'server' || !('json' in frame)) continue;
    const payload = (frame.json as { payload?: { output?: { sentence?: { sentence_end?: boolean; end_time?: number | null } }; usage?: { duration?: unknown } | null } })?.payload;
    const sentence = payload?.output?.sentence;
    if (!sentence?.sentence_end) continue;
    const duration = payload?.usage && typeof payload.usage.duration === 'number' ? payload.usage.duration : null;
    out.push({ endTimeMs: typeof sentence.end_time === 'number' ? sentence.end_time : null, duration });
  }
  return out;
}

export async function recordStt(pcm: Uint8Array, model: string, language: string, conn: RecordConnection): Promise<DashScopeFixture> {
  const frames: FixtureFrame[] = [];
  const engine = new ParaformerSTT({ ...conn, model, language, socketFactory: recordingFactory(defaultSocketFactory, frames) });
  const stream = engine.stream();
  const rate = paraformerSampleRate(model);
  const chunker = new AudioByteStream(rate, 1, rate / 10);
  const audio = [...chunker.write(pcm), ...chunker.flush()];
  const reader = (async () => {
    for await (const ev of stream) {
      if (ev.type === stt.SpeechEventType.FINAL_TRANSCRIPT) console.log(`final: ${ev.alternatives?.[0]?.text ?? ''}`);
    }
  })();
  for (const frame of audio) {
    stream.pushFrame(frame);
    await sleep(100); // real-time pace, as the service expects
  }
  stream.endInput();
  await reader;
  await engine.close();
  for (const u of usageTrace(frames)) console.log(`sentence_end end_time=${u.endTimeMs ?? '-'}ms usage.duration=${u.duration ?? '-'}`);
  return { name: 'recorded-stt', kind: 'stt', source: `live capture via record-fixture, ${new Date().toISOString()}`, model, frames };
}

export async function recordTts(text: string, model: string, voice: string, conn: RecordConnection): Promise<DashScopeFixture> {
  const frames: FixtureFrame[] = [];
  const engine = new CosyVoiceTTS({ ...conn, model, voice, socketFactory: recordingFactory(defaultSocketFactory, frames) });
  const stream = engine.stream();
  stream.pushText(text);
  stream.flush();
  stream.endInput();
  let audioMs = 0;
  for await (const ev of stream) {
    if (ev === tts.SynthesizeStream.END_OF_STREAM) break;
    audioMs += (ev.frame.samplesPerChannel / ev.frame.sampleRate) * 1000;
  }
  console.log(`audio: ${Math.round(audioMs)} ms`);
  await engine.close();
  return { name: 'recorded-tts', kind: 'tts', source: `live capture via record-fixture, ${new Date().toISOString()}`, model, frames };
}

async function main(argv: string[]): Promise<void> {
  initializeLogger({ pretty: true, level: 'warn' });
  const [kind, input, out, modelArg, extra] = argv;
  if (!process.env.DASHSCOPE_API_KEY?.trim() || !kind || !input || !out || (kind !== 'stt' && kind !== 'tts')) {
    console.error('usage: record-fixture.js stt <audio.pcm> <out.json> [model] [language]\n' +
      '       record-fixture.js tts "<text>" <out.json> [model] [voice]\n' +
      '(DASHSCOPE_API_KEY must be set; DASHSCOPE_WS_URL / DASHSCOPE_WORKSPACE are honoured as in the worker)');
    process.exitCode = 2;
    return;
  }
  const conn = dashscopeConnection(process.env);
  let fixture: DashScopeFixture;
  if (kind === 'stt') {
    fixture = await recordStt(readFileSync(input), modelArg || DEFAULT_PARAFORMER_MODEL, extra || 'zh', conn);
  } else {
    const model = modelArg || DEFAULT_COSYVOICE_MODEL;
    const voice = resolveCosyVoice(model, extra, 'female', process.env);
    if (!voice) throw new Error(`no default voice for ${model}; pass one`);
    fixture = await recordTts(input, model, voice, conn);
  }
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${fixture.frames.length} frames to ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
