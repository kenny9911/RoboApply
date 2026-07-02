// verify-greeting.mjs — end-to-end greeting verification harness.
//
// The blocker all along: synthetic dispatch tests put no CANDIDATE mic in the
// room, so the agent's `session.start` never links to a participant and the
// greeting never flushes. This harness fixes that: it joins the room as a
// candidate, PUBLISHES a (silent) mic track so `session.start` links AND the
// STT keeps receiving audio (no idle-close), then SUBSCRIBES to the agent's
// audio track and measures the received PCM to prove the greeting is actually
// spoken — not just "session started" in a log.
//
// Run: node verify-greeting.mjs [language]
//   node verify-greeting.mjs en
//   node verify-greeting.mjs zh
//
// Exit 0 = greeting audio detected (PASS). Exit 1 = no greeting (FAIL).

import { config as loadEnv } from 'dotenv';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import {
  Room,
  RoomEvent,
  AudioSource,
  LocalAudioTrack,
  AudioFrame,
  AudioStream,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from '@livekit/rtc-node';

loadEnv({ path: '.env.local' });

const LANG = (process.argv[2] || 'en').trim();
const URL = process.env.LIVEKIT_URL?.trim();
const KEY = process.env.LIVEKIT_API_KEY?.trim();
const SECRET = process.env.LIVEKIT_API_SECRET?.trim();
const AGENT_NAME = process.env.INTERVIEW_ENGINE_AGENT_NAME?.trim() || 'RoboHire-Interview';
const CALLBACK_BASE = process.env.INTERVIEW_ENGINE_CALLBACK_BASE_URL?.trim() || 'http://localhost:4607';
if (!URL || !KEY || !SECRET) {
  console.error('Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env.local');
  process.exit(2);
}
const HTTP_URL = URL.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');

// Per-language opening so we exercise the same path the control plane writes.
const OPENINGS = {
  en: 'Greet the candidate warmly by saying "Hi, I am Maya, your interviewer today." Then ask them to briefly introduce themselves.',
  zh: '用中文热情地问候候选人，说"你好，我是今天的面试官 Maya。"然后请他们简单地做个自我介绍。',
};
const opening = OPENINGS[LANG] || OPENINGS.en;

const roomName = `verify-greeting-${LANG}-${Date.now()}`;
const sessionId = `verify_${Date.now()}`;

// Faithful InterviewRoomMetadata (mirrors buildRoomMetadata + resolveStt).
const metadata = JSON.stringify({
  kind: 'interview-engine',
  sessionId,
  mode: 'voice',
  language: LANG,
  durationMinutes: 30,
  systemPrompt:
    'You are Maya, a warm, professional interviewer. Conduct a thoughtful, adaptive interview. Keep questions concise and conversational.',
  openingInstruction: opening,
  voice: { provider: 'openai', model: 'tts-1', voiceId: 'nova', languageCode: LANG },
  stt: { provider: 'deepgram', model: 'deepgram/nova-3', language: LANG, fallbackModels: ['deepgram/nova-2'] },
  llm: { model: 'openai/gpt-4o' },
  callbackBaseUrl: CALLBACK_BASE,
});

const log = (...a) => console.log(`[verify ${new Date().toISOString().slice(11, 23)}]`, ...a);

let running = true;
const result = {
  agentParticipantJoined: false,
  agentAudioTrackSubscribed: false,
  framesReceived: 0,
  samplesReceived: 0,
  peakAmplitude: 0,
  nonSilentFrames: 0,
  agentDisconnectedEarly: false,
};

async function main() {
  const roomSvc = new RoomServiceClient(HTTP_URL, KEY, SECRET);
  const dispatchSvc = new AgentDispatchClient(HTTP_URL, KEY, SECRET);

  // 1) Create room with metadata (room.metadata is the agent's fallback source).
  await roomSvc.createRoom({ name: roomName, metadata, emptyTimeout: 120, departureTimeout: 30 });
  log('room created:', roomName);

  // 2) Dispatch the interview agent into the room (job metadata = primary source).
  const dispatch = await dispatchSvc.createDispatch(roomName, AGENT_NAME, { metadata });
  log('agent dispatched:', AGENT_NAME, 'dispatchId=', dispatch.id);

  // 3) Mint a candidate join token (mirrors mintJoinToken).
  const at = new AccessToken(KEY, SECRET, { identity: 'verify-candidate', name: 'Verify Candidate', ttl: 600 });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  const token = await at.toJwt();

  // 4) Connect, auto-subscribing to remote tracks.
  const room = new Room();

  room.on(RoomEvent.ParticipantConnected, (p) => {
    log('participant connected:', p.identity);
    if (p.identity.startsWith('agent') || (p.identity !== 'verify-candidate')) {
      result.agentParticipantJoined = true;
    }
  });
  room.on(RoomEvent.ParticipantDisconnected, (p) => {
    if (p.identity !== 'verify-candidate') {
      log('AGENT participant disconnected:', p.identity);
      result.agentDisconnectedEarly = true;
    }
  });
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (participant.identity === 'verify-candidate') return;
    log('subscribed to remote track from', participant.identity, 'kind=', track.kind);
    result.agentParticipantJoined = true;
    // kind 1 == audio in rtc-node TrackKind
    result.agentAudioTrackSubscribed = true;
    consumeAgentAudio(track).catch((e) => log('audio stream error:', e?.message));
  });

  await room.connect(URL, token, { autoSubscribe: true, dynacast: false });
  log('connected as verify-candidate');

  // 5) Publish a silent mic so session.start links + STT stays fed (no idle-close).
  const source = new AudioSource(48000, 1);
  const micTrack = LocalAudioTrack.createAudioTrack('candidate-mic', source);
  await room.localParticipant.publishTrack(
    micTrack,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );
  log('published silent candidate mic');

  // captureFrame self-paces to real-time, keeping a continuous silent stream.
  const SAMPLES = 480; // 10ms @ 48kHz
  (async () => {
    while (running) {
      const frame = new AudioFrame(new Int16Array(SAMPLES), 48000, 1, SAMPLES);
      try {
        await source.captureFrame(frame);
      } catch {
        break;
      }
    }
  })();

  // 6) Run the observation window. tts-1 first-token ~5-7s; greeting ~5-12s.
  const WINDOW_MS = 28000;
  log(`observing for ${WINDOW_MS / 1000}s …`);
  await new Promise((r) => setTimeout(r, WINDOW_MS));
  running = false;

  // 7) Report + clean up.
  await room.disconnect().catch(() => {});
  await roomSvc.deleteRoom(roomName).catch(() => {});

  const pass =
    result.agentAudioTrackSubscribed &&
    result.framesReceived > 0 &&
    result.nonSilentFrames > 0 &&
    !result.agentDisconnectedEarly;

  console.log('\n──────── VERIFY GREETING RESULT ────────');
  console.log('language               :', LANG);
  console.log('agent joined room      :', result.agentParticipantJoined);
  console.log('agent audio subscribed :', result.agentAudioTrackSubscribed);
  console.log('audio frames received  :', result.framesReceived);
  console.log('samples received       :', result.samplesReceived, `(~${(result.samplesReceived / 48000).toFixed(1)}s of audio)`);
  console.log('non-silent frames      :', result.nonSilentFrames);
  console.log('peak PCM amplitude     :', result.peakAmplitude, '/ 32767');
  console.log('agent left early       :', result.agentDisconnectedEarly);
  console.log('────────────────────────────────────────');
  console.log(pass ? '✅ PASS — greeting audio detected' : '❌ FAIL — no greeting audio');
  console.log('────────────────────────────────────────\n');

  await dispose();
  process.exit(pass ? 0 : 1);
}

async function consumeAgentAudio(track) {
  const stream = new AudioStream(track);
  for await (const frame of stream) {
    if (!running) break;
    result.framesReceived += 1;
    const data = frame.data; // Int16Array
    result.samplesReceived += data.length;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    if (peak > result.peakAmplitude) result.peakAmplitude = peak;
    // Anything clearly above the noise floor counts as real speech.
    if (peak > 500) result.nonSilentFrames += 1;
  }
}

main().catch(async (err) => {
  console.error('HARNESS ERROR:', err?.stack || err?.message || err);
  try { await dispose(); } catch {}
  process.exit(2);
});
