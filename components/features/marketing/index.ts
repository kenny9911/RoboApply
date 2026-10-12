// components/features/marketing — public surface of the marketing site (WP-40).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).

export { RoboApplyHome, HomeHeroSub } from './RoboApplyHome';
export { GoApplyHome, CampusPreview } from './GoApplyHome';
export { FeaturePage } from './FeaturePage';
export { PricingPage } from './PricingPage';
export { AboutPage, SecurityPage, HelpPage, RankingPage, type AboutPageProps } from './CompanyPages';
export { ContactForm, CONTACT_TOPICS } from './ContactForm';
export { MarketingFooter, SiteHeader, SitePage, useFeatureVisible, type MarketingFooterProps } from './SiteChrome';
export { SignupLink, type SignupLinkProps } from './SignupLink';
export { JsonLd } from './JsonLd';
export { Faq, ExampleFrame, HomeExample, IndexCounters, PricingSummary, QuickSearch, type FaqItem } from './Sections';
export { useSignupHref, useIndexStats, useCreditCaps, useBrowseEnabled, BROWSE_FLAG } from './hooks';
export {
  FEATURES,
  RANKING_FACTORS,
  FIT_PARTS,
  COMPANY_SPREAD,
  HOME_FAQ_KEYS,
  CN_HOME_FAQ_KEYS,
  FEATURE_FAQ_KEYS,
  PRICING_FAQ_KEYS,
  HELP_FAQ_KEYS,
  featuresFor,
  findFeature,
  extensionStoreId,
  type FeatureDef,
  type FeatureGate,
} from './catalog';
export {
  HERO_COUNT_MIN,
  PRESERVED_PARAM_KEYS,
  browseHref,
  buildSignupHref,
  fromSlug,
  heroCount,
  popularListHref,
  slugify,
  type QuickSearchInput,
} from './links';
