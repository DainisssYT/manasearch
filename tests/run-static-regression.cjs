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
check('app.js parses as a valid browser ES module (including reserved-word rules)', () => execFileSync(process.execPath, ['--check', '--input-type=module'], { input: app, stdio: ['pipe', 'pipe', 'pipe'] }));
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
check('HTML pako asset cache version matches current app build', () => {
  const pakoMatch = html.match(/pako\.min\.js\?v=([^"']+)/);
  const build = app.match(/const MANASEARCH_APP_BUILD = ['"]([^'"]+)['"]/);
  assert.ok(pakoMatch, 'missing cache-busted pako.min.js reference');
  assert.ok(build, 'missing MANASEARCH_APP_BUILD marker');
  assert.equal(pakoMatch[1], build[1], `build marker and pako asset version drifted: asset=${pakoMatch[1]}, app=${build[1]}`);
});
check('regression and performance suites are available in the production app', () => {
  for (const name of [
    'runMechanicalRegressionSuite',
    'runManaSearchMechanicalRegressionSuite',
    'runManaSearchRepeatabilityRegressionSuite',
    'runManaSearchHighlightIsolationSuite',
    'runManaSearchPerformanceSuite',
    'runManaSearchRealCardBenchmarkSuite',
    'runManaSearchRealCardBenchmarkFromConsole', 'runManaSearchIntentRegressionSuite'
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
check('production score applies the cadence rank factor before clamping', () => {
  assert.match(app, /SOURCE_ACQUISITION_CADENCE_RANKING_PENALTY\s*=\s*0\.55/);

  // Validate the actual scoring pipeline rather than requiring the factor to be repeated in the
  // final similarityScore assignment. Production code intentionally keeps a named intermediate
  // score so the cadence adjustment, quantitative penalty, and final [0, 1] clamp are independently
  // inspectable. The old assertion only accepted one source-code layout and failed despite the
  // factor already being applied.
  const scoreStart = app.indexOf('card.similarityBeforeCadenceAdjustment = preCadenceSimilarityScore;');
  assert.notEqual(scoreStart, -1, 'missing pre-cadence score snapshot');
  const scoreBlock = app.slice(scoreStart, scoreStart + 700);
  assert.match(scoreBlock, /const scoreBeforeQuantityPenalty\s*=\s*preCadenceSimilarityScore\s*\*\s*card\.acquisitionCadenceRankFactor\s*;/,
    'cadence rank factor must multiply the pre-cadence similarity score');
  assert.match(scoreBlock, /card\.unclampedSimilarityScore\s*=\s*Math\.max\(0,\s*scoreBeforeQuantityPenalty\s*-\s*\(Number\(card\.quantitativeConflictPenalty\)\s*\|\|\s*0\)\)\s*;/,
    'quantitative conflict penalty must be applied after cadence adjustment');
  assert.match(scoreBlock, /card\.similarityScore\s*=\s*Math\.max\(0,\s*Math\.min\(1,\s*card\.unclampedSimilarityScore\)\)\s*;/,
    'final similarity score must clamp the adjusted score to [0, 1]');
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
check('static data downloads have deadlines and report a useful failure instead of spinning forever', () => {
  assert.match(app, /async function fetchStaticAsset\(/);
  assert.match(app, /Static card corpus \(cards\.bin\)/);
  assert.match(app, /Static semantic index \(semantic-index\.bin\)/);
  assert.match(app, /request timed out after/);
  assert.match(app, /staticSearchResourceState\.lastError = errors\.join/);
});
check('asset cache-busts match the app build marker and the app module declaration remains async', () => {
  const build = app.match(/const MANASEARCH_APP_BUILD = ['"]([^'"]+)['"]/);
  assert.ok(build, 'missing MANASEARCH_APP_BUILD marker');
  for (const asset of ['app.js', 'pako.min.js', 'style.css']) {
    const escaped = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = html.match(new RegExp(escaped + '\\?v=([^"]+)'));
    assert.ok(match, `missing versioned ${asset} reference`);
    assert.equal(match[1], build[1], `${asset} version does not match app build tag`);
  }
  assert.match(app, /async function scoreCardBatch\(/);
  const deploy = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy-pages.yml'), 'utf8');
  assert.match(deploy, /BUILD_TAG=.*MANASEARCH_APP_BUILD/);
  assert.doesNotMatch(deploy, /grep -Fq ['"](?:app\.js|pako\.min\.js|style\.css)\?v=20261015-\d+['"]/);
});
check('both real-card benchmark console entry points load the static fixture when called without arguments', () => {
  assert.match(app, /window\.runManaSearchRealCardBenchmark\s*=\s*runManaSearchRealCardBenchmarkFromConsole/);
  assert.match(app, /window\.runManaSearchRealCardBenchmarkSuite\s*=\s*runManaSearchRealCardBenchmarkSuite/);
  assert.match(app, /if \(benchmark == null\) \{\s*return runManaSearchRealCardBenchmarkFromConsole\(\{ log \}\);/);
  assert.match(app, /tests\/fixtures\/mtg-mechanical-benchmark\.json/);
});
check('optional live Search intent preference is off by default and exposed in Preferences', () => {
  assert.match(app, /showSearchIntent:\s*false/);
  assert.match(app, /showSearchIntent:\s*stored\?\.showSearchIntent\s*===\s*true/);
  assert.match(html, /id="preference-show-search-intent"/);
  assert.match(html, /id="search-intent-panel"[^>]*class="search-intent-panel hidden"/);
});
check('Search intent Exact/Flexible regression matches the user-facing guidance', () => {
  assert.match(app, /Flexible highlights focus on matching mechanics even when wording differs/i);
  assert.match(app, /exact\?\.summary !== flexible\?\.summary/);
  assert.match(app, /Flexible spans allow the wording or numeric values to differ/i);
  assert.doesNotMatch(app, /Flexible highlights allow\/i\.test\(flexible\.summary\)/);
});
check('Search intent refreshes from the production source/highlight model and is generation-safe', () => {
  assert.match(app, /buildSearchIntentPresentationModel\(sourceCard = currentSourceCard, highlights = manualHighlights\)/);
  assert.match(app, /getSearchIntent\(sourceCard, activeHighlights\)/);
  const intentFn = app.slice(app.indexOf('function getSearchIntent('), app.indexOf('function searchIntentFunctionLabel('));
  assert.match(intentFn, /start: Number\.isInteger\(h\?\.start\) \? h\.start : null/);
  assert.match(intentFn, /typeStart: Number\.isInteger\(h\?\.typeStart\) \? h\.typeStart : null/);
  assert.match(app, /window\.addEventListener\('manasearch:source-highlights-changed',\s*\(\) => refreshManaSearchIntentPanel\(\)\)/);
  assert.match(app, /notifyManaSearchHighlightsChanged\(\);[\s\S]{0,120}highlight/i);
  assert.match(app, /manaSearchIntentRenderGeneration/);
  assert.match(app, /requestAnimationFrame\(\(\) =>/);
});
check('selected outcome plus a custom trigger feeds the same context into retrieval and scoring', () => {
  assert.match(app, /function extractHighlightClauseContext\(/);
  assert.match(app, /function composeHighlightIntentOverride\(/);
  assert.match(app, /const profiles = buildHighlightIntentProfiles\(highlights, sourceCard, sourceText\)/);
  assert.match(app, /mechanical-score-prefers-matching-opponent-draw-trigger/);
  assert.match(app, /unattached-search-trigger-infers-connection-to-single-highlighted-outcome/);
  assert.match(app, /trigger-override-drops-unrelated-native-trigger-restrictions/);
  assert.match(app, /sourceTextToParse = \(hasEffectHighlight && targetText\) \? \(buildHighlightScoringText\(effectHighlights, sourceText\)/);
});
check('test automation files exist', () => {
  assert.ok(fs.existsSync(path.join(root, 'tests', 'run-browser-regression.cjs')));
  assert.ok(fs.existsSync(path.join(root, '.github', 'workflows', 'manasearch-regression-tests.yml')));
  assert.ok(fs.existsSync(path.join(root, '.github', 'workflows', 'deploy-pages.yml')));
  assert.ok(fs.existsSync(path.join(root, '.github', 'workflows', 'recover-stuck-pages-deployment.yml')));
  const deploy = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy-pages.yml'), 'utf8');
  assert.match(deploy, /for f in pako\.min\.js cards\.bin semantic-index\.bin static-data-meta\.json; do/);
  assert.match(deploy, /cp "\$f" _site\//);
  assert.match(deploy, /cp\s+tests\/fixtures\/mtg-mechanical-benchmark\.json\s+_site\/tests\/fixtures\//);
  assert.match(deploy, /cancel-in-progress:\s*false/);
  assert.match(deploy, /uses:\s*actions\/deploy-pages@v5\.0\.1/);
  assert.match(deploy, /uses:\s*actions\/configure-pages@v6/);
  assert.match(deploy, /uses:\s*actions\/upload-pages-artifact@v5/);
  assert.doesNotMatch(deploy, /setup-node|node --check|node tests\//, 'static deployment should not require a Node setup or run test scripts');
  const recovery = fs.readFileSync(path.join(root, '.github', 'workflows', 'recover-stuck-pages-deployment.yml'), 'utf8');
  assert.match(recovery, /pages\/deployments\/\$\{DEPLOYMENT_ID\}\/cancel/);
  assert.match(recovery, /cancel-in-progress:\s*false/);
  assert.match(app, /function getGraveyardReturnDestinationSignature\(/);
  assert.match(app, /opponentUpkeepLifeLoss/);
  assert.ok(fs.existsSync(path.join(root, 'tests', 'fixtures', 'mtg-mechanical-benchmark.json')));
});
const failed = checks.filter(x => !x.pass);
for (const result of checks) console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name}${result.error ? ` — ${result.error}` : ''}`);
console.log(`\nStatic regression checks: ${checks.length - failed.length}/${checks.length} passed.`);
if (failed.length) process.exitCode = 1;
