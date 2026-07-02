// roboapply/lib/interviewRecommendations.ts
//
// Role-aware recommendations for the mock-interview setup: which interview
// FORMATS and which interviewer PERSONAS best fit each role category. Pure UI
// sugar — the picker marks/sorts recommended options; nothing here gates launch.
// Derived from the industry research (see backend interviewFormats.ts +
// project memory). Category names match RA_MOCK_ROLE_CATEGORIES exactly.

import type { RAMockRoleCategory } from './api/v2/types';

export interface RoleRecommendation {
  typeIds: string[];
  personaIds: string[];
}

export const ROLE_FORMAT_RECOMMENDATIONS: Record<string, RoleRecommendation> = {
  "Engineering & DevOps": { typeIds: ["technical","system","debugging","incident_sre","behavioral","take_home","leadership_strategy"], personaIds: ["kai","diaz","atlas","voss","rex"] },
  "Product & Design": { typeIds: ["product_sense","portfolio","design_critique","case","research_design","behavioral","presentation"], personaIds: ["okonkwo","nova","diaz","priya","rex"] },
  "Data, AI & Analytics": { typeIds: ["sql_analytics","technical","system","case","take_home","behavioral","product_sense"], personaIds: ["voss","kai","okonkwo","atlas","diaz"] },
  "Marketing & Content": { typeIds: ["portfolio","case","presentation","product_sense","behavioral","leadership_strategy","pitch_demo"], personaIds: ["nova","june","priya","okonkwo","atlas"] },
  "Sales & Customer Success": { typeIds: ["sales_roleplay","pitch_demo","account_strategy","behavioral","situational_judgement","leadership_strategy","screening"], personaIds: ["voss","diaz","bishop","june","priya"] },
  "Finance & Accounting": { typeIds: ["finance_technical","modeling_test","case","behavioral","presentation","ops_case","leadership_strategy"], personaIds: ["voss","okonkwo","kai","diaz","priya"] },
  "Healthcare & Life Sciences": { typeIds: ["clinical_scenario","situational_judgement","practical_skills","behavioral","culture","reference_check","teaching_demo"], personaIds: ["maya","diaz","priya","voss","okonkwo"] },
  "People, Ops & Trades": { typeIds: ["behavioral","ops_case","practical_skills","situational_judgement","leadership_strategy","presentation","teaching_demo"], personaIds: ["priya","diaz","bishop","okonkwo","maya"] },
};

/** Which category a chosen role title belongs to (exact match within the catalog). */
export function categoryForRole(
  role: string | null,
  categories: RAMockRoleCategory[],
): string | null {
  if (!role) return null;
  const hit = categories.find((c) => c.roles.includes(role));
  return hit?.name ?? null;
}

/** Recommended formats + personas for a chosen role, or null if unknown / JD mode. */
export function recommendationsForRole(
  role: string | null,
  categories: RAMockRoleCategory[],
): RoleRecommendation | null {
  const cat = categoryForRole(role, categories);
  return cat ? ROLE_FORMAT_RECOMMENDATIONS[cat] ?? null : null;
}
