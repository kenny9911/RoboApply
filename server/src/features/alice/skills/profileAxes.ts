// server/src/features/alice/skills/profileAxes.ts — the ways two job profiles can differ.
//
// Alice writes two profiles that differ on purpose, along the one question the
// person's answers leave open. The Goal analyst picks the axis by id from this
// index; the Profile writer receives the chosen axis's full directive. Two
// profiles that differ only in wording teach the person nothing, so each axis
// says how the two sides must read apart.

import type { AliceAxisId } from '../contract.js';

export interface ProfileAxis {
  id: AliceAxisId;
  /** When this is the open question. */
  when: string;
  /** How side A and side B read. */
  sides: readonly [string, string];
  /** What must differ between the two profiles, field by field. */
  differ: string;
}

export const PROFILE_AXES: readonly ProfileAxis[] = [
  {
    id: 'scope',
    when: 'They want a bigger title or more responsibility than the resume shows, or are unsure which level to aim at.',
    sides: ['The same level, at a better place for them', 'One step up, where the resume can carry it'],
    differ: 'levels and titles differ by one step; must-haves name the scope (team size, ownership); the step-up side names the evidence that supports it and the risk.',
  },
  {
    id: 'field',
    when: 'They mention an industry they have not worked in, or the resume spans two fields.',
    sides: ['Their current field, deeper', 'An adjacent field their experience transfers to'],
    differ: 'industries differ; companies differ; whyItFits names the transferable experience on the adjacent side.',
  },
  {
    id: 'companyStage',
    when: 'They are open on the kind of company, or name both mission and stability as wants.',
    sides: ['A start-up or scale-up: range, speed and ownership', 'An established company: structure, depth and stability'],
    differ: 'companyKinds and companySizes differ; mustHaves and tradeoff state what each gives up (stability against range).',
  },
  {
    id: 'workSetting',
    when: 'Where they want to live and how they want to work pull apart (remote wished for, roles mostly in offices).',
    sides: ['Remote first, a wider market of companies', 'Hybrid or in the office in their city, more roles to choose from'],
    differ: 'workModels and places differ; tradeoff names the size of the market each opens.',
  },
  {
    id: 'rolePath',
    when: 'The resume shows some leading of people or projects, or they mention managing.',
    sides: ['Keep building as an individual expert', 'Lead people'],
    differ: 'titles differ (an expert title against a lead or manager title); mustHaves name the kind of work day; levels may differ.',
  },
  {
    id: 'payVsGrowth',
    when: 'Pay is a priority and so is learning or mission, and the two point to different employers.',
    sides: ['Pay first', 'Growth first'],
    differ: 'pay floors differ; companies and companyKinds differ; tradeoff states plainly what each side costs.',
  },
  {
    id: 'breadth',
    when: 'Their skills span several areas and they have not said which to lead with.',
    sides: ['A specialist role on their strongest skill', 'A broader role that uses more of what they can do'],
    differ: 'titles and skills differ; companySizes often differ (specialists in larger companies, broad roles in smaller ones).',
  },
];

export function axisById(id: string): ProfileAxis {
  return PROFILE_AXES.find((a) => a.id === id) ?? PROFILE_AXES[0];
}

/** The compact index the Goal analyst reads. */
export function renderAxisIndex(): string {
  return PROFILE_AXES.map((a) => `- ${a.id}: when ${a.when} Sides: (A) ${a.sides[0]} / (B) ${a.sides[1]}.`).join('\n');
}

/** The full directive the Profile writer receives for the chosen axis. */
export function axisDirective(id: string): string {
  const a = axisById(id);
  return `The two profiles differ along "${a.id}": profile A is "${a.sides[0]}", profile B is "${a.sides[1]}". What must differ: ${a.differ}`;
}
