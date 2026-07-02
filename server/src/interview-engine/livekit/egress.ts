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
import { getLiveKitCreds, getLiveKitHttpUrl, getR2Creds } from '../config.js';
import { logger } from '../../services/LoggerService.js';

let egressClient: EgressClient | null = null;

function getEgressClient(): EgressClient {
  if (!egressClient) {
    const { apiKey, apiSecret } = getLiveKitCreds();
    egressClient = new EgressClient(getLiveKitHttpUrl(), apiKey, apiSecret);
  }
  return egressClient;
}

export function __resetEgressClientForTest(): void {
  egressClient = null;
}

/**
 * Build the EncodedFileOutput that writes the recording into R2 at `filepath`.
 * Returns null when R2 is not configured (recording silently disabled).
 */
export function buildR2FileOutput(filepath: string): EncodedFileOutput | null {
  const r2 = getR2Creds();
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
