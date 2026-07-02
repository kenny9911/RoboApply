import type { BrandConfig } from './types.js';

export const robohireBrand: BrandConfig = {
  id: 'robohire',
  name: 'RoboHire',
  shortName: 'RH',
  tagline: 'AI-Powered Hiring Platform',

  logoUrl: '/logo2.png',
  logoDarkUrl: '/logo2.png',
  faviconUrl: '/logo2.png',
  ogImageUrl: '/robohire.png',
  themeColor: '#4F46E5',
  navLogoHeightPx: 28,
  navLogoHeightCollapsedPx: 24,
  marketingLogoHeightPx: 32,

  primaryColor: '#3B84E2',
  accentColor: '#9154FD',

  supportEmail: 'support@robohire.io',
  salesEmail: 'sales@robohire.io',
  emailFromName: 'RoboHire',
  emailFromAddress: 'noreply@robohire.io',
  legalEntityName: 'RoboHire Inc.',
  termsUrl: '/terms',
  privacyUrl: '/privacy',

  canonicalHost: 'https://robohire.io',
  apiHost: 'https://api.robohire.io',
  seo: {
    defaultTitle: 'RoboHire - AI-Powered Hiring Platform',
    defaultDescription:
      'Hire elite candidates before others. Our AI hiring agent automatically screens resumes, conducts interviews, and delivers comprehensive evaluation reports.',
    defaultKeywords:
      'AI hiring, recruitment automation, resume screening, interview evaluation, candidate matching, hiring platform, AI recruitment, automated hiring, talent acquisition',
    twitterHandle: '@robohireio',
    organizationFoundingYear: '2024',
    organizationSameAs: [
      'https://twitter.com/robohireio',
      'https://linkedin.com/company/robohire',
      'https://github.com/robohire',
    ],
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
