#!/usr/bin/env node
'use strict';

// Execute small, pure helpers copied verbatim from the production app source. The full scoring
// pipeline is exercised by tests/run-browser-regression.cjs in Chromium; this dependency-free
// runner ensures the new mechanical contrast and cadence-rank helpers can be executed locally.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const app = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');
function sliceBetween(startToken, endToken) {
  const start = app.indexOf(startToken);
  const end = app.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `could not locate production source range ${startToken} .. ${endToken}`);
  return app.slice(start, end);
}
function extractFunction(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `production function not found: ${name}`);
  const next = app.indexOf('\nfunction ', start + 10);
  assert.ok(next > start, `could not find boundary after ${name}`);
  return app.slice(start, next);
}
const cases = [];
function test(name, fn) {
  try { fn(); cases.push({ name, pass: true }); }
  catch (error) { cases.push({ name, pass: false, error: error.message }); }
}

test('production contrast classifier separates blink from exile removal', () => {
  const contrastBlock = sliceBetween('function getMechanicalContrastText(', 'function calculateMechanicalSimilarityDetailed(');
  const sandbox = { result: null };
  vm.runInNewContext(`
    const OPPOSITE_MECHANICS = new Set([
      'gain_life|lose_life','lose_life|gain_life','tap|untap','untap|tap',
      'draw|discard','discard|draw','gain_control|self_sacrifice','self_sacrifice|gain_control',
      'reanimate|mill','mill|reanimate'
    ]);
    ${contrastBlock}
    result = inferExplicitMechanicalContrast(
      [{raw:'Exile target creature'}, {raw:"return that card to the battlefield under its owner's control"}],
      [{raw:'Exile target creature'}]
    );
  `, sandbox);
  assert.equal(sandbox.result.kind, 'blink-vs-exile-removal');
});

test('production contrast classifier separates token multiplication from token creation', () => {
  const contrastBlock = sliceBetween('function getMechanicalContrastText(', 'function calculateMechanicalSimilarityDetailed(');
  const sandbox = { result: null };
  vm.runInNewContext(`
    const OPPOSITE_MECHANICS = new Set([]);
    ${contrastBlock}
    result = inferExplicitMechanicalContrast(
      [{raw:'If an effect would create one or more tokens under your control, it creates three times that many tokens instead.'}],
      [{raw:'Create three 1/1 green Saproling creature tokens.'}]
    );
  `, sandbox);
  assert.equal(sandbox.result.kind, 'token-multiplier-vs-token-creation');
});

test('production contrast classifier separates reanimation from graveyard-to-hand recursion', () => {
  const contrastBlock = sliceBetween('function getMechanicalContrastText(', 'function calculateMechanicalSimilarityDetailed(');
  const sandbox = { result: null };
  vm.runInNewContext(`
    const OPPOSITE_MECHANICS = new Set([]);
    ${contrastBlock}
    result = inferExplicitMechanicalContrast(
      [{raw:'Return target creature card from your graveyard to the battlefield.'}],
      [{raw:'Return target creature card from your graveyard to your hand.'}]
    );
  `, sandbox);
  assert.equal(sandbox.result.kind, 'reanimation-vs-graveyard-recursion');
});

test('compound real-card text still distinguishes battlefield reanimation from hand recursion', () => {
  const contrastBlock = sliceBetween('function getMechanicalContrastText(', 'function calculateMechanicalSimilarityDetailed(');
  const sandbox = { result: null };
  vm.runInNewContext(`
    const OPPOSITE_MECHANICS = new Set([]);
    ${contrastBlock}
    result = inferExplicitMechanicalContrast(
      [{raw:'Put target creature card from a graveyard onto the battlefield under your control. You lose life equal to its mana value.'}],
      [{raw:'When this creature enters, you may return target card from your graveyard to your hand.'}]
    );
  `, sandbox);
  assert.equal(sandbox.result.kind, 'reanimation-vs-graveyard-recursion');
});

test('production cadence rank factor strongly downranks one-shot substitutes without excluding them', () => {
  const penaltyStart = app.indexOf('const SOURCE_ACQUISITION_CADENCE_RANKING_PENALTY');
  const scoreBatch = app.indexOf('async function scoreCardBatch(', penaltyStart);
  assert.ok(penaltyStart >= 0 && scoreBatch > penaltyStart);
  const block = app.slice(penaltyStart, scoreBatch);
  const sandbox = {};
  vm.runInNewContext(`${block}; this.factor = sourceAcquisitionCadenceRankFactor;`, sandbox);
  assert.ok(sandbox.factor(0.98) < 0.50, `expected strong penalty, got ${sandbox.factor(0.98)}`);
  assert.equal(sandbox.factor(0), 1);
  assert.ok(Math.abs(sandbox.factor(1) - 0.45) < 1e-9);
});

test('the production scorer applies the new contrast score caps', () => {
  const scorerStart = app.indexOf('function calculateMechanicalSimilarityDetailed(');
  const scorerEnd = app.indexOf('\nfunction calculateMechanicalSimilarity(', scorerStart);
  const scorer = app.slice(scorerStart, scorerEnd);
  assert.match(scorer, /blink-vs-exile-removal'\)\s*score\s*=\s*Math\.min\(score,\s*0\.52\)/);
  assert.match(scorer, /token-multiplier-vs-token-creation'\)\s*score\s*=\s*Math\.min\(score,\s*0\.58\)/);
  assert.match(scorer, /reanimation-vs-graveyard-recursion'\)\s*score\s*=\s*Math\.min\(score\s*\*\s*0\.85,\s*0\.72\)/);
});

test('highlighting only the draw outcome retains native clause context', () => {
  const helperNames = [
    'getHighlightSourceAnchor', 'isCompleteTriggerOutcomeText', 'extractHighlightClauseContext', 'isSearchIntentTriggerPhrase', 'isLikelyEffectOutcomeText',
    'getResolutionAfterTrigger', 'composeHighlightIntentOverride', 'annotateHighlightGroups',
    'buildHighlightScoringText'
  ];
  const blocks = helperNames.map(name => extractFunction(name)).join('\n');
  const sourceText = 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.';
  const start = sourceText.indexOf('draw a card');
  const hs = [{ text: 'draw a card', field: 'oracle', mode: 'variable', origin: 'source', start, end: start + 'draw a card'.length, attachedTo: null }];
  const sandbox = { output: null };
  vm.runInNewContext(`${blocks}\nthis.output = buildHighlightScoringText(${JSON.stringify(hs)}, ${JSON.stringify(sourceText)});`, sandbox);
  assert.match(sandbox.output, /Whenever an opponent casts a spell/i);
  assert.match(sandbox.output, /draw a card/i);
});

test('an unattached user trigger plus selected draw outcome composes the requested trigger and drops unrelated rider', () => {
  const helperNames = [
    'getHighlightSourceAnchor', 'isCompleteTriggerOutcomeText', 'extractHighlightClauseContext', 'isSearchIntentTriggerPhrase', 'isLikelyEffectOutcomeText',
    'getResolutionAfterTrigger', 'composeHighlightIntentOverride', 'annotateHighlightGroups',
    'buildHighlightScoringText'
  ];
  const blocks = helperNames.map(name => extractFunction(name)).join('\n');
  const sourceText = 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.';
  const start = sourceText.indexOf('draw a card');
  // Match the UI case where the user-authored detail exists first, then the user highlights the outcome.
  const hs = [
    { text: 'Whenever an opponent draws a card', field: 'oracle', mode: 'exact', origin: 'user', start: null, end: null, attachedTo: null, intentConnection: 'auto' },
    { text: 'draw a card', field: 'oracle', mode: 'variable', origin: 'source', start, end: start + 'draw a card'.length, attachedTo: null }
  ];
  const sandbox = { output: null };
  vm.runInNewContext(`${blocks}\nthis.output = buildHighlightScoringText(${JSON.stringify(hs)}, ${JSON.stringify(sourceText)});`, sandbox);
  assert.match(sandbox.output, /^Whenever an opponent draws a card, you may draw a card\.?$/i);
  assert.doesNotMatch(sandbox.output, /opponent casts a spell|unless that player pays/i);
});

test('dependent adjacent Oracle sentences are inferred as context in either selection direction', () => {
  const blocks = extractFunction('findDependentOracleContext');
  const sourceText = 'Whenever an opponent draws a card.\nYou draw a card.';
  const triggerStart = sourceText.indexOf('Whenever');
  const triggerEnd = sourceText.indexOf('\n');
  const outcomeStart = sourceText.indexOf('You draw');
  const sandbox = { sourceText, triggerStart, triggerEnd, outcomeStart, results: null };
  vm.runInNewContext(`${blocks}\nthis.results = [\n  findDependentOracleContext(sourceText, outcomeStart, sourceText.length),\n  findDependentOracleContext(sourceText, triggerStart, triggerEnd)\n];`, sandbox);
  assert.equal(sandbox.results.length, 2);
  assert.match(sandbox.results[0].text, /Whenever an opponent draws a card/i);
  assert.match(sandbox.results[1].text, /You draw a card/i);
});

const failed = cases.filter(c => !c.pass);
for (const c of cases) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.error ? ` — ${c.error}` : ''}`);
console.log(`\nCore mechanical unit checks: ${cases.length - failed.length}/${cases.length} passed.`);
if (failed.length) process.exitCode = 1;
