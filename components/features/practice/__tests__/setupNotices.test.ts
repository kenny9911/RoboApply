import { describe, expect, it } from 'vitest';

import { setupNotices } from '../setupNotices';
import type { PracticeSetup } from '../../../../lib/api/interviewEngine';

const base: PracticeSetup = {
  market: 'intl',
  job: null,
  resume: null,
  firstPractice: { method: 'email', verified: true, grant: 'already_granted' },
  voice: { available: true, reason: null },
  ai: { allowed: true, reason: null },
  recording: { available: false, consent: { audio: false, video: false } },
};

describe('setupNotices', () => {
  it('says nothing while the setup is unknown and nothing is wrong', () => {
    expect(setupNotices({ setup: null, jobNotFound: false, creditsShort: true })).toEqual([]);
    expect(setupNotices({ setup: base, jobNotFound: false, creditsShort: false })).toEqual([]);
  });

  it('flags a missing job', () => {
    expect(setupNotices({ setup: null, jobNotFound: true, creditsShort: false })).toEqual(['jobNotFound']);
  });

  it('points unverified users at verification only when they are short of credits', () => {
    const unverified = { ...base, firstPractice: { method: 'email' as const, verified: false, grant: null } };
    expect(setupNotices({ setup: unverified, jobNotFound: false, creditsShort: false })).toEqual([]);
    expect(setupNotices({ setup: unverified, jobNotFound: false, creditsShort: true })).toEqual(['firstEmail']);
    expect(
      setupNotices({ setup: null, jobNotFound: false, creditsShort: false, firstPracticeFrom402: { method: 'phone', verified: false, grant: null } }),
    ).toEqual(['firstPhone']);
  });

  it('GoApply gates: phone first, then AI consent, then voice; one phone prompt only', () => {
    const phone = {
      ...base,
      market: 'cn' as const,
      firstPractice: { method: 'phone' as const, verified: false, grant: null },
      ai: { allowed: false, reason: 'phone_binding_required' as const },
      voice: { available: false, reason: 'phone_binding_required' as const },
    };
    expect(setupNotices({ setup: phone, jobNotFound: false, creditsShort: true })).toEqual(['gatePhone']);
    const consent = { ...base, ai: { allowed: false, reason: 'ai_consent_required' as const } };
    expect(setupNotices({ setup: consent, jobNotFound: false, creditsShort: false })).toEqual(['gateConsent']);
    const noVoice = { ...base, voice: { available: false, reason: 'voice_unavailable' as const } };
    expect(setupNotices({ setup: noVoice, jobNotFound: false, creditsShort: false })).toEqual(['voiceUnavailable']);
  });
});
