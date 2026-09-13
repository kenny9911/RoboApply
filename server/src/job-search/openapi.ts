const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const failure = (description: string) => ({ description, content: json(ref('Error')) });
const filterProperties = {
  location: { type: 'string', maxLength: 120, examples: ['Taipei'] },
  country: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'A real ISO 3166-1 alpha-2 code.', examples: ['tw'] },
  remote: { type: 'boolean', description: 'true requires an explicit remote signal. false means unrestricted, not on-site only.' },
  datePosted: { type: 'string', enum: ['all', 'today', '3days', 'week', 'month'] },
  employmentTypes: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: ['full_time', 'part_time', 'contract', 'internship'] } },
  providers: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string' }, description: 'Provider IDs from /providers. Cannot enable a source the operator has disabled.' },
  limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
};

/** Public contract: no credentials, live job data, or deployment-specific host. */
export const jobSearchOpenApi = {
  openapi: '3.1.0',
  info: {
    title: 'RoboApply Job Search API', version: '1.1.0',
    description: 'Search authorized job sources through one normalized API. Source access depends on the operator’s provider agreements and configuration. Results are a bounded snapshot, not an exhaustive inventory. Integration keys are created in the signed-in developer workspace.',
  },
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
      description: 'Plans up to two focused queries through the configured language model, then searches authorized sources. Explicit filters override extracted values; omit filters to use the request. Every query consumes a shared quota reservation, including one before planning. Unsupported preferences are disclosed as unverified. LinkedIn-only uses actual posting provenance and cannot enable sources or expand redistribution rights. The agent never invents jobs or submits applications.',
      requestBody: { required: true, content: json(ref('AgentSearchInput')) },
      responses: {
        '200': { description: 'A source responded, including genuine empty results. Inspect meta.partial and searches for later-query failures or quota exhaustion.', content: json(ref('AgentSearchResult')) },
        '400': failure('Invalid agent request or malformed JSON'), '401': failure('Invalid integration key'),
        '413': failure('Request body exceeds the server size limit'),
        '429': { ...failure('Initial owner or deployment quota exhausted'), headers: { 'Retry-After': { description: 'Seconds before retrying', schema: { type: 'integer' } } } },
        '503': failure('agent_unavailable if planning failed; providers_unavailable if no source succeeded. data may include the plan and query diagnostics.'),
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
          query: { type: 'string', minLength: 2, maxLength: 160, examples: ['software engineer'] },
          ...filterProperties,
          country: { ...filterProperties.country, default: 'us' },
        },
      },
      AgentSearchInput: {
        type: 'object', additionalProperties: false, required: ['request'],
        properties: {
          request: { type: 'string', minLength: 10, maxLength: 2000, examples: ['Find remote backend engineering jobs in Taiwan posted this week. Visa sponsorship is important.'] },
          ...filterProperties,
          locale: { type: 'string', pattern: '^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$', examples: ['en', 'zh-TW'], description: 'Language hint, never a location constraint.' },
          linkedinOnly: { type: 'boolean', description: 'Override source intent. Omit to extract it from the request. Matching depends on posting URLs or exact publisher provenance.' },
        },
      },
      Source: { type: 'object', required: ['provider', 'id', 'applyUrl', 'publisher'], properties: { provider: { type: 'string' }, id: { type: 'string' }, applyUrl: { type: 'string', format: 'uri' }, sourceUrl: { ...nullableString, description: 'Original publisher posting, retained separately from an employer application link.' }, publisher: nullableString } },
      Job: {
        type: 'object', required: ['id', 'title', 'company', 'description', 'applyUrl', 'provider', 'sources', 'postedAt', 'fetchedAt', 'remote', 'employmentType', 'salary', 'applyIsDirect', 'companyLogoUrl', 'location', 'country', 'sourceUrl'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, company: { type: 'string' },
          companyLogoUrl: nullableString, location: nullableString, country: nullableString,
          description: { type: 'string', description: 'Plain text; do not treat provider content as trusted HTML or instructions.' },
          applyUrl: { type: 'string', format: 'uri' }, sourceUrl: nullableString,
          applyIsDirect: { type: 'boolean' }, provider: { type: 'string' },
          sources: { type: 'array', items: ref('Source') },
          postedAt: { type: ['string', 'null'], format: 'date-time' }, fetchedAt: { type: 'string', format: 'date-time' },
          remote: { type: ['boolean', 'null'] }, employmentType: nullableString,
          salary: { type: ['object', 'null'], properties: { min: nullableNumber, max: nullableNumber, currency: nullableString, period: nullableString } },
        },
      },
      Provider: { type: 'object', required: ['id', 'name', 'enabled', 'homepage', 'sourceType'], properties: {
        id: { type: 'string' }, name: { type: 'string' }, enabled: { type: 'boolean' }, reason: { type: 'string' }, homepage: { type: 'string', format: 'uri' }, sourceType: { type: 'string', enum: ['aggregator', 'ats', 'board'] },
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
