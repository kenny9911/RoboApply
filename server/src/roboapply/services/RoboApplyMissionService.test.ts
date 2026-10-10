// @vitest-environment node
// WP-75: the V1 mission service is reduced to the one read `/auth/me` makes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('../../lib/prisma.js', () => ({ default: { roboApplyMission: { findUnique: m.findUnique } } }));

import * as missionService from './RoboApplyMissionService.js';

describe('RoboApplyMissionService (read-only remnant)', () => {
  beforeEach(() => m.findUnique.mockReset());

  it('exports only the /auth/me reader', () => {
    expect(Object.keys(missionService)).toEqual(['getMissionForUser']);
  });

  it('returns null when the user has no V1 mission', async () => {
    m.findUnique.mockResolvedValue(null);
    await expect(missionService.getMissionForUser('u1')).resolves.toBeNull();
    expect(m.findUnique).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      select: { id: true, userId: true, intentText: true, resumeId: true },
    });
  });

  it('maps the selected fields and normalizes a missing resume to null', async () => {
    m.findUnique.mockResolvedValue({ id: 'm1', userId: 'u1', intentText: 'Backend roles in Berlin', resumeId: undefined });
    await expect(missionService.getMissionForUser('u1')).resolves.toEqual({
      id: 'm1',
      userId: 'u1',
      intentText: 'Backend roles in Berlin',
      resumeId: null,
    });
  });
});
