// DashScope (Aliyun Model Studio) speech plugins for the GoApply interview
// worker: Paraformer realtime STT and CosyVoice streaming TTS over the
// mainland duplex WebSocket API. Loaded only when a session selects a
// DashScope backend (backends/speech.ts); never imported by the RoboApply path.

export { ParaformerSTT, ParaformerStream, type ParaformerSTTOptions } from './stt.js';
export {
  CosyVoiceTTS,
  CosyVoiceChunkedStream,
  CosyVoiceSynthesizeStream,
  type CosyVoiceTTSOptions,
} from './tts.js';
export {
  DASHSCOPE_WS_URL,
  DuplexTask,
  defaultSocketFactory,
  taskFailedError,
  type DashScopeConnection,
  type DashScopeSocket,
  type SocketFactory,
} from './protocol.js';
export * from './models.js';
