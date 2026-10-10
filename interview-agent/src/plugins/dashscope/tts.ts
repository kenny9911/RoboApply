// DashScope CosyVoice streaming TTS for LiveKit Agents (GoApply, CN-1).
//
// One duplex task per spoken segment: the LLM's text streams up as
// `continue-task` messages while CosyVoice streams 16-bit mono PCM back as
// binary frames; the SDK's FLUSH (end of a turn's text) sends `finish-task`
// and the segment ends on `task-finished`. `synthesize()` (one-shot text, used
// by the SDK's adapters) runs the same task with a single text message.

import { AudioByteStream, tts, type APIConnectOptions } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { DuplexTask, type DashScopeConnection, type DuplexTaskSpec } from './protocol.js';
import { COSYVOICE_SAMPLE_RATE, DEFAULT_COSYVOICE_MODEL, cosyVoiceParameters } from './models.js';

export interface CosyVoiceTTSOptions extends DashScopeConnection {
  /** Bare DashScope model id, e.g. cosyvoice-v2. */
  model?: string;
  /** CosyVoice voice id (see models.ts resolveCosyVoice). */
  voice: string;
  sampleRate?: number;
}

type ResolvedOptions = CosyVoiceTTSOptions & { model: string; sampleRate: number };

export class CosyVoiceTTS extends tts.TTS {
  label = 'dashscope.CosyVoiceTTS';
  readonly options: ResolvedOptions;

  constructor(options: CosyVoiceTTSOptions) {
    const sampleRate = options.sampleRate ?? COSYVOICE_SAMPLE_RATE;
    super(sampleRate, 1, { streaming: true });
    this.options = { ...options, model: options.model?.trim() || DEFAULT_COSYVOICE_MODEL, sampleRate };
  }

  override get model(): string {
    return this.options.model;
  }

  override get provider(): string {
    return 'dashscope';
  }

  /** @internal */
  taskSpec(): DuplexTaskSpec {
    return {
      task: 'tts',
      function: 'SpeechSynthesizer',
      model: this.options.model,
      parameters: cosyVoiceParameters(this.options.voice, this.options.sampleRate),
    };
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return new CosyVoiceChunkedStream(this, text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new CosyVoiceSynthesizeStream(this, options?.connOptions);
  }
}

/**
 * PCM bytes → fixed 100 ms frames, holding the newest frame back so the last
 * one of a segment can be flagged `final`.
 */
class FrameEmitter {
  private readonly bytes: AudioByteStream;
  private pending: AudioFrame | undefined;

  constructor(sampleRate: number, private readonly put: (frame: AudioFrame, final: boolean) => void) {
    this.bytes = new AudioByteStream(sampleRate, 1);
  }

  write(chunk: Uint8Array): void {
    for (const frame of this.bytes.write(chunk)) this.push(frame);
  }

  end(): void {
    for (const frame of this.bytes.flush()) this.push(frame);
    if (this.pending) this.put(this.pending, true);
    this.pending = undefined;
  }

  private push(frame: AudioFrame): void {
    if (this.pending) this.put(this.pending, false);
    this.pending = frame;
  }
}

export class CosyVoiceChunkedStream extends tts.ChunkedStream {
  label = 'dashscope.CosyVoiceChunkedStream';

  constructor(
    private readonly owner: CosyVoiceTTS,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, owner, connOptions, abortSignal);
  }

  protected async run(): Promise<void> {
    let requestId = '';
    const emitter = new FrameEmitter(this.owner.options.sampleRate, (frame, final) => {
      this.queue.put({ requestId, segmentId: requestId, frame, final });
    });
    const task = await DuplexTask.start(
      this.owner.options,
      this.owner.taskSpec(),
      { onAudio: (bytes) => emitter.write(bytes) },
      this.abortSignal,
    );
    requestId = task.taskId;
    try {
      task.continueText(this.inputText);
      await task.finish();
      emitter.end();
    } finally {
      task.close();
    }
  }
}

export class CosyVoiceSynthesizeStream extends tts.SynthesizeStream {
  label = 'dashscope.CosyVoiceSynthesizeStream';

  constructor(private readonly owner: CosyVoiceTTS, connOptions?: APIConnectOptions) {
    super(owner, connOptions);
  }

  protected async run(): Promise<void> {
    const requestId = `cosyvoice_${Date.now().toString(36)}`;
    let segment: { task: DuplexTask; emitter: FrameEmitter } | null = null;

    const startSegment = async (): Promise<{ task: DuplexTask; emitter: FrameEmitter }> => {
      let segmentId = '';
      const emitter = new FrameEmitter(this.owner.options.sampleRate, (frame, final) => {
        this.queue.put({ requestId, segmentId, frame, final });
      });
      const task = await DuplexTask.start(
        this.owner.options,
        this.owner.taskSpec(),
        { onAudio: (bytes) => emitter.write(bytes) },
        this.abortSignal,
      );
      segmentId = task.taskId;
      return { task, emitter };
    };

    const endSegment = async (): Promise<void> => {
      const current = segment;
      if (!current) return;
      segment = null;
      try {
        await current.task.finish();
        current.emitter.end();
      } finally {
        current.task.close();
      }
    };

    try {
      for await (const item of this.input) {
        if (this.abortSignal.aborted) return;
        if (typeof item === 'symbol') {
          await endSegment(); // FLUSH: the turn's text is complete
          continue;
        }
        if (!item) continue;
        if (!segment) segment = await startSegment();
        this.markStarted();
        segment.task.continueText(item);
      }
      if (this.abortSignal.aborted) return;
      await endSegment();
      this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
    } finally {
      // Abort / failure: close whatever is still open (idempotent).
      (segment as { task: DuplexTask } | null)?.task.close();
    }
  }
}
