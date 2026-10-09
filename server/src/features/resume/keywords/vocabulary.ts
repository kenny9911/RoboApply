// server/src/features/resume/keywords/vocabulary.ts
//
// A small public vocabulary of hard skills, used by the keyword report only
// when a job has no stored keyword extraction or skills list (a pasted
// posting). Plain, widely used tool and method names; no proprietary list.

export const HARD_SKILLS_EN: readonly string[] = [
  // languages
  'python', 'java', 'javascript', 'typescript', 'golang', 'rust', 'c++', 'c#', 'ruby', 'php', 'kotlin', 'swift', 'scala', 'matlab', 'sql', 'bash',
  // web and app
  'react', 'next.js', 'vue', 'angular', 'node.js', 'django', 'flask', 'fastapi', 'spring boot', 'ruby on rails', 'graphql', 'rest api', 'html', 'css', 'tailwind',
  'ios', 'android', 'react native', 'flutter',
  // data
  'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'kafka', 'spark', 'hadoop', 'airflow', 'dbt', 'snowflake', 'bigquery', 'redshift',
  'pandas', 'numpy', 'scikit-learn', 'pytorch', 'tensorflow', 'machine learning', 'deep learning', 'nlp', 'computer vision', 'statistics',
  'a/b testing', 'data analysis', 'data visualization', 'etl', 'excel', 'tableau', 'power bi', 'looker',
  // infra
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'ci/cd', 'linux', 'git', 'microservices',
  // product, design, business
  'figma', 'sketch', 'user research', 'prototyping', 'product management', 'roadmapping', 'agile', 'scrum', 'jira',
  'seo', 'sem', 'google analytics', 'salesforce', 'hubspot', 'crm', 'financial modeling', 'accounting', 'budgeting', 'forecasting',
  'project management', 'stakeholder management', 'copywriting', 'content strategy', 'customer success', 'sales',
];

export const HARD_SKILLS_CN: readonly string[] = [
  '数据分析', '数据挖掘', '机器学习', '深度学习', '自然语言处理', '计算机视觉', '算法', '前端开发', '后端开发', '测试', '运维',
  '产品设计', '需求分析', '用户研究', '交互设计', '视觉设计', '原型设计', '项目管理', '市场营销', '新媒体运营', '内容运营', '用户运营',
  '活动策划', '财务分析', '审计', '会计', '法务', '人力资源', '招聘', '销售', '客户管理', '供应链', '采购', '英语',
];

/** Acronyms that are not skills (stop list for the posting fallback). */
export const ACRONYM_STOPLIST: ReadonlySet<string> = new Set([
  'USA', 'US', 'UK', 'EU', 'EEO', 'EOE', 'USD', 'CEO', 'CTO', 'CFO', 'HR', 'PTO', 'FAQ', 'LLC', 'INC', 'LTD', 'OR', 'AND', 'THE', 'WE', 'YOU', 'NA', 'TBD', 'ETC',
]);
