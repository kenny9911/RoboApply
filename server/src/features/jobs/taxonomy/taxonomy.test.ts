// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// The Simplified/Traditional variant guard of `npm run check` (its glossary lists mainland terms banned in zh-TW text).
import { checkBundle, loadGlossary } from '../../../../../scripts/check-zh-variants.mjs';
import {
  TAXONOMY_NODES,
  TAXONOMY_SOURCES,
  TAXONOMY_VERSION,
  TAXONOMY_ZH_HANT_REVIEW,
  expandTaxonomyIds,
  exportTaxonomyLabels,
  getTaxonomyNode,
  taxonomyAncestors,
  taxonomyCategories,
  taxonomyLabel,
  taxonomyNodeLabel,
  taxonomyRolesUnder,
  validateTaxonomy,
  type TaxonomyNode,
} from './taxonomy.js';
import { foldTwToCn } from '../normalize/index.js';
import { normalizeTitle } from './match.js';
import * as taxonomy from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');

describe('taxonomy v1 structure', () => {
  it('is valid: unique snake_case ids, labels in English, Simplified and Traditional Chinese, proper parents, no empty branches', () => {
    expect(validateTaxonomy({ version: 1, asOf: '', sources: [], nodes: [...TAXONOMY_NODES] })).toEqual([]);
    expect(TAXONOMY_VERSION).toBe(1);
  });

  it('has about twenty Explore categories with groups and roles under each', () => {
    const l1 = taxonomyCategories();
    expect(l1.length).toBeGreaterThanOrEqual(18);
    expect(l1.length).toBeLessThanOrEqual(24);
    for (const c of l1) expect(taxonomyRolesUnder(c.id).length, c.id).toBeGreaterThanOrEqual(3);
    expect(TAXONOMY_NODES.filter((n) => n.level === 3).length).toBeGreaterThanOrEqual(150);
  });

  it('gives every role a parent group, a Chinese label and at least one synonym', () => {
    for (const n of TAXONOMY_NODES.filter((x) => x.level === 3)) {
      expect(getTaxonomyNode(n.parent!)?.level, n.id).toBe(2);
      expect(n.zh.trim(), n.id).not.toBe('');
      expect(n.synonyms.en.length + n.synonyms.zh.length, n.id).toBeGreaterThan(0);
    }
  });

  it('JT-4: every one of the 307 nodes has a Taiwan label, and every role a list of Taiwan titles', () => {
    expect(TAXONOMY_NODES).toHaveLength(307);
    for (const n of TAXONOMY_NODES) {
      expect(typeof n.zhHant === 'string' && n.zhHant.trim() === n.zhHant && n.zhHant.length > 0, n.id).toBe(true);
      expect(/[㐀-鿿]/.test(n.zhHant) || /^[A-Za-z]/.test(n.zhHant), `${n.id}: ${n.zhHant}`).toBe(true);
      if (n.level !== 3) continue;
      expect(Array.isArray(n.synonyms.zhHant), n.id).toBe(true);
      expect(n.synonyms.zhHant!.length, n.id).toBeGreaterThan(0);
      for (const s of n.synonyms.zhHant!) expect(s.trim() === s && s.length > 0, `${n.id}: "${s}"`).toBe(true);
      // The label is not repeated among its own synonyms.
      expect(n.synonyms.zhHant, n.id).not.toContain(n.zhHant);
      expect(new Set(n.synonyms.zhHant!.map(normalizeTitle)).size, n.id).toBe(n.synonyms.zhHant!.length);
    }
  });

  it('JT-4: the Taiwan labels ship as a draft until a Taiwan-native reviewer signs off', () => {
    expect(TAXONOMY_ZH_HANT_REVIEW).toEqual({ status: 'draft', reviewedBy: null, reviewedOn: null });
    const file = JSON.parse(readFileSync(path.join(here, 'taxonomy.v1.json'), 'utf8')) as { zhHantReview?: unknown };
    expect(file.zhHantReview).toEqual({ status: 'draft', reviewedBy: null, reviewedOn: null });
  });

  it('JT-4: adding the Taiwan labels changed no id, no English or Simplified label or synonym, and no node', () => {
    // sha256 of every node's [id, level, parent, en, zh, synonyms.en, synonyms.zh, soc, generic], taken from the
    // file before the zhHant fields were added (commit 48a5e56). A change here is a change to what mainland and
    // English matching read: make it on purpose and update the fingerprint in the same change.
    const core = TAXONOMY_NODES.map((n) => [n.id, n.level, n.parent, n.en, n.zh, n.synonyms.en, n.synonyms.zh, n.soc ?? null, n.generic ?? null]);
    expect(createHash('sha256').update(JSON.stringify(core)).digest('hex')).toBe('fb4fa8ba446ba6c539a46750df90c6350cf0993df6db8b5a41261b6e540f9e9c');
  });

  it('maps every normalized label and synonym to exactly one node', () => {
    // The Taiwan label of a category or group is display text (the zh-TW web bundle's wording, see the
    // "i18n bundle" tests): it is checked apart, below. Everything a title is matched against is here.
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const n of TAXONOMY_NODES) {
      const phrases = new Set([n.en, n.zh, ...(n.level === 3 ? [n.zhHant] : []), ...n.synonyms.en, ...n.synonyms.zh, ...(n.synonyms.zhHant ?? [])].map(normalizeTitle));
      for (const p of phrases) {
        const prev = owner.get(p);
        if (prev && prev !== n.id) collisions.push(`"${p}": ${prev} / ${n.id}`);
        owner.set(p, n.id);
      }
    }
    expect(collisions).toEqual([]);

    // Category and group labels in zh-TW: no two share one, and the ones that are also a role's own phrase
    // are these two, on purpose (the category 行政 and the mainland one-word title 行政; the group 法務 and
    // the Taiwan one-word title 法務). The typeahead lists the category or group first, then the role.
    const upper = new Map<string, string>();
    const shared: string[] = [];
    for (const n of TAXONOMY_NODES.filter((x) => x.level !== 3)) {
      const label = normalizeTitle(n.zhHant);
      expect(upper.get(label), `${n.id}: ${n.zhHant}`).toBeUndefined();
      upper.set(label, n.id);
      const role = owner.get(label);
      if (role && role !== n.id) shared.push(`${n.zhHant}: ${n.id} / ${role}`);
    }
    expect(shared.sort()).toEqual(['法務: legal_roles / in_house_counsel', '行政: administration / administrative_assistant']);
  });

  it('JT-4: no Taiwan title names another role when it is read in its mainland form', () => {
    // Ingest reads a Taiwan title twice: as written, and folded to mainland wording (normalize `foldTwToCn`).
    // Both readings of one title must name one role: 工程經理 must not be a software manager as written and
    // a construction manager (工程经理) folded.
    const owner = new Map<string, string>();
    for (const n of TAXONOMY_NODES.filter((x) => x.level === 3)) {
      for (const p of [n.en, n.zh, n.zhHant, ...n.synonyms.en, ...n.synonyms.zh, ...(n.synonyms.zhHant ?? [])]) owner.set(normalizeTitle(p), n.id);
    }
    const clashes: string[] = [];
    let checked = 0;
    for (const n of TAXONOMY_NODES.filter((x) => x.level === 3)) {
      for (const p of [n.zhHant, ...(n.synonyms.zhHant ?? [])]) {
        checked += 1;
        const folded = normalizeTitle(foldTwToCn(p));
        const other = owner.get(folded);
        if (other && other !== n.id) clashes.push(`${p} (${n.id}) reads ${folded} (${other})`);
      }
    }
    expect(checked).toBeGreaterThan(1100);
    expect(clashes).toEqual([]);
    // The two that did clash are gone from the Taiwan lists; their mainland reading decides.
    expect(getTaxonomyNode('engineering_manager')!.synonyms.zhHant).not.toContain('工程經理');
    expect(getTaxonomyNode('account_manager')!.synonyms.zhHant).not.toContain('客戶關係經理');
    expect(owner.get(normalizeTitle(foldTwToCn('工程經理')))).toBe('construction_manager');
    expect(owner.get(normalizeTitle(foldTwToCn('客戶關係經理')))).toBe('financial_advisor');
  });

  it('writes Chinese labels in Simplified characters (GoApply)', () => {
    const traditionalOnly = /[體專業開發據學機軟術務師員經經營銷財會計審數據庫測試網絡設計檢驗護醫藥療廠產質運輸廣編輯]/;
    const offenders = TAXONOMY_NODES.flatMap((n) => [n.zh, ...n.synonyms.zh]).filter((s) => traditionalOnly.test(s));
    expect(offenders).toEqual([]);
  });

  it('JT-4: writes the Taiwan labels and titles in Traditional characters and Taiwan wording', () => {
    const texts = TAXONOMY_NODES.flatMap((n) => [n.zhHant, ...(n.synonyms.zhHant ?? [])].map((text) => ({ id: n.id, text })));
    expect(texts.length).toBeGreaterThan(1200);
    // Characters that exist only in Simplified writing (the Simplified side of the words the labels use).
    const simplifiedOnly = /[软体专业开发据学机术务师员经营销财会计审数库测试网络设检验护医药疗厂产质运输广编辑统导维总监领长单创实际协调标类价电脑视觉画动户关规划处环证银险优杂传译语戏应届储级阶线车辆链采购仓构备习职区纳讯资项岗简历办层报汇乐华亲举义乡书买争云亚亩仅从仑仪众伙伤伦伪余侦侧侨债倾偿儿兑兰兴养兽册写军农冲决况冻净减凑凤凭击划刘则刚删别剂剑剧劝励劲劳势协卖卫厅厉压厕县参双变叙叶号叹听员响唤团园围图圆圣场坏块坚坛坝垒垦垫墙壮声壳处复够头夹夺奋奖妇妈娱婴孙宁宝宠宪宫宽宾对寻寿将尔尘尝层属岁岛岭币帅帐带帮应庙庞废庆异弃张弥弯弹强归录彻径忆忧怀态总恋恳恶悬惊惧惩惯愤愿懒战扑执扩扫扬扰抚抛担拟拢拥择挂挥捞损换据摄摆摇撑敌斩断无旧时显晋晒晓晕暂权条杨杰极枢枪柜栅栈栋样树档桥梦楼横欢欧毁毕气汉汤沟没泪洁浅济浇浊浏浑浓涌润涤涨渊温湾湿溃满滚滞滤灭灯灵灾灿炉点炼烂烛烟烦烧热焕爱爷牵牺状犹狱猎猪猫献现琐疯痪瘫盐盖盘矿码砖础硕确碍礼祸离种积称稳穷窃窍窑窝笔笼筛筹签篮粮纠红纤约纪纬纯纱纲纵纷纸纹纺练组细织终绍绑绒结绕绘给绝绞绢继绩绪续绿缆缉缓缔缘缝缠缩缴罗罚罢翘耸联聪肃肠肤肾肿胀胁胜脉脏腊舰舱艰艺节苍苏苹茎荐莲获萧萨蓝虏虑虽虾蚀蚁蛮补装观览誉订认讨让训议记讲许论访评识诈诉诊词诗诚话诞询该详误诱说诵请诸诺读课谁谈谊谋谎谐谓谜谢谣谦谨谱贝负贡责贤败账货贩贪贫贯贴贵贷贸费贺贼赋赌赎赏赐赔赖赚赛赞赠赵赶趋跃践踪躯轨转轮轰轻载辅辈辉辞辩边辽达迁过迈还这进远违连迟迹适选递逻遗邓邮邻郑酱释鉴针钉钓钙钝钞钟钠钢钥钩钮钱钳铁铃铅铜铝铭铲铸铺锁锅锈锋锐错锡锤键锦镇镜门闪闭问闯闲间闷闸闹闻阀阁阅队阳阴阵陆陈随隐难雾静韧韩页顶顷顺须顽顾顿颁预颇颈频颗题颜额风飘飞饥饭饮饰饱饲饶饼馆驰驱驳驶驻驾骂骄骑骗骤鱼鲜鸟鸡鸣鸭鸽鹅鹰麦黄齐齿龙]/;
    expect(texts.filter(({ text }) => simplifiedOnly.test(text)).map(({ id, text }) => `${id}: ${text}`)).toEqual([]);
    // The check means something: every Simplified label that differs from its Taiwan label trips it or uses other words.
    expect(simplifiedOnly.test('软件工程师')).toBe(true);
    // No term the variant glossary bans for zh-TW (軟件, 數據, 網絡, 視頻, 質量, 用戶 …): the taxonomy file is not a
    // bundle, so `npm run check:zh-variants` does not read it; this test reads the glossary itself.
    const glossary = loadGlossary(repoRoot);
    const bundle = Object.fromEntries(texts.map(({ id, text }, i) => [`${id}.${i}`, text]));
    expect(checkBundle(glossary, 'taxonomy.v1.zhHant.json', 'zh-TW', bundle)).toEqual([]);
    expect(checkBundle(glossary, 'taxonomy.v1.zhHant.json', 'zh-TW', { bad: '軟件工程師' }).length).toBeGreaterThan(0);
    expect(checkBundle(glossary, 'taxonomy.v1.zhHant.json', 'zh-TW', { bad: '數據分析師' }).length).toBeGreaterThan(0);
    // Taiwan wording, not a conversion of the mainland label: these are the terms the research note names.
    const label = (id: string) => getTaxonomyNode(id)!.zhHant;
    expect([label('software_engineer'), label('data_analyst'), label('network_engineer'), label('project_manager'), label('marketing_specialist')]).toEqual(['軟體工程師', '資料分析師', '網路工程師', '專案經理', '行銷專員']);
    expect([label('hr_generalist'), label('embedded_software_engineer'), label('product_manager'), label('administrative_assistant')]).toEqual(['人資專員', '韌體工程師', '產品經理', '行政助理']);
    expect(getTaxonomyNode('ml_engineer')!.synonyms.zhHant).toContain('演算法工程師');
    expect(getTaxonomyNode('software_engineer')!.synonyms.zhHant).toContain('程式設計師');
  });

  it('cites public sources and uses well-formed SOC codes', () => {
    expect(TAXONOMY_SOURCES.map((s) => s.id)).toContain('onet_soc_2019');
    const withSoc = TAXONOMY_NODES.filter((n) => n.soc?.length);
    expect(withSoc.length).toBeGreaterThan(80);
  });
});

describe('navigation helpers', () => {
  it('walks ancestors and expands ids at any level to roles', () => {
    expect(taxonomyAncestors('backend_engineer').map((n) => n.id)).toEqual(['backend_engineer', 'swe_backend', 'software_engineering']);
    const roles = expandTaxonomyIds(['swe_quality', 'backend_engineer', 'nope', 'qa_engineer']);
    expect(roles).toEqual(['qa_engineer', 'sdet', 'backend_engineer']);
    expect(expandTaxonomyIds(['data_ai']).length).toBe(taxonomyRolesUnder('data_ai').length);
  });

  it('labels per locale: zh is Simplified, zh-TW is Traditional Chinese in Taiwan wording, others fall back to English', () => {
    expect(taxonomyLabel('product_manager', 'en')).toBe('Product manager');
    expect(taxonomyLabel('product_manager', 'zh')).toBe('产品经理');
    expect(taxonomyLabel('product_manager', 'zh-TW')).toBe('產品經理');
    expect(taxonomyLabel('product_manager', 'ja')).toBe('Product manager');
    expect(taxonomyLabel('missing', 'en')).toBeNull();
    expect(taxonomyLabel('missing', 'zh-TW')).toBeNull();
  });

  it('JT-4: taxonomyLabel(id, "zh-TW") returns the Taiwan label and never a Simplified string', () => {
    expect(taxonomyLabel('software_engineer', 'zh-TW')).toBe('軟體工程師');
    expect(taxonomyLabel('software_engineering', 'zh-TW')).toBe('軟體工程');
    expect(taxonomyLabel('swe_backend', 'zh-TW')).toBe('後端與平台');
    for (const n of TAXONOMY_NODES) {
      const label = taxonomyLabel(n.id, 'zh-TW');
      expect(label, n.id).toBe(n.zhHant);
      // Where the two scripts write a label differently, zh-TW is never the Simplified one.
      if (n.zh !== n.zhHant) expect(label, n.id).not.toBe(n.zh);
    }
    // Only a handful of labels are written the same in both scripts (行政助理, 文案 …).
    expect(TAXONOMY_NODES.filter((n) => n.zh === n.zhHant).length).toBeLessThan(15);
  });

  it('JT-4: exportTaxonomyLabels(locale) is the web bundle\'s taxonomy namespace, one entry per node', () => {
    const tw = exportTaxonomyLabels('zh-TW');
    expect(Object.keys(tw).sort()).toEqual(['categories', 'groups', 'roles']);
    expect([Object.keys(tw.categories).length, Object.keys(tw.groups).length, Object.keys(tw.roles).length]).toEqual([22, 55, 230]);
    expect(Object.keys(tw.categories).length + Object.keys(tw.groups).length + Object.keys(tw.roles).length).toBe(TAXONOMY_NODES.length);
    for (const n of TAXONOMY_NODES) {
      const level = n.level === 1 ? 'categories' : n.level === 2 ? 'groups' : 'roles';
      expect(tw[level][n.id], n.id).toBe(n.zhHant);
      expect(exportTaxonomyLabels('zh')[level][n.id], n.id).toBe(n.zh);
      expect(exportTaxonomyLabels('en')[level][n.id], n.id).toBe(n.en);
      expect(exportTaxonomyLabels('ja')[level][n.id], n.id).toBe(n.en);
    }
    expect(tw.roles.software_engineer).toBe('軟體工程師');
    // Data order, so a generated bundle is stable.
    expect(Object.keys(tw.roles)).toEqual(TAXONOMY_NODES.filter((n) => n.level === 3).map((n) => n.id));
    // Keys are safe next-intl segments and no value is empty.
    for (const group of Object.values(tw)) for (const [id, text] of Object.entries(group)) expect(/^[a-z][a-z0-9_]*$/.test(id) && text.trim().length > 0, id).toBe(true);
    expect(taxonomy.exportTaxonomyLabels).toBe(exportTaxonomyLabels);
    expect(taxonomy.taxonomyNodeLabel).toBe(taxonomyNodeLabel);
  });

  it('MKT-1C / JT-4: zh-TW shows a node\'s Traditional Chinese label; a hand-built node without one shows English, never Simplified', () => {
    // SYNTHETIC nodes.
    const withHant: TaxonomyNode = { id: 'fixture_role', level: 3, parent: 'fixture_group', en: 'Software engineer', zh: '软件工程师', zhHant: '軟體工程師', synonyms: { en: [], zh: [], zhHant: ['軟體開發工程師'] } };
    const without = { id: 'fixture_role_2', level: 3, parent: 'fixture_group', en: 'Data analyst', zh: '数据分析师', synonyms: { en: [], zh: [] } } as const;
    expect(taxonomyNodeLabel(withHant, 'zh-TW')).toBe('軟體工程師');
    expect(taxonomyNodeLabel(withHant, 'zh')).toBe('软件工程师');
    expect(taxonomyNodeLabel(withHant, 'en')).toBe('Software engineer');
    expect(taxonomyNodeLabel(withHant, 'ja')).toBe('Software engineer');
    expect(taxonomyNodeLabel(without, 'zh-TW')).toBe('Data analyst');
    expect(taxonomyNodeLabel({ ...without, zhHant: '  ' }, 'zh-TW')).toBe('Data analyst');
  });

  it('JT-4: validateTaxonomy fails for a node without a Taiwan label, and for a role without its Taiwan titles', () => {
    const base = { version: 1, asOf: '', sources: [] };
    const nodes = (role: Record<string, unknown>): TaxonomyNode[] => [
      { id: 'cat', level: 1, parent: null, en: 'Category', zh: '类别', zhHant: '類別', synonyms: { en: [], zh: [] } },
      { id: 'grp', level: 2, parent: 'cat', en: 'Group', zh: '组', zhHant: '群組', synonyms: { en: [], zh: [], zhHant: [] } },
      { id: 'role', level: 3, parent: 'grp', en: 'Role', zh: '角色', zhHant: '角色', synonyms: { en: [], zh: [], zhHant: ['職位'] }, ...role } as TaxonomyNode,
    ];
    expect(validateTaxonomy({ ...base, nodes: nodes({}) })).toEqual([]);
    expect(validateTaxonomy({ ...base, nodes: nodes({ synonyms: { en: [], zh: [], zhHant: [] } }) })).toEqual([]);
    expect(validateTaxonomy({ ...base, nodes: nodes({ zhHant: undefined }) })).toEqual(['role has no Traditional Chinese label']);
    expect(validateTaxonomy({ ...base, nodes: nodes({ zhHant: ' ' }) })).toEqual(['role has no Traditional Chinese label']);
    expect(validateTaxonomy({ ...base, nodes: nodes({ zhHant: 42 }) })).toEqual(['role has no Traditional Chinese label']);
    expect(validateTaxonomy({ ...base, nodes: nodes({ synonyms: { en: [], zh: [] } }) })).toEqual(['role has no Traditional Chinese synonym list']);
    expect(validateTaxonomy({ ...base, nodes: nodes({ synonyms: { en: [], zh: [], zhHant: ['職位', ' '] } }) })).toEqual(['role has a blank Traditional Chinese synonym']);
    // The shipped file with one label removed fails the same way.
    const broken = TAXONOMY_NODES.map((n) => (n.id === 'software_engineer' ? ({ ...n, zhHant: '' } as TaxonomyNode) : n));
    expect(validateTaxonomy({ ...base, nodes: broken })).toEqual(['software_engineer has no Traditional Chinese label']);
  });
});

describe('i18n bundle', () => {
  it('has one English label per category and group, equal to the data', () => {
    // The `taxonomy` namespace of the English web bundle (WP-91 merged it out of i18n/staging/taxonomy.en.json).
    const english = JSON.parse(readFileSync(path.join(repoRoot, 'i18n/messages/en.json'), 'utf8')) as {
      taxonomy: { categories: Record<string, string>; groups: Record<string, string> };
    };
    const bundle = { taxonomy: english.taxonomy };
    expect(Object.keys(bundle.taxonomy).sort()).toEqual(['categories', 'groups']);
    const l1 = Object.fromEntries(TAXONOMY_NODES.filter((n) => n.level === 1).map((n) => [n.id, n.en]));
    const l2 = Object.fromEntries(TAXONOMY_NODES.filter((n) => n.level === 2).map((n) => [n.id, n.en]));
    expect(bundle.taxonomy.categories).toEqual(l1);
    expect(bundle.taxonomy.groups).toEqual(l2);
    const text = JSON.stringify(bundle);
    expect(text).not.toMatch(/RoboApply|GoApply|\bunlimited\b|\bats\b|\bjd\b/i);
  });

  it('JT-4: the Taiwan labels of categories and groups are the ones the zh-TW web bundle ships', () => {
    // Explore chips read the bundle; the server reads the data file (`taxonomyLabel(id, 'zh-TW')`: typeahead
    // context, onboarding defaults). One wording for both: the 77 labels here ARE the bundle's, which went
    // through the locale pass and the variant check. Changing one is a change to both files.
    const taiwan = JSON.parse(readFileSync(path.join(repoRoot, 'i18n/messages/zh-TW.json'), 'utf8')) as {
      taxonomy: { categories: Record<string, string>; groups: Record<string, string> };
    };
    const exported = exportTaxonomyLabels('zh-TW');
    expect(exported.categories).toEqual(taiwan.taxonomy.categories);
    expect(exported.groups).toEqual(taiwan.taxonomy.groups);
    expect(Object.keys(exported.categories)).toHaveLength(22);
    expect(Object.keys(exported.groups)).toHaveLength(55);
  });
});
