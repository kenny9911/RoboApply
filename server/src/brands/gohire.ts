import type { BrandConfig } from './types.js';

export const gohireBrand: BrandConfig = {
  id: 'gohire',
  name: 'GoHire',
  shortName: 'GH',
  tagline: 'Hire smarter, faster',

  logoUrl: '/gohiretop_logo_lightmode.png',
  logoDarkUrl: '/gohiretop_logo_darkmode.png',
  faviconUrl: '/gohiretop_logo_lightmode.png',
  ogImageUrl: '/gohiretop_logo_lightmode.png',
  themeColor: '#0F766E',
  navLogoHeightPx: 44,
  navLogoHeightCollapsedPx: 34,
  marketingLogoHeightPx: 56,

  primaryColor: '#0F766E',
  accentColor: '#14B8A6',

  supportEmail: 'support@gohire.com',
  salesEmail: 'sales@gohire.com',
  emailFromName: 'GoHire',
  emailFromAddress: 'noreply@gohire.com',
  legalEntityName: 'GoHire',
  termsUrl: '/terms',
  privacyUrl: '/privacy',

  canonicalHost: 'https://gohire.top',
  apiHost: 'https://api.gohire.top',
  seo: {
    defaultTitle: 'GoHire - Hire smarter, faster',
    defaultDescription:
      'GoHire helps recruiters move candidates through the pipeline with AI-assisted screening, structured interviews, and decision-ready evaluation reports.',
    defaultKeywords:
      'AI hiring, recruitment automation, resume screening, interview evaluation, candidate matching, hiring platform, talent acquisition',
    organizationFoundingYear: '2024',
    organizationSameAs: [],
  },

  features: {
    agentAlexVoice: true,
    stripeCheckout: true,
    seekerApp: true,
    fileVault: true,
    autoLoader: true,
    assessments: true,
    marketIntelligence: true,
    multiLanguage: true,
    apiPlayground: true,
    docsHub: true,
    agents: true,
    autoPilot: true,
  },
};
