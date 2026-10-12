// @vitest-environment node
//
// WP-54 acceptance: the LinkedIn Connections.csv parser keeps name, company,
// position and connected-on only. No email value (and no profile URL)
// survives parsing.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createCreditTestKit } from '../../platform/credits/testkit.js';
import { ConnectionsCsvError, parseConnectedOn, parseCsvRows, parseLinkedInConnections } from './connectionsCsv.js';
import { createNetworkFixture } from './testkit.js';

const EXPORT = [
  'Notes:',
  '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email. You can learn more here https://www.linkedin.com/help/linkedin/answer/261"',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Ada,Lovelace,https://www.linkedin.com/in/ada-lovelace,ada@analytical.example,"Acme Analytics, Inc.",Staff Engineer,15 Mar 2021',
  'Grace,Hopper,https://www.linkedin.com/in/grace,,Navy Labs,"Rear Admiral, ""Amazing Grace""",02 Jan 2019',
  'Alan,Turing,https://www.linkedin.com/in/alan,alan.turing@bletchley.example,,Researcher,07 Jun 2018',
  ',,https://www.linkedin.com/in/anon,anon@nowhere.example,Hidden Co,,01 Feb 2020',
  'Ada,Lovelace,https://www.linkedin.com/in/ada-lovelace-2,ada2@analytical.example,acme analytics inc,Engineer,16 Mar 2021',
  'Linus,Torvalds,https://www.linkedin.com/in/linus,linus@kernel.example,Linux Foundation,Fellow,03/15/2020',
  '',
].join('\r\n');

const EMAILS = ['ada@analytical.example', 'alan.turing@bletchley.example', 'anon@nowhere.example', 'ada2@analytical.example', 'linus@kernel.example'];

describe('parseLinkedInConnections', () => {
  const parsed = parseLinkedInConnections(EXPORT);

  it('reads the rows after the Notes preamble', () => {
    expect(parsed.rowCount).toBe(6);
    expect(parsed.connections.map((c) => c.fullName)).toEqual(['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds']);
  });

  it('keeps only name, company, position and connected-on', () => {
    const ada = parsed.connections[0]!;
    expect(Object.keys(ada).sort()).toEqual(['company', 'connectedOn', 'firstName', 'fullName', 'lastName', 'position']);
    expect(ada).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', company: 'Acme Analytics, Inc.', position: 'Staff Engineer' });
    expect(ada.connectedOn?.toISOString()).toBe('2021-03-15T00:00:00.000Z');
    expect(parsed.connections[1]!.position).toBe('Rear Admiral, "Amazing Grace"');
  });

  it('no email value or profile URL survives parsing', () => {
    const out = JSON.stringify(parsed);
    for (const email of EMAILS) expect(out).not.toContain(email);
    expect(out).not.toContain('@');
    expect(out).not.toContain('linkedin.com/in/');
  });

  it('skips rows without a name or company and de-duplicates within the file', () => {
    // Turing (no company), the anonymous row, and the second Ada at the same company.
    expect(parsed.skipped).toBe(3);
  });

  it('never keeps an email that sits in a name or company cell', () => {
    const odd = parseLinkedInConnections('First Name,Last Name,Email Address,Company,Position\nbob@x.example,Builder,bob@x.example,bob@x.example,Lead\n');
    expect(JSON.stringify(odd)).not.toContain('bob@x.example');
    expect(odd.connections).toEqual([]);
  });

  it('rejects a file that is not a connections export', () => {
    expect(() => parseLinkedInConnections('name,email\nA,a@b.example\n')).toThrow(ConnectionsCsvError);
    expect(() => parseLinkedInConnections('')).toThrow(ConnectionsCsvError);
  });

  it('caps the rows it reads', () => {
    const rows = ['First Name,Last Name,Company', ...Array.from({ length: 5 }, (_, i) => `P${i},Q,Co${i}`)].join('\n');
    const capped = parseLinkedInConnections(rows, { maxRows: 3 });
    expect(capped.connections).toHaveLength(3);
    expect(capped.rowCount).toBe(5);
  });

  it('handles a BOM and LF line ends', () => {
    const p = parseLinkedInConnections('﻿First Name,Last Name,Company,Connected On\nMei,Lin,台積電,01 Dec 2022\n');
    expect(p.connections[0]).toMatchObject({ fullName: 'Mei Lin', company: '台積電' });
  });
});

describe('parseConnectedOn', () => {
  it.each([
    ['15 Mar 2021', '2021-03-15'],
    ['Mar 15, 2021', '2021-03-15'],
    ['03/15/2021', '2021-03-15'],
    ['2021-03-15', '2021-03-15'],
    ['1 Sept 2020', '2020-09-01'],
  ])('%s → %s', (input, iso) => {
    expect(parseConnectedOn(input)?.toISOString().slice(0, 10)).toBe(iso);
  });

  it.each(['', 'yesterday', '31 Feb 2021', '13/40/2021', '15 Foo 2021'])('%s → null (never guessed)', (input) => {
    expect(parseConnectedOn(input)).toBeNull();
  });
});

describe('parseCsvRows', () => {
  it('handles quoted newlines and doubled quotes', () => {
    expect(parseCsvRows('a,"b\nc","d""e"\r\nf,g,h')).toEqual([
      ['a', 'b\nc', 'd"e'],
      ['f', 'g', 'h'],
    ]);
  });
});

describe('import stores the company name as the file wrote it (SR-54-2)', () => {
  it('RAContact.companyName keeps the written name next to the normalized one, and the contacts list shows it', async () => {
    const f = createNetworkFixture({ credits: createCreditTestKit({ now: new Date('2026-10-10T12:00:00Z') }).credits });
    const res = await f.service.importConnections('user_1', { text: EXPORT, fileName: 'Connections.csv' });
    expect(res.importedCount).toBe(3);
    const stored = f.store.contacts.map((c) => [c.fullName, c.companyName, c.companyNameNormalized]);
    expect(stored).toEqual([
      ['Ada Lovelace', 'Acme Analytics, Inc.', 'acme analytics'],
      ['Grace Hopper', 'Navy Labs', 'navy labs'],
      ['Linus Torvalds', 'Linux Foundation', 'linux foundation'],
    ]);
    // Outside a job page the view carries the written name, never the normalized key.
    const list = await f.service.listContacts('user_1', {});
    expect(list.items.map((c) => c.companyName)).toEqual(['Acme Analytics, Inc.', 'Navy Labs', 'Linux Foundation']);
  });

  it('a row from before the column (companyName null) falls back to the normalized name', async () => {
    const f = createNetworkFixture({ credits: createCreditTestKit({ now: new Date('2026-10-10T12:00:00Z') }).credits });
    await f.service.importConnections('user_1', { text: EXPORT, fileName: 'Connections.csv' });
    f.store.contacts[0]!.companyName = null;
    const list = await f.service.listContacts('user_1', {});
    expect(list.items[0]!.companyName).toBe('acme analytics');
  });

  it('a contact the user adds keeps the name they typed', async () => {
    const f = createNetworkFixture({ credits: createCreditTestKit({ now: new Date('2026-10-10T12:00:00Z') }).credits });
    const view = await f.service.createContact('user_1', { fullName: 'Lin Example', companyName: '  Globex   Corporation ' });
    expect(view.companyName).toBe('Globex Corporation');
    expect(f.store.contacts[0]).toMatchObject({ companyName: 'Globex Corporation', companyNameNormalized: 'globex' });
  });
});
