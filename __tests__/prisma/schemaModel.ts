// Shared, dependency-free reader for the multi-file Prisma schema in
// server/prisma/schema/ (used by the FND-1b schema tests). It parses just
// enough of the Prisma language for structural assertions: top-level blocks,
// scalar/relation fields with their modifiers, block attributes (@@…) and the
// `///` doc comments directly above each field.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const ROOT = join(__dirname, '..', '..');
export const SCHEMA_DIR = join(ROOT, 'server', 'prisma', 'schema');

export type Field = {
  name: string;
  type: string; // base type without [] / ?
  list: boolean;
  optional: boolean;
  attrs: string; // everything after the type, comments stripped
  doc: string; // `///` lines directly above, joined with \n
  line: string; // the raw line
};

export type Block = {
  kind: 'model' | 'enum' | 'type' | 'view' | 'generator' | 'datasource';
  name: string;
  file: string;
  body: string;
  fields: Field[];
  blockAttrs: string[];
};

function prismaFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return prismaFiles(full);
      return entry.endsWith('.prisma') ? [full] : [];
    });
}

function stripLineComment(s: string): string {
  // Prisma line comments start with `//` outside string literals.
  let inStr = false;
  for (let i = 0; i < s.length - 1; i += 1) {
    if (s[i] === '"' && s[i - 1] !== '\\') inStr = !inStr;
    if (!inStr && s[i] === '/' && s[i + 1] === '/') return s.slice(0, i);
  }
  return s;
}

export function parseSchema(): Block[] {
  const blocks: Block[] = [];
  for (const file of prismaFiles(SCHEMA_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(model|enum|type|view|generator|datasource) (\w+) \{\s*$/.exec(lines[i]);
      if (!m) continue;
      let j = i + 1;
      while (j < lines.length && lines[j] !== '}') j += 1;
      const bodyLines = lines.slice(i + 1, j);
      const fields: Field[] = [];
      const blockAttrs: string[] = [];
      let doc: string[] = [];
      for (const raw of bodyLines) {
        const t = raw.trim();
        if (t.startsWith('///')) {
          doc.push(t.slice(3).trim());
          continue;
        }
        if (t === '' || t.startsWith('//')) {
          if (t === '') doc = [];
          continue;
        }
        if (t.startsWith('@@')) {
          blockAttrs.push(stripLineComment(t).trim());
          doc = [];
          continue;
        }
        if (m[1] === 'model' || m[1] === 'type' || m[1] === 'view') {
          const f = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(t);
          if (f) {
            fields.push({
              name: f[1],
              type: f[2],
              list: Boolean(f[3]),
              optional: Boolean(f[4]),
              attrs: stripLineComment(f[5] ?? '').trim(),
              doc: doc.join('\n'),
              line: raw,
            });
          }
        }
        doc = [];
      }
      blocks.push({
        kind: m[1] as Block['kind'],
        name: m[2],
        file: relative(SCHEMA_DIR, file),
        body: bodyLines.join('\n'),
        fields,
        blockAttrs,
      });
      i = j;
    }
  }
  return blocks;
}

export function modelMap(blocks: Block[]): Map<string, Block> {
  return new Map(blocks.filter((b) => b.kind === 'model').map((b) => [b.name, b]));
}

/** `onDelete: X` of a relation field's @relation(...), or null when absent. */
export function onDelete(field: Field): string | null {
  const m = /onDelete:\s*(\w+)/.exec(field.attrs);
  return m ? m[1] : null;
}
