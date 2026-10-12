// @vitest-environment node
//
// FND-1a: the single-file Prisma schema moved into the multi-file folder
// server/prisma/schema/ (docs/jobright-clone/ARCHITECTURE.md §2.1) with no
// DDL change. The DDL proof is `prisma migrate diff` between the old file and
// the folder, which must print an empty migration (run by the orchestrator;
// see TASK_PLAN.md FND-1a). These tests guard the structure that proof relies
// on, so later additions (FND-1b, SCHEMA-n) cannot silently undo the move:
//
// - prisma.config.ts points at the folder and the old single file is gone;
// - exactly one generator and one datasource, with the generator output one
//   directory deeper (../../src/generated/prisma) and the ESM settings kept;
// - every model and enum that existed before the move is still declared
//   exactly once, and nothing is declared twice;
// - the RA* models live in the area files ARCHITECTURE.md §2.1 assigns them,
//   and legacy.prisma holds no RA* model.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SCHEMA_DIR = join(ROOT, 'server', 'prisma', 'schema');

function prismaFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return prismaFiles(full);
      return entry.endsWith('.prisma') ? [full] : [];
    });
}

type Block = { kind: string; name: string; file: string; body: string };

function parseBlocks(): Block[] {
  const blocks: Block[] = [];
  for (const file of prismaFiles(SCHEMA_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(model|enum|type|view|generator|datasource) (\w+) \{\s*$/.exec(lines[i]);
      if (!m) continue;
      let j = i + 1;
      while (j < lines.length && lines[j] !== '}') j += 1;
      blocks.push({
        kind: m[1],
        name: m[2],
        file: relative(SCHEMA_DIR, file),
        body: lines.slice(i + 1, j).join('\n'),
      });
      i = j;
    }
  }
  return blocks;
}

/** Every model declared in server/prisma/schema.prisma at the move (HEAD e20a5b1; unchanged since 11e102f). */
const MODELS_BEFORE_MOVE = [
  'Team', 'TeamMember', 'TeamInvitation', 'User', 'UserLLMKey',
  'SystemLLMKey', 'Session', 'HiringRequest', 'Candidate', 'HiringSession',
  'ApiKey', 'ApiUsageRecord', 'ApiRequestLog', 'LLMCallLog', 'TopUpRecord',
  'AlipayOrder', 'SubscriptionRenewal', 'AdminAdjustment', 'ExternalPayment',
  'OverageRate', 'OverageCharge', 'UsageDeductionLog', 'GoHireAgentSeat',
  'AppConfig', 'AgentAlexEvalRun', 'InterviewRoomConfigVersion', 'Resume',
  'ResumeVersion', 'ResumeJobFit', 'Job', 'JobMatch', 'DeepMatchJob',
  'MatchCalibration', 'JobResumeMatch', 'Interview', 'InterviewDialogTurn',
  'InterviewEvaluation', 'InterviewQuestionRubric',
  'InterviewTranscriptSegment', 'InterviewGraderResult',
  'EvaluationAccessLog', 'EvaluationShareEvent', 'ATSIntegration',
  'ATSSyncLog', 'WebhookDelivery', 'UserActivity', 'MatchingBatchRun',
  'MatchingTaskTemplate', 'MatchingSession', 'MatchRunResume', 'Agent',
  'AgentCandidate', 'AgentRun', 'AgentCriteriaPreset', 'AgentIdealProfile',
  'UserRecruiterProfile', 'CandidateInteraction', 'MemoryEntry',
  'MemoryAdminAuditLog', 'AgentActivityLog', 'Invitation', 'Outreach',
  'ExternalSourceConfig', 'SourceConfig', 'GoHireInterview',
  'GoHireImportBatch', 'ResumeImportBatch', 'AgentAlexSession', 'AlanSession',
  'AlanCreditLedger', 'AgentAlexVoiceTurn', 'MatchPrefilter', 'Task',
  'TaskAutomationRule', 'Notification', 'Contact', 'Company', 'Assessment',
  'AssessmentQuestion', 'AssessmentInvitation', 'AssessmentSubmission',
  'Instrument', 'InstrumentItem', 'InstrumentDimension', 'NormGroup',
  'CompetencyModel', 'RoleCatalogEntry', 'AssessmentReport', 'WikiArticle',
  'WikiChunk', 'WikiFeedback', 'AlexTurn', 'SupportTicket',
  'SupportTicketMessage', 'EscalationRule', 'JobMatchBrief',
  'JobAutoInviteConfig', 'AutoActionAuditLog', 'InviteAuditEvent',
  'SystemJobRun', 'FileVaultFolder', 'FileVaultFile', 'FileVaultAuditLog',
  'AutoLoaderAgent', 'AutoLoaderTask', 'AutoLoaderTaskJob',
  'AutoLoaderFolderWatch', 'AutoLoaderS3Connector', 'AutoLoaderRun',
  'AutoLoaderFile', 'SeekerProfile', 'SeekerJobPreferences', 'SeekerJobMatch',
  'SeekerResumeVersion', 'SeekerApplication', 'SeekerOnboardingInterview',
  'SeekerMockInterview', 'SeekerMockInterviewQuestion',
  'SeekerTrainingModule', 'SeekerTrainingProgress', 'SeekerProfileVideo',
  'SeekerSubscription', 'MockInterviewCreditLedger',
  'SeekerAutoApplySettings', 'SeekerBoardConnection', 'SeekerSkillGap',
  'SeekerConsentRecord', 'SeekerActivityLog', 'SeekerNotification',
  'RoboApplyMission', 'RoboApplyRun', 'RoboApplyDigest',
  'RoboApplyCoverLetterCache', 'RACareerGoal', 'RAJob', 'RATrackerEntry',
  'RAResumeVariant', 'RASavedSearch', 'RACareerInsight',
  'RAKeywordExtraction', 'RAJobMatchScore', 'RAIntegration', 'RAMockSession',
  'RAOnboardingSession', 'InterviewSession', 'CustomerProfile',
  'HealthScoreSnapshot', 'CustomerInteraction', 'CrmAlert', 'CrmEmailDraft',
  'CrmAutomationRule', 'AIAuditLog', 'Playbook', 'PlaybookRun',
  'OutboundCampaign', 'RuntimeRun', 'RuntimeLock', 'RuntimeAgent',
  'RuntimeCommand', 'RuntimeHeartbeat',
];

/** Every enum declared in server/prisma/schema.prisma at the move (HEAD e20a5b1; unchanged since 11e102f). */
const ENUMS_BEFORE_MOVE = [
  'DeepMatchStatus', 'SeekerSubscriptionTier', 'RoboApplyReviewMode',
  'RoboApplyRunStatus', 'RoboApplyBoardAdapter',
];

/** ARCHITECTURE.md §2.1 placement of the RA* models that existed at the move. */
const RA_PLACEMENT: Record<string, string> = {
  RAJob: 'ra-jobs.prisma',
  RAJobMatchScore: 'ra-match.prisma',
  RAKeywordExtraction: 'ra-match.prisma',
  RACareerGoal: 'ra-search.prisma',
  RASavedSearch: 'ra-search.prisma',
  RAOnboardingSession: 'ra-onboarding.prisma',
  RAResumeVariant: 'ra-resume.prisma',
  RATrackerEntry: 'ra-tracker.prisma',
  RACareerInsight: 'ra-tracker.prisma',
  RAMockSession: 'ra-mock.prisma',
  RAIntegration: 'ra-mock.prisma',
};

describe('FND-1a multi-file schema move', () => {
  const blocks = parseBlocks();
  const byName = (kind: string, name: string) =>
    blocks.filter((b) => b.kind === kind && b.name === name);

  it('points prisma.config.ts at the schema folder and removes the single file', () => {
    const config = readFileSync(join(ROOT, 'prisma.config.ts'), 'utf8');
    expect(config).toMatch(/schema:\s*path\.join\('server',\s*'prisma',\s*'schema'\)/);
    expect(config).not.toMatch(/'schema\.prisma'/);
    expect(existsSync(join(ROOT, 'server', 'prisma', 'schema.prisma'))).toBe(false);
    expect(statSync(SCHEMA_DIR).isDirectory()).toBe(true);
  });

  it('declares exactly one generator, in _datasource.prisma, with the deeper output path', () => {
    const generators = blocks.filter((b) => b.kind === 'generator');
    expect(generators.map((g) => `${g.file}:${g.name}`)).toEqual(['_datasource.prisma:client']);
    const gen = generators[0].body;
    expect(gen).toMatch(/^\s*provider\s*=\s*"prisma-client"\s*$/m);
    expect(gen).toMatch(/^\s*output\s*=\s*"\.\.\/\.\.\/src\/generated\/prisma"\s*$/m);
    expect(gen).toMatch(/^\s*moduleFormat\s*=\s*"esm"\s*$/m);
    expect(gen).toMatch(/^\s*importFileExtension\s*=\s*"js"\s*$/m);
  });

  it('declares exactly one postgresql datasource, in _datasource.prisma', () => {
    const datasources = blocks.filter((b) => b.kind === 'datasource');
    expect(datasources.map((d) => `${d.file}:${d.name}`)).toEqual(['_datasource.prisma:db']);
    expect(datasources[0].body).toMatch(/^\s*provider\s*=\s*"postgresql"\s*$/m);
  });

  it('keeps every pre-move model declared exactly once', () => {
    expect(MODELS_BEFORE_MOVE).toHaveLength(160);
    const missingOrDuplicated = MODELS_BEFORE_MOVE.filter((n) => byName('model', n).length !== 1);
    expect(missingOrDuplicated).toEqual([]);
  });

  it('keeps every pre-move enum declared exactly once', () => {
    expect(ENUMS_BEFORE_MOVE).toHaveLength(5);
    const missingOrDuplicated = ENUMS_BEFORE_MOVE.filter((n) => byName('enum', n).length !== 1);
    expect(missingOrDuplicated).toEqual([]);
  });

  it('declares no top-level name twice across the folder', () => {
    const seen = new Map<string, string[]>();
    for (const b of blocks) {
      const key = `${b.kind === 'generator' || b.kind === 'datasource' ? b.kind : 'type'}:${b.name}`;
      seen.set(key, [...(seen.get(key) ?? []), b.file]);
    }
    const dupes = [...seen.entries()].filter(([, files]) => files.length > 1);
    expect(dupes).toEqual([]);
  });

  it('places the moved RA* models in their ARCHITECTURE.md §2.1 area files', () => {
    const placement = Object.fromEntries(
      Object.keys(RA_PLACEMENT).map((name) => [name, byName('model', name)[0]?.file]),
    );
    expect(placement).toEqual(RA_PLACEMENT);
  });

  it('keeps legacy.prisma free of RA* models and _datasource.prisma free of models', () => {
    const raInLegacy = blocks.filter((b) => b.file === 'legacy.prisma' && /^RA[A-Z]/.test(b.name));
    expect(raInLegacy.map((b) => b.name)).toEqual([]);
    const inDatasource = blocks.filter(
      (b) => b.file === '_datasource.prisma' && b.kind !== 'generator' && b.kind !== 'datasource',
    );
    expect(inDatasource.map((b) => b.name)).toEqual([]);
  });
});
