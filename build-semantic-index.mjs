import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { pipeline } from '@xenova/transformers';

const OUTPUT = process.argv[2] || 'semantic-index.bin';
const BULK_TYPE = 'oracle_cards';
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const MAGIC = 'MSIDX1';
const VERSION = 1;
const EXPECTED_DIM = 384;
const BATCH_SIZE = 64;

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

function extractOracleText(card) {
    if (!card) return '';
    return String(card.oracle_text || (Array.isArray(card.card_faces)
        ? card.card_faces.map(face => face.oracle_text || '').join(' ')
        : '') || '').trim();
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            'User-Agent': 'ManaSearch/1.0 (Static Semantic Index Builder)',
            'Accept': 'application/json, application/jsonl, application/gzip, */*',
            ...(options.headers || {})
        }
    });
    if (!response.ok) throw new Error(`Request failed (${response.status}) for ${url}`);
    return response.json();
}

async function resolveOracleBulkDescriptor() {
    const meta = await fetchJson('https://api.scryfall.com/bulk-data');
    const entries = Array.isArray(meta) ? meta : meta?.data;
    const descriptor = entries?.find(x => String(x?.type || '').toLowerCase() === BULK_TYPE);
    if (!descriptor) throw new Error('Scryfall oracle_cards bulk-data descriptor was not found.');
    const url = descriptor.jsonl_download_uri || descriptor.download_uri;
    if (!url) throw new Error('Scryfall oracle_cards bulk-data descriptor has no download URL.');
    return { ...descriptor, url };
}

function decodeBulkBuffer(buffer, url) {
    const raw = Buffer.from(buffer);
    const data = /\.gz(?:\?|$)/i.test(url) ? gunzipSync(raw) : raw;
    return data.toString('utf8');
}

function parseCards(text, url) {
    const trimmed = text.trim();
    if (!trimmed) return [];
    if (!/\.jsonl(?:\.gz)?(?:\?|$)/i.test(url)) {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
    }
    const cards = [];
    for (const line of trimmed.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            const card = JSON.parse(line);
            if (card?.name) cards.push(card);
        } catch (_) {
            // Skip a malformed record rather than aborting an otherwise usable bulk file.
        }
    }
    return cards;
}

function quantize(vector) {
    const out = new Int8Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
        const value = Math.max(-1, Math.min(1, Number(vector[i]) || 0));
        out[i] = Math.max(-127, Math.min(127, Math.round(value * 127)));
    }
    return out;
}

function encodeIndex(names, vectors, dim) {
    const encoder = new TextEncoder();
    const encodedNames = names.map(name => encoder.encode(name));
    const namesBytes = encodedNames.reduce((sum, bytes) => sum + 2 + bytes.length, 0);
    const vectorsBytes = vectors.length * dim;
    const HEADER_BYTES = 32;
    const output = Buffer.allocUnsafe(HEADER_BYTES + namesBytes + vectorsBytes);
    output.fill(0);
    output.write(MAGIC, 0, 'ascii');
    output.writeUInt32LE(VERSION, 8);
    output.writeUInt32LE(dim, 12);
    output.writeUInt32LE(names.length, 16);
    output.writeUInt32LE(namesBytes, 20);
    output.writeUInt32LE(vectorsBytes, 24);
    output.writeUInt32LE(0, 28); // flags/reserved for future format additions

    let cursor = HEADER_BYTES;
    for (const bytes of encodedNames) {
        if (bytes.length > 0xffff) throw new Error(`Card name is unexpectedly long: ${bytes.length} bytes`);
        output.writeUInt16LE(bytes.length, cursor);
        cursor += 2;
        Buffer.from(bytes).copy(output, cursor);
        cursor += bytes.length;
    }

    for (const vector of vectors) {
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).copy(output, cursor);
        cursor += vector.byteLength;
    }
    return output;
}

async function main() {
    console.log(`Resolving Scryfall ${BULK_TYPE} bulk data…`);
    const descriptor = await resolveOracleBulkDescriptor();
    console.log(`Using bulk revision: ${descriptor.updated_at || 'unknown'}`);
    console.log(`Downloading: ${descriptor.url}`);

    const response = await fetch(descriptor.url, {
        headers: {
            'User-Agent': 'ManaSearch/1.0 (Static Semantic Index Builder)',
            'Accept': 'application/jsonl, application/json, application/gzip, */*'
        }
    });
    if (!response.ok) throw new Error(`Scryfall bulk download failed (${response.status}).`);
    const buffer = await response.arrayBuffer();
    const text = decodeBulkBuffer(buffer, descriptor.url);
    const allCards = parseCards(text, descriptor.url);
    if (allCards.length === 0) throw new Error('Scryfall bulk data contained no cards.');

    console.log(`Preparing semantic text for ${allCards.length.toLocaleString()} Oracle cards…`);
    const rows = [];
    for (const card of allCards) {
        const oracle = normalizeOracleForEmbedding(extractOracleText(card), card.name || '');
        if (!oracle) continue;
        rows.push({ name: card.name, text: oracle });
    }
    console.log(`Embedding ${rows.length.toLocaleString()} cards with ${MODEL} in batches of ${BATCH_SIZE}…`);

    const extractor = await pipeline('feature-extraction', MODEL, { quantized: true });
    const names = [];
    const vectors = [];
    const startedAt = Date.now();

    for (let start = 0; start < rows.length; start += BATCH_SIZE) {
        const batch = rows.slice(start, start + BATCH_SIZE);
        const output = await extractor(batch.map(row => row.text), { pooling: 'mean', normalize: true });
        const dims = output?.dims;
        if (!Array.isArray(dims) || dims.length < 2 || dims[0] !== batch.length) {
            throw new Error(`Unexpected embedding shape: ${JSON.stringify(dims)}.`);
        }
        const dim = dims[dims.length - 1];
        if (dim !== EXPECTED_DIM) throw new Error(`Expected ${EXPECTED_DIM}-D embeddings, received ${dim}-D.`);
        for (let i = 0; i < batch.length; i++) {
            names.push(batch[i].name);
            vectors.push(quantize(output.data.slice(i * dim, (i + 1) * dim)));
        }
        if (start === 0 || (start + BATCH_SIZE) % 1024 === 0 || start + BATCH_SIZE >= rows.length) {
            const pct = ((Math.min(rows.length, start + BATCH_SIZE) / rows.length) * 100).toFixed(1);
            console.log(`  ${Math.min(rows.length, start + BATCH_SIZE).toLocaleString()}/${rows.length.toLocaleString()} (${pct}%)`);
        }
    }

    const outputBuffer = encodeIndex(names, vectors, EXPECTED_DIM);
    await fs.writeFile(OUTPUT, outputBuffer);

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`Wrote ${OUTPUT}`);
    console.log(`  cards: ${names.length.toLocaleString()}`);
    console.log(`  vectors: ${(vectors.length * EXPECTED_DIM).toLocaleString()} bytes`);
    console.log(`  file: ${(outputBuffer.length / 1024 / 1024).toFixed(2)} MiB`);
    console.log(`  embedding time: ${seconds}s`);
    console.log(`  bulk updated_at: ${descriptor.updated_at || 'unknown'}`);
}

main().catch(error => {
    console.error(error?.stack || error);
    process.exit(1);
});
