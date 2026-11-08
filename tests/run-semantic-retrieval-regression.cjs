#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');

async function main() {
  const { buildSemanticOracleViews, splitSemanticTextIntoChunks, normalizeManaSearchOracleText } =
    await import('../semantic-card-views.js');

  const longAbility = Array.from({ length: 430 }, (_, i) => 'abilityword' + i).join(' ');
  const chunks = splitSemanticTextIntoChunks(longAbility);
  assert.ok(chunks.length >= 4, 'long Oracle text should produce multiple semantic windows');
  for (const chunk of chunks) {
    assert.ok(chunk.split(/\s+/).length <= 130, 'each semantic window must remain safely below the model input cap');
  }
  const indexedWords = new Set(chunks.join(' ').split(/\s+/));
  for (const word of longAbility.split(/\s+/)) {
    assert.ok(indexedWords.has(word), 'a word from the source ability was omitted: ' + word);
  }
  assert.ok(chunks.slice(1).every(chunk => chunk.includes('abilityword0')), 'later windows should repeat opening context');

  const card = {
    name: 'Two-Faced Test',
    card_faces: [
      { name: 'Front Face', type_line: 'Creature — Wizard', oracle_text: 'Whenever a creature enters the battlefield, draw a card.\n{T}: Add {U}.' },
      { name: 'Back Face', type_line: 'Enchantment', oracle_text: 'At the beginning of your upkeep, create a token.' }
    ]
  };
  const views = buildSemanticOracleViews(card);
  assert.ok(views.length >= 3, 'each face and ability should have a view');
  assert.ok(views.some(view => /Whenever a creature enters/.test(view.text)));
  assert.ok(views.some(view => /Add \{U\}/.test(view.text)));
  assert.ok(views.some(view => /At the beginning of your upkeep/.test(view.text)));
  assert.deepEqual(new Set(views.map(view => view.faceIndex)), new Set([0, 1]));

  const metadataOnly = buildSemanticOracleViews({
    name: 'Metadata Only Card', type_line: 'Artifact', mana_cost: '{2}', cmc: 2,
    produced_mana: ['C'], keywords: ['Ward']
  });
  assert.ok(metadataOnly.length > 0, 'cards without Oracle text should still be indexed');
  assert.match(metadataOnly[0].text, /Artifact/);
  assert.match(metadataOnly[0].text, /Ward/);
  assert.match(normalizeManaSearchOracleText('When Card Name enters, draw a card.', 'Card Name'), /this permanent/);
  console.log('Semantic retrieval regression checks passed.');
}
main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
