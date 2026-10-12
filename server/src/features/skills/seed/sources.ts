// server/src/features/skills/seed/sources.ts
//
// What the seed generator (build.ts) adds to the tables the repository already
// has (features/match/terms.ts SHOWN_BY, EVERYDAY_WORDS and displayTerm;
// features/search/skills.ts SKILL_ALIASES): ids and labels for the broader
// terms, which spellings are one tool, further well-known tool names, the
// soft skills and the certificates postings name.
//
// Rules (D3; MATCH 4.6):
//   · Tool names and their spellings are public common knowledge. Nothing
//     here is data about jobs, and no ESCO or O*NET identifier is typed here:
//     `attach-ids` sets them from files the owner supplies.
//   · A Chinese label is given only where the standard term is certain;
//     otherwise it is absent and the English label is shown. A Traditional
//     label is never derived from a Simplified one by a table.
//   · A parent is a broader skill the narrower one is evidence for. Only
//     edges that terms.ts already has, or that the two names state
//     themselves (deep learning → machine learning, Spring Boot → Spring).

import type { SkillKind } from '../types.js';

export interface Curated {
  /** Default: the slug of the first name. */
  id?: string;
  /** The first name is the usual one; the others are aliases. Lower case, as terms.ts writes them. */
  names: string[];
  /** Default: `displayTerm(names[0])`. */
  labelEn?: string;
  labelZh?: string;
  labelZhHant?: string;
  /** More names, in any script. */
  aliases?: string[];
  parent?: string;
  kind?: SkillKind;
}

export interface CuratedGeneral extends Omit<Curated, 'names'> {
  id: string;
  /** Terms of the row that are a skill of their own, broader than this one (linux → unix). */
  own?: Record<string, { id: string; labelEn: string }>;
}

/**
 * One entry per row of terms.ts SHOWN_BY, keyed by the row's first broader
 * term. Every other broader term of the row becomes an alias, unless a named
 * tool already has that key ("rest apis": the tool wins, see build.ts).
 */
export const GENERAL_SKILLS: Readonly<Record<string, CuratedGeneral>> = {
  'cloud infrastructure': { id: 'cloud_infrastructure', labelZh: '云基础设施', aliases: ['云计算', '雲端運算', '云平台', '云服务'] },
  'relational databases': { id: 'relational_databases', labelZh: '关系型数据库', labelZhHant: '關聯式資料庫', aliases: ['关系数据库', '資料庫'] },
  // SQL is itself evidence of relational databases ("sql databases" is one of that row's terms).
  sql: { id: 'sql', parent: 'relational_databases' },
  nosql: { id: 'nosql' },
  'api design': { id: 'api_design', labelEn: 'API design', labelZh: 'API 设计', labelZhHant: 'API 設計' },
  'version control': { id: 'version_control', labelZh: '版本控制', labelZhHant: '版本控制' },
  'ci/cd': { id: 'ci_cd', aliases: ['持续集成', '持续交付', '持续部署', '持續整合', '持續交付', '持續部署'] },
  containers: { id: 'containers', labelZh: '容器技术', labelZhHant: '容器技術', aliases: ['容器化', '容器编排', '容器編排'] },
  'infrastructure as code': { id: 'infrastructure_as_code', labelZh: '基础设施即代码' },
  'frontend frameworks': { id: 'frontend_frameworks', labelZh: '前端框架', labelZhHant: '前端框架' },
  'machine learning frameworks': {
    id: 'machine_learning_frameworks',
    labelZh: '机器学习框架',
    labelZhHant: '機器學習框架',
    aliases: ['深度学习框架', '深度學習框架'],
    parent: 'machine_learning',
  },
  'message queues': { id: 'message_queues', labelZh: '消息队列', labelZhHant: '訊息佇列' },
  // The row holds unit, automated and end-to-end testing tools; "Automated testing" names all of it.
  'unit testing': { id: 'automated_testing', labelEn: 'Automated testing', labelZh: '自动化测试', labelZhHant: '自動化測試', aliases: ['单元测试', '單元測試'] },
  'data visualization': { id: 'data_visualization', labelZh: '数据可视化', labelZhHant: '資料視覺化' },
  'design tools': { id: 'design_tools', labelZh: '设计工具', labelZhHant: '設計工具' },
  spreadsheets: { id: 'spreadsheets', labelZh: '电子表格', labelZhHant: '試算表' },
  'object-oriented programming': { id: 'object_oriented_programming', labelZh: '面向对象编程', labelZhHant: '物件導向程式設計' },
  scripting: { id: 'scripting', labelZh: '脚本语言' },
  // The row treats Linux and Unix as one broader term. They are two skills: a Linux distribution shows Linux, and Linux shows Unix.
  linux: { id: 'linux', parent: 'unix', own: { unix: { id: 'unix', labelEn: 'Unix' } } },
  agile: { id: 'agile', labelZh: '敏捷开发', labelZhHant: '敏捷開發' },
};

/**
 * A named tool that two rows of SHOWN_BY list, where neither broader skill is
 * above the other. RASkill has one parent per skill, so one edge is kept and
 * the other is listed in SEED_UNREPRESENTED_PAIRS (the seed test checks both).
 */
export const PARENT_CHOICE: Readonly<Record<string, string>> = {
  // An AWS service and an infrastructure-as-code tool. A resume that names CloudFormation nearly always names AWS itself.
  cloudformation: 'infrastructure_as_code',
};

/**
 * Named tools of SHOWN_BY whose spellings are one skill, or whose label
 * `displayTerm` does not know. A tool of SHOWN_BY that is not here becomes a
 * skill of its own: id = slug, label = `displayTerm`.
 */
export const SPECIFIC_SKILLS: readonly Curated[] = [
  { names: ['aws', 'amazon web services'] },
  { id: 'google_cloud', names: ['google cloud', 'gcp', 'google cloud platform'], labelEn: 'Google Cloud' },
  { names: ['azure', 'microsoft azure'] },
  { id: 'aws_lambda', names: ['aws lambda', 'lambda'], labelEn: 'AWS Lambda' },
  { id: 'alibaba_cloud', names: ['alibaba cloud', '阿里云'], labelEn: 'Alibaba Cloud', labelZh: '阿里云', labelZhHant: '阿里雲', aliases: ['aliyun'] },
  { id: 'tencent_cloud', names: ['腾讯云'], labelEn: 'Tencent Cloud', labelZh: '腾讯云', labelZhHant: '騰訊雲', aliases: ['tencent cloud'] },
  { names: ['postgresql', 'postgres'] },
  { names: ['sql server', 'mssql'], aliases: ['microsoft sql server'] },
  { names: ['oracle', 'oracle database', 'oracle db'] },
  { id: 'amazon_aurora', names: ['amazon aurora', 'aurora', 'aws aurora'], labelEn: 'Amazon Aurora' },
  { names: ['cockroachdb'], labelEn: 'CockroachDB' },
  { names: ['hbase'], labelEn: 'HBase' },
  { names: ['rest', 'rest api', 'rest apis', 'restful', 'restful api'] },
  { names: ['svn'], labelEn: 'SVN', aliases: ['subversion'] },
  { names: ['gitlab ci'], labelEn: 'GitLab CI' },
  { names: ['travis ci'], labelEn: 'Travis CI' },
  { names: ['argo cd', 'argocd'] },
  { names: ['teamcity'], labelEn: 'TeamCity' },
  { names: ['kubernetes', 'k8s'] },
  { names: ['openshift'], labelEn: 'OpenShift' },
  { names: ['react', 'react.js', 'reactjs'] },
  { id: 'vue', names: ['vue', 'vue.js'], labelEn: 'Vue.js' },
  { names: ['sveltekit'], labelEn: 'SvelteKit' },
  { names: ['jax'], labelEn: 'JAX' },
  { names: ['scikit-learn'], aliases: ['sklearn'] },
  { names: ['kafka'], aliases: ['apache kafka'] },
  { names: ['sqs'], labelEn: 'SQS', aliases: ['amazon sqs'] },
  { names: ['pub/sub'], labelEn: 'Pub/Sub' },
  { names: ['nats'], labelEn: 'NATS' },
  { names: ['rocketmq'], labelEn: 'RocketMQ' },
  { names: ['rspec'], labelEn: 'RSpec' },
  { names: ['adobe xd'], labelEn: 'Adobe XD' },
  { names: ['excel', 'microsoft excel'] },
  { names: ['google sheets'], labelEn: 'Google Sheets' },
  { names: ['bash', 'bash scripting', 'bash scripts'] },
  { id: 'shell', names: ['shell', 'shell scripting', 'shell scripts'], labelEn: 'Shell scripting' },
  { names: ['powershell'], labelEn: 'PowerShell' },
  { id: 'cpp', names: ['c++'] },
  { id: 'csharp', names: ['c#'] },
  { names: ['centos'], labelEn: 'CentOS' },
  { names: ['red hat', 'rhel'], labelEn: 'Red Hat' },
];

/**
 * Well-known names that SHOWN_BY does not list. Labels come from `displayTerm`
 * unless given. An abbreviation that commonly means something else in another
 * trade is left out (ELT is also English language teaching, SEM also an
 * electron microscope): a reviewer adds it with the names that tell it apart.
 */
export const EXTRA_SKILLS: readonly Curated[] = [
  // Languages and markup
  { names: ['go'] },
  { names: ['javascript'] },
  { names: ['typescript'] },
  { names: ['rust'] },
  { names: ['scala'] },
  { names: ['php'] },
  { names: ['dart'] },
  { names: ['elixir'] },
  { names: ['haskell'] },
  { names: ['matlab'] },
  { names: ['cobol'] },
  { names: ['objective-c'] },
  { names: ['c'] },
  { names: ['r'] },
  { names: ['html'] },
  { names: ['css'] },
  { names: ['sass'], aliases: ['scss'] },
  { names: ['less'] },
  { names: ['json'] },
  { names: ['xml'] },
  { names: ['yaml'] },
  { id: 'dotnet', names: ['.net', 'dotnet', '.net core', '.net framework'], labelEn: '.NET' },
  { id: 'asp_net', names: ['asp.net', 'asp.net core'], labelEn: 'ASP.NET' },
  // Frameworks and runtimes
  { id: 'nodejs', names: ['node.js'] },
  { names: ['redux'] },
  { names: ['jquery'] },
  { names: ['express', 'express.js', 'expressjs'] },
  { names: ['nestjs'] },
  { names: ['django'] },
  { names: ['flask'] },
  { names: ['fastapi'] },
  { id: 'ruby_on_rails', names: ['ruby on rails', 'rails'] },
  { names: ['spring'], aliases: ['spring framework'] },
  { names: ['spring boot'], parent: 'spring' },
  { names: ['laravel'] },
  { names: ['flutter'] },
  { names: ['ios'] },
  { names: ['android'] },
  { names: ['xcode'] },
  // Data stores and data tools
  { names: ['elasticsearch'] },
  { names: ['opensearch'] },
  { names: ['clickhouse'] },
  { names: ['bigquery'] },
  { names: ['snowflake'] },
  { names: ['redshift'], aliases: ['amazon redshift'] },
  { names: ['databricks'] },
  { names: ['hadoop'] },
  { names: ['spark'], aliases: ['apache spark'] },
  { names: ['airflow'], aliases: ['apache airflow'] },
  { names: ['dbt'] },
  { names: ['flink'], aliases: ['apache flink'] },
  { names: ['hive'], aliases: ['apache hive'] },
  { names: ['presto'] },
  { names: ['trino'] },
  { names: ['pandas'] },
  { names: ['numpy'] },
  { names: ['scipy'] },
  { names: ['opencv'] },
  { names: ['etl'] },
  // Machine learning
  { names: ['machine learning'], labelZh: '机器学习', labelZhHant: '機器學習' },
  { names: ['deep learning'], labelZh: '深度学习', labelZhHant: '深度學習', parent: 'machine_learning' },
  { names: ['artificial intelligence'], labelZh: '人工智能', labelZhHant: '人工智慧' },
  { names: ['natural language processing'], labelZh: '自然语言处理', labelZhHant: '自然語言處理' },
  { names: ['llm', 'llms', 'large language models'], aliases: ['大语言模型', '大型語言模型'] },
  { names: ['rag'], aliases: ['retrieval-augmented generation', 'retrieval augmented generation'] },
  { names: ['langchain'] },
  { names: ['hugging face'] },
  { names: ['mlops'] },
  // Protocols and security
  { names: ['oauth'], aliases: ['oauth 2.0', 'oauth2'] },
  { names: ['saml'] },
  { names: ['jwt'] },
  { names: ['sso'], aliases: ['single sign-on'] },
  { names: ['tcp/ip'] },
  { names: ['dns'] },
  { names: ['cdn'] },
  { names: ['tls'] },
  { names: ['ssl'] },
  { names: ['soap'] },
  { names: ['iam'] },
  { names: ['vpc'] },
  // Operations and tooling
  { names: ['devops'] },
  { names: ['sre'], aliases: ['site reliability engineering'] },
  { names: ['helm'] },
  { names: ['nginx'] },
  { names: ['prometheus'] },
  { names: ['grafana'] },
  { names: ['datadog'] },
  { names: ['splunk'] },
  { names: ['sentry'] },
  { names: ['new relic'] },
  { names: ['jira'] },
  { names: ['confluence'] },
  { names: ['webpack'] },
  { names: ['vite'] },
  { names: ['npm'] },
  { names: ['yarn'] },
  { names: ['maven'] },
  { names: ['gradle'] },
  { names: ['postman'] },
  { names: ['tdd'], aliases: ['test-driven development', 'test driven development'] },
  // Business and design tools
  { names: ['powerpoint'], aliases: ['microsoft powerpoint'] },
  { names: ['photoshop'], aliases: ['adobe photoshop'] },
  { names: ['illustrator'], aliases: ['adobe illustrator'] },
  { names: ['indesign'], aliases: ['adobe indesign'] },
  { names: ['salesforce'] },
  { names: ['hubspot'] },
  { names: ['sap'] },
  { names: ['workday'] },
  { names: ['zendesk'] },
  { names: ['shopify'] },
  { names: ['wordpress'] },
  { names: ['stripe'] },
  { names: ['twilio'] },
  { names: ['crm'] },
  { names: ['erp'] },
  { names: ['seo'], aliases: ['search engine optimization'] },
  // Standards and methods
  { names: ['six sigma'] },
  { names: ['gaap'] },
  { names: ['ifrs'] },
  { names: ['sox'], aliases: ['sarbanes-oxley'] },
  { names: ['gdpr'] },
  { names: ['hipaa'] },
  { names: ['pci dss'] },
  { names: ['soc 2'] },
  { names: ['iso 27001'] },
];

/** Soft skills postings list as "skills". Shown, never scored. */
export const SOFT_SKILLS: readonly Curated[] = [
  { kind: 'soft', names: ['communication', 'communication skills'], labelZh: '沟通能力', labelZhHant: '溝通能力', aliases: ['沟通', '溝通', '沟通技巧', '溝通技巧'] },
  { kind: 'soft', names: ['attention to detail', 'detail-oriented', 'detail oriented'], labelZh: '注重细节', labelZhHant: '注重細節', aliases: ['细心', '細心'] },
  { kind: 'soft', names: ['teamwork', 'team work', 'team player'], labelZh: '团队合作', labelZhHant: '團隊合作', aliases: ['团队协作', '團隊協作'] },
  { kind: 'soft', names: ['leadership', 'leadership skills'], labelZh: '领导力', labelZhHant: '領導力', aliases: ['领导能力', '領導能力'] },
  { kind: 'soft', names: ['problem solving', 'problem-solving skills'], labelZh: '解决问题的能力', labelZhHant: '解決問題的能力', aliases: ['问题解决能力', '問題解決能力', '解决问题能力'] },
  { kind: 'soft', id: 'sense_of_responsibility', names: ['sense of responsibility'], labelZh: '责任心', labelZhHant: '責任心', aliases: ['责任感', '責任感'] },
];

/**
 * Certificates postings name (strategy 2.5: first-class skills). The four
 * mainland certificates carry their own name in Traditional script too (the
 * same words, not a Taiwan credential). CPA has no Traditional label: Taiwan
 * names its own licence differently, which a Taiwan-native reviewer decides.
 * English labels of the mainland certificates are descriptions, not official
 * titles.
 */
export const CERTIFICATIONS: readonly Curated[] = [
  { kind: 'certification', names: ['cpa', 'certified public accountant'], labelZh: '注册会计师', aliases: ['註冊會計師', '注会'] },
  { kind: 'certification', names: ['cfa', 'chartered financial analyst'], labelZh: '特许金融分析师', labelZhHant: '特許財務分析師', aliases: ['特許金融分析師'] },
  { kind: 'certification', names: ['pmp', 'project management professional'] },
  {
    kind: 'certification',
    id: 'cet_6',
    names: ['cet-6', 'cet6', 'college english test band 6'],
    labelEn: 'CET-6',
    labelZh: '大学英语六级',
    labelZhHant: '大學英語六級',
    aliases: ['英语六级', '英語六級'],
  },
  {
    kind: 'certification',
    id: 'teacher_qualification_certificate',
    names: ['teacher qualification certificate'],
    labelEn: 'Teacher qualification certificate (China)',
    labelZh: '教师资格证',
    labelZhHant: '教師資格證',
    aliases: ['教师资格证书', '教師資格證書', '教资'],
  },
  {
    kind: 'certification',
    id: 'first_class_constructor',
    names: ['first-class constructor'],
    labelEn: 'First-class constructor (China)',
    labelZh: '一级建造师',
    labelZhHant: '一級建造師',
    aliases: ['一建', '一级注册建造师', '一級註冊建造師'],
  },
  {
    kind: 'certification',
    id: 'putonghua_certificate',
    names: ['putonghua proficiency certificate'],
    labelEn: 'Putonghua proficiency certificate',
    labelZh: '普通话等级证书',
    labelZhHant: '普通話等級證書',
    aliases: ['普通话水平测试等级证书', '普通話水平測試等級證書', '普通话证书', '普通话水平测试', '普通話水平測試'],
  },
];

/**
 * The typeahead's alias table, character for character the SKILL_ALIASES of
 * features/search/skills.ts (alias → the usual spelling). It is a copy
 * because an area may import another area only through its index.ts
 * (features/boundary.test.ts) and features/search/index.ts does not export
 * the table. seed.test.ts reads the original and fails when the two differ,
 * so one cannot be edited without the other.
 */
export const TYPEAHEAD_SKILL_ALIASES: Readonly<Record<string, string>> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  py: 'Python',
  golang: 'Go',
  k8s: 'Kubernetes',
  postgres: 'PostgreSQL',
  psql: 'PostgreSQL',
  'react.js': 'React',
  reactjs: 'React',
  'vue.js': 'Vue',
  vuejs: 'Vue',
  'node.js': 'Node.js',
  nodejs: 'Node.js',
  node: 'Node.js',
  'c#': 'C#',
  csharp: 'C#',
  'c++': 'C++',
  cpp: 'C++',
  ml: 'Machine learning',
  ai: 'Artificial intelligence',
  nlp: 'Natural language processing',
  gcp: 'Google Cloud',
  aws: 'Amazon Web Services',
  excel: 'Microsoft Excel',
  ppt: 'PowerPoint',
  ps: 'Photoshop',
  sql: 'SQL',
};
