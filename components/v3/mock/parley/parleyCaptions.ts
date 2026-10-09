// Parley data-channel events → the live page's transcript segments and agent
// state. Pure (no React, no WebRTC) so it is unit-testable in jsdom.
//
// The page keeps captions in a Map keyed by segment id ({who, text, final}),
// the same store LiveKit's TranscriptionReceived feeds. Parley differs in two
// ways this module absorbs:
//   - `user.partial` carries no turn id, so the candidate's in-progress line
//     gets a running placeholder id that `user.final` then finalizes in place
//     (a retracted line becomes the placeholder again until its merged final);
//   - interviewer text is shown as it is HEARD (`agent.segment` = a sentence
//     started playing), not as the model streams it (`agent.text`), and a
//     barge-in finalizes it to exactly what was played.

import type { ParleyState } from './parleyClient';

export interface CaptionSegment {
  id: string;
  who: 'you' | 'them';
  text: string;
  final: boolean;
}

/** The interviewer state the page renders (LiveKit's useVoiceAssistant vocabulary). */
export type ParleyAgentState = 'connecting' | 'listening' | 'thinking' | 'speaking';

export function agentStateFor(state: ParleyState): ParleyAgentState | null {
  switch (state) {
    case 'greeting':
    case 'speaking':
      return 'speaking';
    case 'listening':
    case 'user_speaking':
      return 'listening';
    case 'thinking':
      return 'thinking';
    case 'connecting':
    case 'ready':
      return 'connecting';
    default:
      return null; // reconnecting / ended / failed are connection-level, not agent states
  }
}

export class ParleyCaptions {
  private userSeq = 0;
  private userLive: string | null = null;
  private readonly userIds = new Map<string, string>();
  private readonly agentText = new Map<string, string[]>();

  private liveUserId(): string {
    this.userLive ??= `parley-you-${this.userSeq++}`;
    return this.userLive;
  }

  userPartial(text: string): CaptionSegment | null {
    if (!text.trim()) return null;
    return { id: this.liveUserId(), who: 'you', text, final: false };
  }

  userFinal(turnId: string, text: string): CaptionSegment {
    const id = this.userIds.get(turnId) ?? this.liveUserId();
    this.userIds.set(turnId, id);
    if (this.userLive === id) this.userLive = null;
    return { id, who: 'you', text, final: true };
  }

  /** The committed line is back in progress; a merged user.final follows. */
  userRetracted(turnId: string, text: string): CaptionSegment | null {
    const id = this.userIds.get(turnId);
    if (!id) return null;
    this.userIds.delete(turnId);
    this.userLive = id;
    return { id, who: 'you', text, final: false };
  }

  agentSegment(turnId: string, index: number, text: string): CaptionSegment {
    const parts = this.agentText.get(turnId) ?? [];
    parts[index] = text;
    this.agentText.set(turnId, parts);
    return { id: `parley-them-${turnId}`, who: 'them', text: joinParts(parts), final: false };
  }

  agentDone(turnId: string, text: string): CaptionSegment {
    this.agentText.delete(turnId);
    return { id: `parley-them-${turnId}`, who: 'them', text, final: true };
  }

  /** Barge-in: keep only what the candidate actually heard (null if nothing played). */
  agentInterrupted(turnId: string, playedText: string): CaptionSegment | null {
    const heard = this.agentText.has(turnId);
    this.agentText.delete(turnId);
    if (!heard && !playedText.trim()) return null;
    return { id: `parley-them-${turnId}`, who: 'them', text: playedText, final: true };
  }
}

function joinParts(parts: string[]): string {
  // CJK sentences join without a space; Latin ones with one.
  return parts.filter(Boolean).reduce((acc, p) => {
    if (!acc) return p;
    return /[　-鿿＀-￯]$/.test(acc) ? acc + p : `${acc} ${p}`;
  }, '');
}
