/**
 * Parley browser SDK — connects a candidate to a Parley interview session.
 *
 * VENDORED from the Parley repo (web/sdk/parley.ts, protocol v1: WHIP-style
 * POST /v1/rtc/:id/offer + the `parley` data channel) for the practice-
 * interview pilot. Kept verbatim below this note so a re-sync is a plain copy;
 * bundling it beats a runtime import from the Parley origin (no CSP/script-src
 * exception, typed, testable). Re-copy it whenever Parley's protocol changes.
 *
 *   const client = await Parley.connect({ sessionId, token, video: true });
 *   client.on('state', (e) => …);           // ready | greeting | listening | user_speaking | thinking | speaking | ended
 *   client.on('user.partial', (e) => …);    // live caption of the candidate
 *   client.on('agent.segment', (e) => …);   // sentence the interviewer is speaking
 *   startButton.onclick = () => client.start(); // must be a user gesture (unlocks audio)
 *
 * The interviewer's audio is played through an <audio> element fed by the
 * WebRTC track, so the browser's echo canceller removes it from the microphone.
 */

export type ParleyState =
  | 'connecting'
  | 'ready'
  | 'greeting'
  | 'listening'
  | 'user_speaking'
  | 'thinking'
  | 'speaking'
  | 'reconnecting'
  | 'ended'
  | 'failed';

export interface ParleyEventMap {
  state: { state: ParleyState };
  'user.partial': { text: string };
  'user.final': { turnId: string; text: string };
  'agent.text': { turnId: string; delta: string };
  'agent.segment': { turnId: string; index: number; text: string };
  'agent.interrupted': { turnId: string; playedText: string };
  'agent.done': { turnId: string; text: string };
  /** A reply was dropped before it was heard because the candidate kept talking. */
  'agent.cancelled': { turnId: string };
  /** The candidate's committed line is back in progress (it will be re-sent merged with what follows). */
  'user.retracted': { turnId: string; text: string };
  /** The interviewer's audio track is attached and playing through `client.audio`. */
  track: { stream: MediaStream };
  metrics: {
    turnId: string;
    endOfTurnMs?: number;
    sttFinalMs?: number;
    llmFirstTokenMs?: number;
    ttsFirstAudioMs?: number;
    voiceToVoiceMs?: number;
  };
  notice: { level: 'info' | 'warn' | 'error'; message: string };
  ended: { reason: string };
  pong: { t: number };
  error: { message: string };
  connection: { state: RTCPeerConnectionState; candidateType?: string; connectMs?: number };
}

export interface ConnectOptions {
  sessionId: string;
  token: string;
  /** Parley base URL; defaults to the page origin. */
  baseUrl?: string;
  /** Also send the camera (recorded server-side). */
  video?: boolean | MediaTrackConstraints;
  audio?: MediaTrackConstraints;
  iceServers?: RTCIceServer[];
  /** Existing element to play the interviewer through; one is created otherwise. */
  audioElement?: HTMLAudioElement;
  /** Re-use already-acquired media (e.g. from a device-check page). */
  stream?: MediaStream;
}

type Handler<K extends keyof ParleyEventMap> = (ev: ParleyEventMap[K]) => void;

export class ParleyClient {
  private handlers = new Map<string, Set<(ev: unknown) => void>>();
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private queue: string[] = [];
  private closed = false;
  private reconnects = 0;
  private pingTimer: number | null = null;
  state: ParleyState = 'connecting';
  readonly audio: HTMLAudioElement;
  localStream!: MediaStream;
  remoteStream: MediaStream | null = null;
  /** Round-trip time to the server (ms) from the last ping. */
  rttMs: number | null = null;

  private constructor(private readonly opts: ConnectOptions & { baseUrl: string }) {
    this.audio = opts.audioElement ?? document.createElement('audio');
    this.audio.autoplay = true;
    this.audio.setAttribute('playsinline', '');
  }

  /** Create and connect in one step. */
  static async connect(opts: ConnectOptions): Promise<ParleyClient> {
    const client = ParleyClient.create(opts);
    await client.connect();
    return client;
  }

  /** Create without connecting, so listeners can be attached before any event fires. */
  static create(opts: ConnectOptions): ParleyClient {
    const baseUrl = (opts.baseUrl ?? location.origin).replace(/\/$/, '');
    return new ParleyClient({ ...opts, baseUrl });
  }

  private connecting: Promise<void> | null = null;
  /** Acquire media and connect (idempotent). */
  connect(): Promise<void> {
    this.connecting ??= this.init();
    return this.connecting;
  }

  on<K extends keyof ParleyEventMap>(type: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as (ev: unknown) => void);
    return () => set!.delete(handler as (ev: unknown) => void);
  }

  private fire(type: string, ev: unknown): void {
    this.handlers.get(type)?.forEach((h) => {
      try {
        h(ev);
      } catch (err) {
        console.error('[parley] handler error', err);
      }
    });
    this.handlers.get('*')?.forEach((h) => h({ type, ...(ev as object) }));
  }

  private async init(): Promise<void> {
    this.localStream =
      this.opts.stream ??
      (await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          ...(this.opts.audio ?? {}),
        },
        video: this.opts.video ? (this.opts.video === true ? { width: 640, height: 480, frameRate: 15 } : this.opts.video) : false,
      }));
    if (this.closed) {
      // disconnect()/close() ran while the devices were opening.
      if (!this.opts.stream) this.localStream.getTracks().forEach((t) => t.stop());
      return;
    }
    await this.negotiate();
    this.pingTimer = window.setInterval(() => this.send({ type: 'ping', t: performance.now() }), 5000);
  }

  private async negotiate(): Promise<void> {
    if (this.closed) return;
    const started = performance.now();
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? [], bundlePolicy: 'max-bundle' });
    this.pc = pc;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (!audioTrack) throw new Error('no microphone track');
    pc.addTransceiver(audioTrack, { direction: 'sendrecv', streams: [this.localStream] });
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) pc.addTransceiver(videoTrack, { direction: 'sendonly', streams: [this.localStream] });

    const dc = pc.createDataChannel('parley', { ordered: true });
    this.dc = dc;
    dc.onopen = () => {
      for (const m of this.queue.splice(0)) dc.send(m);
    };
    dc.onmessage = (e) => this.onMessage(e.data);

    pc.ontrack = (e) => {
      if (e.track.kind !== 'audio') return;
      this.remoteStream = e.streams[0] ?? new MediaStream([e.track]);
      this.audio.srcObject = this.remoteStream;
      void this.audio.play().catch(() => undefined);
      this.fire('track', { stream: this.remoteStream });
    };
    pc.onconnectionstatechange = async () => {
      const s = pc.connectionState;
      if (pc !== this.pc) return;
      if (s === 'connected') {
        this.reconnects = 0;
        this.fire('connection', { state: s, candidateType: await candidateType(pc), connectMs: Math.round(performance.now() - started) });
      } else {
        this.fire('connection', { state: s });
      }
      if ((s === 'failed' || s === 'disconnected') && !this.closed) this.scheduleReconnect(s === 'failed' ? 0 : 3000);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // No need to wait for ICE gathering: the server is reachable directly and
    // learns our address from the connectivity checks.
    const res = await fetch(`${this.opts.baseUrl}/v1/rtc/${encodeURIComponent(this.opts.sessionId)}/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp', authorization: `Bearer ${this.opts.token}` },
      body: pc.localDescription!.sdp,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(`Parley connect failed (${res.status}): ${msg.slice(0, 300)}`);
    }
    const answer = await res.text();
    if (this.closed || pc !== this.pc) {
      // Disconnected (or superseded) while the offer was in flight.
      pc.close();
      return;
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }

  private reconnectTimer: number | null = null;
  private scheduleReconnect(delay: number): void {
    if (this.reconnectTimer || this.closed || this.state === 'ended') return;
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closed || this.pc?.connectionState === 'connected') return;
      if (this.reconnects++ >= 5) {
        this.setState('failed');
        return;
      }
      this.setState('reconnecting');
      try {
        this.pc?.close();
        await this.negotiate();
      } catch (err) {
        this.fire('error', { message: (err as Error).message });
        this.scheduleReconnect(2000);
      }
    }, delay);
  }

  private onMessage(raw: unknown): void {
    let msg: { type?: string } & Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg.type) return;
    if (msg.type === 'state') {
      this.setState(msg.state as ParleyState);
      return;
    }
    if (msg.type === 'pong' && typeof msg.t === 'number') this.rttMs = Math.round(performance.now() - msg.t);
    if (msg.type === 'ended') this.setState('ended');
    this.fire(msg.type, msg);
  }

  private setState(s: ParleyState): void {
    if (this.state === s) return;
    this.state = s;
    this.fire('state', { state: s });
  }

  private send(msg: Record<string, unknown>): void {
    const text = JSON.stringify(msg);
    if (this.dc?.readyState === 'open') this.dc.send(text);
    else if (this.queue.length < 50) this.queue.push(text);
  }

  /** Start the interview. Call from a click handler so audio playback is allowed. */
  start(): void {
    void this.audio.play().catch(() => undefined);
    this.send({ type: 'start' });
  }

  /** Candidate ends the interview (the interviewer says goodbye first). */
  end(): void {
    this.send({ type: 'end' });
  }

  mute(muted: boolean): void {
    this.localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.send({ type: 'mute', muted });
  }

  /**
   * Drop this page's connection WITHOUT ending the interview: the server keeps
   * the session for its reconnect grace (SESSION_RECONNECT_GRACE_SEC), so a
   * reload, a remount or another tab can resume it by connecting again.
   * close() is the hang-up that ends it.
   */
  disconnect(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.pc?.close();
    this.audio.srcObject = null;
    if (!this.opts.stream) this.localStream?.getTracks().forEach((t) => t.stop());
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      await fetch(`${this.opts.baseUrl}/v1/rtc/${encodeURIComponent(this.opts.sessionId)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${this.opts.token}` },
        keepalive: true,
      });
    } catch {
      /* ignore */
    }
    this.pc?.close();
    if (!this.opts.stream) this.localStream?.getTracks().forEach((t) => t.stop());
  }
}

async function candidateType(pc: RTCPeerConnection): Promise<string | undefined> {
  try {
    const stats = await pc.getStats();
    let pairId: string | undefined;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    let local: string | undefined;
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && (s.id === pairId || (!pairId && s.nominated))) local = s.localCandidateId;
    });
    let type: string | undefined;
    stats.forEach((s) => {
      if (s.type === 'local-candidate' && s.id === local) type = `${s.candidateType}/${s.protocol}`;
    });
    return type;
  } catch {
    return undefined;
  }
}

export const Parley = {
  connect: ParleyClient.connect.bind(ParleyClient),
  create: ParleyClient.create.bind(ParleyClient),
};
export default Parley;
