// DashScope Paraformer realtime STT for LiveKit Agents (GoApply, CN-1).
//
// One duplex task per SpeechStream: 16-bit mono PCM at the model's rate
// (16 kHz, 8 kHz for the -8k- models) goes up as binary frames; each
// `result-generated` carries the current sentence — partial while
// `sentence_end` is false (INTERIM_TRANSCRIPT), final when it is true
// (FINAL_TRANSCRIPT). Heartbeat sentences (kept-alive silence) are ignored.
// Usage (`payload.usage.duration`, seconds) is reported as RECOGNITION_USAGE so
// the session's usage callback carries the billed audio.

import { APIConnectionError, normalizeLanguage, stt, type APIConnectOptions } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import {
  DuplexTask,
  type DashScopeConnection,
  type DashScopeEnvelope,
} from './protocol.js';
import { DEFAULT_PARAFORMER_MODEL, paraformerParameters, paraformerSampleRate } from './models.js';

export interface ParaformerSTTOptions extends DashScopeConnection {
  /** Bare DashScope model id, e.g. paraformer-realtime-v2. */
  model?: string;
  /** Interview language (BCP-47 or short code); drives language_hints. */
  language?: string;
}

interface ParaformerSentence {
  begin_time?: number | null;
  end_time?: number | null;
  text?: string;
  sentence_end?: boolean;
  heartbeat?: boolean;
}

/** Short language code the transcript events carry. */
function eventLanguage(language: string | undefined): string {
  const raw = (language ?? '').toLowerCase();
  if (!raw || raw === 'multi') return 'zh';
  if (raw.startsWith('zh') || raw.startsWith('cmn')) return 'zh';
  return raw.split(/[-_]/)[0] || 'zh';
}

export class ParaformerSTT extends stt.STT {
  label = 'dashscope.ParaformerSTT';
  readonly options: Required<Pick<ParaformerSTTOptions, 'model'>> & ParaformerSTTOptions;

  constructor(options: ParaformerSTTOptions) {
    // Chunk-level timing only (sentence begin/end); no word alignment is
    // promised to the SDK.
    super({ streaming: true, interimResults: true, alignedTranscript: false });
    this.options = { ...options, model: options.model?.trim() || DEFAULT_PARAFORMER_MODEL };
  }

  override get model(): string {
    return this.options.model;
  }

  override get provider(): string {
    return 'dashscope';
  }

  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('ParaformerSTT supports streaming recognition only');
  }

  stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    return new ParaformerStream(this, options?.connOptions);
  }
}

export class ParaformerStream extends stt.SpeechStream {
  label = 'dashscope.ParaformerStream';
  private readonly owner: ParaformerSTT;

  constructor(owner: ParaformerSTT, connOptions?: APIConnectOptions) {
    super(owner, paraformerSampleRate(owner.options.model), connOptions);
    this.owner = owner;
  }

  protected async run(): Promise<void> {
    const opts = this.owner.options;
    const language = normalizeLanguage(eventLanguage(opts.language));
    let inSpeech = false;
    let requestId = '';

    const onResult = (payload: NonNullable<DashScopeEnvelope['payload']>): void => {
      const sentence = (payload.output as { sentence?: ParaformerSentence } | undefined)?.sentence;
      if (!sentence || sentence.heartbeat) return;
      const text = (sentence.text ?? '').trim();
      const offset = this.startTimeOffset;
      const begin = typeof sentence.begin_time === 'number' ? sentence.begin_time / 1000 : 0;
      const end = typeof sentence.end_time === 'number' ? sentence.end_time / 1000 : begin;
      if (text) {
        if (!inSpeech) {
          inSpeech = true;
          this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH, requestId });
        }
        // Paraformer reports no confidence; 1 keeps the SDK's averaged
        // transcript confidence neutral rather than reading as "unsure".
        const data: stt.SpeechData = {
          language,
          text,
          startTime: begin + offset,
          endTime: end + offset,
          confidence: 1,
        };
        this.queue.put({
          type: sentence.sentence_end ? stt.SpeechEventType.FINAL_TRANSCRIPT : stt.SpeechEventType.INTERIM_TRANSCRIPT,
          alternatives: [data],
          requestId,
        });
        if (sentence.sentence_end) {
          inSpeech = false;
          this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH, alternatives: [data], requestId });
        }
      } else if (sentence.sentence_end && inSpeech) {
        inSpeech = false;
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH, requestId });
      }
      const duration = payload.usage && typeof payload.usage.duration === 'number' ? payload.usage.duration : null;
      if (sentence.sentence_end && duration !== null && duration > 0) {
        this.queue.put({
          type: stt.SpeechEventType.RECOGNITION_USAGE,
          requestId,
          recognitionUsage: { audioDuration: duration },
        });
      }
    };

    const task = await DuplexTask.start(
      opts,
      {
        task: 'asr',
        function: 'recognition',
        model: opts.model,
        parameters: paraformerParameters(opts.model, opts.language),
      },
      { onResult },
      this.abortSignal,
    );
    requestId = task.taskId;

    let stopped = false;
    let inputEnded = false;
    const pump = async (): Promise<void> => {
      for await (const item of this.input) {
        if (stopped || this.abortSignal.aborted) return;
        if (typeof item === 'symbol') continue; // FLUSH: Paraformer segments on its own VAD
        task.sendAudio(pcmBytes(item));
      }
      inputEnded = true;
      if (!stopped) await task.finish();
    };

    try {
      // The task can fail (or the server can finish) while the pump waits
      // for the next frame; whichever settles first decides the outcome.
      await Promise.race([pump(), task.done]);
      await task.done;
      if (!inputEnded && !this.abortSignal.aborted) {
        // The server ended the task while the candidate's audio was still
        // flowing: reconnect (the SDK retries a retryable APIError).
        throw new APIConnectionError({ message: 'DashScope ended the recognition task unexpectedly' });
      }
    } finally {
      stopped = true;
      task.close();
    }
  }
}

function pcmBytes(frame: AudioFrame): Uint8Array {
  const data = frame.data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
