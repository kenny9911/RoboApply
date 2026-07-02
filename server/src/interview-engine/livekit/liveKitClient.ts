// backend/src/interview-engine/livekit/liveKitClient.ts
//
// Fresh LiveKit room + token + explicit-agent-dispatch primitives for the
// Interview Engine. Deliberately NOT importing the legacy lib/livekitTokens.ts
// — this module is self-contained per the "design from scratch" requirement.
//
// Flow:
//   1. createRoom(roomName, metadata)            — room exists with the worker's
//                                                  full config in metadata.
//   2. dispatchAgent(roomName, agentName, meta)  — explicit dispatch so the
//                                                  Python worker joins the room.
//   3. mintJoinToken(...)                         — the JWT the browser uses to
//                                                  connect (full-duplex: publish
//                                                  mic [+cam in video mode] +
//                                                  subscribe + data).

import {
  AccessToken,
  type AccessTokenOptions,
  AgentDispatchClient,
  RoomServiceClient,
  type CreateOptions,
} from 'livekit-server-sdk';
import { TrackSource } from '@livekit/protocol';
import { getLiveKitCreds, getLiveKitHttpUrl, getJoinTokenTtlSeconds } from '../config.js';
import { logger } from '../../services/LoggerService.js';

let roomClient: RoomServiceClient | null = null;
let dispatchClient: AgentDispatchClient | null = null;

function getRoomClient(): RoomServiceClient {
  if (!roomClient) {
    const { apiKey, apiSecret } = getLiveKitCreds();
    roomClient = new RoomServiceClient(getLiveKitHttpUrl(), apiKey, apiSecret);
  }
  return roomClient;
}

function getDispatchClient(): AgentDispatchClient {
  if (!dispatchClient) {
    const { apiKey, apiSecret } = getLiveKitCreds();
    dispatchClient = new AgentDispatchClient(getLiveKitHttpUrl(), apiKey, apiSecret);
  }
  return dispatchClient;
}

/** For tests — drop memoized clients so new creds take effect. */
export function __resetLiveKitClientsForTest(): void {
  roomClient = null;
  dispatchClient = null;
}

/**
 * Create (idempotently) the interview room with the worker config in metadata.
 * Best-effort: LiveKit dedupes by name and may error on an existing room — we
 * log and continue so token issuance never blocks on a transient room error.
 */
export async function createInterviewRoom(params: {
  roomName: string;
  metadata: string;
  maxParticipants?: number;
  emptyTimeoutSec?: number;
  departureTimeoutSec?: number;
}): Promise<{ sid: string | null }> {
  const opts: CreateOptions = {
    name: params.roomName,
    metadata: params.metadata,
    emptyTimeout: params.emptyTimeoutSec ?? 15 * 60,
    departureTimeout: params.departureTimeoutSec ?? 60,
    maxParticipants: params.maxParticipants ?? 3,
  };
  try {
    const room = await getRoomClient().createRoom(opts);
    return { sid: room.sid || null };
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_LK', 'createRoom failed (best-effort)', {
      roomName: params.roomName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sid: null };
  }
}

/** Update an existing room's metadata (e.g. if regenerated). Best-effort. */
export async function updateRoomMetadata(roomName: string, metadata: string): Promise<void> {
  try {
    await getRoomClient().updateRoomMetadata(roomName, metadata);
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_LK', 'updateRoomMetadata failed', {
      roomName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Explicitly dispatch the named agent worker into the room. Requires the worker
 * to be registered with the same `agentName`. Returns the dispatch id (or null
 * if no agent is configured / dispatch failed — the session can still proceed
 * with the candidate connected, the worker just won't join).
 */
export async function dispatchAgent(params: {
  roomName: string;
  agentName: string;
  metadata: string;
}): Promise<string | null> {
  try {
    const dispatch = await getDispatchClient().createDispatch(params.roomName, params.agentName, {
      metadata: params.metadata,
    });
    return dispatch.id || null;
  } catch (err) {
    logger.error('INTERVIEW_ENGINE_LK', 'dispatchAgent failed', {
      roomName: params.roomName,
      agentName: params.agentName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface JoinTokenResult {
  token: string;
  url: string;
  roomName: string;
  identity: string;
  expiresAt: Date;
}

/**
 * Mint a participant join token. Full duplex: the candidate publishes mic
 * (+camera/screenshare in video mode), subscribes to the agent's audio, and
 * can publish data messages.
 */
export async function mintJoinToken(params: {
  roomName: string;
  identity: string;
  name?: string;
  allowVideo: boolean;
  ttlSeconds?: number;
  metadata?: string;
}): Promise<JoinTokenResult> {
  const creds = getLiveKitCreds();
  const ttl = params.ttlSeconds ?? getJoinTokenTtlSeconds();
  const tokenOpts: AccessTokenOptions = { identity: params.identity, ttl };
  if (params.name) tokenOpts.name = params.name;
  if (params.metadata) tokenOpts.metadata = params.metadata;

  const at = new AccessToken(creds.apiKey, creds.apiSecret, tokenOpts);
  at.addGrant({
    room: params.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: params.allowVideo
      ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE]
      : [TrackSource.MICROPHONE],
  });

  const token = await at.toJwt();
  return {
    token,
    url: creds.url,
    roomName: params.roomName,
    identity: params.identity,
    expiresAt: new Date(Date.now() + ttl * 1000),
  };
}

/** Tear down a room early (candidate ended / cleanup). Best-effort. */
export async function deleteInterviewRoom(roomName: string): Promise<void> {
  try {
    await getRoomClient().deleteRoom(roomName);
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_LK', 'deleteRoom failed (best-effort)', {
      roomName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
