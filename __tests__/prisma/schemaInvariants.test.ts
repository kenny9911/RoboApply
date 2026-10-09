// @vitest-environment node
//
// FND-1b: invariants of the Jobright-clone data model
// (docs/jobright-clone/TASK_PLAN.md FND-1b, §1 R-06/R-17/R-18/R-19;
// ARCHITECTURE.md §2). Structural checks on server/prisma/schema/**:
//
// - every planned model exists, in the area file ARCHITECTURE.md §2.1 assigns it;
// - user-owned RA* data is deleted with the account (onDelete: Cascade), with a
//   short, reasoned exemption list that the account wipe (WP-10) must handle;
// - every brand-scoped model carries `brand` or `market`, and every RA* model is
//   classified (brand-scoped, user-scoped or global) so additions must choose;
// - the honesty rulings encoded in the schema (D1/D3) stay encoded.
//
// SCHEMA-n steps that add models must extend PLACEMENT and SCOPE below.

import { describe, expect, it } from 'vitest';
import { type Block, modelMap, onDelete, parseSchema } from './schemaModel';

const blocks = parseSchema();
const models = modelMap(blocks);
const raModels = [...models.values()].filter((b) => /^RA[A-Z]/.test(b.name));

function model(name: string): Block {
  const b = models.get(name);
  if (!b) throw new Error(`model ${name} is not declared`);
  return b;
}
function field(modelName: string, fieldName: string) {
  const f = model(modelName).fields.find((x) => x.name === fieldName);
  if (!f) throw new Error(`${modelName}.${fieldName} is not declared`);
  return f;
}
const hasField = (modelName: string, fieldName: string) =>
  model(modelName).fields.some((x) => x.name === fieldName);

/** ARCHITECTURE.md §2.1 file per RA* model (+ R-17 additions). */
const PLACEMENT: Record<string, string> = {
  // ra-platform
  RAWorkItem: 'ra-platform.prisma',
  RARateCounter: 'ra-platform.prisma',
  RAAuthToken: 'ra-platform.prisma',
  RAAuthIdentity: 'ra-platform.prisma',
  RAProductEvent: 'ra-platform.prisma',
  RASurveyResponse: 'ra-platform.prisma',
  RABrandInvite: 'ra-platform.prisma',
  // ra-jobs
  RAJob: 'ra-jobs.prisma',
  RACompany: 'ra-jobs.prisma',
  RAIngestQuery: 'ra-jobs.prisma',
  RAProviderUsage: 'ra-jobs.prisma',
  RAH1bEmployerStat: 'ra-jobs.prisma',
  RACareerSiteSource: 'ra-jobs.prisma',
  // ra-match
  RAJobMatchScore: 'ra-match.prisma',
  RAKeywordExtraction: 'ra-match.prisma',
  RAFitReport: 'ra-match.prisma',
  // ra-feed
  RAJobUserState: 'ra-feed.prisma',
  RAJobInteraction: 'ra-feed.prisma',
  RAFeedSession: 'ra-feed.prisma',
  RAFeedRating: 'ra-feed.prisma',
  RAUserAffinity: 'ra-feed.prisma',
  // ra-profile
  RAProfile: 'ra-profile.prisma',
  RAProfileEducation: 'ra-profile.prisma',
  RAProfileExperience: 'ra-profile.prisma',
  RASensitiveAnswers: 'ra-profile.prisma',
  // ra-search
  RASearchProfile: 'ra-search.prisma',
  RACareerGoal: 'ra-search.prisma',
  RASavedSearch: 'ra-search.prisma',
  // ra-onboarding
  RAOnboardingSession: 'ra-onboarding.prisma',
  // ra-resume
  RAResumeVariant: 'ra-resume.prisma',
  RAResumeGrade: 'ra-resume.prisma',
  RATailorSession: 'ra-resume.prisma',
  // ra-coverletter
  RACoverLetter: 'ra-coverletter.prisma',
  // ra-tracker
  RATrackerEntry: 'ra-tracker.prisma',
  RATrackerEvent: 'ra-tracker.prisma',
  RAApplicationArtifact: 'ra-tracker.prisma',
  RACareerInsight: 'ra-tracker.prisma',
  // ra-network
  RAContact: 'ra-network.prisma',
  RAContactImport: 'ra-network.prisma',
  RAOutreachDraft: 'ra-network.prisma',
  // ra-copilot
  RACopilotThread: 'ra-copilot.prisma',
  RACopilotMessage: 'ra-copilot.prisma',
  RACopilotProposal: 'ra-copilot.prisma',
  RACopilotMemory: 'ra-copilot.prisma',
  // ra-agent
  RAAgentSettings: 'ra-agent.prisma',
  RAAgentQueueItem: 'ra-agent.prisma',
  RAAgentKitEvent: 'ra-agent.prisma',
  RAAnswerBankItem: 'ra-agent.prisma',
  // ra-extension
  RAExtensionDevice: 'ra-extension.prisma',
  RAAutofillRun: 'ra-extension.prisma',
  RASiteRequest: 'ra-extension.prisma',
  // ra-credits
  RACreditWindow: 'ra-credits.prisma',
  RACreditLedger: 'ra-credits.prisma',
  RACreditGrant: 'ra-credits.prisma',
  RAEntitlementOverride: 'ra-credits.prisma',
  // ra-notify
  RAAlertDelivery: 'ra-notify.prisma',
  RAPushSubscription: 'ra-notify.prisma',
  RAAnnouncement: 'ra-notify.prisma',
  RAUserUiState: 'ra-notify.prisma',
  RAEmailLog: 'ra-notify.prisma',
  RAAnonAlertSubscription: 'ra-notify.prisma',
  // ra-growth
  RAReferralCode: 'ra-growth.prisma',
  RAReferral: 'ra-growth.prisma',
  RAAttribution: 'ra-growth.prisma',
  RAGrowthChecklist: 'ra-growth.prisma', // SCHEMA-2 (SR-23-1)
  // ra-prep
  RAInterviewQuestion: 'ra-prep.prisma',
  RAQuestionContribution: 'ra-prep.prisma',
  RAQuestionReport: 'ra-prep.prisma',
  RACoach: 'ra-prep.prisma',
  RACoachSlot: 'ra-prep.prisma',
  RACoachBooking: 'ra-prep.prisma',
  // ra-seo
  RASeoPage: 'ra-seo.prisma',
  // ra-cn
  RAPhoneOtp: 'ra-cn.prisma',
  RACampusEvent: 'ra-cn.prisma',
  RACampusSubscription: 'ra-cn.prisma',
  // ra-compliance (R-17)
  RAAiContentLabelLog: 'ra-compliance.prisma',
  RAContentSafetyEvent: 'ra-compliance.prisma',
  RAPersonalInfoRequest: 'ra-compliance.prisma',
  // ra-mock
  RAMockSession: 'ra-mock.prisma',
  RAIntegration: 'ra-mock.prisma',
};

/**
 * RA* models that hold user data but are NOT deleted with the account by a
 * cascade. The account wipe (WP-10) deletes these explicitly, or the reason
 * says why the row must outlive the account.
 */
const NO_CASCADE: Record<string, { behaviour: 'no_fk' | 'SetNull'; reason: string }> = {
  RAOnboardingSession: {
    behaviour: 'no_fk',
    reason: 'moved model with no FK today; WP-10 wipe deletes it with deleteMany({ userId })',
  },
  RAWorkItem: {
    behaviour: 'no_fk',
    reason: 'transient queue row (ARCH §2.3); WP-10 wipe deletes by userId, jobs-maintain prunes',
  },
  RAAiContentLabelLog: {
    behaviour: 'no_fk',
    reason: 'AI-label log the operator must keep; compliance-daily purges it at 6 months',
  },
  RAContentSafetyEvent: {
    behaviour: 'no_fk',
    reason: 'content-safety log the operator must keep; compliance-daily purges it',
  },
  RAPersonalInfoRequest: {
    behaviour: 'SetNull',
    reason: 'proof that an access/delete request was handled must outlive the account',
  },
};

type Scope = 'brand' | 'user' | 'global';
/**
 * Every RA* model is classified. 'brand' models must carry `brand` or `market`;
 * 'user' models take the brand of their user (User.brand is immutable);
 * 'global' models are brand-neutral by design.
 */
const SCOPE: Record<string, Scope> = {
  RAWorkItem: 'brand',
  RARateCounter: 'global', // key embeds the scope (e.g. 'budget:llm:enrich:roboapply')
  RAAuthToken: 'brand',
  RAAuthIdentity: 'brand',
  RAProductEvent: 'brand',
  RASurveyResponse: 'brand',
  RABrandInvite: 'brand',
  RAJob: 'brand',
  RACompany: 'brand',
  RAIngestQuery: 'brand',
  RAProviderUsage: 'global', // provider quota is per API key, not per brand
  RAH1bEmployerStat: 'global', // US DOL public data
  RACareerSiteSource: 'brand',
  RAJobMatchScore: 'user',
  RAKeywordExtraction: 'global', // derived from one RAJob, which carries market
  RAFitReport: 'user',
  RAJobUserState: 'user',
  RAJobInteraction: 'user',
  RAFeedSession: 'user',
  RAFeedRating: 'user',
  RAUserAffinity: 'user',
  RAProfile: 'user',
  RAProfileEducation: 'user',
  RAProfileExperience: 'user',
  RASensitiveAnswers: 'user',
  RASearchProfile: 'user',
  RACareerGoal: 'user',
  RASavedSearch: 'user',
  RAOnboardingSession: 'user',
  RAResumeVariant: 'user',
  RAResumeGrade: 'user',
  RATailorSession: 'user',
  RACoverLetter: 'user',
  RATrackerEntry: 'user',
  RATrackerEvent: 'user',
  RAApplicationArtifact: 'user',
  RACareerInsight: 'user',
  RAContact: 'brand',
  RAContactImport: 'user',
  RAOutreachDraft: 'user',
  RACopilotThread: 'brand',
  RACopilotMessage: 'global', // child of RACopilotThread (brand)
  RACopilotProposal: 'user',
  RACopilotMemory: 'user',
  RAAgentSettings: 'user',
  RAAgentQueueItem: 'user',
  RAAgentKitEvent: 'user',
  RAAnswerBankItem: 'user',
  RAExtensionDevice: 'brand',
  RAAutofillRun: 'user',
  RASiteRequest: 'user',
  RACreditWindow: 'user',
  RACreditLedger: 'user',
  RACreditGrant: 'user',
  RAEntitlementOverride: 'user',
  RAAlertDelivery: 'user',
  RAPushSubscription: 'brand',
  RAAnnouncement: 'brand',
  RAUserUiState: 'user',
  RAEmailLog: 'brand',
  RAAnonAlertSubscription: 'brand',
  RAReferralCode: 'brand',
  RAReferral: 'brand',
  RAAttribution: 'user',
  RAGrowthChecklist: 'user', // SCHEMA-2 (SR-23-1)
  RAInterviewQuestion: 'brand',
  RAQuestionContribution: 'brand',
  RAQuestionReport: 'user',
  RACoach: 'brand',
  RACoachSlot: 'global', // child of RACoach (brand)
  RACoachBooking: 'user',
  RASeoPage: 'brand',
  RAPhoneOtp: 'brand',
  RACampusEvent: 'brand',
  RACampusSubscription: 'user',
  RAAiContentLabelLog: 'brand',
  RAContentSafetyEvent: 'brand',
  RAPersonalInfoRequest: 'brand',
  RAMockSession: 'user',
  RAIntegration: 'user',
};

const userRelations = (b: Block) => b.fields.filter((f) => f.type === 'User');

describe('FND-1b planned models', () => {
  it('declares every planned RA* model in its ARCHITECTURE.md §2.1 area file', () => {
    const actual = Object.fromEntries(
      Object.keys(PLACEMENT).map((name) => [name, models.get(name)?.file ?? '(missing)']),
    );
    expect(actual).toEqual(PLACEMENT);
  });

  it('has no RA* model that the placement map does not know about', () => {
    expect(raModels.map((b) => b.name).filter((n) => !(n in PLACEMENT))).toEqual([]);
  });

  it('keeps every new RA* model out of legacy.prisma and _datasource.prisma', () => {
    const misplaced = raModels.filter((b) => !/^ra-[a-z]+\.prisma$/.test(b.file));
    expect(misplaced.map((b) => `${b.name}@${b.file}`)).toEqual([]);
  });
});

describe('account deletion (user-owned data cascades on User delete)', () => {
  it('every RA* relation to User cascades, except the reasoned exemptions', () => {
    const offenders: string[] = [];
    for (const b of raModels) {
      for (const f of userRelations(b)) {
        const want = NO_CASCADE[b.name]?.behaviour === 'SetNull' ? 'SetNull' : 'Cascade';
        if (onDelete(f) !== want) offenders.push(`${b.name}.${f.name}: onDelete ${onDelete(f)} (want ${want})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every RA* model with a userId/ownerUserId but no User relation is a listed no-FK exemption', () => {
    const noFk = raModels
      .filter((b) => b.fields.some((f) => f.name === 'userId' || f.name === 'ownerUserId'))
      .filter((b) => userRelations(b).length === 0)
      .map((b) => b.name)
      .sort();
    const listed = Object.entries(NO_CASCADE)
      .filter(([, v]) => v.behaviour === 'no_fk')
      .map(([k]) => k)
      .sort();
    expect(noFk).toEqual(listed);
  });

  it('the SetNull exemptions really are SET NULL with an optional user', () => {
    for (const [name, v] of Object.entries(NO_CASCADE)) {
      if (v.behaviour !== 'SetNull') continue;
      const rel = userRelations(model(name));
      expect(rel).toHaveLength(1);
      expect(rel[0].optional).toBe(true);
      expect(onDelete(rel[0])).toBe('SetNull');
      expect(v.reason.length).toBeGreaterThan(20);
    }
  });

  it('first-party analytics events are deleted with the account (honesty H28)', () => {
    expect(onDelete(field('RAProductEvent', 'user'))).toBe('Cascade');
  });

  it('User declares a back-relation for every RA* model that points at it', () => {
    const user = model('User');
    const backTypes = new Set(user.fields.map((f) => f.type));
    const missing = raModels.filter((b) => userRelations(b).length > 0 && !backTypes.has(b.name));
    expect(missing.map((b) => b.name)).toEqual([]);
  });
});

describe('brand scoping', () => {
  it('classifies every RA* model', () => {
    expect(raModels.map((b) => b.name).filter((n) => !(n in SCOPE))).toEqual([]);
    expect(Object.keys(SCOPE).filter((n) => !models.has(n))).toEqual([]);
  });

  it('every brand-scoped RA* model has a brand or market column', () => {
    const missing = Object.entries(SCOPE)
      .filter(([, s]) => s === 'brand')
      .map(([n]) => n)
      .filter((n) => !hasField(n, 'brand') && !hasField(n, 'market'));
    expect(missing).toEqual([]);
  });

  it('every user-scoped RA* model is keyed to a user', () => {
    const missing = Object.entries(SCOPE)
      .filter(([, s]) => s === 'user')
      .map(([n]) => n)
      .filter((n) => !hasField(n, 'userId'));
    expect(missing).toEqual([]);
  });

  it('the shared models FND-1b extends carry brand', () => {
    for (const name of ['User', 'SeekerSubscription', 'AlipayOrder', 'SeekerNotification']) {
      expect(hasField(name, 'brand'), name).toBe(true);
    }
    // R-01: brand ids are 'roboapply' | 'goapply'; existing users are RoboApply users.
    expect(field('User', 'brand').attrs).toContain('@default("roboapply")');
    expect(field('User', 'brand').optional).toBe(false);
    expect(model('User').blockAttrs).toContain('@@unique([brand, phoneE164])');
  });
});

describe('rulings encoded in the schema', () => {
  it('R-06: onboardingStep defaults to "done" and answers are stored', () => {
    expect(field('SeekerProfile', 'onboardingStep').attrs).toContain('@default("done")');
    const answers = field('SeekerProfile', 'onboardingAnswers');
    expect(answers.type).toBe('Json');
    expect(answers.optional).toBe(true);
  });

  it('R-17: GoApply fields on shared models', () => {
    expect(field('User', 'emailIsPlaceholder').attrs).toContain('@default(false)');
    for (const f of ['wxPrepayId', 'wxCodeUrl', 'wxTransactionId', 'tradeType']) {
      expect(field('AlipayOrder', f).optional, f).toBe(true);
    }
    expect(field('AlipayOrder', 'channel').attrs).toContain('@default("alipay")');
    expect(field('SeekerSubscription', 'billingCountry').optional).toBe(true);
    for (const f of ['sourceName', 'originalSourceName', 'salaryText', 'fraudFlags', 'marketTags']) {
      expect(hasField('RAJob', f), f).toBe(true);
    }
  });

  it('PRODUCT §6.3: SeekerSubscriptionTier gains pro and keeps every legacy value', () => {
    const tier = blocks.find((b) => b.kind === 'enum' && b.name === 'SeekerSubscriptionTier');
    const values = (tier?.body ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\w+$/.test(l));
    expect(values).toEqual(['free', 'premium', 'premium_plus', 'starter', 'growth', 'pro']);
  });

  it('H33: CN-rail orders default to a subscription and never document coaching as a purpose', () => {
    const purpose = field('AlipayOrder', 'purpose');
    expect(purpose.attrs).toContain('@default("subscription")');
    expect(model('AlipayOrder').body).toMatch(/'subscription' \| 'interview_pack' only/);
  });

  it('H13: recruiter-bank jobs are a provenance flag, not an exclusivity claim', () => {
    expect(hasField('RAJob', 'isExclusive')).toBe(false);
    expect(field('RAJob', 'fromRecruiterBank').attrs).toContain('@default(false)');
    expect(field('RAJob', 'employerVerified').attrs).toContain('@default(false)');
  });

  it('H16: imported contacts store no email address', () => {
    expect(model('RAContact').fields.map((f) => f.name).filter((n) => /email/i.test(n))).toEqual([]);
  });

  it('D3: the honesty comments restate their rule', () => {
    const docs: Array<[string, string]> = [
      ['RAJob', 'applicantCount'],
      ['RAJob', 'fromRecruiterBank'],
      ['RAJob', 'employerVerified'],
      ['RACompany', 'facts'],
      ['RACampusEvent', 'officialUrl'],
      ['RAContact', 'consentBasis'],
    ];
    for (const [m, f] of docs) expect(field(m, f).doc, `${m}.${f}`).toMatch(/D3/);
  });

  it('C6: the feed badge has a last-visit stamp', () => {
    const f = field('RAUserUiState', 'lastFeedVisitAt');
    expect(f.type).toBe('DateTime');
    expect(f.optional).toBe(true);
  });

  it('R-19 / C13: Ready to apply settings and queue states', () => {
    expect(field('RAAgentSettings', 'weeklyTarget').type).toBe('Int');
    expect(field('RAAgentSettings', 'weeklyTarget').attrs).toContain('@default(10)');
    expect(field('RAAgentSettings', 'minTier').attrs).toContain('@default("good")');
    for (const f of ['tailorEach', 'coverLetterMode', 'baseVariantId', 'fileNameStyle']) {
      expect(hasField('RAAgentSettings', f), f).toBe(true);
    }
    expect(field('RAAgentSettings', 'setupStep').doc).toContain("'extension'");
    expect(field('RAAgentQueueItem', 'state').attrs).toContain('@default("picked")');
    expect(field('RAAgentQueueItem', 'state').doc).toContain('ready_for_review');
    expect(hasField('RAAgentQueueItem', 'weekKey')).toBe(true);
    // D1: no column or default anywhere records that we submitted something.
    const submittedDefaults = raModels.flatMap((b) =>
      b.fields.filter((f) => /@default\("submitted"\)/.test(f.attrs)).map((f) => `${b.name}.${f.name}`),
    );
    expect(submittedDefaults).toEqual([]);
  });

  it('R-18: the coach roster works without an account', () => {
    expect(field('RACoach', 'userId').optional).toBe(true);
    for (const f of ['photoUrl', 'bookingUrl', 'requestEmail', 'sessionLengths', 'active']) {
      expect(hasField('RACoach', f), f).toBe(true);
    }
    expect(field('RACoach', 'sessionLengths').list).toBe(true);
  });

  it('ARCH §2.1: RAJob.searchText carries the trigram GIN index (pg_trgm)', () => {
    expect(model('RAJob').blockAttrs).toContain(
      '@@index([searchText(ops: raw("gin_trgm_ops"))], type: Gin)',
    );
  });

  it('new columns on pre-existing shared models are nullable or defaulted', () => {
    // Columns added by FND-1b to models that already had rows; db push must be
    // able to add them without a backfill.
    const added: Record<string, string[]> = {
      User: ['brand', 'phoneE164', 'phoneVerifiedAt', 'lastActiveAt', 'emailIsPlaceholder'],
      SeekerProfile: [
        'onboardingStep', 'onboardingAnswers', 'onboardingPath', 'onboardingVersion',
        'onboardingStartedAt', 'onboardingCompletedAt', 'onboardingEntry', 'timezone',
        'acquisitionSource', 'acquisitionNote',
      ],
      SeekerSubscription: ['brand', 'planKey', 'interval', 'rail', 'billingCountry'],
      AlipayOrder: [
        'channel', 'brand', 'planKey', 'purpose', 'amountMinor', 'relatedId',
        'wxPrepayId', 'wxCodeUrl', 'wxTransactionId', 'tradeType',
      ],
      SeekerNotification: ['userId', 'brand', 'category', 'templateKey', 'params', 'pushSentAt'],
    };
    const bad: string[] = [];
    for (const [m, names] of Object.entries(added)) {
      for (const n of names) {
        const f = field(m, n);
        if (!f.optional && !f.list && !/@default\(/.test(f.attrs)) bad.push(`${m}.${n}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
