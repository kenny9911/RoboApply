// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ALONE_ONLY_PHRASES,
  CJK_HEAD_WORDS,
  HEAD_NOUNS,
  MODIFIER_MATCH_SCORE,
  TITLE_MATCH_TRUSTED,
  bestTaxonomyMatch,
  headNounOf,
  lexiconCandidates,
  matchTitle,
  normalizeTitle,
  oneWordRolesIn,
  searchTaxonomy,
  stripLevelWords,
} from './match.js';
import { TAXONOMY_NODES, taxonomyAncestors } from './taxonomy.js';
import { foldTwToCn } from '../normalize/index.js';

describe('normalizeTitle', () => {
  it('folds case, width, punctuation, bracketed notes and tech spellings', () => {
    expect(normalizeTitle('Senior C++ Engineer (Remote) – Payments')).toBe('senior cpp engineer payments');
    expect(normalizeTitle('.NET / C# Developer')).toBe('dotnet csharp developer');
    expect(normalizeTitle('Node.js Developer')).toBe('nodejs developer');
    expect(normalizeTitle('Ｊａｖａ后端开发工程师（2027届校招）')).toBe('java后端开发工程师');
    expect(normalizeTitle('R&D Engineer')).toBe('r and d engineer');
  });

  it('removes level words in the second pass', () => {
    expect(stripLevelWords('senior software engineer ii')).toBe('software engineer');
    expect(stripLevelWords('高级java开发工程师')).toBe('java开发工程师');
    expect(stripLevelWords('2027届校招 后端开发工程师')).toBe('后端开发工程师');
  });
});

const category = (title: string) => {
  const m = bestTaxonomyMatch(title);
  return m ? [m.id, taxonomyAncestors(m.id).find((n) => n.level === 1)!.id] : null;
};

describe('SM-2: "architect" beside software words is a software architect, not Design', () => {
  it.each([
    // The titles Explore listed under "Design".
    'Lead AI Architect',
    'Full Stack Architect with AI',
    'Java Backend Architect',
    'Principal Architect - Machine Learning',
    'Microservices Architect',
    'Senior Platform Architect',
    'Integration Architect (Remote)',
    'IT Architect',
    'Salesforce Architect',
  ])('%s → software_architect, in Software engineering', (title) => {
    expect(category(title)).toEqual(['software_architect', 'software_engineering']);
  });

  it.each([
    ['Solutions Architect', 'cloud_engineer', 'it_infrastructure'],
    ['Cloud Solutions Architect', 'cloud_engineer', 'it_infrastructure'],
    ['Data Architect', 'data_architect', 'data_ai'],
    ['Security Architect', 'security_architect', 'security'],
    ['Enterprise Architect', 'software_architect', 'software_engineering'],
  ])('a named tech architect keeps its own role: %s → %s', (title, id, cat) => {
    expect(category(title)).toEqual([id, cat]);
  });

  it.each([
    'Architect',
    'Senior Architect',
    'Project Architect',
    'Landscape Architect',
    'Licensed Architect - Healthcare',
    'Architect, Residential Projects',
    'Architectural Designer',
    'Interior Architect',
    'Project Architect, Data Centers',
    '建筑师',
  ])('the building profession stays in Design: %s', (title) => {
    expect(category(title)?.[1]).toBe('design');
  });

  it('the three building titles of the acceptance line name the role itself', () => {
    for (const title of ['Landscape Architect', 'Project Architect', 'Architect']) expect(bestTaxonomyMatch(title)).toMatchObject({ id: 'architect', score: 1 });
  });

  it('no title with a software word lands in the building role', () => {
    for (const title of ['AI Architect', 'ML Architect', 'Backend Architect', 'Cloud Architect', 'Systems Architect', 'Application Architect', 'Technical Architect', 'Network Architect', 'Database Architect', '软件架构师', '架构师', '后端 Architect', '云数据Architect']) {
      expect(bestTaxonomyMatch(title)?.id, title).not.toBe('architect');
    }
  });
});

describe('SM-2 rule 1: a head noun alone is the role only when it is the whole title', () => {
  it('lists the nine English head nouns and the six Chinese head words', () => {
    expect([...HEAD_NOUNS]).toEqual(['architect', 'designer', 'developer', 'engineer', 'analyst', 'consultant', 'manager', 'specialist', 'technician']);
    expect([...CJK_HEAD_WORDS]).toEqual(['设计师', '工程师', '顾问', '专员', '经理', '分析师']);
  });

  it.each([
    ['Architect', 'architect', 1],
    ['Senior Architect', 'architect', 1],
    ['Architect II (Remote)', 'architect', 1],
    // "Developer" and "consultant" belong to catch-all roles, which lose 0.15.
    ['Developer', 'software_engineer', 0.85],
    ['Senior Developer', 'software_engineer', 0.85],
    ['Junior Developer II', 'software_engineer', 0.85],
    ['Consultant', 'management_consultant', 0.85],
    ['Principal Consultant', 'management_consultant', 0.85],
  ])('%s → %s at %f', (title, id, score) => {
    expect(bestTaxonomyMatch(title)).toMatchObject({ id, score });
  });

  it.each(['Sales Developer', 'Payments Developer', 'Developer Advocate', 'Wellness Consultant', 'Engineer', 'Staff Engineer', 'Principal Engineer', 'Manager', 'Senior Manager', 'Specialist', 'Technician', 'Analyst', 'Designer', 'Nail Technician'])(
    'inside a longer title, or with nothing but a level word, the head noun names no role: %s',
    (title) => {
      expect(bestTaxonomyMatch(title)).toBeNull();
    },
  );

  it('"Sales Developer Representative" is a sales title, not a software engineer', () => {
    expect(category('Sales Developer Representative')?.[1]).toBe('sales');
    expect(matchTitle('Sales Developer Representative', { limit: 5, minScore: 0 }).map((m) => m.id)).not.toContain('software_engineer');
  });

  it('a Chinese head word alone names no role, with or without a level word or the filler 开发 / 研发', () => {
    for (const title of ['工程师', '高级工程师', '设计师', '资深设计师', '专员', '经理', '高级经理', '分析师', '顾问', '工程師', '專員']) expect(bestTaxonomyMatch(title), title).toBeNull();
    // 开发工程师 / 研发工程师 are the catch-all software role by its own name, and nothing inside a longer title.
    expect(bestTaxonomyMatch('研发工程师')).toMatchObject({ id: 'software_engineer', score: 0.85 });
    expect(bestTaxonomyMatch('光学研发工程师')).toBeNull();
    expect(bestTaxonomyMatch('服装设计师')).toBeNull();
  });
});

describe('SM-2 rule 2: in "<modifiers> <head noun>" the modifiers decide', () => {
  // One case per head noun in at least three disciplines.
  const cases: [string, string, string][] = [
    ['Java Backend Architect', 'software_architect', 'software_engineering'],
    ['Landscape Architect', 'architect', 'design'],
    ['Cloud Solutions Architect', 'cloud_engineer', 'it_infrastructure'],
    ['Data Warehouse Architect', 'data_architect', 'data_ai'],
    ['UX Designer', 'ux_designer', 'design'],
    ['Interior Designer', 'interior_designer', 'design'],
    ['Instructional Designer', 'instructional_designer', 'education'],
    ['Senior Product Designer, Growth', 'product_designer', 'design'],
    ['Salesforce Developer', 'software_engineer', 'software_engineering'],
    ['Senior Java Spring Developer', 'backend_engineer', 'software_engineering'],
    ['Power BI Developer', 'bi_analyst', 'data_ai'],
    ['Curriculum Developer', 'instructional_designer', 'education'],
    ['Business Developer', 'bd_manager', 'sales'],
    ['SQL Server Developer', 'database_administrator', 'data_ai'],
    ['Civil Engineer', 'civil_engineer', 'engineering'],
    ['Sales Engineer', 'sales_engineer', 'sales'],
    ['Customer Support Engineer', 'technical_support_engineer', 'customer'],
    ['Senior C# / .NET Engineer', 'backend_engineer', 'software_engineering'],
    ['Financial Analyst', 'financial_analyst', 'finance'],
    ['Help Desk Analyst', 'it_support', 'it_infrastructure'],
    ['Compliance Analyst', 'compliance_officer', 'legal'],
    ['Senior Analyst, Risk', 'risk_analyst', 'finance'],
    ['SAP Consultant', 'erp_consultant', 'it_infrastructure'],
    ['Recruitment Consultant', 'recruiter', 'people'],
    ['Travel Consultant', 'travel_consultant', 'hospitality'],
    ['Leasing Consultant', 'real_estate_agent', 'sales'],
    ['Store Manager', 'store_manager', 'sales'],
    ['Construction Project Manager', 'construction_manager', 'engineering'],
    ['Clinical Trial Manager', 'clinical_research_associate', 'healthcare'],
    ['Manager, Financial Planning & Analysis', 'financial_analyst', 'finance'],
    ['Payroll Specialist', 'compensation_benefits', 'people'],
    ['Regulatory Affairs Specialist', 'regulatory_affairs', 'legal'],
    ['EHS Specialist', 'environmental_engineer', 'engineering'],
    ['Medical Billing Specialist', 'medical_coder', 'healthcare'],
    ['HVAC Technician', 'maintenance_technician', 'manufacturing'],
    ['Help Desk Technician', 'it_support', 'it_infrastructure'],
    ['Medical Laboratory Technician', 'medical_technologist', 'healthcare'],
    ['Research Technician', 'research_assistant', 'education'],
  ];
  it.each(cases)('%s → %s (%s)', (title, id, cat) => {
    expect(category(title)).toEqual([id, cat]);
  });

  // The Chinese head words, each in three disciplines: the words before the head word decide.
  it.each([
    ['UI设计师', 'ui_designer', 'design'],
    ['课程设计师', 'instructional_designer', 'education'],
    ['软件设计师', 'software_engineer', 'software_engineering'],
    ['土木工程师', 'civil_engineer', 'engineering'],
    ['售前工程师', 'sales_engineer', 'sales'],
    ['硬件工程师', 'hardware_engineer', 'hardware'],
    ['留学顾问', 'academic_advisor', 'education'],
    ['猎头顾问', 'recruiter', 'people'],
    ['SAP顾问', 'erp_consultant', 'it_infrastructure'],
    ['招聘专员', 'recruiter', 'people'],
    ['合规专员', 'compliance_officer', 'legal'],
    ['采购专员', 'buyer', 'operations'],
    ['餐厅经理', 'restaurant_manager', 'hospitality'],
    ['研发经理', 'engineering_manager', 'software_engineering'],
    ['客户成功经理', 'customer_success_manager', 'customer'],
    ['财务分析师', 'financial_analyst', 'finance'],
    ['安全分析师', 'security_analyst', 'security'],
    ['高级数据分析师（校招）', 'data_analyst', 'data_ai'],
  ] as [string, string, string][])('%s → %s (%s)', (title, id, cat) => {
    expect(category(title)).toEqual([id, cat]);
  });

  it('"UX Designer", "Interior Designer" and "Instructional Designer" are three different roles', () => {
    expect(new Set(['UX Designer', 'Interior Designer', 'Instructional Designer'].map((t) => bestTaxonomyMatch(t)?.id)).size).toBe(3);
  });

  it('a role chosen by its modifiers alone scores 0.85, below the trusted mark', () => {
    expect(MODIFIER_MATCH_SCORE).toBe(0.85);
    expect(TITLE_MATCH_TRUSTED).toBe(0.9);
    const m = bestTaxonomyMatch('Principal Architect - Machine Learning')!;
    expect(m).toMatchObject({ id: 'software_architect', score: 0.85 });
    expect(m.matched).toBe('machine learning architect');
    // A catch-all role chosen that way still loses its 0.15.
    expect(bestTaxonomyMatch('Salesforce Developer')).toMatchObject({ id: 'software_engineer', score: 0.7 });
  });

  it('the role sharing the most modifier words wins', () => {
    // "data" alone points at the data architect; "data" and "platform" together at the software architect.
    expect(bestTaxonomyMatch('Data Architect')?.id).toBe('data_architect');
    expect(bestTaxonomyMatch('Data Platform Architect')?.id).toBe('software_architect');
  });

  it('a tie between two specific roles is no match from the modifiers (enrichment decides)', () => {
    // "device" points nowhere alone ("medical device engineer" needs both words), "kernel" at nothing: no role.
    expect(bestTaxonomyMatch('Device Driver Engineer')).toBeNull();
    // "nurse" and "pharmacist" each point at one role: neither wins.
    expect(bestTaxonomyMatch('Nurse Pharmacist Consultant')).toBeNull();
    expect(lexiconCandidates('Nurse Pharmacist Consultant').slice(0, 2).sort()).toEqual(['pharmacist', 'registered_nurse']);
  });

  it('a catch-all role gives way to a specific one on equal count', () => {
    // "java" points at the back-end role (its own phrase) and at the catch-all (a software word).
    expect(bestTaxonomyMatch('Java Spring Boot Developer')?.id).toBe('backend_engineer');
  });

  it('a one-word role beside a head noun is a modifier, and votes like one', () => {
    expect(bestTaxonomyMatch('Nurse Manager')).toMatchObject({ id: 'registered_nurse', score: 0.85 });
    expect(bestTaxonomyMatch('DevOps Consultant')).toMatchObject({ id: 'devops_engineer', score: 0.85 });
    expect(bestTaxonomyMatch('Paralegal Specialist')?.id).toBe('paralegal');
  });

  it('lexiconCandidates lists every role that shares a modifier word, most shared first; none without a head noun', () => {
    const ids = lexiconCandidates('Java Backend Architect');
    expect(ids[0]).toBe('software_architect');
    expect(lexiconCandidates('Cloud Data Architect')).toEqual(expect.arrayContaining(['software_architect', 'cloud_engineer', 'data_architect']));
    expect(lexiconCandidates('Registered Nurse')).toEqual([]);
    expect(headNounOf('Java Backend Architect')).toBe('architect');
    expect(headNounOf('Machine Learning 工程師')).toBe('engineer');
    expect(headNounOf('Registered Nurse')).toBeNull();
  });
});

describe('SM-2 rule 3: ambiguous one-word phrases match only as the whole title', () => {
  it('every entry is a one-word phrase of a role, with its reason', () => {
    const oneWord = new Set(TAXONOMY_NODES.filter((n) => n.level === 3).flatMap((n) => [n.en, ...n.synonyms.en, ...n.synonyms.zh].map(normalizeTitle)).filter((p) => p && !p.includes(' ')));
    for (const [word, reason] of Object.entries(ALONE_ONLY_PHRASES)) {
      expect(oneWord.has(word), word).toBe(true);
      expect(reason.length, word).toBeGreaterThan(10);
    }
  });

  it.each([
    ['PT Cashier', 'retail_sales'], // part time, not a physical therapist
    ['PM 项目经理', 'project_manager'], // not the product manager "pm" names alone
    ['Insurance Producer', 'insurance_agent'],
    ['Banquet Server', 'server'],
    ['Windows Server Administrator', 'sysadmin'],
    ['Financial Controller', 'finance_leader'],
    ['Grant Writer', 'nonprofit_program_manager'],
    ['Corporate Trainer', 'learning_development'],
    ['School Principal', 'education_administrator'],
  ])('%s → %s', (title, id) => {
    expect(bestTaxonomyMatch(title)?.id).toBe(id);
  });

  it.each(['Principal Designer', 'Personal Trainer', 'Dog Trainer', 'Air Traffic Controller', 'Document Control Clerk II', 'Service Writer', 'Night Auditor', 'Data Steward', 'Game Producer', 'EA to the CEO', 'AE Motion Artist'])(
    'the word does not name its role inside another title: %s',
    (title) => {
      expect(bestTaxonomyMatch(title)).toBeNull();
    },
  );

  it('alone, the word is its role at the modifier score: ambiguous even then, so enrichment may overrule it', () => {
    expect(bestTaxonomyMatch('Controller')).toMatchObject({ id: 'finance_leader', score: 0.85 });
    expect(bestTaxonomyMatch('Senior PM')).toMatchObject({ id: 'product_manager', score: 0.85 });
    expect(bestTaxonomyMatch('Principal')).toMatchObject({ id: 'education_administrator', score: 0.85 });
  });

  it('oneWordRolesIn names the roles a title reaches only through such a word (what the old match would have filed it under)', () => {
    expect(oneWordRolesIn('Java Backend Architect')).toEqual(['architect']);
    expect(oneWordRolesIn('Principal Engineer')).toEqual(['education_administrator']);
    expect(oneWordRolesIn('SQL Server Developer').sort()).toEqual(['server', 'software_engineer']);
    expect(oneWordRolesIn('光学研发工程师')).toEqual(['software_engineer']);
    // The word alone is the role by name; a title without such a word reaches none.
    expect(oneWordRolesIn('Senior Architect')).toEqual([]);
    expect(oneWordRolesIn('Principal')).toEqual([]);
    expect(oneWordRolesIn('Registered Nurse - ICU')).toEqual([]);
  });

  it('of two one-word roles with the same score, the one the title ends on wins', () => {
    expect(bestTaxonomyMatch('Physician Recruiter')?.id).toBe('recruiter');
    expect(bestTaxonomyMatch('Pharmacist Recruiter')?.id).toBe('recruiter');
  });
});

describe('Chinese titles: mainland aliases, filler words, Taiwan forms and mixed languages', () => {
  it.each([
    ['前端开发工程师', 'frontend_engineer'],
    ['Web前端', 'frontend_engineer'],
    ['FE工程师', 'frontend_engineer'],
    ['服务端开发', 'backend_engineer'],
    ['服务端', 'backend_engineer'],
    ['后端', 'backend_engineer'],
    ['运营专员', 'product_operations'],
    ['新媒体', 'social_media_manager'],
    ['新媒体运营专员', 'social_media_manager'],
    ['店铺运营', 'ecommerce_manager'],
    ['业务员', 'account_executive'],
    ['销售工程师', 'sales_engineer'],
    ['医药销售代表', 'medical_sales_rep'],
  ])('the mainland alias layer: %s → %s', (title, id) => {
    expect(bestTaxonomyMatch(title)?.id).toBe(id);
  });

  it('开发 and 研发 before 工程师 are filler; a role named with the word keeps its exact name', () => {
    expect(bestTaxonomyMatch('前端研发工程师')?.id).toBe('frontend_engineer');
    expect(bestTaxonomyMatch('Java高级研发工程师')?.id).toBe('backend_engineer');
    expect(bestTaxonomyMatch('高级数据库开发工程师')?.id).toBe('database_administrator');
    expect(bestTaxonomyMatch('测试开发工程师')).toMatchObject({ id: 'sdet', score: 1 });
    expect(bestTaxonomyMatch('运维开发工程师')).toMatchObject({ id: 'devops_engineer', score: 1 });
    expect(bestTaxonomyMatch('测试工程师')).toMatchObject({ id: 'qa_engineer', score: 1 });
  });

  it('管培生 and 储备干部 are entry tracks: the function decides, and alone they stay unknown', () => {
    expect(stripLevelWords('2027届销售管培生')).toBe('销售');
    expect(bestTaxonomyMatch('销售管培生')?.id).toBe('account_executive');
    expect(bestTaxonomyMatch('储备店长')?.id).toBe('store_manager');
    for (const title of ['管培生', '2027届管培生', '管理培训生', '储备干部', foldTwToCn('儲備幹部'), '实习生']) expect(bestTaxonomyMatch(title), title).toBeNull();
  });

  it('a Taiwan title also matches in the mainland reading its caller makes', () => {
    // Ingest, enrichment and the backfill read a Taiwan title both ways (enrich/titleEvidence.ts) and take the better.
    for (const [title, id] of [
      ['資深後端工程師', 'backend_engineer'],
      ['資料分析師', 'data_analyst'],
      ['專案經理', 'project_manager'],
      ['程式設計師', 'software_engineer'],
      ['總經理特助', 'executive_assistant'],
      ['業務儲備幹部', null],
    ] as const) {
      expect(bestTaxonomyMatch(foldTwToCn(title))?.id ?? null, title).toBe(id);
    }
  });

  it('JT-4: a Traditional Chinese title is matched as written, in Taiwan wording', () => {
    // No conversion: the role's own Taiwan label and titles are in the index.
    expect(bestTaxonomyMatch('資深軟體工程師')).toMatchObject({ id: 'software_engineer', matched: '軟體工程師' });
    expect(bestTaxonomyMatch('軟體工程師')).toMatchObject({ id: 'software_engineer', score: 0.85 });
    expect(bestTaxonomyMatch('資深後端工程師')).toMatchObject({ id: 'backend_engineer', score: 1 });
    for (const [title, id] of [
      ['後端工程師', 'backend_engineer'],
      ['前端工程師', 'frontend_engineer'],
      ['全端工程師', 'fullstack_engineer'],
      ['韌體工程師', 'embedded_software_engineer'],
      ['資深韌體工程師', 'embedded_software_engineer'],
      ['演算法工程師', 'ml_engineer'],
      ['資料分析師', 'data_analyst'],
      ['資料工程師', 'data_engineer'],
      ['網路工程師', 'network_engineer'],
      ['資安工程師', 'security_engineer'],
      ['MIS工程師', 'it_support'],
      ['專案經理', 'project_manager'],
      ['產品經理', 'product_manager'],
      ['程式設計師', 'software_engineer'],
      ['行銷專員', 'marketing_specialist'],
      ['行銷企劃', 'marketing_specialist'],
      ['社群小編', 'social_media_manager'],
      ['人資專員', 'hr_generalist'],
      ['招募專員', 'recruiter'],
      ['業務代表', 'account_executive'],
      ['業務專員', 'account_executive'],
      ['業務經理', 'sales_manager'],
      ['業務工程師', 'sales_engineer'],
      ['客服專員', 'customer_service_rep'],
      ['會計', 'accountant'],
      ['護理師', 'registered_nurse'],
      ['專科護理師', 'nurse_practitioner'],
      ['行政助理', 'administrative_assistant'],
      ['總經理特助', 'executive_assistant'],
      ['門市人員', 'retail_sales'],
      ['作業員', 'machine_operator'],
      ['IC設計工程師', 'chip_design_engineer'],
      ['半導體製程工程師', 'semiconductor_process_engineer'],
      ['機構工程師', 'mechanical_engineer'],
      ['品保工程師', 'quality_engineer'],
      ['國貿人員', 'import_export'],
      ['空服員', 'flight_attendant'],
    ] as const) {
      expect(bestTaxonomyMatch(title)?.id ?? null, title).toBe(id);
    }
  });

  it('JT-4: Taiwan level words, head words and filler work like the mainland ones', () => {
    expect(stripLevelWords('資深軟體工程師')).toBe('軟體工程師');
    expect(stripLevelWords('高階產品經理')).toBe('產品經理');
    expect(stripLevelWords('2027屆業務儲備幹部')).toBe('業務');
    expect(stripLevelWords('行銷工讀生')).toBe('行銷');
    // The harness persona's title (carry-over M1, MKT-3E.2): 初階 is a level, 業務代表 the role.
    expect(bestTaxonomyMatch('初階業務代表')).toMatchObject({ id: 'account_executive', score: 1 });
    expect(bestTaxonomyMatch('實習軟體工程師')?.id).toBe('software_engineer');
    // 開發 and 研發 before 工程師 are filler in Taiwan titles too; a role named with the word keeps its exact name.
    expect(bestTaxonomyMatch('前端開發工程師')).toMatchObject({ id: 'frontend_engineer', score: 1 });
    expect(bestTaxonomyMatch('後端研發工程師')?.id).toBe('backend_engineer');
    expect(bestTaxonomyMatch('測試開發工程師')).toMatchObject({ id: 'sdet', score: 1 });
    // A bare head word, and the entry tracks, name no role.
    for (const title of ['工程師', '設計師', '專員', '經理', '顧問', '分析師', '資深工程師', '研發工程師', '儲備幹部', '工讀生', '實習生', '2027屆儲備幹部']) expect(bestTaxonomyMatch(title), title).toBeNull();
    // A Chinese title ends on its role in either script: the phrase before another role's phrase is its modifier.
    expect(bestTaxonomyMatch('資料分析產品經理')?.id).toBe('product_manager');
    expect(bestTaxonomyMatch('保險業務員')?.id).toBe('insurance_agent');
    expect(bestTaxonomyMatch('律師助理')?.id).toBe('paralegal');
  });

  it('JT-4: Taiwan wording does not leak into mainland matching, and the two scripts of one role agree', () => {
    // Mainland titles read exactly as before.
    expect(bestTaxonomyMatch('高级后端开发工程师')).toMatchObject({ id: 'backend_engineer', score: 1 });
    expect(bestTaxonomyMatch('软件工程师')).toMatchObject({ id: 'software_engineer', score: 0.85 });
    // 電工 inside an engineer's title is not an electrician: the Taiwan phrases do not hold the bare word.
    for (const title of ['光電工程師', '弱電工程師']) expect(bestTaxonomyMatch(title)?.id ?? null, title).not.toBe('electrician');
    expect(bestTaxonomyMatch('機電工程師')?.id).toBe('mep_engineer');
    expect(bestTaxonomyMatch('水電工')?.id).toBe('electrician');
    // A two-character abbreviation that hides inside other titles is not a phrase (理專 in 管理專員).
    expect(bestTaxonomyMatch('管理專員')?.id ?? null).not.toBe('financial_advisor');
    // Every role is found by its own Taiwan label, and by each of its Taiwan titles.
    for (const n of TAXONOMY_NODES.filter((x) => x.level === 3)) {
      for (const text of [n.zhHant, ...(n.synonyms.zhHant ?? [])]) {
        const ranked = matchTitle(text, { limit: 5, minScore: 0 });
        expect(ranked[0]?.id, `${n.id}: ${text}`).toBe(n.id);
      }
    }
  });

  it('JT-4: the typeahead finds a role by its Taiwan label and shows it in zh-TW', () => {
    expect(searchTaxonomy('軟體工程師', { locale: 'zh-TW', levels: [3] })[0]).toMatchObject({ id: 'software_engineer', label: '軟體工程師', context: '後端與平台 · 軟體工程' });
    expect(searchTaxonomy('行銷', { locale: 'zh-TW', levels: [3], limit: 30 }).map((s) => s.id)).toEqual(expect.arrayContaining(['marketing_manager', 'marketing_specialist']));
    expect(searchTaxonomy('韌體', { locale: 'zh-TW' })[0]).toMatchObject({ id: 'embedded_software_engineer', label: '韌體工程師' });
    // The same role in the other two languages.
    expect(searchTaxonomy('软件工程师', { locale: 'zh', levels: [3] })[0]).toMatchObject({ id: 'software_engineer', label: '软件工程师' });
    expect(searchTaxonomy('software engineer', { locale: 'en', levels: [3] })[0]).toMatchObject({ id: 'software_engineer', label: 'Software engineer' });
    for (const s of searchTaxonomy('工程師', { locale: 'zh-TW', limit: 50 })) expect(s.label, s.id).toMatch(/[㐀-鿿]|^[A-Za-z]/);
  });

  it('an English phrase in a mixed-language title needs its whole words', () => {
    // "cto" is inside "director"; that is not a chief technology officer.
    expect(matchTitle('Art Director 艺术总监', { limit: 5, minScore: 0 }).map((m) => m.id)).not.toContain('engineering_director');
    expect(bestTaxonomyMatch('CTO 首席技术官')?.id).toBe('engineering_director');
    expect(bestTaxonomyMatch('QC工程师')?.id).toBe('quality_inspector');
    expect(bestTaxonomyMatch('Senior Backend Engineer 高级后端')?.id).toBe('backend_engineer');
  });

  it('a closing Chinese head word after Latin words reads as its English head noun, in either script', () => {
    expect(bestTaxonomyMatch('Machine Learning 工程師')?.id).toBe('ml_engineer');
    expect(bestTaxonomyMatch('Machine Learning 工程师')?.id).toBe('ml_engineer');
    expect(bestTaxonomyMatch('Marketing 專員')?.id).toBe('marketing_specialist');
    expect(bestTaxonomyMatch('Java 后端 Architect')?.id).toBe('software_architect');
    expect(bestTaxonomyMatch('產品經理 Product Manager')?.id).toBe('product_manager');
  });
});

describe('SM-2: a phrase that needs a level word gives the lexicon nothing', () => {
  // "lead software engineer" is a tech-lead synonym. Its modifier without the level word is
  // "software", the catch-all role's own word: it must not turn every software engineer into a lead.
  it.each([
    'Software Engineer, Payments',
    'Software Engineer - Growth',
    'Associate Software Engineer',
    'Junior Software Engineer, Billing',
    'Software Engineer Intern, Summer 2027',
    'Graduate Software Engineer 2027',
    'Software Engineer - C++',
    'Software Engineer',
    'Senior Software Engineer',
  ])('%s is a software engineer, not a tech lead', (title) => {
    const matches = matchTitle(title, { limit: 5 });
    expect(matches[0]?.id).toBe('software_engineer');
    expect(matches.map((m) => m.id)).not.toContain('tech_lead');
  });

  it('still names the tech lead by its whole phrase', () => {
    expect(matchTitle('Lead Software Engineer', { limit: 1 })[0]).toMatchObject({ id: 'tech_lead', score: 1 });
    expect(bestTaxonomyMatch('Lead Software Engineer, Payments')?.id).toBe('tech_lead');
  });

  it.each([
    ['Smart Home Engineer', 'blockchain_engineer'], // "smart contract engineer"
    ['Power Generation Specialist', 'sdr'], // "lead generation specialist"
    ['Data Specialist', 'data_entry_clerk'], // "data entry specialist"
    ['Tech Stack Engineer', 'fullstack_engineer'], // "full stack engineer"
  ])('%s is not filed under %s by half a phrase', (title, wrong) => {
    expect(matchTitle(title, { limit: 10, minScore: 0 }).map((m) => m.id)).not.toContain(wrong);
  });

  it('keeps those roles for the titles that carry the whole phrase', () => {
    expect(bestTaxonomyMatch('Smart Contract Engineer - DeFi')?.id).toBe('blockchain_engineer');
    expect(bestTaxonomyMatch('Lead Generation Specialist (EMEA)')?.id).toBe('sdr');
    expect(bestTaxonomyMatch('Data Entry Specialist II')?.id).toBe('data_entry_clerk');
    expect(bestTaxonomyMatch('Full Stack Engineer, Payments')?.id).toBe('fullstack_engineer');
  });

  // The general statement: no other role's lexicon entry has the same words as a catch-all role's phrase.
  const genericPhrases = TAXONOMY_NODES.filter((n) => n.level === 3 && n.generic).flatMap((n) =>
    [n.en, n.zh, ...n.synonyms.en, ...n.synonyms.zh].map((phrase) => [n.id, phrase] as const),
  );

  it('has catch-all roles to check', () => {
    expect(genericPhrases.length).toBeGreaterThan(10);
  });

  it.each(genericPhrases)('%s: "%s" names it alone, first whatever the id order, and beside an unknown word', (id, phrase) => {
    const alone = matchTitle(phrase, { limit: 3 });
    expect(alone[0]?.id).toBe(id);
    // Nothing shares the top score: the answer does not rest on the alphabetical order of two ids.
    expect(alone[1]?.score ?? 0).toBeLessThan(alone[0]!.score);
    for (const title of [`${phrase} zzqx`, `zzqx ${phrase}`]) {
      const best = bestTaxonomyMatch(title);
      // A head noun or an ambiguous word says nothing inside a longer title; any other phrase still names its own role.
      if (best) expect(best.id, title).toBe(id);
    }
  });

  it('lets a role phrase found in the title win a tie with a lexicon pick', () => {
    // "Software Developer": the catch-all phrase (1 - 0.15) and the lexicon pick of the same role tie at 0.85;
    // the answer names the phrase, not the lexicon's "<modifiers> <head noun>" form.
    expect(matchTitle('Software Developer', { limit: 1 })[0]).toEqual({ id: 'software_engineer', level: 3, score: 0.85, matched: 'software developer' });
  });
});

describe('Chinese titles end on the role: words that name a function only as the whole title', () => {
  it.each([
    ['行政司机', 'driver'],
    ['行政前台', 'receptionist'],
    ['新媒体销售', 'account_executive'],
    ['新媒体主播', 'content_creator'],
    ['常年法律顾问销售', 'account_executive'],
    ['数据分析产品经理', 'product_manager'],
  ])('%s → %s (the earlier phrase is a modifier)', (title, id) => {
    expect(bestTaxonomyMatch(title)?.id).toBe(id);
  });

  it.each(['行政总厨', '行政主厨', '客户服务工程师', '物流运营专员', '门店运营专员', '人事财务'])('%s stays unknown rather than being filed by one word', (title) => {
    expect(bestTaxonomyMatch(title)).toBeNull();
  });

  it.each([
    ['行政', 'administrative_assistant'],
    ['人事', 'hr_generalist'],
    ['新媒体', 'social_media_manager'],
    ['客户服务', 'customer_service_rep'],
    ['运营专员', 'product_operations'],
    ['运营助理', 'product_operations'],
    ['高级运营专员', 'product_operations'],
  ])('%s alone is %s, at a score enrichment may overrule', (title, id) => {
    const m = bestTaxonomyMatch(title);
    expect(m).toMatchObject({ id, score: MODIFIER_MATCH_SCORE });
    expect(m!.score).toBeLessThan(TITLE_MATCH_TRUSTED);
    expect(Object.hasOwn(ALONE_ONLY_PHRASES, title.replace('高级', ''))).toBe(true);
  });

  it.each([
    ['行政专员', 'administrative_assistant'],
    ['行政助理', 'administrative_assistant'],
    ['行政经理', 'office_manager'],
    ['行政总监', 'office_manager'],
    ['人事专员', 'hr_generalist'],
    ['人事经理', 'hr_manager'],
    ['新媒体运营', 'social_media_manager'],
    ['新媒体运营专员', 'social_media_manager'],
    ['新媒体编辑', 'editor'],
    ['客服代表', 'customer_service_rep'],
    ['客户服务专员', 'customer_service_rep'],
    ['客户服务经理', 'customer_service_manager'],
    ['产品运营专员', 'product_operations'],
    ['电商运营专员', 'ecommerce_manager'],
    ['法律顾问', 'in_house_counsel'],
  ])('the full form %s still names %s outright', (title, id) => {
    expect(matchTitle(title, { limit: 1 })[0]).toMatchObject({ id, score: 1 });
  });

  it('keeps a phrase that nothing follows, and one a level word or a head word follows', () => {
    expect(bestTaxonomyMatch('企业法律顾问')?.id).toBe('in_house_counsel');
    expect(bestTaxonomyMatch('法律顾问助理')?.id).toBe('in_house_counsel');
    expect(bestTaxonomyMatch('销售经理')?.id).toBe('sales_manager');
  });

  it('never lets the catch-all 开发工程师 displace the words before it', () => {
    expect(matchTitle('Java开发工程师', { limit: 1 })[0]).toMatchObject({ id: 'backend_engineer', score: 1 });
    expect(bestTaxonomyMatch('算法开发工程师')?.id).toBe('ml_engineer');
    expect(bestTaxonomyMatch('数据开发工程师')?.id).toBe('data_engineer');
  });
});

describe('开发工程师 inside a longer title is a weak software vote; 研发工程师 is not', () => {
  it.each(['系统开发工程师', '中间件开发工程师', 'ERP开发工程师', '音视频开发工程师', '爬虫开发工程师', '高级系统开发工程师（上海）'])('%s → software_engineer, under the trusted score', (title) => {
    const m = bestTaxonomyMatch(title);
    expect(m?.id).toBe('software_engineer');
    expect(m!.score).toBeGreaterThanOrEqual(0.6);
    expect(m!.score).toBeLessThan(TITLE_MATCH_TRUSTED);
  });

  it('gives way to a specific role named in the title', () => {
    expect(matchTitle('硬件开发工程师', { limit: 1 })[0]).toMatchObject({ id: 'hardware_engineer', score: 1 });
    expect(matchTitle('前端开发工程师', { limit: 1 })[0]).toMatchObject({ id: 'frontend_engineer', score: 1 });
    expect(matchTitle('嵌入式开发工程师', { limit: 1 })[0]).toMatchObject({ id: 'embedded_software_engineer', score: 1 });
    expect(bestTaxonomyMatch('机械开发工程师')?.id).toBe('mechanical_engineer');
  });

  it('never reaches a title that has no 开发 in it', () => {
    for (const title of ['机械工程师', '土木工程师', '质量工程师', '销售工程师', '工程师']) {
      expect(matchTitle(title, { limit: 20, minScore: 0 }).map((m) => m.id), title).not.toContain('software_engineer');
    }
  });

  it('keeps 研发工程师 for the whole title only: an R&D engineer of any discipline', () => {
    expect(bestTaxonomyMatch('研发工程师')).toMatchObject({ id: 'software_engineer', score: 0.85 });
    expect(bestTaxonomyMatch('开发工程师')).toMatchObject({ id: 'software_engineer', score: 0.85 });
    for (const title of ['系统研发工程师', '光学研发工程师']) expect(bestTaxonomyMatch(title), title).toBeNull();
    expect(bestTaxonomyMatch('化工研发工程师')?.id).toBe('chemical_engineer');
    expect(bestTaxonomyMatch('前端研发工程师')?.id).toBe('frontend_engineer');
    expect(bestTaxonomyMatch('硬件研发工程师')?.id).toBe('hardware_engineer');
  });

  it('counts only words the retired one-word rule matched as retired', () => {
    // 开发工程师 still votes, so a stored software role beside it is not a leftover of a retired rule.
    expect(oneWordRolesIn('系统开发工程师')).toEqual([]);
    expect(oneWordRolesIn('系统研发工程师')).toEqual(['software_engineer']);
    // Words that became role names with SM-2 never filed a longer title.
    expect(oneWordRolesIn('新媒体设计')).toEqual([]);
    expect(oneWordRolesIn('行政总厨')).toEqual([]);
    expect(oneWordRolesIn('物流运营专员')).toEqual([]);
    expect(oneWordRolesIn('FE Analysis Engineer')).toEqual([]);
    expect(oneWordRolesIn('Principal Engineer')).toEqual(['education_administrator']);
  });
});

describe('matchTitle', () => {
  const cases: [string, string][] = [
    ['Senior Software Engineer, Backend', 'backend_engineer'],
    ['Backend Developer (Go)', 'backend_engineer'],
    ['Staff Frontend Engineer', 'frontend_engineer'],
    ['React Developer', 'frontend_engineer'],
    ['Software Engineer II', 'software_engineer'],
    ['SDE', 'software_engineer'],
    ['iOS Developer', 'ios_engineer'],
    ['Machine Learning Engineer, Ads', 'ml_engineer'],
    ['LLM Engineer', 'nlp_engineer'],
    ['Senior Data Scientist', 'data_scientist'],
    ['Data Analyst Intern', 'data_analyst'],
    ['Site Reliability Engineer', 'sre'],
    ['Product Manager, Growth', 'product_manager'],
    ['Associate Product Manager', 'product_manager'],
    ['Technical Program Manager', 'program_manager'],
    ['UX/UI Designer', 'product_designer'],
    ['Account Executive, Mid-Market', 'account_executive'],
    ['Customer Success Manager', 'customer_success_manager'],
    ['Staff Accountant', 'accountant'],
    ['Registered Nurse - ICU', 'registered_nurse'],
    ['Technical Recruiter', 'recruiter'],
    ['Paralegal', 'paralegal'],
    ['Warehouse Associate', 'warehouse_manager'],
    ['Line Cook', 'chef'],
    ['Java后端开发工程师（2027届校招）', 'backend_engineer'],
    ['高级前端开发工程师', 'frontend_engineer'],
    ['大模型算法工程师', 'nlp_engineer'],
    ['产品经理（实习）', 'product_manager'],
    ['数据分析师', 'data_analyst'],
    ['新媒体运营', 'social_media_manager'],
    ['会计', 'accountant'],
    ['小红书运营专员', 'social_media_manager'],
    ['数字IC设计工程师', 'chip_design_engineer'],
    ['外贸业务员', 'import_export'],
  ];
  it.each(cases)('%s → %s', (title, id) => {
    expect(bestTaxonomyMatch(title)?.id).toBe(id);
  });

  it('prefers a specific role to the generic one', () => {
    const [first, second] = matchTitle('Software Engineer, Backend', { limit: 2 });
    expect(first.id).toBe('backend_engineer');
    expect(second?.id).toBe('software_engineer');
    expect(first.score).toBeGreaterThan(second!.score);
  });

  it('returns nothing rather than a weak guess', () => {
    expect(bestTaxonomyMatch('Wizard of Light Bulb Moments')).toBeNull();
    expect(bestTaxonomyMatch('')).toBeNull();
    expect(matchTitle('!!!')).toEqual([]);
  });

  it('is deterministic, and a caller cannot change a later answer by editing the one it got', () => {
    const first = matchTitle('Senior Data Engineer');
    expect(first).toEqual(matchTitle('Senior Data Engineer'));
    first[0]!.id = 'edited';
    first.length = 0;
    expect(matchTitle('Senior Data Engineer')[0]).toMatchObject({ id: 'data_engineer', level: 3, matched: 'data engineer' });
  });

  it('keeps its signature: ranked matches with id, level, score and the phrase that matched', () => {
    expect(matchTitle('Backend Developer (Go)', { limit: 1 })).toEqual([{ id: 'backend_engineer', level: 3, score: 1, matched: 'backend developer' }]);
    expect(matchTitle('Backend Developer', { limit: 2, minScore: 0.99 })).toHaveLength(1);
  });
});

describe('searchTaxonomy (typeahead)', () => {
  it('needs two Latin characters or one Chinese character', () => {
    expect(searchTaxonomy('d')).toEqual([]);
    expect(searchTaxonomy('数').length).toBeGreaterThan(0);
  });

  it('ranks an exact label first and adds the group and category as context', () => {
    const [first] = searchTaxonomy('data scientist');
    expect(first).toMatchObject({ id: 'data_scientist', level: 3, label: 'Data scientist', context: 'Data science and analytics · Data and AI' });
  });

  it('finds roles by synonym prefix and filters by level', () => {
    expect(searchTaxonomy('swe').map((s) => s.id)).toContain('software_engineer');
    const cats = searchTaxonomy('data', { levels: [1] });
    expect(cats.map((s) => s.id)).toEqual(['data_ai']);
  });

  it('returns Chinese labels for zh', () => {
    const [first] = searchTaxonomy('产品经理', { locale: 'zh' });
    expect(first).toMatchObject({ id: 'product_manager', label: '产品经理', context: '产品管理 · 产品与项目管理' });
  });

  it('GoApply (zh) is not answered from the Taiwan vocabulary; every other locale is', () => {
    // The lists the Simplified typeahead gave before the Taiwan titles existed (commit 48a5e56). A Taiwan
    // title written with characters both scripts share (主管秘書, 助理教授) must not reorder them.
    expect(searchTaxonomy('主管', { locale: 'zh' }).map((s) => s.id)).toEqual([
      'customer_service_manager', 'design_manager', 'education_administrator', 'engineering_manager', 'finance_leader',
      'it_manager', 'marketing_manager', 'office_manager', 'product_manager', 'production_supervisor',
    ]);
    expect(searchTaxonomy('助理', { locale: 'zh' }).map((s) => s.id)).toEqual([
      'administrative_assistant', 'bookkeeper', 'executive_assistant', 'hr_generalist', 'investment_analyst',
      'marketing_specialist', 'paralegal', 'product_manager', 'product_operations', 'project_manager',
    ]);
    expect(searchTaxonomy('房', { locale: 'zh' }).map((s) => s.id)).toEqual(['real_estate_agent']);
    expect(searchTaxonomy('主管秘書', { locale: 'zh' })).toEqual([]);
    expect(searchTaxonomy('助理教授', { locale: 'zh' }).map((s) => s.id)).not.toContain('professor');
    // A text both vocabularies write the same way stays in the Simplified one.
    expect(searchTaxonomy('研究助理', { locale: 'zh' }).map((s) => s.id)).toEqual(['research_assistant']);
    // Nothing shown to GoApply is Traditional, whatever was typed.
    for (const q of ['主管', '助理', '工程', '经理', '設計']) {
      for (const hit of searchTaxonomy(q, { locale: 'zh', limit: 50 })) expect(TAXONOMY_NODES.find((n) => n.id === hit.id)!.zh, `${q}: ${hit.id}`).toBe(hit.label);
    }
    // Taiwan, and every other locale, still searches the Taiwan titles.
    expect(searchTaxonomy('主管秘書', { locale: 'zh-TW' }).map((s) => s.id)).toEqual(['executive_assistant']);
    expect(searchTaxonomy('助理教授', { locale: 'zh-TW' }).map((s) => s.id)).toContain('professor');
    expect(searchTaxonomy('主管秘書', { locale: 'en' }).map((s) => s.id)).toEqual(['executive_assistant']);
    expect(searchTaxonomy('主管秘書').map((s) => s.id)).toEqual(['executive_assistant']);
  });
});

describe('服务员 names restaurant staff only as the whole title (JT-2: care workers are not servers)', () => {
  /** What ingest does with a title: as written, then folded to its mainland reading; the better of the two. */
  const role = (title: string): string | null => {
    const raw = bestTaxonomyMatch(title);
    const folded = bestTaxonomyMatch(foldTwToCn(title));
    return (folded && (!raw || folded.score > raw.score) ? folded : raw)?.id ?? null;
  };

  it.each(['照顧服務員', '居家照顧服務員', '長照服務員', '機構照顧服務員', '加油站服務員', '停車場服務員', '客房服務員', '門市服務員', '照顾服务员', '客房服务员', '加油站服务员'])(
    '%s is not filed under restaurant staff',
    (title) => {
      expect(bestTaxonomyMatch(title)).toBeNull();
      expect(bestTaxonomyMatch(foldTwToCn(title))).toBeNull();
      expect(role(title)).toBeNull();
    },
  );

  it.each(['餐廳服務生', '服務生', '餐厅服务员', '餐廳服務員', '日式餐廳服務員', '餐飲服務員', '外場服務人員', '咖啡師', '服务员', '服務員', '資深服務員'])('%s is restaurant staff', (title) => {
    expect(role(title)).toBe('server');
  });

  it('the bare word is an ambiguous one: its role, under the trusted score, so enrichment may overrule it', () => {
    expect(Object.hasOwn(ALONE_ONLY_PHRASES, '服务员')).toBe(true);
    expect(bestTaxonomyMatch('服务员')).toMatchObject({ id: 'server', score: MODIFIER_MATCH_SCORE });
    expect(MODIFIER_MATCH_SCORE).toBeLessThan(TITLE_MATCH_TRUSTED);
    // The label keeps naming the role outright.
    expect(bestTaxonomyMatch('餐厅服务员')).toMatchObject({ id: 'server', score: 1 });
    // A row that holds `server` only through the retired suffix rule is recognisable as such.
    expect(oneWordRolesIn('照顾服务员')).toEqual(['server']);
    expect(oneWordRolesIn('服务员')).toEqual([]);
  });
});
