// MKT-3G (MARKET_STRATEGY JC-5) — the "search other job sites" links on GoApply:
// the order the server sends is the order shown; sites for both audiences
// appear as two groups with the user's own group first; one audience is one
// list with no group heading; every link opens in a new tab without a
// referrer; nothing is shown as a link when the server sends none.
//
// SYNTHETIC: the link addresses below are made up under the reserved `.test`
// domain (the component shows whatever address the server sends).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../../../__tests__/shell/helpers';

const api = vi.hoisted(() => ({ getExternalLinks: vi.fn() }));
vi.mock('../../../../../lib/api/cnJobs', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));

import { ExternalSearchLinks, ExternalSearchPanel } from '..';
import { groupExternalLinks, type ExternalLinkView } from '../../../../../lib/api/cnJobs';
import stagedEn from '../../../../../i18n/staging/jobsCn.en.json';
import stagedZh from '../../../../../i18n/staging/jobsCn.zh.json';

const link = (board: string, label: string, audience?: 'campus' | 'experienced' | 'both'): ExternalLinkView =>
  ({ board, label, url: `https://${board}.search.test/jobs?q=x`, ...(audience ? { audience } : {}) }) as ExternalLinkView;

const CAMPUS = [link('shixiseng', '实习僧', 'campus'), link('nowcoder', '牛客', 'campus'), link('ncss', '24365', 'campus'), link('iguopin', '国聘', 'campus')];
const GENERAL = [
  link('boss', 'BOSS直聘', 'experienced'),
  link('zhaopin', '智联招聘', 'experienced'),
  link('liepin', '猎聘', 'experienced'),
  link('job51', '前程无忧', 'experienced'),
  link('lagou', '拉勾', 'experienced'),
];
const NAMES = [...CAMPUS, ...GENERAL].map((l) => l.label);

const namesIn = (el: HTMLElement) => within(el).getAllByRole('link').map((a) => a.textContent!.replace(/\s*\(opens in a new tab\)$/, '').replace(/^Search on /, ''));

beforeEach(() => {
  api.getExternalLinks.mockReset();
});

describe('groupExternalLinks', () => {
  it('keeps the server order: the group of the first link comes first', () => {
    expect(groupExternalLinks([...CAMPUS, ...GENERAL]).map((g) => [g.audience, g.links.map((l) => l.board)])).toEqual([
      ['campus', ['shixiseng', 'nowcoder', 'ncss', 'iguopin']],
      ['experienced', ['boss', 'zhaopin', 'liepin', 'job51', 'lagou']],
    ]);
    expect(groupExternalLinks([...GENERAL, ...CAMPUS]).map((g) => g.audience)).toEqual(['experienced', 'campus']);
  });

  it('one audience is one group; no links is no group', () => {
    expect(groupExternalLinks(GENERAL.slice(0, 3))).toEqual([{ audience: 'experienced', links: GENERAL.slice(0, 3) }]);
    expect(groupExternalLinks(CAMPUS)).toHaveLength(1);
    expect(groupExternalLinks([])).toEqual([]);
    expect(groupExternalLinks(null)).toEqual([]);
    expect(groupExternalLinks(undefined)).toEqual([]);
  });

  it('a link with no audience counts as general; a link for both joins the first group', () => {
    const old = [link('boss', 'BOSS直聘'), link('zhaopin', '智联招聘')];
    expect(groupExternalLinks(old)).toEqual([{ audience: 'experienced', links: old }]);
    const odd = { ...link('x', 'X'), audience: 'alumni' } as unknown as ExternalLinkView;
    expect(groupExternalLinks([odd]).map((g) => g.audience)).toEqual(['experienced']);
    const both = link('any', 'Any', 'both');
    expect(groupExternalLinks([both, ...CAMPUS, ...GENERAL]).map((g) => [g.audience, g.links.length])).toEqual([
      ['campus', 5],
      ['experienced', 5],
    ]);
    expect(groupExternalLinks([...GENERAL, both, ...CAMPUS]).map((g) => [g.audience, g.links.length])).toEqual([
      ['experienced', 6],
      ['campus', 4],
    ]);
    expect(groupExternalLinks([both])).toEqual([{ audience: 'experienced', links: [both] }]);
  });

  it('drops an entry that is not a link', () => {
    const broken = [null, { board: 'boss' }, link('liepin', '猎聘', 'experienced')] as unknown as ExternalLinkView[];
    expect(groupExternalLinks(broken).flatMap((g) => g.links.map((l) => l.board))).toEqual(['liepin']);
  });
});

describe('ExternalSearchLinks: groups', () => {
  it('a campus user with nine links: the campus group first with four links, then the general group with five', async () => {
    api.getExternalLinks.mockResolvedValue({ links: [...CAMPUS, ...GENERAL] });
    renderWithBrand(<ExternalSearchLinks query="管培生" city="成都" />, { brand: 'goapply' });
    const groups = await screen.findAllByTestId('cn-external-group');
    expect(groups.map((g) => g.getAttribute('data-audience'))).toEqual(['campus', 'experienced']);
    expect(namesIn(groups[0]!)).toEqual(['实习僧', '牛客', '24365', '国聘']);
    expect(namesIn(groups[1]!)).toEqual(['BOSS直聘', '智联招聘', '猎聘', '前程无忧', '拉勾']);
    // Each group is named by its heading; the campus group has its one line.
    expect(within(groups[0]!).getByRole('heading', { level: 4, name: 'Campus hiring and internship sites' })).toBeInTheDocument();
    expect(within(groups[1]!).getByRole('heading', { level: 4, name: 'General job sites' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Campus hiring and internship sites' })).toBe(groups[0]);
    expect(screen.getByRole('group', { name: 'General job sites' })).toBe(groups[1]);
    expect(groups[0]).toHaveTextContent('Useful for campus hiring, internships and jobs for new graduates.');
    expect(groups[1]).not.toHaveTextContent('Useful for campus hiring');
    // The page order is the server order.
    expect(namesIn(screen.getByTestId('cn-external-links'))).toEqual(NAMES);
    expect(api.getExternalLinks).toHaveBeenCalledWith({ q: '管培生', city: '成都' }, expect.anything());
  });

  it('an experienced user with nine links: the general group first', async () => {
    api.getExternalLinks.mockResolvedValue({ links: [...GENERAL, ...CAMPUS] });
    renderWithBrand(<ExternalSearchLinks query="后端开发" />, { brand: 'goapply' });
    const groups = await screen.findAllByTestId('cn-external-group');
    expect(groups.map((g) => g.getAttribute('data-audience'))).toEqual(['experienced', 'campus']);
    expect(namesIn(groups[0]!)).toHaveLength(5);
    expect(namesIn(groups[1]!)).toHaveLength(4);
  });

  it('every link opens that site in a new tab, with no opener and no referrer, at the address the server sent', async () => {
    api.getExternalLinks.mockResolvedValue({ links: [...CAMPUS, ...GENERAL] });
    renderWithBrand(<ExternalSearchLinks query="产品" />, { brand: 'goapply' });
    await screen.findAllByTestId('cn-external-group');
    const anchors = within(screen.getByTestId('cn-external-links')).getAllByRole('link');
    expect(anchors).toHaveLength(9);
    anchors.forEach((a, i) => {
      const sent = [...CAMPUS, ...GENERAL][i]!;
      expect(a).toHaveAttribute('href', sent.url);
      expect(a).toHaveAttribute('target', '_blank');
      expect(a.getAttribute('rel')!.split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
      expect(a).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(a.textContent!.replace(/\s+/g, ' ')).toBe(`Search on ${sent.label} (opens in a new tab)`);
    });
  });

  it('three links of one audience: one list, no group and no heading besides the title', async () => {
    api.getExternalLinks.mockResolvedValue({ links: GENERAL.slice(0, 3) });
    renderWithBrand(<ExternalSearchLinks query="产品" />, { brand: 'goapply' });
    const box = screen.getByTestId('cn-external-links');
    await within(box).findByRole('link', { name: /Search on BOSS直聘/ });
    expect(namesIn(box)).toEqual(['BOSS直聘', '智联招聘', '猎聘']);
    expect(screen.queryByTestId('cn-external-group')).toBeNull();
    expect(within(box).queryByRole('group')).toBeNull();
    expect(within(box).getAllByRole('heading').map((h) => h.textContent)).toEqual(['Search other job sites']);
    expect(within(box).getAllByRole('list')).toHaveLength(1);
    expect(box).not.toHaveTextContent('General job sites');
    expect(box).not.toHaveTextContent('Campus hiring');
  });

  it('links from a server that sends no audience are one plain list', async () => {
    api.getExternalLinks.mockResolvedValue({ links: [link('boss', 'BOSS直聘'), link('zhaopin', '智联招聘')] });
    renderWithBrand(<ExternalSearchLinks query="产品" />, { brand: 'goapply' });
    await screen.findByRole('link', { name: /Search on 智联招聘/ });
    expect(screen.queryByTestId('cn-external-group')).toBeNull();
  });

  it('says what the links are: a search on that site with the user\'s own words; nothing is sent there', async () => {
    api.getExternalLinks.mockResolvedValue({ links: [...CAMPUS, ...GENERAL] });
    renderWithBrand(<ExternalSearchLinks query=" 数据分析 " />, { brand: 'goapply' });
    await screen.findAllByTestId('cn-external-group');
    const box = screen.getByTestId('cn-external-links');
    expect(box).toHaveTextContent('Opens a search for “数据分析” on that site in a new tab.');
    // The brand name is filled in by the message loader; the sentence around it is what matters here.
    expect(box).toHaveTextContent('does not sign you in there or send anything to it.');
    expect(screen.getByRole('region', { name: 'Search other job sites' })).toBe(box);
  });
});

describe('ExternalSearchLinks: nothing to link', () => {
  it('no links from the server: one honest line, no empty list, no group heading, no "opens a search" sentence', async () => {
    api.getExternalLinks.mockResolvedValue({ links: [] });
    renderWithBrand(<ExternalSearchLinks query="产品" />, { brand: 'goapply' });
    const none = await screen.findByTestId('cn-external-none');
    expect(none).toHaveTextContent('No search links are available right now.');
    const box = screen.getByTestId('cn-external-links');
    expect(within(box).queryByRole('list')).toBeNull();
    expect(within(box).queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('cn-external-group')).toBeNull();
    expect(box).not.toHaveTextContent('Opens a search for');
  });

  it('while loading and on an error there is no list and no "none" line', async () => {
    let fail!: (e: Error) => void;
    api.getExternalLinks.mockReturnValue(new Promise((_res, rej) => (fail = rej)));
    renderWithBrand(<ExternalSearchLinks query="产品" />, { brand: 'goapply' });
    const box = screen.getByTestId('cn-external-links');
    expect(box).toHaveTextContent('Preparing links…');
    expect(screen.queryByTestId('cn-external-none')).toBeNull();
    fail(new Error('down'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be prepared'));
    expect(screen.queryByTestId('cn-external-none')).toBeNull();
    expect(within(box).queryByRole('list')).toBeNull();
  });

  it('renders nothing on RoboApply or without a query, and asks the server for nothing', () => {
    renderWithBrand(<ExternalSearchLinks query="campus jobs" />, { brand: 'roboapply' });
    renderWithBrand(<ExternalSearchLinks query="   " />, { brand: 'goapply' });
    expect(screen.queryByTestId('cn-external-links')).toBeNull();
    expect(api.getExternalLinks).not.toHaveBeenCalled();
  });
});

describe('ExternalSearchPanel with grouped links', () => {
  it('the panel shows both groups for the words the user typed, and two panels on one page keep separate ids', async () => {
    api.getExternalLinks.mockResolvedValue({ links: [...CAMPUS, ...GENERAL] });
    renderWithBrand(
      <>
        <ExternalSearchPanel variant="thin" initialQuery="管培生" />
        <ExternalSearchPanel />
      </>,
      { brand: 'goapply' },
    );
    const [thin, empty] = screen.getAllByTestId('cn-external-search');
    const groups = await within(thin!).findAllByTestId('cn-external-group');
    expect(groups.map((g) => g.getAttribute('data-audience'))).toEqual(['campus', 'experienced']);
    expect(within(empty!).queryByTestId('cn-external-links')).toBeNull();
    fireEvent.change(within(empty!).getByLabelText('What job are you looking for?'), { target: { value: '运营' } });
    fireEvent.click(within(empty!).getByRole('button', { name: 'Show search links' }));
    await within(empty!).findAllByTestId('cn-external-group');
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of screen.getAllByTestId('cn-external-group')) expect(document.getElementById(g.getAttribute('aria-labelledby')!)).not.toBeNull();
  });
});

describe('staged copy (jobsCn.external)', () => {
  // Site names are server data (the copy gate bans two of them in zh copy).
  const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

  it('names no job site in English or Chinese, and has the same keys in both files', () => {
    const banned = [...NAMES, '北森', 'BOSS', 'Boss直聘', '51job', 'Lagou', 'Nowcoder', 'Shixiseng', 'Zhaopin', 'Liepin'];
    for (const bundle of [stagedEn, stagedZh]) {
      for (const s of strings(bundle.jobsCn.external)) for (const name of banned) expect(s).not.toContain(name);
    }
    const keys = (v: unknown, at = ''): string[] => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => keys(x, at ? `${at}.${k}` : k)) : [at]);
    expect(keys(stagedZh.jobsCn.external).sort()).toEqual(keys(stagedEn.jobsCn.external).sort());
    expect(keys(stagedEn.jobsCn.external)).toEqual(expect.arrayContaining(['none', 'groups.campus', 'groups.experienced', 'groups.campusNote']));
  });

  it('uses no em dash and promises nothing on the other sites', () => {
    for (const s of [...strings(stagedEn.jobsCn.external), ...strings(stagedZh.jobsCn.external)]) {
      expect(s).not.toMatch(/—|–/);
      expect(s).not.toMatch(/apply for you|we apply|替你投递|帮你投递|自动投递/);
    }
  });
});
