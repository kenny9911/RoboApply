import { type APIConnectOptions } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { OpenAI } from 'openai';

/** OpenAI floor with handled failures for the SDK 1.6.2 ChunkedStream task. */
export class SafeOpenAiTts extends openai.TTS {
  private readonly speechClient: OpenAI;
  private readonly speechAbort = new AbortController();
  private speechOptions: openai.TTSOptions;

  constructor(options: Partial<openai.TTSOptions> = {}) {
    const speechOptions: openai.TTSOptions = {
      model: 'tts-1', voice: 'alloy', speed: 1, ...options,
    };
    const client = options.client ?? new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      maxRetries: 0,
    });
    super({ ...speechOptions, client });
    this.speechClient = client;
    this.speechOptions = speechOptions;
  }

  override updateOptions(options: Parameters<openai.TTS['updateOptions']>[0]): void {
    super.updateOptions(options);
    this.speechOptions = { ...this.speechOptions, ...options };
  }

  override synthesize(text: string, options?: APIConnectOptions, abortSignal?: AbortSignal): openai.ChunkedStream {
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, this.speechAbort.signal])
      : this.speechAbort.signal;
    const response = this.speechClient.audio.speech.create({
      input: text,
      model: this.speechOptions.model,
      voice: this.speechOptions.voice,
      speed: this.speechOptions.speed,
      instructions: this.speechOptions.instructions,
      response_format: 'pcm',
    }, { signal });
    return new SafeOpenAiChunkedStream(this, text, response, options, signal);
  }

  override async close(): Promise<void> {
    this.speechAbort.abort();
    await super.close();
  }
}

class SafeOpenAiChunkedStream extends openai.ChunkedStream {
  constructor(
    private readonly source: openai.TTS,
    text: string,
    response: Promise<Response>,
    options?: APIConnectOptions,
    private readonly requestSignal?: AbortSignal,
  ) {
    super(source, text, response, options, requestSignal);
  }

  protected override async run(): Promise<void> {
    try {
      await super.run();
    } catch (error) {
      if (this.abortSignal.aborted || this.requestSignal?.aborted) return;
      // The SDK's ChunkedStream launches a task without a rejection handler.
      // Report the provider failure, then finish with zero frames so the outer
      // fallback can try another provider or emit its aggregate fatal error.
      this.source.emit('error', {
        type: 'tts_error', timestamp: Date.now(), label: this.source.label,
        error: error instanceof Error ? error : new Error(String(error)),
        recoverable: false,
      });
    }
  }
}
