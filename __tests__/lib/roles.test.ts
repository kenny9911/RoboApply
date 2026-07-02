// roles.isRecruiterRole — the job-seeker-vs-recruiter gate (req 2: "sign up /
// log in as a Job Seeker, not Recruiter, except Admin"). Recruiters are bounced
// to the /job-seeker bridge; seekers, GoHire candidates, and admins are allowed.
//
// INVARIANT (CLAUDE.md): the recruiter-role set here must stay byte-identical to
// frontend/src/utils/userRole.ts, and the gate compares the RAW role (never the
// normalized one, which collapses seeker→user and would misroute job-seekers).

import { describe, it, expect } from 'vitest';
import { isRecruiterRole } from '../../lib/roles';

describe('roles.isRecruiterRole', () => {
  it('treats every recruiter-side role as a recruiter (→ bounced from RoboApply)', () => {
    for (const r of ['user', 'internal', 'agency', 'sales', 'customer_success']) {
      expect(isRecruiterRole(r)).toBe(true);
    }
  });

  it('treats job-seeker / candidate / admin as NOT recruiters (→ allowed in)', () => {
    // admin is the "except Admin" carve-out — deliberately not a recruiter here.
    for (const r of ['seeker', 'candidate', 'admin']) {
      expect(isRecruiterRole(r)).toBe(false);
    }
  });

  it('treats unknown / empty / missing roles as NOT recruiter', () => {
    expect(isRecruiterRole(undefined)).toBe(false);
    expect(isRecruiterRole(null)).toBe(false);
    expect(isRecruiterRole('')).toBe(false);
    expect(isRecruiterRole('mystery')).toBe(false);
  });

  it('compares the RAW role — "seeker" is never treated as the recruiter default "user"', () => {
    expect(isRecruiterRole('seeker')).toBe(false);
  });
});
