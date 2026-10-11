// @vitest-environment node
//
// Taxonomy v1 ids are frozen (SM-2): stored rows, saved searches and the web
// bundle's label keys all hold these ids, so a title-matching change may add
// synonyms and nothing else. A new, removed or renamed node is taxonomy v2
// (a new data file and a migration of stored ids), never an edit to this list.

import { describe, expect, it } from 'vitest';
import { TAXONOMY_AS_OF, TAXONOMY_NODES, TAXONOMY_SOURCES, TAXONOMY_VERSION, validateTaxonomy } from './taxonomy.js';

const CATEGORIES = `
  software_engineering data_ai it_infrastructure security product design hardware engineering marketing sales customer finance operations people legal
  healthcare education consulting administration media manufacturing hospitality
`;
const GROUPS = `
  swe_backend swe_frontend swe_quality swe_systems swe_leadership data_analytics data_engineering ml_ai devops_cloud it_ops security_engineering
  security_governance product_management program_management product_design visual_design spatial_design hardware_design semiconductors robotics
  mechanical_manufacturing civil_construction process_energy aero_auto marketing_brand digital_marketing online_operations sales_roles
  business_development customer_service customer_success accounting financial_analysis banking business_operations supply_chain human_resources
  recruiting legal_roles compliance clinical health_admin life_sciences teaching education_support research consulting_roles public_sector admin_roles
  writing_editorial video_production production trades food_service hotel_travel
`;
const ROLES = `
  software_engineer backend_engineer fullstack_engineer platform_engineer blockchain_engineer frontend_engineer web_developer ios_engineer
  android_engineer mobile_engineer game_developer qa_engineer sdet embedded_software_engineer systems_software_engineer tech_lead engineering_manager
  engineering_director software_architect data_scientist data_analyst product_analyst bi_analyst statistician data_engineer analytics_engineer
  database_administrator data_architect ml_engineer ai_research_scientist nlp_engineer cv_engineer recsys_engineer mlops_engineer data_annotator
  devops_engineer sre cloud_engineer infrastructure_engineer sysadmin network_engineer it_support it_manager it_project_manager systems_analyst
  erp_consultant security_engineer penetration_tester security_analyst security_architect security_compliance security_leader product_manager
  technical_product_manager ai_product_manager product_director program_manager project_manager scrum_master product_designer ux_designer ui_designer
  ux_researcher design_manager graphic_designer motion_designer illustrator game_artist game_designer industrial_designer interior_designer architect
  hardware_engineer electrical_engineer electronics_engineer chip_design_engineer chip_verification_engineer semiconductor_process_engineer
  robotics_engineer controls_engineer autonomous_driving_engineer mechanical_engineer manufacturing_engineer industrial_engineer quality_engineer
  civil_engineer construction_manager mep_engineer cost_estimator chemical_engineer energy_engineer environmental_engineer materials_engineer
  aerospace_engineer automotive_engineer marketing_manager marketing_specialist brand_manager product_marketing_manager market_research_analyst
  pr_specialist event_planner digital_marketing_manager seo_specialist growth_marketer content_marketer social_media_manager ecommerce_manager
  user_operations content_operations product_operations live_commerce_operations content_moderator account_executive sdr account_manager sales_manager
  sales_engineer retail_sales store_manager real_estate_agent insurance_agent bd_manager partnerships_manager customer_service_rep
  technical_support_engineer customer_service_manager customer_success_manager onboarding_specialist accountant auditor bookkeeper tax_specialist
  finance_leader financial_analyst investment_analyst investment_banker quant_analyst risk_analyst actuary financial_advisor loan_officer bank_teller
  trader operations_manager operations_analyst facilities_manager supply_chain_manager logistics_coordinator buyer warehouse_manager import_export
  hr_generalist hrbp hr_manager compensation_benefits learning_development employee_relations recruiter talent_acquisition_manager lawyer
  in_house_counsel paralegal ip_specialist compliance_officer regulatory_affairs privacy_specialist physician registered_nurse nurse_practitioner
  pharmacist physical_therapist dentist medical_technologist psychologist healthcare_administrator medical_coder medical_sales_rep
  clinical_research_associate biomedical_scientist chemist biomedical_engineer bioinformatics_scientist school_teacher tutor language_teacher
  early_childhood_teacher professor special_education_teacher instructional_designer academic_advisor education_administrator postdoc
  research_assistant economist management_consultant business_analyst strategy_manager policy_analyst civil_servant nonprofit_program_manager
  social_worker administrative_assistant executive_assistant office_manager receptionist data_entry_clerk copywriter technical_writer editor
  journalist translator video_editor photographer content_creator producer production_supervisor machine_operator quality_inspector cnc_machinist
  electrician maintenance_technician welder driver chef restaurant_manager server hotel_manager travel_consultant flight_attendant
`;

const ids = (text: string) => text.trim().split(/\s+/);

describe('taxonomy v1: frozen ids', () => {
  it('is structurally valid', () => {
    expect(validateTaxonomy({ version: TAXONOMY_VERSION, asOf: TAXONOMY_AS_OF, sources: [...TAXONOMY_SOURCES], nodes: [...TAXONOMY_NODES] })).toEqual([]);
    expect(TAXONOMY_VERSION).toBe(1);
  });

  it.each([
    [1, 'categories', CATEGORIES, 22],
    [2, 'role groups', GROUPS, 55],
    [3, 'roles', ROLES, 230],
  ] as const)('level %i: the %s are exactly the frozen list, in data order', (level, _name, frozen, count) => {
    const expected = ids(frozen);
    expect(expected).toHaveLength(count);
    expect(TAXONOMY_NODES.filter((n) => n.level === level).map((n) => n.id)).toEqual(expected);
  });

  it('has 307 nodes and no id twice', () => {
    expect(TAXONOMY_NODES).toHaveLength(307);
    expect(new Set(TAXONOMY_NODES.map((n) => n.id)).size).toBe(307);
  });
});
