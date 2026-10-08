import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { pipeline as createPipeline } from '@xenova/transformers';

const gzip = promisify(zlib.gzip);
const ROOT = process.cwd();
const CARDS_OUT = path.join(ROOT, 'cards.bin');
const SEMANTIC_OUT = path.join(ROOT, 'semantic-index.bin');
const META_OUT = path.join(ROOT, 'static-data-meta.json');
const SCRYPT = 'https://api.scryfall.com/bulk-data';
const USER_AGENT = 'ManaSearch-static-data-builder/1.0 (GitHub Pages project)';
const SEMANTIC_MAGIC = 'MSIDX1';
const SEMANTIC_VERSION = 1;
const CARD_MAGIC = 'MSCARD1G';
const CARD_VERSION = 1;
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_BATCH_SIZE = 32;
const BUILDER_VERSION = 3;

const SEMANTIC_KEYWORD_EXPANSIONS = {
  cascade: ' cascade reveals cards until a spell is found and casts it ',
  flashback: ' flashback cast from graveyard ',
  prowess: ' prowess gets plus one plus one when you cast a noncreature spell ',
  deathtouch: ' deathtouch lethal damage destroys creature ',
  lifelink: ' lifelink damage causes you to gain life ',
  trample: ' trample excess combat damage to defending player ',
  vigilance: ' vigilance does not tap to attack ',
  menace: ' menace requires two or more blockers ',
  flying: ' flying can be blocked only by flying or reach ',
  haste: ' haste can attack and tap immediately ',
  hexproof: ' hexproof cannot be targeted by opponents ',
  indestructible: ' indestructible cannot be destroyed by damage or destroy effects '
};

function normalizeOracleForEmbedding(text, cardName = '') {
  let value = String(text || '');
  if (!value) return '';
  if (cardName) {
    const escaped = String(cardName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), 'this permanent');
  }
  value = value.replace(/\([^()]*\)/g, ' ');
  value = value.replace(/\{T\}/gi, ' tap ')
    .replace(/\{Q\}/gi, ' untap ')
    .replace(/\{[WUBRGC]\}/gi, ' colored mana ')
    .replace(/\{\d+\}/g, ' generic mana ')
    .replace(/\{X\}/gi, ' X mana ')
    .replace(/\{[^}]+\}/g, ' mana symbol ');
  for (const [keyword, expansion] of Object.entries(SEMANTIC_KEYWORD_EXPANSIONS)) {
    value = value.replace(new RegExp(`\\b${keyword}\\b`, 'gi'), ` ${keyword} ${expansion} `);
  }
  return value.replace(/[^a-z0-9+\-\s]/gi, ' ').replace(/\s+/g, ' ').trim();
}

function getOracleText(card) {
  if (typeof card?.oracle_text === 'string' && card.oracle_text.trim()) return card.oracle_text;
  return Array.isArray(card?.card_faces)
    ? card.card_faces.map(face => face?.oracle_text || '').filter(Boolean).join(' ')
    : '';
}

function compactFace(face) {
  if (!face) return null;
  return {
    name: face.name,
    mana_cost: face.mana_cost,
    type_line: face.type_line,
    oracle_text: face.oracle_text,
    colors: face.colors,
    color_indicator: face.color_indicator,
    power: face.power,
    toughness: face.toughness,
    loyalty: face.loyalty,
    defense: face.defense,
    hand_modifier: face.hand_modifier,
    life_modifier: face.life_modifier,
    image_uris: face.image_uris
  };
}

function compactCard(card) {
  return {
    id: card.id,
    oracle_id: card.oracle_id,
    name: card.name,
    lang: card.lang,
    released_at: card.released_at,
    layout: card.layout,
    mana_cost: card.mana_cost,
    cmc: card.cmc,
    type_line: card.type_line,
    oracle_text: card.oracle_text,
    colors: card.colors,
    color_identity: card.color_identity,
    keywords: card.keywords,
    produced_mana: card.produced_mana,
    power: card.power,
    toughness: card.toughness,
    loyalty: card.loyalty,
    defense: card.defense,
    hand_modifier: card.hand_modifier,
    life_modifier: card.life_modifier,
    card_faces: Array.isArray(card.card_faces) ? card.card_faces.map(compactFace).filter(Boolean) : undefined,
    image_uris: card.image_uris,
    prices: card.prices,
    legalities: card.legalities,
    set: card.set,
    set_name: card.set_name,
    collector_number: card.collector_number,
    rarity: card.rarity,
    artist: card.artist,
    flavor_text: card.flavor_text,
    finishes: card.finishes,
    promo_types: card.promo_types,
    games: card.games,
    scryfall_uri: card.scryfall_uri
  };
}

function writeSemanticIndex(cards, vectors) {
  const encoder = new TextEncoder();
  const nameParts = [];
  let namesBytes = 0;
  for (const card of cards) {
    const bytes = encoder.encode(card.name);
    if (bytes.length > 65535) throw new Error(`Card name is too long: ${card.name}`);
    const part = Buffer.allocUnsafe(2 + bytes.length);
    part.writeUInt16LE(bytes.length, 0);
    Buffer.from(bytes).copy(part, 2);
    nameParts.push(part);
    namesBytes += part.length;
  }
  const dim = vectors[0]?.length || 0;
  if (!dim) throw new Error('No embedding vectors were generated.');
  const vectorBytes = Buffer.allocUnsafe(cards.length * dim);
  let offset = 0;
  for (const vector of vectors) {
    for (let i = 0; i < dim; i++) {
      const v = Math.max(-1, Math.min(1, Number(vector[i]) || 0));
      vectorBytes.writeInt8(Math.max(-127, Math.min(127, Math.round(v * 127))), offset++);
    }
  }
  const header = Buffer.alloc(32);
  header.write(SEMANTIC_MAGIC, 0, 'ascii');
  header.writeUInt32LE(SEMANTIC_VERSION, 8);
  header.writeUInt32LE(dim, 12);
  header.writeUInt32LE(cards.length, 16);
  header.writeUInt32LE(namesBytes, 20);
  header.writeUInt32LE(vectorBytes.length, 24);
  return Buffer.concat([header, ...nameParts, vectorBytes]);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json;q=0.9,*/*;q=0.8'
    }
  });
  if (!response.ok) throw new Error(`Scryfall request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function writeAtomicFile(filePath, data) {
  const directory = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(directory, `.${base}.tmp-${process.pid}`);
  try {
    await fs.writeFile(tempPath, data);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try { await fs.unlink(tempPath); } catch (_) {}
    throw error;
  }
}

async function main() {
  console.log('Fetching Scryfall bulk-data metadata…');
  const bulk = await fetchJson(SCRYPT);
  const oracleEntry = bulk.data?.find(item => item.type === 'oracle_cards');
  if (!oracleEntry?.download_uri) throw new Error('Scryfall oracle_cards bulk dataset was not found.');

  let previousMeta = null;
  try { previousMeta = JSON.parse(await fs.readFile(META_OUT, 'utf8')); } catch (_) {}
  if (previousMeta?.oracle_cards_updated_at === oracleEntry.updated_at &&
      previousMeta?.model === MODEL_ID &&
      previousMeta?.builder_version === BUILDER_VERSION &&
      (await exists(CARDS_OUT)) && (await exists(SEMANTIC_OUT))) {
    console.log(`Oracle card dataset is unchanged (${oracleEntry.updated_at}); static assets are already current.`);
    return;
  }

  console.log(`Downloading oracle card dataset (${oracleEntry.size} bytes)…`);
  const response = await fetch(oracleEntry.download_uri, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/gzip,application/json;q=0.9,*/*;q=0.8' }
  });
  if (!response.ok) throw new Error(`Bulk download failed: ${response.status} ${response.statusText}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  const raw = zlib.gunzipSync(compressed);
  const sourceCards = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(sourceCards) || !sourceCards.length) throw new Error('Downloaded oracle card dataset is empty.');

  // Oracle cards are already the right semantic unit: one record per distinct Oracle card,
  // rather than every printing. Keep only records usable by the search UI.
  const cards = sourceCards.filter(card => card?.name).map(compactCard);
  console.log(`Preparing ${cards.length.toLocaleString()} Oracle cards…`);

  // Everything below is built in memory first. Existing published assets are not touched
  // until cards.bin, semantic-index.bin, and metadata have all been generated successfully.
  const generatedAt = new Date().toISOString();
  const buildId = `${oracleEntry.updated_at}|${MODEL_ID}|${BUILDER_VERSION}`;

  const cardPayload = Buffer.from(JSON.stringify({
    version: CARD_VERSION,
    build_id: buildId,
    generated_at: generatedAt,
    cards
  }));
  const cardCompressed = await gzip(cardPayload, { level: 9 });
  const cardHeader = Buffer.alloc(24);
  cardHeader.write(CARD_MAGIC, 0, 'ascii');
  cardHeader.writeUInt32LE(CARD_VERSION, 8);
  cardHeader.writeUInt32LE(cardCompressed.length, 12);
  cardHeader.writeUInt32LE(cards.length, 16);
  cardHeader.writeUInt32LE(1, 20); // flag 1 = gzip payload
  const cardBinary = Buffer.concat([cardHeader, cardCompressed]);
  console.log(`Prepared ${path.basename(CARDS_OUT)} (${(cardBinary.length / 1024 / 1024).toFixed(2)} MiB compressed).`);

  console.log(`Loading ${MODEL_ID}…`);
  const extractor = await createPipeline('feature-extraction', MODEL_ID, { quantized: true });
  const vectors = [];
  const texts = cards.map(card => normalizeOracleForEmbedding(getOracleText(card), card.name));
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const chunk = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const output = await extractor(chunk, { pooling: 'mean', normalize: true });
    const dims = output?.dims;
    if (!Array.isArray(dims) || dims.length < 2 || dims[0] !== chunk.length) {
      throw new Error(`Unexpected embedding shape at batch ${i}: ${JSON.stringify(dims)}`);
    }
    const hidden = dims[dims.length - 1];
    for (let j = 0; j < chunk.length; j++) vectors.push(output.data.slice(j * hidden, (j + 1) * hidden));
    console.log(`Embedded ${Math.min(i + chunk.length, texts.length).toLocaleString()}/${texts.length.toLocaleString()}`);
  }

  const semanticBinary = writeSemanticIndex(cards, vectors);
  console.log(`Prepared ${path.basename(SEMANTIC_OUT)} (${(semanticBinary.length / 1024 / 1024).toFixed(2)} MiB).`);

  const metadata = JSON.stringify({
    builder_version: BUILDER_VERSION,
    generated_at: generatedAt,
    build_id: buildId,
    oracle_cards_updated_at: oracleEntry.updated_at,
    oracle_cards_uri: oracleEntry.download_uri,
    card_count: cards.length,
    embedding_dimension: vectors[0]?.length || 0,
    model: MODEL_ID
  }, null, 2) + '\n';

  // Final validation happens before replacing any existing asset. This means a failed
  // download, compression, embedding run, or serialization leaves the previous release intact.
  if (!cardBinary.length || !semanticBinary.length || !metadata.length) {
    throw new Error('Static asset generation produced an empty artifact.');
  }
  if (vectors.length !== cards.length) {
    throw new Error(`Semantic vector/card count mismatch: ${vectors.length} vectors for ${cards.length} cards.`);
  }
  if (vectors[0]?.length !== 384) {
    throw new Error(`Unexpected semantic dimension: ${vectors[0]?.length || 0}; expected 384.`);
  }

  // Replace each final file only after every artifact is complete. The temporary-file
  // rename is atomic on the filesystem, so an interrupted build cannot leave a truncated
  // cards.bin or semantic-index.bin behind. GitHub Actions commits the three replacements
  // together only after this function exits successfully.
  await writeAtomicFile(CARDS_OUT, cardBinary);
  await writeAtomicFile(SEMANTIC_OUT, semanticBinary);
  await writeAtomicFile(META_OUT, metadata);
  console.log(`Static data build ${buildId} committed locally as three complete artifacts.`);
}

async function exists(file) {
  try { await fs.access(file); return true; } catch (_) { return false; }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

