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
  // analysis and data tools
  'sas', 'spss', 'stata', 'vba', 'power query', 'databricks', 'clickhouse', 'hive', 'flink', 'presto', 'trino', 'dynamodb', 'cassandra', 'sql server',
  'mlflow', 'sagemaker', 'langchain', 'prompt engineering', 'llm', 'opencv',
  // engineering tools
  'jenkins', 'github actions', 'gitlab', 'ansible', 'prometheus', 'grafana', 'datadog', 'splunk', 'nginx', 'rabbitmq',
  'selenium', 'cypress', 'playwright', 'jest', 'pytest', 'junit', 'postman', 'api', 'unity', 'unreal engine',
  // business tools and methods
  'sap', 'netsuite', 'quickbooks', 'erp', 'gaap', 'hipaa', 'six sigma', 'kpi', 'okr', 'saas', 'b2b',
  'zendesk', 'intercom', 'shopify', 'wordpress', 'photoshop', 'illustrator', 'indesign', 'after effects', 'autocad', 'solidworks', 'revit',
];

export const HARD_SKILLS_CN: readonly string[] = [
  '数据分析', '数据挖掘', '机器学习', '深度学习', '自然语言处理', '计算机视觉', '算法', '前端开发', '后端开发', '测试', '运维',
  '产品设计', '需求分析', '用户研究', '交互设计', '视觉设计', '原型设计', '项目管理', '市场营销', '新媒体运营', '内容运营', '用户运营',
  '活动策划', '财务分析', '审计', '会计', '法务', '人力资源', '招聘', '销售', '客户管理', '供应链', '采购', '英语',
  '数据可视化', '数据库', '数据仓库', '大数据', '数据结构', '操作系统', '计算机网络', '嵌入式', '单片机', '电路设计', '机械设计',
  '财务报表', '税务', '跨境电商', '直播运营', '社群运营', '文案', '平面设计', '视频剪辑', '客户服务', '商务拓展', '品牌营销', '日语', '韩语',
];

/**
 * Words that are never a skill, whatever list they arrive in: pay and benefit
 * words, verbs of degree ("了解", "熟悉"), fillers. A safety net for job skill
 * lists and stored keyword rows; the main rule is in keywordReport.ts (only
 * extracted skills and vocabulary terms count).
 */
export const NON_SKILL_TERMS: ReadonlySet<string> = new Set([
  'paid', 'pay', 'salary', 'bonus', 'benefits', 'benefit', 'status', 'curiosity', 'curious', 'fraudulent', 'fraud', 'passion', 'passionate',
  'team', 'teams', 'work', 'job', 'role', 'company', 'candidate', 'candidates', 'experience', 'years', 'year', 'degree', 'required', 'preferred',
  'remote', 'hybrid', 'onsite', 'full-time', 'part-time', 'equal', 'opportunity', 'employer', 'insurance', 'vacation', 'holiday', 'holidays',
  'location', 'office', 'apply', 'application', 'position', 'responsibilities', 'requirements', 'qualifications', 'skills', 'ability', 'strong',
  '了解', '熟悉', '掌握', '精通', '协作', '常用', '专业', '一种', '负责', '优先', '能力', '经验', '以上', '相关', '具备', '良好', '工作', '岗位', '职位',
  '公司', '团队', '薪资', '福利', '五险一金', '双休', '包括', '以及', '进行', '完成', '参与', '学历', '本科', '硕士', '要求', '任职', '职责',
]);

/**
 * Vocabulary terms that are also everyday words of a posting: "our sales and
 * accounting teams", "public API docs", "本次招聘 3 人", "配合销售团队和测试团队".
 * Found in the text alone they say nothing about what the job asks for, so
 * they count only when the job's own skill list, a required-skill row or the
 * job title names them (keywordReport.ts).
 */
export const EVERYDAY_TERMS: ReadonlySet<string> = new Set([
  'sales', 'accounting', 'api', 'statistics', 'budgeting', 'forecasting', 'agile', 'saas', 'b2b', 'ios', 'android', 'customer success',
  '招聘', '销售', '测试', '运维', '采购', '法务', '人力资源', '会计', '审计', '文案', '客户服务',
]);

/**
 * Tool names that are also ordinary English words ("values unity", "sketch out
 * ideas", "excel at", "spark interest"). From the text alone they count only
 * when the posting writes them as a name: capitalised, and not merely because
 * a sentence starts there.
 */
export const WORD_LIKE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'unity', 'sketch', 'swift', 'rust', 'spark', 'hive', 'presto', 'jest', 'flask', 'excel', 'cypress', 'postman', 'looker', 'intercom', 'illustrator',
]);

/** Acronyms that are not skills (stop list for the posting fallback). */
export const ACRONYM_STOPLIST: ReadonlySet<string> = new Set([
  'USA', 'US', 'UK', 'EU', 'EEO', 'EOE', 'USD', 'CEO', 'CTO', 'CFO', 'HR', 'PTO', 'FAQ', 'LLC', 'INC', 'LTD', 'OR', 'AND', 'THE', 'WE', 'YOU', 'NA', 'TBD', 'ETC',
]);
