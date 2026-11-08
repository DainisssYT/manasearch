import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticDocuments, normalizeOracleForEmbedding } from '../scripts/semantic-text.mjs';

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
  assert.ok(docs.length > 0);
  assert.ok(docs.some(doc => /attacks/.test(doc.text) && /draw a card/.test(doc.text)));
});
