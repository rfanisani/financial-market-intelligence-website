// Minimum test suite (node:test, zero dependencies).
// Run: node scripts/test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  OUNCE_GRAMS, usdPerGram, gold18UsdPerGram, gold24UsdPerGram,
  impliedUsd, difference, expectedDomesticPrice,
} from '../src/calc.js';
import { validateCurrent, validateHistory } from '../src/validate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('troy ounce conversion constant', () => {
  assert.equal(OUNCE_GRAMS, 31.1034768);
  assert.ok(Math.abs(usdPerGram(OUNCE_GRAMS) - 1) < 1e-12);
});

test('18K and 24K gram values from ounce price', () => {
  const oz = 2650;
  assert.ok(Math.abs(gold18UsdPerGram(oz) - (oz / OUNCE_GRAMS) * 0.75) < 1e-9);
  assert.ok(Math.abs(gold24UsdPerGram(oz) - (oz / OUNCE_GRAMS) * 0.999) < 1e-9);
  assert.ok(gold24UsdPerGram(oz) > gold18UsdPerGram(oz));
});

test('implied USD: 18K per-gram quote', () => {
  // If 18K gram costs exactly its USD value at rate 1, implied must be 1.
  const g18 = gold18UsdPerGram(2650);
  assert.ok(Math.abs(impliedUsd({ domesticPrice: g18, globalOunceUsd: 2650, purity: 0.75 }) - 1) < 1e-9);
});

test('implied USD: Emami coin (8.133 g, 0.900 fineness)', () => {
  const rate = 140000;
  const coin = rate * 8.133 * 0.9 * (2650 / OUNCE_GRAMS);
  assert.ok(Math.abs(impliedUsd({ domesticPrice: coin, globalOunceUsd: 2650, purity: 0.9, weightGrams: 8.133 }) - rate) < 1e-6);
});

test('implied USD returns null on invalid input', () => {
  assert.equal(impliedUsd({ domesticPrice: 0, globalOunceUsd: 2650 }), null);
  assert.equal(impliedUsd({ domesticPrice: -5, globalOunceUsd: 2650 }), null);
  assert.equal(impliedUsd({ domesticPrice: 100, globalOunceUsd: 0 }), null);
  assert.equal(impliedUsd({ domesticPrice: undefined, globalOunceUsd: 2650 }), null);
  assert.equal(impliedUsd({ domesticPrice: 100, globalOunceUsd: 2650, purity: 0 }), null);
});

test('difference and difference %', () => {
  const d = difference(100, 110);
  assert.equal(d.abs, 10);
  assert.ok(Math.abs(d.pct - 10) < 1e-9);
  assert.equal(difference(0, 110), null);
  assert.equal(difference(100, null), null);
});

test('reverse calculation: expected domestic price', () => {
  const p = expectedDomesticPrice({ usdRate: 140000, globalOunceUsd: 2650, purity: 0.75, weightGrams: 1 });
  const back = impliedUsd({ domesticPrice: p, globalOunceUsd: 2650, purity: 0.75 });
  assert.ok(Math.abs(back - 140000) < 1e-6);
  assert.equal(expectedDomesticPrice({ usdRate: 0, globalOunceUsd: 2650 }), null);
});

test('current.json seed data is valid', () => {
  const data = JSON.parse(readFileSync(path.join(root, 'data/current.json'), 'utf8'));
  const res = validateCurrent(data, { now: data.t + 60 });
  assert.deepEqual(res.errors, []);
  assert.ok(res.ok);
});

test('stale data is rejected', () => {
  const data = JSON.parse(readFileSync(path.join(root, 'data/current.json'), 'utf8'));
  const res = validateCurrent(data, { now: data.t + 4 * 86400 });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('stale')));
});

test('missing/invalid fields are rejected', () => {
  assert.equal(validateCurrent(null).ok, false);
  assert.equal(validateCurrent({ t: 1 }).ok, false);
  assert.equal(validateCurrent({ t: Date.now() / 1000, a: { XAU: { v: -1, c: 0, s: 'seed' } } }).ok, false);
  assert.equal(validateCurrent({ t: Date.now() / 1000, a: { XAU: { v: 1, c: 0, s: 'unknown-src' } } }).ok, false);
});

test('history files are valid', () => {
  for (const f of ['history-7d.json', 'history-30d.json']) {
    const h = JSON.parse(readFileSync(path.join(root, 'data', f), 'utf8'));
    const res = validateHistory(h);
    assert.deepEqual(res.errors, [], f);
  }
});
