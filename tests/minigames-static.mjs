import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('index.html');
const app = read('app.js');
const game = read('minigames.js');
const styles = read('minigames.css');
const puzzlesDoc = JSON.parse(read('minigames/puzzles.json'));

assert.match(html, /id="minigames-btn"/);
assert.match(html, /<dialog id="minigames-dialog"/);
assert.match(html, /href="minigames\.css\?v=20261020-118"/);
assert.match(html, /src="minigames\.js\?v=20261020-118"/);
assert.match(html, /app\.js\?v=20261020-118/);
assert.match(app, /window\.ManaSearchApi\s*=\s*Object\.freeze/);
for (const apiName of ['getCardByName', 'getCardNames', 'getOracleText', 'parseEffects', 'scoreEffectMatch', 'assignEffects', 'openCard']) {
    assert.match(app, new RegExp(`\\b${apiName}\\s*\\(`), `Missing minigame API method: ${apiName}`);
}
assert.match(game, /assignEffects\(typedEffects, hiddenEffects, 'variable'\)/);
assert.match(game, /wrongGuessLimit:\s*6/);
assert.match(game, /abilityCheckLimit:\s*3/);
assert.match(game, /runManaSearchMinigameRegressionSuite/);
assert.match(game, /item\.cardId && guessedCard\.id && item\.cardId === guessedCard\.id/, 'alternate faces of the same card should count as a repeated guess');
assert.ok(game.includes(".replace(/^[\\s.,;:!?]+|[\\s.,;:!?]+$/g, '').replace(/\\s+/g, ' ')"), 'ability-check dedupe should ignore terminal punctuation');
assert.match(app, /card\.cmc !== null && card\.cmc !== undefined && card\.cmc !== ''/, 'unknown mana values must not be converted to zero');

assert.match(html, /Starting minigames… retrying the game module\./, 'launcher must fail visibly if its module did not initialize');
assert.match(html, /import\(retryUrl\)/, 'launcher must retry a cache-busted module request after a boot failure');
assert.match(game, /open:\s*openMinigames/, 'minigame module must expose its open action to the launcher recovery');
assert.match(game, /dataset\.minigamesBound !== 'true'/, 'module recovery must avoid duplicate click handlers');
const appBuild = app.match(/MANASEARCH_APP_BUILD\s*=\s*'([^']+)'/)?.[1];
assert.ok(appBuild, 'app build tag must be present');
for (const asset of ['app.js', 'pako.min.js', 'style.css', 'minigames.js', 'minigames.css']) {
    assert.match(html, new RegExp(`${asset.replace('.', '\\.')}\\?v=${appBuild}`), `${asset} asset URL must match app build tag`);
}

for (const forbidden of ['currentSourceCard', 'lastSearchResults', 'manualHighlights', 'searchRequestId', 'HISTORY_KEY', 'addToHistory']) {
    assert.ok(!game.includes(forbidden), `Minigame UI should not access ${forbidden} directly`);
}

assert.equal(puzzlesDoc.schemaVersion, 1);
assert.equal(puzzlesDoc.puzzles.length, 20);
const ignored = new Set(['a', 'an', 'and', 'of', 'the', 'to', 'in', 'on', 'for', 'with', 'from', 'by', 'at']);
const normalize = value => String(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const words = value => new Set(normalize(value).split(' ').filter(word => word.length > 2 && !ignored.has(word)));
for (const puzzle of puzzlesDoc.puzzles) {
    assert.ok(puzzle.id && puzzle.answer, 'Each puzzle must have an ID and answer');
    assert.equal(puzzle.candidates.length, 8, `${puzzle.id} should have 8 candidate records`);
    const seen = new Set();
    for (const candidate of puzzle.candidates) {
        const key = normalize(candidate.name);
        assert.ok(key, `${puzzle.id} has a blank candidate name`);
        assert.ok(!seen.has(key), `${puzzle.id} repeats candidate ${candidate.name}`);
        seen.add(key);
        assert.ok([0, 1, 4].includes(candidate.revealAtWrongGuesses), `${puzzle.id} has an invalid reveal step`);
        assert.ok(Number.isFinite(candidate.rank) && candidate.rank >= 15 && candidate.rank <= 40, `${puzzle.id} rank must be within 15–40`);
        const overlap = [...words(puzzle.answer)].filter(word => words(candidate.name).has(word));
        assert.deepEqual(overlap, [], `${puzzle.id} candidate ${candidate.name} leaks an answer word`);
        assert.ok(candidate.reason && candidate.reason.length >= 20, `${puzzle.id} candidate ${candidate.name} needs a similarity rationale`);
    }
    assert.equal(puzzle.candidates.filter(candidate => candidate.revealAtWrongGuesses === 0).length, 3);
    assert.equal(puzzle.candidates.filter(candidate => candidate.revealAtWrongGuesses === 1).length, 2);
    assert.equal(puzzle.candidates.filter(candidate => candidate.revealAtWrongGuesses === 4).length, 3);
    assert.ok(puzzle.candidates.every((candidate, index, all) => index === 0 || all[index - 1].revealAtWrongGuesses <= candidate.revealAtWrongGuesses), `${puzzle.id} candidate rows must be ordered by clue unlock stage`);
}

let depth = 0;
for (const char of styles) {
    if (char === '{') depth++;
    if (char === '}') depth--;
    assert.ok(depth >= 0, 'CSS has a closing brace without an opening brace');
}
assert.equal(depth, 0, 'CSS brace count must balance');

console.log(`Minigame static integration checks passed (${puzzlesDoc.puzzles.length} puzzles, ${puzzlesDoc.puzzles.reduce((sum, puzzle) => sum + puzzle.candidates.length, 0)} candidate records).`);
