#!/usr/bin/env node
'use strict';

// Dependency-free guard checks. The browser suite exercises production parser/scorer functions;
// this file catches syntax, asset-reference, benchmark-presence, and feature-preservation issues
// even on machines that have not installed Playwright.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const appPath = path.join(root, 'app.js');
const htmlPath = path.join(root, 'index.html');
const cssPath = path.join(root, 'style.css');
const app = fs.readFileSync(appPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');

const checks = [];
function check(name, fn) {
  try { fn(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: error.message }); }
}

check('app.js parses as valid JavaScript', () => execFileSync(process.execPath, ['--check', appPath], { stdio: 'pipe' }));
check('HTML references the current cache-busted app.js', () => {
  const match = html.match(/app\.js\?v=([^"']+)/);
  assert.ok(match, 'missing app.js script reference');
  const build = app.match(/const MANASEARCH_APP_BUILD = ['"]([^'"]+)['"]/);
  assert.ok(build, 'missing MANASEARCH_APP_BUILD marker');
  assert.equal(build[1], match[1], `build marker and app asset version drifted: asset=${match[1]}, app=${build[1]}`);
});
check('HTML stylesheet cache version matches the current app build', () => {
  const cssMatch = html.match(/style\.css\?v=([^"']+)/);
  const build = app.match(/const MANASEARCH_APP_BUILD = ['"]([^'"]+)['"]/);
  assert.ok(cssMatch, 'missing cache-busted style.css reference');
  assert.ok(build, 'missing MANASEARCH_APP_BUILD marker');
  assert.equal(cssMatch[1], build[1], `build marker and stylesheet asset version drifted: asset=${cssMatch[1]}, app=${build[1]}`);
});
check('regression and performance suites are available in the production app', () => {
  for (const name of [
    'runMechanicalRegressionSuite',
    'runManaSearchMechanicalRegressionSuite',
    'runManaSearchRepeatabilityRegressionSuite',
    'runManaSearchHighlightIsolationSuite',
    'runManaSearchPerformanceSuite',
    'runManaSearchRealCardBenchmarkSuite'
  ]) assert.ok(app.includes(`function ${name}(`), `missing ${name}`);
});
check('mechanical suite contains blink, token-multiplier, and cadence guards', () => {
  for (const id of [
    'blink-sequence-is-not-exile-removal',
    'token-multiplier-is-not-token-creation',
    'graveyard-return-destination-is-mechanically-distinct',
    'repeatable-acquisition-rank-adjustment-is-directional',
    'repeatable-draw-engine-not-equivalent-to-etb-cantrip',
    'draw-trigger-condition-is-not-a-draw-outcome'
  ]) assert.ok(app.includes(id), `missing regression case ${id}`);
});
check('production score uses the cadence rank factor', () => {
  assert.match(app, /SOURCE_ACQUISITION_CADENCE_RANKING_PENALTY\s*=\s*0\.55/);
  assert.match(app, /card\.similarityScore\s*=\s*Math\.max[\s\S]{0,180}card\.acquisitionCadenceRankFactor/);
});
check('mechanical contrast penalties are present', () => {
  assert.match(app, /kind:\s*'blink-vs-exile-removal'/);
  assert.match(app, /kind:\s*'token-multiplier-vs-token-creation'/);
  assert.match(app, /kind:\s*'reanimation-vs-graveyard-recursion'/);
});
check('existing critical features remain in the app', () => {
  for (const token of [
    'findSimilarCards', 'searchDeeper', 'calculateMechanicalSimilarityDetailed',
    'scoreCardBatch', 'manualHighlights', 'exportToCSV',
    'runManaSearchBenchmarkHighlightSuite', 'runManaSearchHighlightIsolationSuite',
    'runManaSearchRepeatabilityRegressionSuite', 'runManaSearchRealCardBenchmarkSuite'
  ]) assert.ok(app.includes(token), `missing existing feature or scorer ${token}`);
});
check('all HTML ids are unique', () => {
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
  const seen = new Set();
  const dup = [];
  for (const id of ids) { if (seen.has(id)) dup.push(id); seen.add(id); }
  assert.deepEqual(dup, [], `duplicate IDs: ${dup.join(', ')}`);
});
check('CSS braces are balanced', () => {
  let depth = 0, quote = null, escaped = false, inComment = false;
  for (let i = 0; i < css.length; i++) {
    const c = css[i], n = css[i + 1];
    if (inComment) { if (c === '*' && n === '/') { inComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '*') { inComment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}') depth--;
    assert.ok(depth >= 0, `extra closing brace at offset ${i}`);
  }
  assert.equal(depth, 0, 'unclosed CSS block');
});
check('test automation files exist', () => {
  assert.ok(fs.existsSync(path.join(root, 'tests', 'run-browser-regression.cjs')));
  assert.ok(fs.existsSync(path.join(root, '.github', 'workflows', 'manasearch-regression-tests.yml')));
  assert.ok(fs.existsSync(path.join(root, 'tests', 'fixtures', 'mtg-mechanical-benchmark.json')));
});

const failed = checks.filter(x => !x.pass);
for (const result of checks) console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name}${result.error ? ` — ${result.error}` : ''}`);
console.log(`\nStatic regression checks: ${checks.length - failed.length}/${checks.length} passed.`);
if (failed.length) process.exitCode = 1;
