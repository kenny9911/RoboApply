import { APIConnectionError, DEFAULT_API_CONNECT_OPTIONS, tokenize, tts, type APIConnectOptions } from '@livekit/agents';

type ProviderError = Parameters<tts.TTSCallbacks['error']>[0];

const ignoreLateError = () => {};

function isExhaustedQuota(error: Error): boolean {
  const details = error as Error & { code?: string; type?: string; error?: { code?: string; type?: string } };
  return [details.code, details.type, details.error?.code, details.error?.type].some(
    (code) => code === 'credit_balance_exhausted' || code === 'insufficient_quota',
  );
}

/** Own a single streaming adapter and keep child failures recoverable until failover is exhausted. */
class FallbackProvider extends tts.TTS {
  label: string;
  private readonly streaming: tts.TTS;
  private closed = false;
  private quotaExhausted = false;

  private readonly forwardMetrics: tts.TTSCallbacks['metrics_collected'] = (metrics) => {
    if (!this.closed) this.emit('metrics_collected', metrics);
  };

  private readonly forwardError = (error: ProviderError) => {
    this.quotaExhausted ||= isExhaustedQuota(error.error);
    if (!this.closed) this.emit('error', { ...error, recoverable: true });
  };

  constructor(private readonly source: tts.TTS) {
    const streaming = source.capabilities.streaming
      ? source
      : new tts.StreamAdapter(source, new tokenize.basic.SentenceTokenizer());
    super(streaming.sampleRate, streaming.numChannels, streaming.capabilities);
    this.label = source.label;
    this.streaming = streaming;
    streaming.on('metrics_collected', this.forwardMetrics);
    streaming.on('error', this.forwardError);
  }

  override get model(): string { return this.source.model; }
  override get provider(): string { return this.source.provider; }

  synthesize(text: string, options?: APIConnectOptions, signal?: AbortSignal): tts.ChunkedStream {
    return this.source.synthesize(text, options, signal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    if (this.closed || this.quotaExhausted) {
      return new UnavailableStream(this.streaming, options?.connOptions);
    }
    return this.streaming.stream(options);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // OpenAI.close() aborts requests without awaiting their completion. Drain late
    // errors after removing the owned StreamAdapter's event forwarding.
    this.source.on('error', ignoreLateError);
    if (this.streaming !== this.source) this.streaming.on('error', ignoreLateError);
    try {
      await this.streaming.close();
      if (this.streaming !== this.source) await this.source.close();
    } finally {
      this.streaming.off('metrics_collected', this.forwardMetrics);
      this.streaming.off('error', this.forwardError);
    }
  }
}

class UnavailableStream extends tts.SynthesizeStream {
  label = 'interview.UnavailableTtsStream';

  constructor(provider: tts.TTS, options?: APIConnectOptions) {
    super(provider, { ...options, maxRetry: 0, timeoutMs: options?.timeoutMs ?? 10000, retryIntervalMs: 0 });
  }

  protected async run(): Promise<void> {
    throw new APIConnectionError({
      message: 'TTS provider is unavailable for this interview',
      options: { retryable: false },
    });
  }
}

/**
 * Session-scoped failover for LiveKit Agents 1.6.2.
 *
 * Its stock adapter health-checks every failed provider with synthesize(), which
 * inference.TTS does not implement, and creates unowned StreamAdapters. Keep one
 * adapter per provider and retry failed providers only on a real utterance when
 * every provider failed. A new interview starts with fresh provider health.
 */
export class InterviewTtsFallback extends tts.FallbackAdapter {
  private closed = false;

  constructor(providers: tts.TTS[]) {
    super({ ttsInstances: providers.map((provider) => new FallbackProvider(provider)), maxRetryPerTTS: 0 });
  }

  override stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    // AgentSession supplies its own retry count. Once every provider has failed,
    // surface one terminal failure instead of replaying the entire chain.
    return super.stream({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, ...options?.connOptions, maxRetry: 0 },
    });
  }

  override markUnAvailable(index: number): void {
    const status = this.status[index];
    if (this.closed || !status?.available) return;
    status.available = false;
    // Do not launch synthesize() probes: besides being unsupported by inference
    // TTS, they continually charge/retry unavailable provider accounts.
  }

  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // An active SDK fallback can finish after AgentSession detached its error
    // listener. Its aggregate failure still needs a listener during teardown.
    this.on('error', ignoreLateError);
    await super.close();
  }
}
