// server/src/interview-engine/prep/industries.ts
//
// The industries a candidate can browse when they do not have a job title in
// mind yet. Reference data, not a role list: the roles of an industry are
// written per market and language by IndustryRolesAgent, and a candidate can
// type an industry that is not listed (it is then used as typed).
//
// Labels are carried here for the nine product locales (the list is served by
// the API, like the job taxonomy, so the client needs no key per industry).
// `rank` orders the list per market: the industries with the most hiring in
// that market come first; a market without its own order uses `default`.

export type IndustryLocale = 'en' | 'zh' | 'zh-TW' | 'ja' | 'ko' | 'es' | 'fr' | 'pt' | 'de';

export interface IndustryEntry {
  id: string;
  labels: Record<IndustryLocale, string>;
}

const L = (en: string, zh: string, zhTW: string, ja: string, ko: string, es: string, fr: string, pt: string, de: string): Record<IndustryLocale, string> =>
  ({ en, zh, 'zh-TW': zhTW, ja, ko, es, fr, pt, de });

export const INDUSTRIES: readonly IndustryEntry[] = [
  { id: 'software_internet', labels: L('Software & Internet', '软件与互联网', '軟體與網路', 'ソフトウェア・インターネット', '소프트웨어·인터넷', 'Software e internet', 'Logiciel et Internet', 'Software e internet', 'Software & Internet') },
  { id: 'ai', labels: L('Artificial Intelligence', '人工智能', '人工智慧', '人工知能（AI）', '인공지능', 'Inteligencia artificial', 'Intelligence artificielle', 'Inteligência artificial', 'Künstliche Intelligenz') },
  { id: 'semiconductors_electronics', labels: L('Semiconductors & Electronics', '半导体与电子', '半導體與電子', '半導体・エレクトロニクス', '반도체·전자', 'Semiconductores y electrónica', 'Semi-conducteurs et électronique', 'Semicondutores e eletrônica', 'Halbleiter & Elektronik') },
  { id: 'telecom', labels: L('Telecommunications', '通信', '電信通訊', '通信', '통신', 'Telecomunicaciones', 'Télécommunications', 'Telecomunicações', 'Telekommunikation') },
  { id: 'gaming_entertainment', labels: L('Gaming & Entertainment', '游戏与娱乐', '遊戲與娛樂', 'ゲーム・エンターテインメント', '게임·엔터테인먼트', 'Videojuegos y entretenimiento', 'Jeux vidéo et divertissement', 'Games e entretenimento', 'Gaming & Unterhaltung') },
  { id: 'media_advertising', labels: L('Media, Advertising & Publishing', '传媒、广告与出版', '媒體、廣告與出版', 'メディア・広告・出版', '미디어·광고·출판', 'Medios, publicidad y editorial', 'Médias, publicité et édition', 'Mídia, publicidade e editorial', 'Medien, Werbung & Verlage') },
  { id: 'banking_financial', labels: L('Banking & Financial Services', '银行与金融服务', '銀行與金融服務', '銀行・金融サービス', '은행·금융 서비스', 'Banca y servicios financieros', 'Banque et services financiers', 'Bancos e serviços financeiros', 'Banken & Finanzdienstleistungen') },
  { id: 'investment', labels: L('Investment & Asset Management', '投资与资产管理', '投資與資產管理', '投資・資産運用', '투자·자산운용', 'Inversión y gestión de activos', "Investissement et gestion d'actifs", 'Investimentos e gestão de ativos', 'Investment & Vermögensverwaltung') },
  { id: 'insurance', labels: L('Insurance', '保险', '保險', '保険', '보험', 'Seguros', 'Assurance', 'Seguros', 'Versicherungen') },
  { id: 'consulting_professional', labels: L('Consulting & Professional Services', '咨询与专业服务', '顧問與專業服務', 'コンサルティング・専門サービス', '컨설팅·전문 서비스', 'Consultoría y servicios profesionales', 'Conseil et services professionnels', 'Consultoria e serviços profissionais', 'Beratung & professionelle Dienstleistungen') },
  { id: 'legal', labels: L('Legal Services', '法律服务', '法律服務', '法律サービス', '법률 서비스', 'Servicios legales', 'Services juridiques', 'Serviços jurídicos', 'Rechtsdienstleistungen') },
  { id: 'healthcare', labels: L('Healthcare & Hospitals', '医疗与医院', '醫療與醫院', '医療・病院', '의료·병원', 'Salud y hospitales', 'Santé et hôpitaux', 'Saúde e hospitais', 'Gesundheitswesen & Kliniken') },
  { id: 'pharma_biotech', labels: L('Pharma & Biotech', '医药与生物科技', '醫藥與生物科技', '製薬・バイオテクノロジー', '제약·바이오', 'Farmacéutica y biotecnología', 'Pharmacie et biotechnologies', 'Farmacêutica e biotecnologia', 'Pharma & Biotechnologie') },
  { id: 'medical_devices', labels: L('Medical Devices', '医疗器械', '醫療器材', '医療機器', '의료기기', 'Dispositivos médicos', 'Dispositifs médicaux', 'Dispositivos médicos', 'Medizintechnik') },
  { id: 'manufacturing_industrial', labels: L('Manufacturing & Industrial', '制造与工业', '製造與工業', '製造・工業', '제조·산업', 'Manufactura e industria', 'Industrie et fabrication', 'Manufatura e indústria', 'Fertigung & Industrie') },
  { id: 'automotive_ev', labels: L('Automotive & Electric Vehicles', '汽车与新能源汽车', '汽車與電動車', '自動車・EV', '자동차·전기차', 'Automoción y vehículos eléctricos', 'Automobile et véhicules électriques', 'Automotivo e veículos elétricos', 'Automobil & Elektromobilität') },
  { id: 'aerospace_defense', labels: L('Aerospace & Defense', '航空航天与国防', '航太與國防', '航空宇宙・防衛', '항공우주·방산', 'Aeroespacial y defensa', 'Aérospatial et défense', 'Aeroespacial e defesa', 'Luft- und Raumfahrt & Verteidigung') },
  { id: 'energy_utilities', labels: L('Energy & Utilities', '能源与公用事业', '能源與公用事業', 'エネルギー・公益事業', '에너지·유틸리티', 'Energía y servicios públicos', 'Énergie et services publics', 'Energia e utilidades', 'Energie & Versorgung') },
  { id: 'consumer_goods', labels: L('Consumer Goods', '快消品', '消費品', '消費財', '소비재', 'Bienes de consumo', 'Biens de consommation', 'Bens de consumo', 'Konsumgüter') },
  { id: 'retail_ecommerce', labels: L('Retail & E-commerce', '零售与电商', '零售與電商', '小売・EC', '유통·이커머스', 'Retail y comercio electrónico', 'Commerce et e-commerce', 'Varejo e e-commerce', 'Handel & E-Commerce') },
  { id: 'hospitality_travel', labels: L('Hospitality, Travel & Food Service', '酒店、旅游与餐饮', '飯店、旅遊與餐飲', 'ホテル・旅行・外食', '호텔·여행·외식', 'Hostelería, turismo y restauración', 'Hôtellerie, tourisme et restauration', 'Hotelaria, turismo e alimentação', 'Hotellerie, Tourismus & Gastronomie') },
  { id: 'logistics_transport', labels: L('Transportation & Logistics', '交通运输与物流', '運輸與物流', '運輸・物流', '운송·물류', 'Transporte y logística', 'Transport et logistique', 'Transporte e logística', 'Transport & Logistik') },
  { id: 'real_estate_construction', labels: L('Real Estate & Construction', '房地产与建筑', '房地產與營建', '不動産・建設', '부동산·건설', 'Inmobiliaria y construcción', 'Immobilier et construction', 'Imobiliário e construção', 'Immobilien & Bau') },
  { id: 'education', labels: L('Education', '教育', '教育', '教育', '교육', 'Educación', 'Éducation', 'Educação', 'Bildung') },
  { id: 'government_public', labels: L('Government & Public Sector', '政府与公共部门', '政府與公共部門', '官公庁・公共', '정부·공공', 'Gobierno y sector público', 'Administration et secteur public', 'Governo e setor público', 'Öffentlicher Dienst') },
  { id: 'nonprofit', labels: L('Non-profit & NGOs', '非营利与公益组织', '非營利與公益組織', '非営利・NGO', '비영리·NGO', 'Organizaciones sin fines de lucro', 'Associations et ONG', 'Organizações sem fins lucrativos', 'Non-Profit & NGOs') },
  { id: 'agriculture_food', labels: L('Agriculture & Food Production', '农业与食品', '農業與食品', '農業・食品', '농업·식품', 'Agricultura y alimentación', 'Agriculture et agroalimentaire', 'Agricultura e alimentos', 'Landwirtschaft & Lebensmittel') },
];

/** Market orders (ids first, the rest keep the list order). */
const RANK: Record<string, readonly string[]> = {
  default: ['software_internet', 'ai', 'banking_financial', 'healthcare', 'consulting_professional', 'retail_ecommerce', 'manufacturing_industrial', 'pharma_biotech', 'semiconductors_electronics', 'consumer_goods', 'media_advertising', 'energy_utilities'],
  cn: ['software_internet', 'ai', 'semiconductors_electronics', 'automotive_ev', 'banking_financial', 'manufacturing_industrial', 'pharma_biotech', 'consumer_goods', 'retail_ecommerce', 'gaming_entertainment', 'telecom', 'education'],
  tw: ['semiconductors_electronics', 'software_internet', 'ai', 'manufacturing_industrial', 'banking_financial', 'healthcare', 'retail_ecommerce', 'telecom', 'insurance', 'consumer_goods', 'gaming_entertainment', 'education'],
  jp: ['manufacturing_industrial', 'automotive_ev', 'software_internet', 'ai', 'semiconductors_electronics', 'banking_financial', 'consulting_professional', 'retail_ecommerce', 'pharma_biotech', 'gaming_entertainment', 'insurance', 'logistics_transport'],
  kr: ['semiconductors_electronics', 'software_internet', 'ai', 'automotive_ev', 'manufacturing_industrial', 'banking_financial', 'gaming_entertainment', 'pharma_biotech', 'retail_ecommerce', 'telecom', 'energy_utilities', 'media_advertising'],
};

export function normalizeIndustryLocale(locale: string | null | undefined): IndustryLocale {
  const value = (locale ?? '').trim();
  if (value === 'zh-TW' || value === 'zh-Hant' || value === 'zh-HK') return 'zh-TW';
  const base = value.split('-')[0] as IndustryLocale;
  return (['en', 'zh', 'ja', 'ko', 'es', 'fr', 'pt', 'de'] as const).includes(base as never) ? base : 'en';
}

export interface IndustryOption {
  id: string;
  label: string;
  /** True for the first entries of the market's order (shown before "More"). */
  top: boolean;
}

/** The industries in the market's order, labelled in `locale`. */
export function industriesFor(market: string | null | undefined, locale: string | null | undefined): IndustryOption[] {
  const order = RANK[market ?? ''] ?? RANK.default;
  const lang = normalizeIndustryLocale(locale);
  const position = new Map(order.map((id, index) => [id, index]));
  return [...INDUSTRIES]
    .sort((a, b) => (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    .map((entry) => ({ id: entry.id, label: entry.labels[lang], top: position.has(entry.id) }));
}

export function findIndustry(id: string | null | undefined): IndustryEntry | null {
  return INDUSTRIES.find((entry) => entry.id === id) ?? null;
}

/** An industry id's English label, or the typed text itself for an industry that is not listed. */
export function industryTextEn(value: string | null | undefined): string | null {
  const text = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!text) return null;
  return findIndustry(text)?.labels.en ?? text;
}
