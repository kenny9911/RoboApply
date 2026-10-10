// server/src/interview-engine/providers/types.ts
//
// VoiceSessionProvider — the per-brand media seam of the interview engine
// (WP-63a; ARCHITECTURE.md §1.9; CN_TW_LAUNCH_PLAN.md CN-E-06 / WP-VOICE-CN).
//
// One provider instance serves one brand. It owns everything that touches the
// media plane — rooms, agent dispatch, join tokens, recording, webhooks — so
// InterviewSessionService never reads LiveKit credentials itself.
//
//   livekit_cloud       Wave 0's LiveKit Cloud code, wrapped unchanged
//                       (RoboApply; GoApply CN-0 on a separate Asia project).
//   livekit_selfhosted  The same LiveKit protocol against a self-hosted server
//                       (GoApply CN-1 in Shanghai).
//   volcano, trtc       Reserved ids for Volcano Engine RTC / Tencent TRTC.
//                       NOT implemented and never offered as a capability:
//                       selecting one makes voice practice unavailable.
//
// Brand media policy (CN L-11) is applied INSIDE the provider, so no caller
// can get it wrong: on GoApply the join token cannot publish a camera (the
// camera is a local preview only) and recordings are audio-only.

import type { WebhookEvent } from 'livekit-server-sdk';
import type { BrandId } from '../../platform/brand/registry.js';
import { InterviewEngineConfigError, type InterviewMediaPolicy, type VoiceProviderId } from '../config.js';

export type { VoiceProviderId } from '../config.js';

export interface ProviderJoinToken {
  token: string;
  url: string;
  roomName: string;
  identity: string;
  expiresAt: Date;
}

export interface ProviderRecording {
  egressId: string;
  filepath: string;
}

export interface VoiceSessionProvider {
  readonly id: VoiceProviderId;
  readonly brand: BrandId;
  /** What this brand allows on the media plane. */
  readonly media: InterviewMediaPolicy;
  /** Credentials for this brand's media plane are present. */
  isConfigured(): boolean;
  /** The worker name dispatched for this brand ('RoboApply-Interview' / 'GoApply-Interview'). */
  agentName(): string;
  createRoom(params: { roomName: string; metadata: string }): Promise<{ sid: string | null }>;
  /** Explicit dispatch of this brand's worker. Null when dispatch failed. */
  dispatchAgent(params: { roomName: string; metadata: string }): Promise<string | null>;
  /** The candidate's join token. `allowVideo` is ignored where the brand forbids a published camera. */
  mintClientToken(params: {
    roomName: string;
    identity: string;
    name?: string;
    allowVideo: boolean;
    ttlSeconds?: number;
    metadata?: string;
  }): Promise<ProviderJoinToken>;
  /** Ask the worker to wrap up ({type:'end'} on topic 'ie'). */
  sendEndSignal(roomName: string): Promise<boolean>;
  deleteRoom(roomName: string): Promise<void>;
  /** Start recording into this brand's bucket. `audioOnly` is forced where the brand records no video. */
  startRecording(params: { roomName: string; filepath: string; audioOnly: boolean }): Promise<ProviderRecording | null>;
  stopRecording(egressId: string): Promise<void>;
  /** Verify + decode a media-plane webhook signed by this brand's project. */
  verifyWebhook(rawBody: string, authHeader?: string): Promise<WebhookEvent>;
}

/** A reserved provider id (volcano, trtc) was selected. Maps to 503 like any missing config. */
export class VoiceProviderNotImplementedError extends InterviewEngineConfigError {
  readonly providerId: VoiceProviderId;
  constructor(providerId: VoiceProviderId, brand: BrandId) {
    super(`Voice provider "${providerId}" (brand ${brand}) is reserved and not implemented.`);
    this.name = 'VoiceProviderNotImplementedError';
    this.providerId = providerId;
  }
}
