import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticDocuments, enforceSemanticTokenBudget, mergeSemanticRetrievalRanks, normalizeOracleForEmbedding } from '../scripts/semantic-text.mjs';

test('normalization preserves parenthetical rules and reminder text', () => {
  const text = normalizeOracleForEmbedding('Flying (This creature can\'t be blocked except by creatures with flying or reach.)');
  assert.match(text, /reach/);
  assert.match(text, /flying/);
});

test('mana symbols retain their color and special meaning', () => {
  const text = normalizeOracleForEmbedding('Add {W}{U}{C}{2}{W/U}{W/P}.');
  assert.match(text, /white mana/);
  assert.match(text, /blue mana/);
  assert.match(text, /colorless mana/);
  assert.match(text, /generic mana/);
  assert.match(text, /hybrid mana/);
  assert.match(text, /phyrexian mana/);
});

test('each double-faced card face is indexed independently', () => {
  const docs = buildSemanticDocuments([{
    name: 'Test Transform',
    card_faces: [
      { name: 'Front', type_line: 'Creature', mana_cost: '{1}{G}', oracle_text: 'Whenever this creature attacks, draw a card.' },
      { name: 'Back', type_line: 'Enchantment', mana_cost: '', oracle_text: 'At the beginning of your upkeep, create a token.' }
    ]
  }]);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].name, 'Test Transform');
  assert.match(docs[0].text, /attacks/);
  assert.match(docs[1].text, /upkeep/);
  assert.notEqual(docs[0].face, docs[1].face);
});

test('long abilities are chunked with overlap instead of being discarded', () => {
  const longText = Array.from({ length: 410 }, (_, i) => `ruleword${i}`).join(' ');
  const docs = buildSemanticDocuments([{ name: 'Long Card', oracle_text: longText }], { maxWords: 100, overlapWords: 15 });
  assert.ok(docs.length >= 4);
  assert.match(docs[0].text, /ruleword0/);
  assert.ok(docs.some(doc => /ruleword409/.test(doc.text)));
});

test('card-level Oracle text is retained when face records omit it', () => {
  const docs = buildSemanticDocuments([{
    name: 'Fallback Transform',
    oracle_text: 'Whenever this card attacks, draw a card.',
    card_faces: [
      { name: 'Front', type_line: 'Creature', oracle_text: '' },
      { name: 'Back', type_line: 'Enchantment', oracle_text: '' }
    ]
  }]);
  assert.equal(docs.length, 1);
  assert.ok(docs.some(doc => /attacks/.test(doc.text) && /draw a card/.test(doc.text)));
});

test('cards without Oracle text retain searchable structured profiles', () => {
  const docs = buildSemanticDocuments([{
    name: 'Vanilla Profile',
    mana_cost: '{2}{G}',
    cmc: 3,
    type_line: 'Creature — Bear',
    colors: ['G'],
    color_identity: ['G'],
    power: '3',
    toughness: '3'
  }]);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].kind, 'profile');
  assert.match(docs[0].text, /creature bear/i);
  assert.match(docs[0].text, /power 3/);
  assert.match(docs[0].text, /toughness 3/);
  assert.match(docs[0].text, /green mana/);
});


test('semantic documents are split to the actual tokenizer budget without losing the ability tail', async () => {
  const ability = Array.from({ length: 180 }, (_, i) => `ruleword${i}`).join(' ');
  const initial = buildSemanticDocuments([{ name: 'Token Budget Card', oracle_text: ability }], {
    maxWords: 120,
    overlapWords: 12
  });
  const tokenizer = async text => ({
    input_ids: { dims: [1, String(text).trim().split(/\s+/).filter(Boolean).length] }
  });
  const fitted = await enforceSemanticTokenBudget(initial, tokenizer, { maxTokens: 40, overlapWords: 6 });
  assert.ok(fitted.length > initial.length, 'oversized ability chunks should be split further');
  assert.ok(fitted.every(document => document.tokenCount <= 40));
  assert.ok(fitted.some(document => /ruleword179/.test(document.text)), 'the final Oracle words must remain searchable');
});

test('semantic retrieval uses reciprocal rank fusion and records ability coverage', () => {
  const results = mergeSemanticRetrievalRanks([
    [{ name: 'A', similarity: 0.72 }, { name: 'B', similarity: 0.70 }],
    [{ name: 'B', similarity: 0.79 }, { name: 'A', similarity: 0.74 }],
    [{ name: 'A', similarity: 0.68 }, { name: 'C', similarity: 0.76 }]
  ], ['intent', 'ability-1', 'ability-2']);
  assert.equal(results[0].name, 'A');
  assert.equal(results[0]._semanticAbilityCoverage, 2);
  assert.equal(results[0]._semanticAbilityTotal, 2);
  assert.equal(results[0]._semanticAbilityCoverageRatio, 1);
  assert.ok(results[0]._semanticRrfScoreRatio > 0);
  assert.ok(results.some(item => item.name === 'B' && item._semanticAbilityCoverage === 1));
});


test('long Oracle clauses keep their trigger and initial cost context in later chunks', () => {
  const tail = Array.from({ length: 96 }, (_, i) => `detailword${i}`).join(' ');
  const oracle = `Whenever this creature attacks, you may pay {2}. If you do, ${tail}; then create a Treasure token.`;
  const docs = buildSemanticDocuments([{ name: 'Clause Anchor', oracle_text: oracle }], {
    maxWords: 20,
    overlapWords: 5
  });
  assert.ok(docs.length >= 4);
  assert.ok(docs.slice(1).every(doc => /Whenever this creature attacks, you may pay/.test(doc.abilityText)),
    'continuation chunks must retain the trigger and cost anchor');
  assert.ok(docs.some(doc => /detailword95/.test(doc.abilityText)), 'the end of the long effect must remain indexed');
  assert.ok(docs.some(doc => /create a Treasure token/.test(doc.abilityText)), 'a trailing clause must not be dropped');
});


test('keyword-heavy Odric ability keeps keyword names without duplicating their definitions in metadata', async () => {
  const card = {
    name: 'Odric, Blood-Cursed',
    mana_cost: '{1}{R}{W}',
    type_line: 'Legendary Creature — Vampire Soldier',
    colors: ['R', 'W'],
    color_identity: ['R', 'W'],
    keywords: ['deathtouch', 'double strike', 'first strike', 'haste', 'hexproof', 'indestructible', 'lifelink', 'menace', 'reach', 'trample'],
    oracle_text: 'When Odric, Blood-Cursed enters, create X Blood tokens, where X is the number of abilities from among flying, first strike, double strike, deathtouch, haste, hexproof, indestructible, lifelink, menace, reach, trample, and vigilance found among creatures you control. (Count each ability only once.)'
  };
  const documents = buildSemanticDocuments([card], { maxWords: 32, overlapWords: 8 });
  assert.ok(documents.length > 0);
  const first = documents[0].text;
  const deathtouchExpansion = 'deathtouch makes any amount of damage lethal to a creature';
  assert.equal(first.split(deathtouchExpansion).length - 1, 1,
    'the deathtouch definition should be expanded once, not duplicated by the keywords metadata');
  assert.match(first, /keywords deathtouch double strike first strike haste/);
  const tokenizer = async text => ({
    input_ids: { dims: [1, String(text).trim().split(/\s+/).filter(Boolean).length] }
  });
  const fitted = await enforceSemanticTokenBudget(documents, tokenizer, { maxTokens: 240, overlapWords: 8 });
  assert.ok(fitted.length > 0);
  assert.ok(fitted.every(document => document.tokenCount <= 240));
  assert.ok(fitted.some(document => /count each ability only once/.test(document.text)),
    'the parenthetical count-once rule must remain indexed');
});

test('oversized metadata context is compacted before rejecting a short Oracle ability', async () => {
  const fullContext = 'card face Short Ability. type Legendary Creature. ' +
    Array.from({ length: 180 }, (_, i) => 'secondaryfield' + i).join(' ');
  const compactContext = 'card face Short Ability. type Legendary Creature. mana cost one green mana';
  const documents = [{
    name: 'Short Ability',
    face: 'Short Ability',
    contextText: fullContext,
    compactContextText: compactContext,
    minimalContextText: 'card face Short Ability. type Legendary Creature',
    abilityText: 'Create a Blood token.',
    text: fullContext + ' ability create a blood token'
  }];
  const tokenizer = async text => ({
    input_ids: { dims: [1, String(text).trim().split(/\s+/).filter(Boolean).length] }
  });
  const fitted = await enforceSemanticTokenBudget(documents, tokenizer, { maxTokens: 40 });
  assert.equal(fitted.length, 1);
  assert.ok(fitted[0].tokenCount <= 40);
  assert.equal(fitted[0].contextText, compactContext);
  assert.match(fitted[0].text, /create a blood token/);
});
