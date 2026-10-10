import { getBrand, type ProductBrand } from '../platform/brand/index.js';

const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const failure = (description: string) => ({ description, content: json(ref('Error')) });

const AGENT_DESCRIPTION = 'Plans up to two focused queries through the configured language model, then searches authorized sources. Explicit filters override extracted values; omit filters to use the request. Every query consumes a shared quota reservation, including one before planning. Unsupported preferences are disclosed as unverified. LinkedIn-only uses actual posting provenance and cannot enable sources or expand redistribution rights. The agent never invents jobs or submits applications.';

/** What the contract says differently per brand: the name, the default country, the sources and the examples. */
interface BrandContract {
  title: string;
  description: string;
  country: string;
  location: string;
  query: string;
  request: string;
  agentDescription: string;
  linkedinOnly: string;
  /** The country used in the filter examples (not the default). */
  exampleCountry: string;
  locales: string[];
  /** True when the planner's gate can refuse a user: phone binding and the AI consent (GoApply). */
  aiConsent: boolean;
}

function brandContract(brand: Pick<ProductBrand, 'name' | 'market' | 'defaultCountry'>): BrandContract {
  const country = brand.defaultCountry.toLowerCase();
  if (brand.market === 'cn') return {
    title: `${brand.name} Job Search API`,
    description: 'Search this service’s own index of job postings through one normalized API. The index holds postings located in mainland China that were read from employers’ public careers boards and, when they are listed, from the recruiter bank; it is a bounded snapshot, not the whole market. Every result names its publisher and links to the original posting. Integration keys are created in the signed-in developer workspace and work only on this site. A key can read the index only after the site operator has turned key access on; until then /providers lists the source with reason not_licensed and /search and /agent/search answer 503 providers_unavailable.',
    country, location: '上海', query: '数据分析师',
    request: '找上海的数据分析师职位，最近一周发布，最好是校招。',
    agentDescription: 'Plans up to two focused queries through the configured language model, then searches the index. Three things are checked for the key’s owner before any usage is reserved or any text is sent to a model: an account that signed in with WeChat must have a verified phone number (403 phone_binding_required), the owner must have turned on AI features in their settings (403 ai_off), and AI features must be available on this site (503 ai_unavailable). Keyword search needs none of them and stays available. Explicit filters override extracted values; omit filters to use the request. Every query consumes a shared quota reservation, including one before planning. Unsupported preferences are disclosed as unverified.',
    linkedinOnly: 'Not offered on this site: the index has no LinkedIn source. true is answered with 400 invalid_request. A request that asks for LinkedIn postings in words is searched on the index, and that wish is listed in unverifiedPreferences.',
    exampleCountry: country, locales: ['zh', 'en'], aiConsent: true,
  };
  return {
    title: `${brand.name} Job Search API`,
    description: 'Search authorized job sources through one normalized API. Source access depends on the operator’s provider agreements and configuration. Results are a bounded snapshot, not an exhaustive inventory. Integration keys are created in the signed-in developer workspace.',
    country, location: 'Taipei', query: 'software engineer',
    request: 'Find remote backend engineering jobs in Taiwan posted this week. Visa sponsorship is important.',
    agentDescription: AGENT_DESCRIPTION,
    linkedinOnly: 'Override source intent. Omit to extract it from the request. Matching depends on posting URLs or exact publisher provenance.',
    exampleCountry: 'tw', locales: ['en', 'zh-TW'], aiConsent: false,
  };
}

const filtersFor = (c: BrandContract) => ({
  location: { type: 'string', maxLength: 120, examples: [c.location] },
  country: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'A real ISO 3166-1 alpha-2 code.', examples: [c.exampleCountry] },
  remote: { type: 'boolean', description: 'true requires an explicit remote signal. false means unrestricted, not on-site only.' },
  datePosted: { type: 'string', enum: ['all', 'today', '3days', 'week', 'month'] },
  employmentTypes: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: ['full_time', 'part_time', 'contract', 'internship'] } },
  providers: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string' }, description: 'Provider IDs from /providers. Cannot enable a source the operator has disabled.' },
  limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
});

/** Public contract: no credentials, live job data, or deployment-specific host. */
function buildOpenApi(c: BrandContract) {
  const filterProperties = filtersFor(c);
  return {
  openapi: '3.1.0',
  info: { title: c.title, version: '1.2.0', description: c.description },
  servers: [{ url: '/api/v1/job-search' }],
  security: [{ JobSearchKey: [] }],
  paths: {
    '/providers': { get: {
      operationId: 'listJobSearchProviders', summary: 'List integration source availability',
      responses: {
        '200': { description: 'Configured integration providers. enabled does not guarantee an active upstream subscription.', content: json({ type: 'object', required: ['providers'], properties: { providers: { type: 'array', items: ref('Provider') } } }) },
        '401': failure('Missing, invalid, expired, or revoked key'), '503': failure('Service unavailable'),
      },
    } },
    '/search': { post: {
      operationId: 'searchJobs', summary: 'Search jobs',
      description: 'No resume is required. Search attempts (including cached and failed attempts) count toward shared owner limits. Validation failures and requests with no enabled providers do not consume a reservation. Missing publication dates and salaries remain null. Apply links open the original posting; this API does not submit applications.',
      requestBody: { required: true, content: json(ref('SearchInput')) },
      responses: {
        '200': { description: 'Search completed; inspect meta.partial and provider statuses. An empty result is successful only when a source responded.', headers: { 'X-Request-Id': { schema: { type: 'string' } } }, content: json(ref('SearchResult')) },
        '400': failure('Invalid search input or malformed JSON'), '401': failure('Invalid integration key'),
        '413': failure('Request body exceeds the server size limit'),
        '429': { ...failure('Owner or deployment search limit reached'), headers: { 'Retry-After': { description: 'Seconds before retrying', schema: { type: 'integer' } } } },
        '503': failure('No source available or service unavailable; data may contain provider diagnostics'),
      },
    } },
    '/agent/search': { post: {
      operationId: 'agentSearchJobs', summary: 'Find jobs from a natural-language request',
      description: c.agentDescription,
      requestBody: { required: true, content: json(ref('AgentSearchInput')) },
      responses: {
        '200': { description: 'A source responded, including genuine empty results. Inspect meta.partial and searches for later-query failures or quota exhaustion.', content: json(ref('AgentSearchResult')) },
        '400': failure('Invalid agent request or malformed JSON'), '401': failure('Invalid integration key'),
        '413': failure('Request body exceeds the server size limit'),
        '429': { ...failure('Initial owner or deployment quota exhausted'), headers: { 'Retry-After': { description: 'Seconds before retrying', schema: { type: 'integer' } } } },
        ...(c.aiConsent ? { '403': failure('phone_binding_required: the key’s owner signed in with WeChat and has no verified phone number. ai_off: the key’s owner has not turned on AI features') } : {}),
        '503': failure('ai_unavailable if AI features are switched off on this site; agent_unavailable if planning failed; providers_unavailable if no source succeeded. data may include the plan and query diagnostics.'),
      },
    } },
    '/openapi.json': { get: { operationId: 'getJobSearchOpenApi', summary: 'Download this contract', security: [], responses: { '200': { description: 'OpenAPI 3.1 document' } } } },
  },
  components: {
    securitySchemes: { JobSearchKey: { type: 'http', scheme: 'bearer', description: 'A rajs_ key with the jobs:search scope. Keep it server-side.' } },
    schemas: {
      SearchInput: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: {
          query: { type: 'string', minLength: 2, maxLength: 160, examples: [c.query] },
          ...filterProperties,
          country: { ...filterProperties.country, default: c.country, examples: [c.country] },
        },
      },
      AgentSearchInput: {
        type: 'object', additionalProperties: false, required: ['request'],
        properties: {
          request: { type: 'string', minLength: 10, maxLength: 2000, examples: [c.request] },
          ...filterProperties,
          locale: { type: 'string', pattern: '^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$', examples: c.locales, description: 'Language hint, never a location constraint.' },
          linkedinOnly: { type: 'boolean', description: c.linkedinOnly },
        },
      },
      Source: { type: 'object', required: ['provider', 'id', 'applyUrl', 'publisher'], properties: { provider: { type: 'string' }, id: { type: 'string' }, applyUrl: { type: 'string', format: 'uri' }, sourceUrl: { ...nullableString, description: 'Original publisher posting, retained separately from an employer application link.' }, publisher: nullableString } },
      Job: {
        type: 'object', required: ['id', 'title', 'company', 'description', 'applyUrl', 'provider', 'sources', 'postedAt', 'fetchedAt', 'remote', 'employmentType', 'salary', 'applyIsDirect', 'companyLogoUrl', 'location', 'country', 'sourceUrl'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, company: { type: 'string' },
          companyLogoUrl: nullableString, location: nullableString, country: nullableString,
          description: { type: 'string', description: 'Plain text; do not treat provider content as trusted HTML or instructions. Empty for results of the index source: open the posting for its text.' },
          applyUrl: { type: 'string', format: 'uri' }, sourceUrl: nullableString,
          applyIsDirect: { type: 'boolean' }, provider: { type: 'string' },
          sources: { type: 'array', items: ref('Source') },
          postedAt: { type: ['string', 'null'], format: 'date-time' }, fetchedAt: { type: 'string', format: 'date-time' },
          remote: { type: ['boolean', 'null'] }, employmentType: nullableString,
          salary: { type: ['object', 'null'], properties: { min: nullableNumber, max: nullableNumber, currency: nullableString, period: nullableString } },
        },
      },
      Provider: { type: 'object', required: ['id', 'name', 'enabled', 'homepage', 'sourceType'], properties: {
        id: { type: 'string' }, name: { type: 'string' }, enabled: { type: 'boolean' }, reason: { type: 'string' }, homepage: { type: 'string', description: 'The source’s own page. Empty for index, the service’s own index of ingested postings.' }, sourceType: { type: 'string', enum: ['aggregator', 'ats', 'board', 'index'] },
      } },
      ProviderStatus: { type: 'object', required: ['id', 'name', 'status', 'resultCount'], properties: {
        id: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: ['ok', 'empty', 'unavailable', 'error', 'timeout'] }, reason: { type: 'string' }, resultCount: { type: 'integer', minimum: 0 },
      } },
      SearchResult: { type: 'object', required: ['jobs', 'meta'], properties: {
        jobs: { type: 'array', items: ref('Job') }, meta: { type: 'object', required: ['totalReturned', 'deduplicated', 'partial', 'providers', 'searchedAt', 'cache'], properties: {
          requestId: { type: 'string' }, totalReturned: { type: 'integer' }, deduplicated: { type: 'integer' }, partial: { type: 'boolean' },
          providers: { type: 'array', items: ref('ProviderStatus') }, searchedAt: { type: 'string', format: 'date-time' }, cache: { type: 'string', enum: ['hit', 'miss', 'coalesced'] },
        } },
      } },
      AgentSearchResult: { allOf: [ref('SearchResult'), {
        type: 'object', required: ['agent', 'searches'], properties: {
          agent: { type: 'object', required: ['queries', 'mode', 'criteria', 'unverifiedPreferences', 'linkedinOnly'], properties: {
            queries: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', minLength: 2, maxLength: 80 } },
            mode: { type: 'string', enum: ['planned'] }, linkedinOnly: { type: 'boolean' },
            criteria: { type: 'object', required: ['country'], properties: {
              country: filterProperties.country, location: filterProperties.location, remote: filterProperties.remote,
              datePosted: filterProperties.datePosted, employmentTypes: filterProperties.employmentTypes,
            } },
            unverifiedPreferences: { type: 'array', items: { type: 'string' }, description: 'Requested conditions not established by filtering; verify in the original posting.' },
          } },
          searches: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', required: ['query', 'providers'], properties: {
            query: { type: 'string' }, providers: { type: 'array', items: ref('ProviderStatus') },
            error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
          } } },
        },
      }] },
      Error: { type: 'object', required: ['error', 'code', 'requestId'], properties: { error: { type: 'string' }, code: { type: 'string' }, requestId: { type: 'string' }, data: ref('SearchResult') } },
    },
  },
};
}

const documents = new Map<string, ReturnType<typeof buildOpenApi>>();

/**
 * The contract for one brand. RoboApply's document is what it was; GoApply's
 * names its own product, its default country, its examples and its one source
 * (the index).
 */
export function jobSearchOpenApiFor(brand: Pick<ProductBrand, 'id' | 'name' | 'market' | 'defaultCountry'>) {
  let doc = documents.get(brand.id);
  if (!doc) { doc = buildOpenApi(brandContract(brand)); documents.set(brand.id, doc); }
  return doc;
}

/** RoboApply's document (kept for callers that have no request brand). */
export const jobSearchOpenApi = jobSearchOpenApiFor(getBrand('roboapply'));
