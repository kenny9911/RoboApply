// __tests__/fixtures/resume — tailor session (fictional data).
import type * as R from '../../../lib/api/contracts/resume';
import type { RequestFixture } from '../types';

export const gradeStart = { gradeId: 'g_fixture_1' } satisfies R.GradeStartResponse;

export const resumeRequests: RequestFixture[] = [
  { contract: 'resume', schema: 'ResumeIdParamsSchema', value: { id: 'rv_fixture_1' } },
];
