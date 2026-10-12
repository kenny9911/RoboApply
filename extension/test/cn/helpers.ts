// extension/test/cn/helpers.ts — mainland portal fixtures and a GoApply sample profile.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AutofillProfile } from '../../src/shared/contract';

export const CN_FIXTURES = join(__dirname, 'fixtures');

/** Load a saved portal form into the jsdom document (scripts are never run). */
export function loadCnFixture(portal: string, name: string): Document {
  const html = readFileSync(join(CN_FIXTURES, portal, `${name}.html`), 'utf8');
  const head = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
  document.head.innerHTML = head;
  document.body.innerHTML = body;
  return document;
}

/** A GoApply user: Chinese name, mainland mobile, two degrees, one internship, optional details. */
export function cnProfile(overrides: Partial<AutofillProfile> = {}): AutofillProfile {
  return {
    profile: {
      firstName: '小明',
      lastName: '王',
      email: 'xiaoming@example.test',
      phone: '+8613800138000',
      city: '长沙',
      country: 'CN',
      cnFields: { identity: 'yingjie', graduationClass: 2026, graduationMonth: 6, degree: 'master', internshipDaysPerWeek: 4, internshipMonths: '6+', availableFrom: '2026-03' },
    },
    education: [
      { school: '示例大学', degree: '硕士', major: '计算机科学与技术', startDate: '2023-09', endDate: '2026-06', current: true },
      { school: '示例理工学院', degree: '本科', major: '软件工程', startDate: '2019-09', endDate: '2023-06', current: false },
    ],
    experience: [{ company: '示例网络科技', title: '后端开发实习生', startDate: '2025-06', endDate: '2025-09', current: false }],
    links: {},
    workAuth: [],
    answers: [{ questionKey: 'sourcePlace', questionText: '生源地', answer: '湖南' }],
    sensitive: {
      cn: {
        nativePlace: '湖南长沙',
        politicalStatus: '共青团员',
        familyMembers: [
          { relation: '父亲', name: '王某', employer: '示例机械厂', title: '工程师' },
          { relation: '母亲', name: '李某', employer: '示例小学', title: '教师' },
        ],
      },
    },
    ...overrides,
  };
}
