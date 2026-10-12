#!/usr/bin/env node
// Structural check of a bundles file before a wave runs:
//   node check-bundles.mjs <bundles.json> [--phase <id>]
// Reports duplicate ids, malformed bundles or items, ownership overlaps between bundles that
// run in parallel (same "phase"; bundles without a phase all count as one phase), i18n
// namespaces owned twice in a phase, and dependsOn that names an unknown or same/later-phase
// bundle. Exit code 1 when anything is reported.
import { readFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
const onlyPhase = rest.includes('--phase') ? rest[rest.indexOf('--phase') + 1] : null;
const raw = JSON.parse(readFileSync(file, 'utf8'));
const bundles = Array.isArray(raw) ? raw : raw.bundles;
let problems = 0;
const say = (m) => { problems++; console.log(`✗ ${m}`); };

const norm = (p) => p.replace(/\/+$/, '');
const overlap = (a, b) => { const x = norm(a), y = norm(b); return x === y || x.startsWith(y + '/') || y.startsWith(x + '/'); };
const namespaces = (b) => String(b.namespace || '').replace(/\(.*?\)/g, '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

const ids = new Map();
for (const b of bundles) {
  if (!b.id) { say('bundle without id'); continue; }
  if (ids.has(b.id)) say(`duplicate id ${b.id}`);
  ids.set(b.id, b);
  if (!Array.isArray(b.owns) || !b.owns.length) say(`${b.id}: no owns`);
  if (!Array.isArray(b.items) || !b.items.length) say(`${b.id}: no items`);
  for (const [i, it] of (b.items || []).entries()) {
    if (typeof it !== 'string') { say(`${b.id} item ${i}: not a string`); continue; }
    if (!/^\[P[0-2]\]/.test(it)) say(`${b.id} item ${i}: missing [P0|P1|P2] prefix`);
    for (const part of ['CHANGE:', 'ACCEPT:', 'TESTS:', 'FILES:']) if (!it.includes(part)) say(`${b.id} item ${i}: missing ${part}`);
  }
  for (const o of b.owns || []) if (/^\/|\.\.|\*/.test(o)) say(`${b.id}: owns entry must be a plain repo-relative path: ${o}`);
}

const phaseOf = (b) => b.phase || '_';
const phases = [...new Set(bundles.map(phaseOf))];
const order = (p) => { const n = phases.indexOf(p); const m = /(\d+)/.exec(p); return m ? Number(m[1]) : n; };
for (const ph of phases) {
  if (onlyPhase && ph !== onlyPhase) continue;
  const group = bundles.filter((b) => phaseOf(b) === ph);
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      for (const a of group[i].owns || []) for (const c of group[j].owns || []) {
        if (overlap(a, c)) say(`[${ph}] ownership overlap: ${group[i].id} ${a}  <->  ${group[j].id} ${c}`);
      }
      const shared = namespaces(group[i]).filter((n) => namespaces(group[j]).includes(n));
      for (const n of shared) say(`[${ph}] i18n namespace "${n}" owned by ${group[i].id} and ${group[j].id}`);
    }
  }
}
for (const b of bundles) {
  for (const d of b.dependsOn || []) {
    const dep = ids.get(d);
    if (!dep) { if (!/^PAR-|^FIX-|^WP-/.test(d)) say(`${b.id}: dependsOn unknown bundle ${d}`); continue; }
    if (order(phaseOf(dep)) >= order(phaseOf(b))) say(`${b.id} (${phaseOf(b)}) depends on ${d} (${phaseOf(dep)}): must be an earlier phase`);
  }
}
const summary = phases.map((p) => `${p}: ${bundles.filter((b) => phaseOf(b) === p).length}`).join(', ');
console.log(`${bundles.length} bundles (${summary}); ${problems} problem(s)`);
process.exit(problems ? 1 : 0);
