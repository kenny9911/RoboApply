#!/usr/bin/env node
// Run after editing jobSearch or jobSearchApi copy:
//   node scripts/check-job-search-locales.mjs
// Checks only these namespaces, leaving unrelated locale content untouched.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

const root = new URL('../', import.meta.url);
const messagesDir = new URL('i18n/messages/', root);
const namespaces = ['jobSearch', 'jobSearchApi'];
const source = JSON.parse(readFileSync(new URL('components/job-search/messages.en.json', root), 'utf8'));
const english = JSON.parse(readFileSync(new URL('en.json', messagesDir), 'utf8'));
const errors = [];
const protectedTokens = [
  'RoboApply', 'API', 'OpenAPI', 'ROBOAPPLY_ORIGIN', 'ROBOAPPLY_JOB_SEARCH_KEY',
  'jobs', 'meta.providers', 'meta.partial',
];

function leaves(value, prefix = '', result = new Map()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      leaves(child, prefix ? `${prefix}.${key}` : key, result);
    }
  } else {
    result.set(prefix, value);
  }
  return result;
}

function argumentsOf(ast, found = new Set()) {
  for (const node of ast) {
    if ([TYPE.argument, TYPE.number, TYPE.date, TYPE.time, TYPE.select, TYPE.plural, TYPE.tag].includes(node.type)) {
      found.add(`${node.type}:${node.value}`);
    }
    if (node.options) {
      for (const option of Object.values(node.options)) argumentsOf(option.value, found);
    }
    if (node.children) argumentsOf(node.children, found);
  }
  return [...found].sort();
}

for (const namespace of namespaces) {
  if (JSON.stringify(english[namespace]) !== JSON.stringify(source[namespace])) {
    errors.push(`en.${namespace}: English bundle differs from components/job-search/messages.en.json`);
  }
}

let checked = 0;
const locales = readdirSync(fileURLToPath(messagesDir)).filter((file) => file.endsWith('.json')).sort();
for (const file of locales) {
  const bundle = JSON.parse(readFileSync(new URL(file, messagesDir), 'utf8'));
  for (const namespace of namespaces) {
    const expected = leaves(source[namespace]);
    const actual = leaves(bundle[namespace]);
    for (const key of actual.keys()) {
      if (!expected.has(key)) errors.push(`${file}:${namespace}.${key}: unexpected key`);
    }
    for (const [key, original] of expected) {
      const label = `${file}:${namespace}.${key}`;
      const translated = actual.get(key);
      if (typeof translated !== 'string' || !translated.trim()) {
        errors.push(`${label}: missing or empty translation`);
        continue;
      }
      try {
        const expectedArgs = argumentsOf(parse(original));
        const actualArgs = argumentsOf(parse(translated));
        if (JSON.stringify(expectedArgs) !== JSON.stringify(actualArgs)) {
          errors.push(`${label}: ICU argument names or types differ from English`);
        }
      } catch (error) {
        errors.push(`${label}: invalid ICU message (${error.message})`);
      }
      for (const token of protectedTokens) {
        // Whole tokens avoid treating the ordinary English word "jobs" as an
        // API field except in the response documentation that names the field.
        if (token === 'jobs' && !(namespace === 'jobSearchApi' && key === 'response_body')) continue;
        if (original.includes(token) && !translated.includes(token)) {
          errors.push(`${label}: missing technical identifier ${token}`);
        }
      }
      checked += 1;
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Job search locales passed: ${checked} messages across ${locales.length} locales; keys, ICU arguments, and API identifiers match.`);
}
