// -----------------------------------------------------------------------------
// Every text Gladys shows exists in the four languages of its interface
// (English, French, German, Spanish): the manifest, the message tables of the
// code and the documentation. German says "du", never the polite "Sie".
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/config.js';
import { STATES } from '../src/moonraker/model.js';
import {
  COMMAND_ERRORS,
  DONE_TEXT,
  DURATION,
  INIT_FAILED,
  NAMES,
  NO_FILE,
  STATE_LABELS,
  STATUS_TEXT,
  TEST_TEXT,
  commandMessage,
  formatDuration,
} from '../src/texts.js';
import { TEXT } from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const LANGS = ['en', 'fr', 'de', 'es'];
const POLITE_GERMAN = /(?<!\p{L})(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?!\p{L})/u;

// Upper bounds, in characters: what the Gladys interface shows without cutting.
const MAX = {
  catalog: 100,
  widgetLabel: 30,
  label: 60,
  placeholder: 60,
  description: 300,
  message: 200,
  short: 24,
  status: 40,
  featureName: 40,
};

const sorted = (keys) => [...keys].sort();

/** Checks one multi-language object; returns its problems. */
function problems(value, path, max) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} must be a multi-language object`];
  }
  const found = [];
  if (JSON.stringify(sorted(Object.keys(value))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${path} has [${Object.keys(value)}], expected exactly [${LANGS}]`);
  }
  for (const [lang, text] of Object.entries(value)) {
    found.push(...textProblems(text, `${path}.${lang}`, lang, max));
  }
  return found;
}

function textProblems(text, path, lang, max) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [`${path} is empty`];
  }
  const found = [];
  if (text.length > max) {
    found.push(`${path} has ${text.length} characters (${max} at most)`);
  }
  if (lang === 'de' && POLITE_GERMAN.test(text)) {
    found.push(`${path} uses the polite form: "${text}"`);
  }
  return found;
}

/** Every multi-language object of the manifest, with its length limit. */
function manifestTexts(root) {
  const texts = [];
  const walk = (value, path, key) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, key));
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const isText =
      ['label', 'description', 'placeholder'].includes(key) ||
      Object.keys(value).some((child) => LANGS.includes(child));
    if (isText) {
      // The store schema caps the catalog and widget descriptions, and widget
      // labels; section texts may be longer (1000 characters).
      const max =
        path === 'manifest.description' || /^manifest\.widgets\[\d+\]\.description$/.test(path)
          ? MAX.catalog
          : /^manifest\.widgets\[\d+\]\.label$/.test(path)
            ? MAX.widgetLabel
            : /^manifest\.config_schema\[0\]\.description$/.test(path)
              ? 1000
              : (MAX[key] ?? MAX.label);
      texts.push({ path, value, max });
      return;
    }
    for (const [child, item] of Object.entries(value)) {
      walk(item, `${path}.${child}`, child);
    }
  };
  walk(root, 'manifest', null);
  return texts;
}

// Tables written one language at a time: same keys everywhere, no empty text.
function tableProblems(table, name, max, render = (value) => value) {
  const found = [];
  if (JSON.stringify(sorted(Object.keys(table))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${name} has [${Object.keys(table)}], expected exactly [${LANGS}]`);
  }
  for (const lang of LANGS) {
    const entries = table[lang] ?? {};
    if (
      JSON.stringify(sorted(Object.keys(entries))) !== JSON.stringify(sorted(Object.keys(table.en)))
    ) {
      found.push(`${name}.${lang} does not have the keys of ${name}.en`);
    }
    for (const [key, value] of Object.entries(entries)) {
      found.push(...textProblems(render(value), `${name}.${lang}.${key}`, lang, max));
    }
  }
  return found;
}

const render = (value) => (typeof value === 'function' ? value(3, 'Printing') : value);

test('the configuration offers the four languages', () => {
  assert.deepEqual(LANGUAGES, LANGS);
  const options = manifest.config_schema.find((f) => f.key === 'language').options;
  assert.deepEqual(
    options.map((o) => o.value),
    LANGS,
  );
});

test('every text of the manifest is in English, French, German and Spanish', () => {
  const texts = manifestTexts(manifest);
  assert.ok(texts.length >= 85, `only ${texts.length} texts found in the manifest`);
  const found = texts.flatMap(({ path, value, max }) => problems(value, path, max));
  assert.deepEqual(found, []);
});

test('the catalog description holds 10 characters at least in every language', () => {
  for (const lang of LANGS) {
    assert.ok(manifest.description[lang].length >= 10, `description.${lang} is too short`);
  }
});

test('the feature names and state labels exist in every language', () => {
  assert.deepEqual(tableProblems(NAMES, 'NAMES', MAX.featureName), []);
  assert.deepEqual(tableProblems(STATE_LABELS, 'STATE_LABELS', MAX.status), []);
  // One label per state of the model, no more.
  assert.deepEqual(sorted(Object.keys(STATE_LABELS.en)), sorted(STATES));
  // "Nozzle 2 (target)" stays a short name.
  for (const lang of LANGS) {
    const longest = `${NAMES[lang].extruder} 8 (${NAMES[lang].target})`;
    assert.ok(longest.length <= MAX.featureName, longest);
  }
});

test('every message table of the code has the four languages', () => {
  const found = [
    ...problems(INIT_FAILED, 'INIT_FAILED', MAX.message),
    ...problems(NO_FILE, 'NO_FILE', MAX.status),
    ...tableProblems(COMMAND_ERRORS, 'COMMAND_ERRORS', MAX.message, render),
    ...tableProblems(STATUS_TEXT, 'STATUS_TEXT', MAX.message, render),
    ...tableProblems(TEST_TEXT, 'TEST_TEXT', MAX.message, render),
    ...tableProblems(DURATION, 'DURATION', MAX.short, render),
    ...Object.entries(DONE_TEXT).flatMap(([key, value]) =>
      problems(value, `DONE_TEXT.${key}`, MAX.message),
    ),
    ...Object.entries(TEXT).flatMap(([key, value]) =>
      problems(
        value,
        `TEXT.${key}`,
        ['pick', 'unknown', 'waiting'].includes(key) ? MAX.message : MAX.short,
      ),
    ),
  ];
  assert.deepEqual(found, []);
});

test('coded messages and durations are rendered in every language', () => {
  assert.deepEqual(problems(commandMessage('out_of_range', 350), 'out_of_range', MAX.message), []);
  assert.match(commandMessage('out_of_range', 150).de, /0 bis 150 °C/);
  assert.equal(formatDuration(3900, 'fr'), '1 h 05 min');
  assert.equal(formatDuration(3900, 'de'), '1 Std. 05 Min.');
  assert.equal(formatDuration(125, 'es'), '2 min');
  assert.equal(formatDuration(null, 'en'), '');
});

test('the four documentations exist, with the same sections', async () => {
  const docs = {};
  for (const lang of LANGS) {
    const text = await readFile(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8');
    assert.ok(text.length >= 300, `docs/${lang}.md is too short`);
    docs[lang] = text.split('\n').filter((line) => /^#{1,3} /.test(line));
  }
  const shape = (headings) => headings.map((line) => line.match(/^#+/)[0]).join(',');
  for (const lang of LANGS) {
    assert.equal(docs[lang].length, docs.en.length, `docs/${lang}.md: number of sections`);
    assert.equal(shape(docs[lang]), shape(docs.en), `docs/${lang}.md: heading levels`);
  }
  assert.doesNotMatch(
    await readFile(new URL('../docs/de.md', import.meta.url), 'utf8'),
    POLITE_GERMAN,
  );
});

test('the guard catches a missing language, an empty text and the polite German form', () => {
  assert.equal(problems({ en: 'Bed', fr: 'Plateau', de: 'Bett' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'Bed', fr: 'Plateau', de: '', es: 'Cama' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a', es: 'a', it: 'a' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a'.repeat(61), es: 'a' }, 'x', 60).length, 1);
  for (const polite of ['Wählen Sie', 'Ihr Drucker', 'Ihre IP', 'mit Ihrem', 'Ihren', 'Ihrer']) {
    assert.equal(problems({ en: 'a', fr: 'a', de: polite, es: 'a' }, 'x', 60).length, 1, polite);
  }
  assert.deepEqual(
    problems({ en: 'a', fr: 'a', de: 'Siebenschläfer, ihre', es: 'a' }, 'x', 60),
    [],
  );
  const forgotten = structuredClone(manifest);
  delete forgotten.scene_actions[1].fields[1].label.de;
  const found = manifestTexts(forgotten).flatMap(({ path, value, max }) =>
    problems(value, path, max),
  );
  assert.deepEqual(found, [
    'manifest.scene_actions[1].fields[1].label has [en,fr,es], expected exactly [en,fr,de,es]',
  ]);
});
