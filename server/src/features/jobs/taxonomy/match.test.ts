// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bestTaxonomyMatch, matchTitle, normalizeTitle, searchTaxonomy, stripLevelWords } from './match.js';
import { taxonomyAncestors } from './taxonomy.js';

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
  });
});

describe('FIX-3: "architect" beside software words is a software architect, not Design', () => {
  const category = (title: string) => {
    const m = bestTaxonomyMatch(title);
    return m ? [m.id, taxonomyAncestors(m.id).find((n) => n.level === 1)!.id] : null;
  };

  it.each([
    // The titles Explore listed under "Design".
    'Lead AI Architect',
    'Full Stack Architect with AI',
    'Java Backend Architect',
    'Principal Architect - Machine Learning',
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

  it.each(['Architect', 'Senior Architect', 'Project Architect', 'Landscape Architect', 'Licensed Architect - Healthcare', 'Architectural Designer', 'Interior Architect', 'Project Architect, Data Centers', '建筑师'])(
    'the building profession stays in Design: %s',
    (title) => {
      expect(category(title)?.[1]).toBe('design');
    },
  );

  it('no title with a software word lands in the building role', () => {
    for (const title of ['AI Architect', 'ML Architect', 'Backend Architect', 'Cloud Architect', 'Systems Architect', 'Application Architect', 'Technical Architect', 'Network Architect', 'Database Architect', '软件架构师', '架构师']) {
      expect(bestTaxonomyMatch(title)?.id, title).not.toBe('architect');
    }
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

  it('is deterministic', () => {
    expect(matchTitle('Senior Data Engineer')).toEqual(matchTitle('Senior Data Engineer'));
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
});
