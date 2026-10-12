// Mainland portal adapters (WP-71): ≥3 fixtures each — detection, job, field
// coverage with the cn field map, round-trip, resume attach, no presses.

import { describe, expect, it } from 'vitest';

import { beisenAdapter } from '../../src/adapters/cn/beisen';
import { dayeeAdapter } from '../../src/adapters/cn/dayee';
import { feishuAdapter } from '../../src/adapters/cn/feishu';
import { genericCnAdapter } from '../../src/adapters/cn/generic';
import { CN_ADAPTERS, CN_PORTAL_ADAPTERS } from '../../src/adapters/cn/index';
import { mokaAdapter } from '../../src/adapters/cn/moka';
import { runCnFixtureCases } from './harness';
import { loadCnFixture } from './helpers';

describe('Moka adapter', () => {
  runCnFixtureCases(mokaAdapter, 'moka', [
    {
      name: 'campus',
      url: 'https://app.mokahr.com/campus-recruitment/example/12345#/job/abc/apply',
      job: { title: '后端开发工程师（2026届）', company: '示例科技', location: '上海' },
      fields: [
        { label: '附件简历', kind: 'file', cn: '-', required: true },
        { label: '姓名', kind: 'text', cn: 'name', required: true },
        { label: '手机号码', kind: 'text', cn: 'phone', required: true },
        { label: '邮箱', kind: 'text', cn: 'email', required: true },
        { label: '性别', kind: 'combobox', cn: 'gender', required: true },
        { label: '出生日期', kind: 'text', cn: 'birthDate' },
        { label: '籍贯', kind: 'text', cn: 'nativePlace' },
        { label: '政治面貌', kind: 'combobox', cn: 'politicalStatus' },
        { label: '生源地', kind: 'text', cn: 'sourcePlace' },
        { label: '学校名称', kind: 'text', cn: 'school', row: 0, required: true },
        { label: '学历', kind: 'combobox', cn: 'degree', row: 0 },
        { label: '专业', kind: 'text', cn: 'major', row: 0 },
        { label: '入学时间', kind: 'text', cn: 'eduStart', row: 0 },
        { label: '毕业时间', kind: 'text', cn: 'eduEnd', row: 0 },
        { label: '学校名称', kind: 'text', cn: 'school', row: 1, required: false },
        { label: '学历', kind: 'combobox', cn: 'degree', row: 1 },
        { label: '专业', kind: 'text', cn: 'major', row: 1 },
        { label: '入学时间', kind: 'text', cn: 'eduStart', row: 1 },
        { label: '毕业时间', kind: 'text', cn: 'eduEnd', row: 1 },
        { label: '个人照片', kind: 'file', cn: 'photo' },
      ],
      roundTrip: [
        { id: 'name', value: '王小明' },
        { id: 'political', value: '共青团员' },
        { id: 'edu1_degree', value: '本科' },
        { id: 'edu0_end', value: '2026-06' },
      ],
      resume: 'resume',
    },
    {
      name: 'intern',
      url: 'https://app.mokahr.com/apply/sample/678#/job/def',
      job: { title: '数据分析实习生', company: '样例互联网', location: '北京' },
      fields: [
        { label: '姓名', kind: 'text', cn: 'name', required: true },
        { label: '手机号码', kind: 'text', cn: 'phone' },
        { label: '邮箱', kind: 'text', cn: 'email' },
        { label: '微信号', kind: 'text', cn: 'wechat' },
        { label: '公司名称', kind: 'text', cn: 'company', row: 0 },
        { label: '职位名称', kind: 'text', cn: 'title', row: 0 },
        { label: '开始时间', kind: 'text', cn: 'expStart', row: 0 },
        { label: '结束时间', kind: 'text', cn: 'expEnd', row: 0 },
        { label: '工作描述', kind: 'textarea', cn: null },
        { label: '每周可实习天数', kind: 'select', cn: 'internDays', required: true },
        { label: '实习时长', kind: 'select', cn: 'internMonths' },
        { label: '最快到岗时间', kind: 'text', cn: 'availableFrom' },
        { label: '自我评价', kind: 'textarea', cn: '-' },
        { label: '附件简历', kind: 'file', cn: '-', required: true },
      ],
      roundTrip: [
        { id: 'f_days', value: '4天' },
        { id: 'f_months', value: '6个月' },
        { id: 'exp0_company', value: '示例网络科技' },
      ],
      resume: 'f_resume',
    },
    {
      name: 'social',
      url: 'https://app.mokahr.com/social-recruitment/demo/9#/job/ghi/apply',
      job: { title: '机械设计工程师', company: '演示制造' },
      fields: [
        { label: '姓名', kind: 'text', cn: 'name' },
        { label: '手机', kind: 'text', cn: 'phone' },
        { label: '电子邮箱', kind: 'text', cn: 'email' },
        { label: '政治面貌', kind: 'select', cn: 'politicalStatus' },
        { label: '简历', kind: 'file', cn: '-' },
        { label: '关系', kind: 'select', cn: 'familyRelation', row: 0 },
        { label: '姓名', kind: 'text', cn: 'familyName', row: 0 },
        { label: '工作单位', kind: 'text', cn: 'familyEmployer', row: 0 },
        { label: '职务', kind: 'text', cn: 'familyTitle', row: 0 },
        { label: '关系', kind: 'select', cn: 'familyRelation', row: 1 },
        { label: '姓名', kind: 'text', cn: 'familyName', row: 1 },
        { label: '工作单位', kind: 'text', cn: 'familyEmployer', row: 1 },
        { label: '职务', kind: 'text', cn: 'familyTitle', row: 1 },
      ],
      roundTrip: [
        { id: 'fm1_rel', value: '母亲' },
        { id: 'fm0_name', value: '王某' },
      ],
      resume: 's_resume',
    },
  ]);
});

describe('Beisen adapter', () => {
  runCnFixtureCases(beisenAdapter, 'beisen', [
    {
      name: 'campus',
      url: 'https://example.zhiye.com/campus/jobs/apply?jobId=1',
      job: { title: '储备干部（管培生）', company: '示范能源', location: '成都' },
      fields: [
        { label: '姓名', kind: 'text', cn: 'name', required: true },
        { label: '手机号码', kind: 'text', cn: 'phone', required: true },
        { label: '电子邮箱', kind: 'text', cn: 'email', required: true },
        { label: '性别', kind: 'radio', cn: 'gender', required: true },
        { label: '出生年月', kind: 'text', cn: 'birthDate' },
        { label: '政治面貌', kind: 'combobox', cn: 'politicalStatus', required: false },
        { label: '学校', kind: 'text', cn: 'school', row: 0 },
        { label: '学历', kind: 'select', cn: 'degree', row: 0 },
        { label: '专业', kind: 'text', cn: 'major', row: 0 },
        { label: '入学时间', kind: 'date', cn: 'eduStart' },
        { label: '毕业时间', kind: 'date', cn: 'eduEnd' },
        { label: '简历附件', kind: 'file', cn: '-', required: true },
      ],
      roundTrip: [
        { id: 'bs_political', value: '群众' },
        { id: 'bs_degree', value: '硕士' },
        { id: 'bs_end', value: '2026-06' },
      ],
      resume: 'bs_resume',
    },
    {
      name: 'intern',
      url: 'https://sample.zhiye.com/intern/apply/2',
      job: { title: '投行部实习生', company: '模拟证券' },
      fields: [
        { label: '真实姓名', kind: 'text', cn: 'name', required: true },
        { label: '联系电话', kind: 'text', cn: 'phone' },
        { label: '邮箱地址', kind: 'text', cn: 'email' },
        { label: '实习单位', kind: 'text', cn: 'company' },
        { label: '岗位', kind: 'text', cn: 'title' },
        { label: '开始时间', kind: 'text', cn: 'expStart' },
        { label: '结束时间', kind: 'text', cn: 'expEnd' },
        { label: '每周可实习天数', kind: 'radio', cn: 'internDays', required: true },
        { label: '到岗时间', kind: 'text', cn: 'availableFrom' },
        { label: '为什么想加入我们', kind: 'textarea', cn: '-' },
        { label: '上传简历', kind: 'file', cn: '-' },
      ],
      roundTrip: [
        { id: 'i_days', value: '4天' },
        { id: 'i_from', value: '2025年06月' },
      ],
      resume: 'i_cv',
    },
    {
      name: 'family',
      url: 'https://bank.zhiye.com/social/apply/3',
      job: { title: '柜面服务岗', company: '样本银行' },
      fields: [
        { label: '姓名', kind: 'text', cn: 'name' },
        { label: '手机号码', kind: 'text', cn: 'phone' },
        { label: '邮箱', kind: 'text', cn: 'email' },
        { label: '籍贯', kind: 'text', cn: 'nativePlace' },
        { label: '户口所在地', kind: 'text', cn: 'hukou' },
        { label: '称谓', kind: 'text', cn: 'familyRelation', row: 0 },
        { label: '姓名', kind: 'text', cn: 'familyName', row: 0 },
        { label: '工作单位', kind: 'text', cn: 'familyEmployer', row: 0 },
        { label: '职务', kind: 'text', cn: 'familyTitle', row: 0 },
        { label: '联系电话', kind: 'text', cn: null },
        { label: '称谓', kind: 'text', cn: 'familyRelation', row: 1 },
        { label: '姓名', kind: 'text', cn: 'familyName', row: 1 },
        { label: '工作单位', kind: 'text', cn: 'familyEmployer', row: 1 },
        { label: '职务', kind: 'text', cn: 'familyTitle', row: 1 },
        { label: '联系电话', kind: 'text', cn: null },
        { label: '附件简历', kind: 'file', cn: '-' },
      ],
      roundTrip: [{ id: 'm1_org', value: '示例小学' }],
      resume: 'b_resume',
    },
  ]);
});

describe('Feishu adapter', () => {
  runCnFixtureCases(feishuAdapter, 'feishu', [
    {
      name: 'campus',
      url: 'https://example.jobs.feishu.cn/campus/position/123/apply',
      job: { title: '算法工程师-2026届', company: '示例智能', location: '杭州' },
      fields: [
        { label: '简历', kind: 'file', cn: '-', required: true },
        { label: '姓名', kind: 'text', cn: 'name', required: true },
        { label: '手机号码', kind: 'tel', cn: 'phone', required: true },
        { label: '邮箱', kind: 'email', cn: 'email', required: true },
        { label: '毕业时间', kind: 'date', cn: 'graduation' },
        { label: '学校', kind: 'text', cn: 'school', required: true },
        { label: '学历', kind: 'combobox', cn: 'degree', required: true },
        { label: '专业', kind: 'text', cn: 'major', required: false },
        { label: '开始时间', kind: 'date', cn: 'eduStart' },
        { label: '结束时间', kind: 'date', cn: 'eduEnd' },
      ],
      roundTrip: [
        { id: 'fs_degree', value: '硕士' },
        { id: 'fs_grad', value: '2026-06' },
      ],
      resume: 'fs_resume',
    },
    {
      name: 'intern',
      url: 'https://sample.jobs.feishu.cn/intern/position/456/apply',
      job: { title: '产品运营实习生', company: '样例出行' },
      fields: [
        { label: '姓名', kind: 'text', cn: 'name' },
        { label: '手机号', kind: 'text', cn: 'phone' },
        { label: '邮箱', kind: 'text', cn: 'email' },
        { label: '微信号', kind: 'text', cn: 'wechat' },
        { label: '公司名称', kind: 'text', cn: 'company' },
        { label: '职位名称', kind: 'text', cn: 'title' },
        { label: '开始时间', kind: 'date', cn: 'expStart' },
        { label: '结束时间', kind: 'date', cn: 'expEnd' },
        { label: '每周实习天数', kind: 'select', cn: 'internDays', required: true },
        { label: '实习时长', kind: 'select', cn: 'internMonths' },
        { label: '最快到岗时间', kind: 'text', cn: 'availableFrom' },
        { label: '简历', kind: 'file', cn: '-' },
      ],
      roundTrip: [
        { id: 'fi_len', value: '3个月' },
        { id: 'fi_from', value: '2025-06' },
      ],
      resume: 'fi_resume',
    },
    {
      name: 'experienced',
      url: 'https://demo.jobs.feishu.cn/social/position/789/apply',
      job: { title: '高级前端工程师', company: '演示云', location: '深圳' },
      fields: [
        { label: '姓名', kind: 'text', cn: 'name' },
        { label: '手机号码', kind: 'text', cn: 'phone' },
        { label: '邮箱', kind: 'text', cn: 'email' },
        { label: '民族', kind: 'text', cn: 'ethnicity' },
        { label: '婚姻状况', kind: 'select', cn: 'marital' },
        { label: '身份证号', kind: 'text', cn: 'idNumber', required: true },
        { label: '公司', kind: 'text', cn: 'company', row: 0 },
        { label: '职位', kind: 'text', cn: 'title', row: 0 },
        { label: '入职时间', kind: 'text', cn: 'expStart', row: 0 },
        { label: '离职时间', kind: 'text', cn: 'expEnd', row: 0 },
        { label: '公司', kind: 'text', cn: 'company', row: 1 },
        { label: '职位', kind: 'text', cn: 'title', row: 1 },
        { label: '入职时间', kind: 'text', cn: 'expStart', row: 1 },
        { label: '离职时间', kind: 'text', cn: 'expEnd', row: 1 },
        { label: '附件简历', kind: 'file', cn: '-', required: true },
      ],
      roundTrip: [{ id: 'fe1_company', value: '演示云' }],
      resume: 'fe_resume',
    },
  ]);
});

describe('Dayee adapter', () => {
  runCnFixtureCases(dayeeAdapter, 'dayee', [
    {
      name: 'campus',
      url: 'https://wecruit.hotjob.cn/SU61234/pb/apply.html',
      job: { title: '质量管理培训生', company: '示例食品', location: '广州' },
      fields: [
        { label: '姓名', kind: 'text', cn: 'name', required: true },
        { label: '性别', kind: 'select', cn: 'gender', required: true },
        { label: '出生日期', kind: 'date', cn: 'birthDate' },
        { label: '手机', kind: 'text', cn: 'phone', required: true },
        { label: '电子邮箱', kind: 'text', cn: 'email', required: true },
        { label: '籍贯', kind: 'text', cn: 'nativePlace' },
        { label: '政治面貌', kind: 'select', cn: 'politicalStatus' },
        { label: '生源地', kind: 'text', cn: 'sourcePlace' },
        { label: '学校名称', kind: 'text', cn: 'school' },
        { label: '学历', kind: 'select', cn: 'degree' },
        { label: '专业', kind: 'text', cn: 'major' },
        { label: '入学时间', kind: 'text', cn: 'eduStart' },
        { label: '毕业时间', kind: 'text', cn: 'eduEnd' },
        { label: '简历附件', kind: 'file', cn: '-' },
      ],
      roundTrip: [
        { id: 'political', value: '共青团员' },
        { id: 'mobile', value: '13800138000' },
      ],
      resume: 'attachment',
    },
    {
      name: 'family',
      url: 'https://grid.dayee.com/campus/apply/7',
      job: { title: '变电运维岗', company: '样本电网' },
      fields: [
        { label: '姓名', kind: 'text', cn: 'name', required: true },
        { label: '手机号码', kind: 'text', cn: 'phone' },
        { label: '邮箱', kind: 'text', cn: 'email' },
        { label: '政治面貌', kind: 'text', cn: 'politicalStatus' },
        ...[0, 1, 2].flatMap((row) => [
          { label: '关系', kind: 'text' as const, cn: 'familyRelation', row },
          { label: '姓名', kind: 'text' as const, cn: 'familyName', row },
          { label: '工作单位', kind: 'text' as const, cn: 'familyEmployer', row },
          { label: '职务', kind: 'text' as const, cn: 'familyTitle', row },
        ]),
        { label: '个人简历', kind: 'file', cn: '-' },
      ],
      roundTrip: [{ id: 'fam2_title', value: '会计' }],
      resume: 'd_cv',
    },
    {
      name: 'social',
      url: 'https://logistics.dayee.com/social/apply/8',
      job: { title: '仓储主管', company: '演示物流', location: '武汉' },
      fields: [
        { label: '姓名', kind: 'text', cn: 'name' },
        { label: '手机', kind: 'text', cn: 'phone' },
        { label: '电子邮件', kind: 'text', cn: 'email' },
        { label: '户口所在地', kind: 'text', cn: 'hukou' },
        ...[0, 1].flatMap((row) => [
          { label: '公司名称', kind: 'text' as const, cn: 'company', row },
          { label: '职位', kind: 'text' as const, cn: 'title', row },
          { label: '开始时间', kind: 'text' as const, cn: 'expStart', row },
          { label: '结束时间', kind: 'text' as const, cn: 'expEnd', row },
        ]),
        { label: '自我评价', kind: 'textarea', cn: '-' },
        { label: '简历', kind: 'file', cn: '-' },
      ],
      roundTrip: [{ id: 'w0_from', value: '2025-06' }],
      resume: 'x_cv',
    },
  ]);
});

describe('generic adapter (label heuristics)', () => {
  runCnFixtureCases(
    genericCnAdapter,
    'generic',
    [
      {
        name: 'self-built',
        url: 'https://careers.example-games.cn/apply/1',
        job: { title: '游戏客户端开发', company: '示例游戏' },
        fields: [
          { label: '姓名', kind: 'text', cn: 'name', required: true },
          { label: '手机号码', kind: 'tel', cn: 'phone', required: true },
          { label: '邮箱', kind: 'email', cn: 'email', required: true },
          { label: '学校', kind: 'text', cn: 'school' },
          { label: '学历', kind: 'select', cn: 'degree' },
          { label: '专业', kind: 'text', cn: 'major' },
          { label: '简历', kind: 'file', cn: '-' },
        ],
        roundTrip: [{ id: 'g_degree', value: '硕士' }],
        resume: 'g_cv',
      },
      {
        name: 'div-labels',
        url: 'https://hr.example-auto.cn/campus/apply',
        job: { title: '电池研发工程师' },
        fields: [
          { label: '姓名', kind: 'text', cn: 'name' },
          { label: '手机', kind: 'text', cn: 'phone' },
          { label: '邮箱', kind: 'text', cn: 'email' },
          { label: '政治面貌', kind: 'text', cn: 'politicalStatus' },
          { label: '学校', kind: 'text', cn: 'school' },
          { label: '专业', kind: 'text', cn: 'major' },
          { label: '简历', kind: 'file', cn: '-' },
        ],
        roundTrip: [{ id: 'xm', value: '王小明' }],
        resume: 'cv',
      },
      {
        name: 'table-form',
        url: 'https://www.example-institute.cn/recruit/apply',
        job: { title: '科研助理' },
        fields: [
          { label: '姓名', kind: 'text', cn: 'name' },
          { label: '性别', kind: 'select', cn: 'gender' },
          { label: '手机号码', kind: 'text', cn: 'phone' },
          { label: '电子邮箱', kind: 'text', cn: 'email' },
          { label: '最高学历', kind: 'text', cn: 'degree' },
          { label: '毕业院校', kind: 'text', cn: 'school' },
          { label: '简历', kind: 'file', cn: '-' },
        ],
        roundTrip: [{ id: 'school', value: '示例大学' }],
        resume: 'cv',
      },
    ],
    { otherHost: 'https://www.zhipin.com/job_detail/1.html' },
  );

  it('div-labels: reads aria labels and section rows', () => {
    const doc = loadCnFixture('generic', 'div-labels');
    expect(genericCnAdapter.matches(new URL('https://hr.example-auto.cn/campus/apply'), doc)).toBe(true);
    expect(genericCnAdapter.listFields(doc).map((f) => f.label)).toEqual(['姓名', '手机', '邮箱', '政治面貌', '学校', '专业', '简历']);
  });

  it('does not treat a sign-up box as an application form', () => {
    const doc = loadCnFixture('generic', 'not-a-form');
    expect(genericCnAdapter.matches(new URL('https://careers.example.cn/subscribe'), doc)).toBe(false);
    for (const a of CN_ADAPTERS) expect(a.matches(new URL('https://app.mokahr.com/subscribe'), doc)).toBe(false);
  });

  it('never runs on job boards', () => {
    const doc = loadCnFixture('generic', 'self-built');
    for (const host of ['https://www.zhipin.com/x', 'https://www.liepin.com/x', 'https://jobs.51job.com/x', 'https://www.linkedin.com/jobs/1']) {
      expect(genericCnAdapter.matches(new URL(host), doc)).toBe(false);
    }
  });

  it('shows the page host as the site name and holds no host permission', () => {
    expect(genericCnAdapter.siteName).toBe(location.hostname);
    expect(genericCnAdapter.hostPatterns).toEqual([]);
  });
});

describe('cn adapter list', () => {
  it('ships Moka, Beisen, Feishu, Dayee, then the generic fallback', () => {
    expect(CN_ADAPTERS.map((a) => a.id)).toEqual(['moka', 'beisen', 'feishu', 'dayee', 'generic']);
    expect(CN_PORTAL_ADAPTERS.map((a) => a.id)).toEqual(['moka', 'beisen', 'feishu', 'dayee']);
  });

  it('no adapter has a submit or next method (D1)', () => {
    for (const a of CN_ADAPTERS) {
      for (const k of Object.keys(a)) expect(/submit|next|continue|send/i.test(k), `${a.id}.${k}`).toBe(false);
    }
  });

  it('each portal adapter matches only its own hosts', () => {
    const doc = loadCnFixture('moka', 'campus');
    expect(mokaAdapter.matches(new URL('https://app.mokahr.com/x'), doc)).toBe(true);
    expect(mokaAdapter.matches(new URL('https://mokahr.com.evil.example/x'), doc)).toBe(false);
    expect(beisenAdapter.matches(new URL('https://app.mokahr.com/x'), doc)).toBe(false);
  });
});
