#!/usr/bin/env node
'use strict';

// Validate the externally-sourced, offline card benchmark before any browser/scorer work begins.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, 'fixtures', 'mtg-mechanical-benchmark.json');
const benchmark = JSON.parse(fs.readFileSync(file, 'utf8'));
const checks = [];
function check(name, fn) {
  try { fn(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: error.message }); }
}
const cards = benchmark.cards || [];
const pairs = benchmark.pairs || [];
const cardIds = new Set(cards.map(card => card.id));
const pairIds = new Set(pairs.map(pair => pair.id));
const categories = new Set(pairs.map(pair => pair.category));
check('benchmark has at least 25 real card fixtures', () => assert.ok(cards.length >= 25, `found ${cards.length}`));
check('benchmark has at least 20 pair comparisons', () => assert.ok(pairs.length >= 20, `found ${pairs.length}`));
check('each card has a name, Oracle text, type line, and online source', () => {
  const invalid = cards.filter(card => !card.id || !card.name || !card.type_line || !card.oracle_text?.trim() || !/^https:\/\//.test(card.source_url || ''));
  assert.deepEqual(invalid.map(card => card.id || card.name || '<unknown>'), []);
});
check('card IDs and names are unique', () => {
  assert.equal(cardIds.size, cards.length, 'duplicate card IDs');
  assert.equal(new Set(cards.map(card => card.name.toLowerCase())).size, cards.length, 'duplicate card names');
});
check('all comparison pairs refer to existing cards', () => {
  const missing = pairs.filter(pair => !cardIds.has(pair.a) || !cardIds.has(pair.b));
  assert.deepEqual(missing.map(pair => pair.id), []);
});
check('comparison IDs are unique and not self-pairs', () => {
  assert.equal(pairIds.size, pairs.length, 'duplicate pair IDs');
  assert.deepEqual(pairs.filter(pair => pair.a === pair.b).map(pair => pair.id), []);
});
check('score expectations are valid ranges', () => {
  for (const pair of pairs) {
    const e = pair.expect || {};
    if (e.minScore != null) assert.ok(e.minScore >= 0 && e.minScore <= 1, `${pair.id} minScore`);
    if (e.maxScore != null) assert.ok(e.maxScore >= 0 && e.maxScore <= 1, `${pair.id} maxScore`);
    if (e.minScore != null && e.maxScore != null) assert.ok(e.minScore <= e.maxScore, `${pair.id} min exceeds max`);
    if (e.scoreAbove) assert.ok(pairIds.has(e.scoreAbove), `${pair.id} references missing scoreAbove ${e.scoreAbove}`);
    if (e.scoreBelow) assert.ok(pairIds.has(e.scoreBelow), `${pair.id} references missing scoreBelow ${e.scoreBelow}`);
  }
});
check('benchmark covers all requested mechanic families', () => {
  const missing = (benchmark.requiredCoverage || []).filter(category => !categories.has(category));
  assert.deepEqual(missing, [], `missing ${missing.join(', ')}`);
});
check('real-card cases cover key previous regressions', () => {
  for (const id of [
    'blink-ephemerate-cloudshift', 'blink-ephemerate-swords',
    'replacement-doubling-parallel-lives', 'replacement-doubling-vs-raise-alarm',
    'counter-replacement-scales-vorinclex', 'sacrifice-mana-ashnod-phyrexian-altar',
    'repeatable-draw-rhystic-beast-whisperer', 'repeatable-draw-rhystic-chronicler',
    'counterspell-counterspell-negate', 'reanimation-vs-hand-recursion'
  ]) assert.ok(pairIds.has(id), `missing pair ${id}`);
});

const failed = checks.filter(x => !x.pass);
for (const result of checks) console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name}${result.error ? ` — ${result.error}` : ''}`);
console.log(`\nCard benchmark data checks: ${checks.length - failed.length}/${checks.length} passed (${cards.length} cards, ${pairs.length} pairs, ${categories.size} categories).`);
if (failed.length) process.exitCode = 1;
