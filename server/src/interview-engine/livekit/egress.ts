// backend/src/interview-engine/livekit/egress.ts
//
// Recording via LiveKit Egress, written DIRECTLY to Cloudflare R2 (requirement
// #2). We use RoomCompositeEgress (the composed room view) with an
// EncodedFileOutput pointed at an S3Upload carrying our R2 creds. For voice
// mode we set audioOnly so the file is an audio-only MP4.
//
// The control plane starts egress AFTER the room is created and the agent is
// dispatched (see InterviewSessionService.getConnection). On stop / room
// finish, the `egress_ended` webhook (livekit/webhookReceiver.ts) carries the
// final file location + size + duration which we persist on the session.
//
// API verified against livekit-server-sdk@2.15.2:
//   EgressClient(host, key, secret).startRoomCompositeEgress(roomName, output, opts)
//   output: EncodedFileOutput{ fileType, filepath, output:{case:'s3', value:S3Upload} }
//   opts:   RoomCompositeOptions{ audioOnly?, layout?, encodingOptions? }

import { EgressClient } from 'livekit-server-sdk';
import { EncodedFileOutput, EncodedFileType, S3Upload, type EgressInfo } from '@livekit/protocol';
import { getLiveKitCreds, getLiveKitHttpUrl, getR2WriteCreds } from '../config.js';
import { logger } from '../../services/LoggerService.js';

// Per brand (WP-63a; D5): the LiveKit project is the plane the session runs on
// and the bucket is the brand's (the `storage` group): the shared bucket for
// both brands by default, CN_S3_* when GoApply has its own. Whether video is
// recorded is the provider's media policy plus the session's two consents.
const egressClients = new Map<string, EgressClient>();

function getEgressClient(): EgressClient {
  const { apiKey, apiSecret } = getLiveKitCreds();
  const url = getLiveKitHttpUrl();
  const key = `${url}|${apiKey}`;
  let client = egressClients.get(key);
  if (!client) {
    client = new EgressClient(url, apiKey, apiSecret);
    egressClients.set(key, client);
  }
  return client;
}

export function __resetEgressClientForTest(): void {
  egressClients.clear();
}

/**
 * Build the EncodedFileOutput that writes the recording into R2 at `filepath`.
 * Returns null when the brand has no store for new recordings (not configured,
 * or GoApply under CN_RESIDENCY_STRICT without a bucket of its own): recording
 * is then disabled.
 */
export function buildR2FileOutput(filepath: string): EncodedFileOutput | null {
  const r2 = getR2WriteCreds();
  if (!r2) return null;
  return new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath,
    disableManifest: true,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: r2.accessKeyId,
        secret: r2.secretAccessKey,
        region: r2.region,
        endpoint: r2.endpoint ?? '',
        bucket: r2.bucket,
        forcePathStyle: r2.forcePathStyle,
      }),
    },
  });
}

export interface StartRecordingResult {
  egressId: string;
  filepath: string;
}

/**
 * Start a RoomComposite recording → R2. Returns null when R2 isn't configured
 * or the egress start fails (the session still proceeds without a recording).
 */
export async function startRoomRecording(params: {
  roomName: string;
  filepath: string;
  audioOnly: boolean;
}): Promise<StartRecordingResult | null> {
  const output = buildR2FileOutput(params.filepath);
  if (!output) {
    logger.info('INTERVIEW_ENGINE_EGRESS', 'recording skipped — R2 not configured', { roomName: params.roomName });
    return null;
  }
  try {
    const info: EgressInfo = await getEgressClient().startRoomCompositeEgress(
      params.roomName,
      output,
      // No explicit layout — the default grid avoids the "empty speaker view"
      // issue when egress starts before any track is published. audioOnly drops
      // video entirely for voice mode.
      { audioOnly: params.audioOnly },
    );
    logger.info('INTERVIEW_ENGINE_EGRESS', 'recording started', {
      roomName: params.roomName,
      egressId: info.egressId,
      audioOnly: params.audioOnly,
      filepath: params.filepath,
    });
    return { egressId: info.egressId, filepath: params.filepath };
  } catch (err) {
    logger.error('INTERVIEW_ENGINE_EGRESS', 'startRoomRecording failed', {
      roomName: params.roomName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Stop an active egress early. Best-effort; never throws. */
export async function stopRecording(egressId: string): Promise<void> {
  try {
    await getEgressClient().stopEgress(egressId);
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_EGRESS', 'stopRecording failed (best-effort)', {
      egressId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
