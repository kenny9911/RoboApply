// server/src/features/match/terms.ts
//
// How skill and keyword terms are compared, de-duplicated and written
// (FIX-3). The keyword check used to be literal: a resume listing AWS,
// PostgreSQL and REST APIs was told it was missing "cloud infrastructure",
// "relational databases" and "api design", the same thing appeared two or
// three times ("typescript/node.js", "TypeScript", "Node.js"), and skills were
// printed in the lower case they are stored in ("go", "mysql", "grpc").
//
//   shownBy        the named technology on the resume that shows a broader
//                  term the post uses (AWS → cloud infrastructure). Only
//                  specific → general, never the other way round: "cloud
//                  infrastructure" on a resume does not show AWS. The check
//                  reports WHICH term counted, so nothing is claimed that the
//                  reader cannot see.
//   termKey        comparison key: skillKey plus singular/plural.
//   dedupeTerms    one entry per thing: exact repeats, "a/b" when a and b are
//                  both listed, and a longer phrase that only adds words to a
//                  listed one ("shared backend systems and frameworks").
//   displayTerm    the usual spelling of a known technology (Go, MySQL, gRPC,
//                  Node.js); anything else keeps the casing it came with, or
//                  gets a capital first letter when it is all lower case.
//   isEverydayWord a technology name that is also an ordinary word (rest,
//                  excel, swift, react, oracle, less). The resume text is
//                  compared in lower case, so "the rest of the migration" and
//                  "REST" look the same: such a name is never taken from a
//                  sentence as proof of a broader skill, and never re-spelled
//                  inside a phrase that names no other technology.
//
// Pure data and functions. Nothing here calls a model or reads the database.

/** NFKC, lower case, no spaces/dots/dashes/slashes ("Node.js" = "nodejs"). */
function baseKey(term: string): string {
  return term.normalize('NFKC').toLowerCase().replace(/[\s._\-/]+/g, '');
}

/** Singular form of a Latin word ("apis" → "api", "databases" → "database", "technologies" → "technology"). */
function singular(word: string): string {
  if (!/^[a-z]+$/.test(word) || word.length < 4) return word;
  if (word === 'apis') return 'api';
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  // "redis", "analysis", "kubernetes"-like names are compared as they are or consistently on both sides.
  if (/(ss|us|is|ics|js)$/.test(word)) return word;
  if (/(ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Words of a term, lower case, singular, in order ("REST APIs" → ["rest", "api"]). */
export function termWords(term: string): string[] {
  return term
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#.]+/u)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .map(singular);
}

/** Comparison key that treats singular and plural as one term ("REST APIs" = "rest api"). */
export function termKey(term: string): string {
  const words = termWords(term);
  return words.length ? words.join('').replace(/[._\-/]+/g, '') : baseKey(term);
}

// ── Technology names that are also ordinary words ─────────────────────────

/**
 * Lower-case names that read as plain English (or a person's or company's
 * name) as often as they name a technology. A single letter ("c", "r") is
 * always one.
 */
const EVERYDAY_WORDS: ReadonlySet<string> = new Set([
  // languages and runtimes
  'go', 'swift', 'ruby', 'rust', 'dart', 'perl', 'elixir', 'bash', 'shell', 'less', 'sass', 'soap', 'rest',
  // frameworks and libraries
  'react', 'express', 'spring', 'rails', 'flask', 'flutter', 'jest', 'mocha', 'cypress', 'playwright', 'yarn',
  // data and infrastructure
  'oracle', 'aurora', 'lambda', 'spark', 'hive', 'presto', 'pulsar', 'helm', 'sentry', 'mercurial',
  // tools and products
  'excel', 'sketch', 'framer', 'superset', 'illustrator', 'workday', 'postman', 'stripe', 'sap',
]);

/** Is `term` one word that is also an ordinary word (or a single letter)? */
export function isEverydayWord(term: string): boolean {
  const t = term.normalize('NFKC').trim().toLowerCase();
  return [...t].length === 1 || EVERYDAY_WORDS.has(t);
}

// ── Named technology → the broader term a post may use ────────────────────

/**
 * Each row: the broader terms, then the named things that show them. A resume
 * that names one of the right-hand items shows every left-hand term. A
 * right-hand item that is an everyday word (`isEverydayWord`: rest, oracle,
 * react, excel…) counts only from the person's skill list, never from a
 * sentence; its unmistakable forms ("rest api", "oracle database",
 * "react.js") are listed beside it and count from the text as usual.
 */
const SHOWN_BY: ReadonlyArray<readonly [general: readonly string[], specific: readonly string[]]> = [
  [
    ['cloud infrastructure', 'cloud', 'cloud computing', 'cloud platforms', 'cloud services', 'public cloud', 'cloud technologies'],
    ['aws', 'amazon web services', 'gcp', 'google cloud', 'google cloud platform', 'azure', 'microsoft azure', 'ec2', 's3', 'lambda', 'aws lambda', 'cloudformation', 'alibaba cloud', '阿里云', '腾讯云'],
  ],
  [
    ['relational databases', 'relational database', 'sql databases', 'sql database', 'rdbms', 'databases', 'database', 'database systems', '关系型数据库', '數據庫', '数据库'],
    ['postgresql', 'postgres', 'mysql', 'mariadb', 'sql server', 'mssql', 'oracle', 'oracle database', 'oracle db', 'sqlite', 'aurora', 'amazon aurora', 'aws aurora', 'cockroachdb'],
  ],
  [['sql'], ['postgresql', 'postgres', 'mysql', 'mariadb', 'sql server', 'mssql', 'sqlite', 't-sql', 'pl/sql']],
  [['nosql', 'nosql databases', 'non-relational databases'], ['mongodb', 'dynamodb', 'cassandra', 'couchbase', 'redis', 'firestore', 'hbase']],
  [
    ['api design', 'api development', 'apis', 'api', 'web apis', 'restful apis', 'rest apis', 'web services', 'backend apis', 'api 设计'],
    ['rest', 'rest api', 'rest apis', 'restful', 'restful api', 'graphql', 'grpc', 'openapi', 'swagger'],
  ],
  [['version control', 'source control', 'version control systems'], ['git', 'github', 'gitlab', 'bitbucket', 'svn', 'mercurial']],
  [
    ['ci/cd', 'cicd', 'continuous integration', 'continuous delivery', 'continuous deployment', 'ci/cd pipelines', 'build pipelines'],
    ['jenkins', 'github actions', 'gitlab ci', 'circleci', 'travis ci', 'argo cd', 'argocd', 'teamcity', 'buildkite'],
  ],
  [['containers', 'containerization', 'container orchestration', 'container technologies'], ['docker', 'kubernetes', 'k8s', 'ecs', 'eks', 'gke', 'openshift', 'podman']],
  [['infrastructure as code', 'iac'], ['terraform', 'cloudformation', 'pulumi', 'ansible']],
  [['frontend frameworks', 'front-end frameworks', 'javascript frameworks', 'modern javascript frameworks'], ['react', 'react.js', 'reactjs', 'react native', 'vue', 'vue.js', 'angular', 'angularjs', 'svelte', 'sveltekit', 'next.js', 'nuxt']],
  [['machine learning frameworks', 'ml frameworks', 'deep learning frameworks'], ['pytorch', 'tensorflow', 'keras', 'jax', 'scikit-learn']],
  [['message queues', 'messaging systems', 'event streaming', 'message brokers', '消息队列'], ['kafka', 'rabbitmq', 'sqs', 'pub/sub', 'pulsar', 'nats', 'rocketmq']],
  [['unit testing', 'automated testing', 'test automation', 'testing frameworks'], ['jest', 'pytest', 'junit', 'mocha', 'cypress', 'playwright', 'selenium', 'vitest', 'rspec']],
  [['data visualization', 'bi tools', 'business intelligence tools'], ['tableau', 'power bi', 'looker', 'superset', 'metabase']],
  [['design tools', 'prototyping tools'], ['figma', 'sketch', 'adobe xd', 'framer']],
  [['spreadsheets'], ['excel', 'microsoft excel', 'google sheets']],
  [['object-oriented programming', 'oop', 'object oriented programming'], ['java', 'c++', 'c#', 'kotlin', 'swift', 'swiftui']],
  [['scripting', 'scripting languages'], ['python', 'bash', 'bash scripting', 'bash scripts', 'shell', 'shell scripting', 'shell scripts', 'perl', 'ruby', 'powershell']],
  [['linux', 'unix'], ['ubuntu', 'debian', 'centos', 'red hat', 'rhel']],
  [['agile', 'agile methodologies', 'agile development'], ['scrum', 'kanban']],
];

const SHOWN_BY_INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [general, specific] of SHOWN_BY) {
    for (const g of general) {
      const key = termKey(g);
      m.set(key, [...(m.get(key) ?? []), ...specific]);
    }
  }
  return m;
})();

/** Named technologies that show the broader term `term` (empty when the term is not a broader one we know). */
export function showingTerms(term: string): readonly string[] {
  return SHOWN_BY_INDEX.get(termKey(term)) ?? [];
}

/** Roles whose own title shows the practice the post names ("software engineering" for a Software Engineer). */
const PRACTICE_OF_ROLE: ReadonlyArray<readonly [practice: readonly string[], role: RegExp]> = [
  [['software engineering', 'software development', 'programming', 'coding', '软件开发', '軟體開發'], /\b(software|backend|back-end|frontend|front-end|full[- ]?stack|mobile|ios|android|web|platform)\s+(engineer|developer)\b|\bsde\b|\bswe\b|\bprogrammer\b|软件工程师|開發工程師|开发工程师/i],
  [['data analysis', 'data analytics', 'analytics', '数据分析'], /\bdata\s+(analyst|scientist)\b|\banalytics\s+engineer\b|数据分析师/i],
  [['product management', '产品管理'], /\bproduct\s+manager\b|产品经理|產品經理/i],
  [['product design', 'ux design', 'user experience design', 'ui/ux design'], /\b(product|ux|ui\/ux|ui|interaction)\s+designer\b/i],
  [['project management', '项目管理'], /\b(project|program)\s+manager\b|项目经理|專案經理/i],
];

/** Does a job title show the practice `term` names? */
export function titleShows(title: string | null | undefined, term: string): boolean {
  if (!title) return false;
  const key = termKey(term);
  return PRACTICE_OF_ROLE.some(([practices, role]) => practices.some((p) => termKey(p) === key) && role.test(title));
}

// ── One entry per thing ───────────────────────────────────────────────────

/** Names that contain a joiner are one thing, on their own or inside a longer term. */
const ONE_THING = /ci\/cd|ui\/ux|ux\/ui|pl\/sql|tcp\/ip|a\/b test(?:ing|s)?|r&d|q&a|m&a|p&l|i\/o|pub\/sub|at&t/gi;
/**
 * What separates two terms: "/", ",", ";", "&", "and", "or", their CJK forms,
 * and "+" between two terms ("react+redux", "react + redux"). A "+" that
 * belongs to a name is not one: "C++", "A+ certification".
 */
const JOINERS = /\s*(?:\/|,|;|&|\band\b|\bor\b|、|，)\s*|\s+\+\s+|(?<=[\p{L}\p{N}])\+(?=[\p{L}\p{N}])/iu;
/** 和 / 及 join two terms only when what is on each side is a term: they are also inside ordinary words (亲和力, 及时). */
const CJK_JOINERS = /\s*[和及]\s*/u;

/** "typescript/node.js", "React and Redux", "Java和Python" → their parts (a single term → itself). */
export function termParts(term: string): string[] {
  const whole = term.trim();
  const kept: string[] = [];
  const masked = whole.replace(ONE_THING, (m) => `\u0000${kept.push(m) - 1}\u0000`);
  // eslint-disable-next-line no-control-regex
  const restore = (p: string) => p.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)] ?? '').trim();
  const parts = masked
    .split(JOINERS)
    .flatMap((p) => {
      const sides = p.split(CJK_JOINERS).map((x) => x.trim());
      return sides.length > 1 && sides.every((x) => [...x].length >= 2) ? sides : [p];
    })
    .map(restore)
    .filter(Boolean);
  return parts.length ? parts : [whole];
}

/**
 * Drop repeats, keeping the first spelling of each thing:
 *   · the same term again (case, punctuation, plural);
 *   · "a/b" (or "a and b") when a and b are each listed on their own;
 *   · a longer phrase whose words contain all the words of a listed phrase of
 *     two or more words ("shared backend systems and frameworks" next to
 *     "shared backend systems").
 */
export function dedupeTerms<T>(items: readonly T[], termOf: (item: T) => string): T[] {
  const keys = items.map((it) => termKey(termOf(it)));
  const present = new Set(keys.filter(Boolean));
  const wordSets = items.map((it) => new Set(termWords(termOf(it))));
  const out: T[] = [];
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const key = keys[i]!;
    if (!key || seen.has(key)) return;
    const parts = termParts(termOf(item));
    if (parts.length > 1 && parts.every((p) => present.has(termKey(p)) && termKey(p) !== key)) return;
    const words = wordSets[i]!;
    const covered = items.some((_, j) => {
      if (j === i) return false;
      const other = wordSets[j]!;
      if (other.size < 2 || other.size >= words.size) return false;
      for (const w of other) if (!words.has(w)) return false;
      return true;
    });
    if (covered) return;
    seen.add(key);
    out.push(item);
  });
  return out;
}

// ── Display spelling ──────────────────────────────────────────────────────

const SPELLINGS: readonly string[] = [
  'Go', 'Golang', 'Java', 'JavaScript', 'TypeScript', 'Python', 'Ruby', 'Rust', 'Kotlin', 'Swift', 'Scala', 'PHP', 'Perl', 'Dart', 'Elixir', 'Haskell', 'MATLAB', 'COBOL', 'Objective-C',
  'C', 'C++', 'C#', '.NET', 'ASP.NET', 'R', 'SQL', 'NoSQL', 'T-SQL', 'PL/SQL', 'HTML', 'CSS', 'Sass', 'LESS', 'JSON', 'XML', 'YAML',
  'MySQL', 'PostgreSQL', 'Postgres', 'SQLite', 'MariaDB', 'MongoDB', 'DynamoDB', 'Redis', 'Cassandra', 'Elasticsearch', 'OpenSearch', 'ClickHouse', 'BigQuery', 'Snowflake', 'Redshift', 'Databricks', 'Oracle', 'SQL Server',
  'gRPC', 'GraphQL', 'REST', 'REST API', 'REST APIs', 'RESTful', 'RESTful APIs', 'API', 'APIs', 'OpenAPI', 'SOAP', 'HTTP', 'HTTPS', 'TCP/IP', 'DNS', 'CDN', 'OAuth', 'SSO', 'SAML', 'JWT', 'TLS', 'SSL',
  'AWS', 'GCP', 'Azure', 'EC2', 'S3', 'ECS', 'EKS', 'GKE', 'IAM', 'VPC', 'Lambda', 'CloudFormation', 'Terraform', 'Ansible', 'Pulumi', 'Docker', 'Kubernetes', 'K8s', 'Helm', 'Linux', 'Unix', 'Bash',
  'Node.js', 'Next.js', 'Nuxt', 'Vue', 'Vue.js', 'React', 'React Native', 'Redux', 'Angular', 'AngularJS', 'Svelte', 'jQuery', 'Express', 'NestJS', 'Django', 'Flask', 'FastAPI', 'Rails', 'Ruby on Rails', 'Spring', 'Spring Boot', 'Laravel', 'Flutter', 'SwiftUI',
  'iOS', 'macOS', 'Android', 'Xcode', 'Git', 'GitHub', 'GitLab', 'Bitbucket', 'Jira', 'Confluence', 'Jenkins', 'CircleCI', 'GitHub Actions', 'Argo CD', 'CI/CD', 'DevOps', 'MLOps', 'SRE', 'TDD', 'OOP', 'QA', 'UX', 'UI', 'UI/UX', 'SEO', 'SEM', 'CRM', 'ERP', 'KPI', 'OKR', 'ROI', 'B2B', 'B2C', 'SaaS', 'PaaS', 'IaaS', 'ETL', 'ELT', 'BI', 'AI', 'ML', 'NLP', 'LLM', 'LLMs', 'RAG', 'GPU', 'IoT', 'AR', 'VR',
  'Kafka', 'RabbitMQ', 'Spark', 'Hadoop', 'Airflow', 'dbt', 'Flink', 'Hive', 'Presto', 'Trino', 'PyTorch', 'TensorFlow', 'Keras', 'scikit-learn', 'pandas', 'NumPy', 'SciPy', 'OpenCV', 'LangChain', 'Hugging Face',
  'Tableau', 'Power BI', 'Looker', 'Excel', 'PowerPoint', 'Figma', 'Sketch', 'Photoshop', 'Illustrator', 'InDesign', 'Salesforce', 'HubSpot', 'SAP', 'Workday', 'Zendesk', 'Shopify', 'WordPress', 'Stripe', 'Twilio',
  'Jest', 'Vitest', 'Cypress', 'Playwright', 'Selenium', 'JUnit', 'pytest', 'Postman', 'Webpack', 'Vite', 'npm', 'Yarn', 'Maven', 'Gradle', 'Nginx', 'Apache', 'Prometheus', 'Grafana', 'Datadog', 'Splunk', 'Sentry', 'New Relic',
  'Agile', 'Scrum', 'Kanban', 'Six Sigma', 'GAAP', 'IFRS', 'SOX', 'GDPR', 'HIPAA', 'PCI DSS', 'SOC 2', 'ISO 27001', 'CPA', 'CFA', 'PMP', 'MBA', 'PhD',
];

const SPELLING_BY_KEY: ReadonlyMap<string, string> = new Map(SPELLINGS.map((s) => [s.normalize('NFKC').toLowerCase(), s] as const));

/**
 * The spelling a reader expects: "go" → "Go", "mysql" → "MySQL", "grpc" →
 * "gRPC", "typescript/node.js" → "TypeScript/Node.js". A term that already
 * has capitals is the post's or the user's own spelling and is kept; an
 * unknown all-lower-case phrase gets a capital first letter.
 *
 * Inside a phrase, a word that is also an ordinary word (`isEverydayWord`:
 * less, soap, rest, c, r, go…) is re-spelled only when the phrase names
 * another technology that is not: "html, css and less" → "HTML, CSS and LESS",
 * but "less supervision" → "Less supervision" and "bed rest" → "Bed rest".
 */
export function displayTerm(term: string): string {
  const t = term.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!t) return t;
  const whole = SPELLING_BY_KEY.get(t.toLowerCase());
  if (whole) return whole;
  if (t !== t.toLowerCase()) return t;
  // Word by word, keeping the separators ("typescript/node.js", "aws lambda").
  const pieces = t.split(/(\s+|\/|,\s*)/);
  const hits = pieces.map((p) => SPELLING_BY_KEY.get(p) ?? null);
  const namesTechnology = pieces.some((p, i) => hits[i] !== null && !isEverydayWord(p));
  let known = false;
  const spelled = pieces.map((p, i) => {
    const hit = hits[i];
    if (!hit || (isEverydayWord(p) && !namesTechnology)) return p;
    known = true;
    return hit;
  });
  const joined = spelled.join('');
  if (known && pieces.length > 1 && /^[a-z]/.test(joined)) return joined.charAt(0).toUpperCase() + joined.slice(1);
  if (known) return joined;
  return /^[a-z]/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
