import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('semantic worker ranks unique cards, not duplicate ability rows', async () => {
  const source = await readFile(new URL('../semantic-search-worker.js', import.meta.url), 'utf8');
  const messages = [];
  const self = { postMessage(message) { messages.push(message); } };
  vm.runInNewContext(source, { self, console });

  const names = Array.from({ length: 45 }, () => 'Ability-heavy card');
  names.push('Closest distinct card', 'Second distinct card');
  const normalizedNames = names.map(name => name.toLowerCase());
  const vectors = new Int8Array(names.length * 2);
  const norms = new Float32Array(names.length);
  for (let i = 0; i < 45; i++) {
    vectors[i * 2] = 127;
    norms[i] = 127 * 127;
  }
  vectors[90] = 110;
  vectors[91] = 60;
  norms[45] = 110 * 110 + 60 * 60;
  vectors[92] = 100;
  vectors[93] = 80;
  norms[46] = 100 * 100 + 80 * 80;

  await self.onmessage({ data: {
    type: 'init',
    dim: 2,
    chunks: [{
      names,
      normalizedNames,
      ids: [],
      buffer: vectors.buffer,
      normBuffer: norms.buffer,
      count: names.length
    }]
  } });
  await self.onmessage({ data: {
    type: 'query',
    queryBuffer: Float32Array.from([127, 0]).buffer,
    limit: 2,
    minSimilarity: 0.2,
    baseline: 0.3,
    generation: 1
  } });

  const result = messages.find(message => message.type === 'result');
  assert.ok(result, JSON.stringify(messages));
  assert.deepEqual(Array.from(result.results, item => item.name), [
    'Ability-heavy card',
    'Closest distinct card'
  ]);
});

test('semantic baseline calibration samples across the entire ability index', async () => {
  const source = await readFile(new URL('../semantic-search-worker.js', import.meta.url), 'utf8');
  const messages = [];
  const self = { postMessage(message) { messages.push(message); } };
  vm.runInNewContext(source + '\nself.__calibrateSemanticBaseline = calibrateSemanticBaseline;', { self, console });

  const count = 1200;
  const dim = 2;
  const vectors = new Int8Array(count * dim);
  const norms = new Float32Array(count);
  // The first 96 rows deliberately look identical (the failure mode in the old sampler).
  for (let i = 0; i < 96; i++) {
    vectors[i * dim] = 127;
    norms[i] = 127 * 127;
  }
  // The rest of the index has varied vectors, so a corpus-wide background estimate is lower.
  for (let i = 96; i < count; i++) {
    const mode = i % 3;
    vectors[i * dim] = mode === 0 ? 127 : 0;
    vectors[i * dim + 1] = mode === 1 ? 127 : (mode === 2 ? 127 : 0);
    norms[i] = vectors[i * dim] ** 2 + vectors[i * dim + 1] ** 2;
  }

  const calibrated = self.__calibrateSemanticBaseline(vectors, count, dim, norms);
  assert.ok(calibrated < 0.52, 'baseline should not be pinned by the first 96 duplicate-like rows');
});
