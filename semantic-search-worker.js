/* ManaSearch dedicated local-data and semantic-search worker.
 * No remote card API is used at runtime. Binary assets are fetched from the same static site.
 */
let indexChunks = [];
let indexDim = 384;
let semanticIndexUrl = '';
let ready = false;
let latestGeneration = -1;

function normalizeCardName(name) {
    return String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

async function fetchArrayBuffer(url, timeoutMs = 60000, cacheMode = 'force-cache') {
    if (typeof AbortController !== 'function') {
        const response = await fetch(url, { method: 'GET', cache: cacheMode });
        if (!response.ok) throw new Error(`Request failed (${response.status}) for ${url}`);
        return response.arrayBuffer();
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch (_) {}
    }, Math.max(1000, Number(timeoutMs) || 60000));
    try {
        const response = await fetch(url, { method: 'GET', cache: cacheMode, signal: controller.signal });
        if (!response.ok) throw new Error(`Request failed (${response.status}) for ${url}`);
        return await response.arrayBuffer();
    } catch (error) {
        if (timedOut) throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function* decompressCardJsonChunks(buffer, payloadBytes) {
    const compressed = new Uint8Array(buffer, 24, payloadBytes);
    if (typeof DecompressionStream === 'function' && typeof ReadableStream !== 'undefined') {
        let offset = 0;
        const compressedStream = new ReadableStream({
            pull(controller) {
                if (offset >= compressed.length) {
                    controller.close();
                    return;
                }
                const end = Math.min(offset + 64 * 1024, compressed.length);
                controller.enqueue(compressed.subarray(offset, end));
                offset = end;
            }
        });
        const reader = compressedStream.pipeThrough(new DecompressionStream('gzip')).getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (text) yield text;
        }
        const tail = decoder.decode();
        if (tail) yield tail;
        return;
    }

    // Compatibility fallback for older worker implementations without DecompressionStream.
    if (!self.pako) {
        try { importScripts(new URL('./pako.min.js', self.location.href).href); } catch (_) {}
    }
    if (!self.pako?.ungzip) throw new Error('This browser cannot decompress cards.bin in a worker.');
    const text = self.pako.ungzip(compressed, { to: 'string' });
    for (let offset = 0; offset < text.length; offset += 64 * 1024) {
        yield text.slice(offset, offset + 64 * 1024);
    }
}

async function loadCards(data) {
    const buffer = await fetchArrayBuffer(data.url, data.timeoutMs, data.cacheMode);
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24) throw new Error('cards.bin is too small or empty.');
    const bytes = new Uint8Array(buffer, 0, 8);
    if (new TextDecoder().decode(bytes) !== 'MSCARD1G') throw new Error('cards.bin has an unknown binary format.');
    const view = new DataView(buffer);
    const version = view.getUint32(8, true);
    const payloadBytes = view.getUint32(12, true);
    const declaredCount = view.getUint32(16, true);
    const flags = view.getUint32(20, true);
    if (version !== 1) throw new Error(`cards.bin version ${version} is not supported.`);
    if (!payloadBytes || 24 + payloadBytes !== buffer.byteLength || flags !== 1) {
        throw new Error('cards.bin header or compressed payload length is invalid.');
    }

    let sourceCardCount = 0;
    let payloadBuildId = '';
    let prefix = '';
    let foundCardsArray = false;
    let cardsArrayClosed = false;
    let inCard = false;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let currentCardParts = [];
    let batch = [];
    const flushBatch = () => {
        if (!batch.length) return;
        self.postMessage({ type: 'cards-chunk', requestId: data.requestId, cards: batch });
        batch = [];
    };
    const parseCardObject = raw => {
        const card = JSON.parse(raw);
        sourceCardCount++;
        if (card?.name) batch.push(card);
        if (batch.length >= 128) flushBatch();
    };

    for await (let text of decompressCardJsonChunks(buffer, payloadBytes)) {
        if (!foundCardsArray) {
            prefix += text;
            const marker = /"cards"\s*:\s*\[/.exec(prefix);
            if (!marker) {
                if (prefix.length > 1024 * 1024) throw new Error('cards.bin JSON header is unexpectedly large or missing the cards array.');
                continue;
            }
            const buildMatch = /"build_id"\s*:\s*("(?:\\.|[^"\\])*")/.exec(prefix.slice(0, marker.index));
            if (buildMatch) {
                try { payloadBuildId = String(JSON.parse(buildMatch[1]) || '').trim(); } catch (_) { payloadBuildId = ''; }
            }
            const expectedBuildId = String(data.expectedBuildId || '').trim();
            if (expectedBuildId && payloadBuildId && payloadBuildId !== expectedBuildId) {
                throw new Error('cards.bin build ID does not match static-data-meta.json.');
            }
            text = prefix.slice(marker.index + marker[0].length);
            prefix = '';
            foundCardsArray = true;
        }
        if (cardsArrayClosed) continue;

        let i = 0;
        let segmentStart = inCard ? 0 : -1;
        while (i < text.length) {
            if (!inCard) {
                const ch = text[i];
                if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') { i++; continue; }
                if (ch === ']') { cardsArrayClosed = true; i++; break; }
                if (ch !== '{') throw new Error(`cards.bin card array is malformed near item ${sourceCardCount + 1}.`);
                inCard = true;
                depth = 1;
                inString = false;
                escaped = false;
                segmentStart = i;
                i++;
                continue;
            }

            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
            } else {
                if (ch === '"') inString = true;
                else if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        currentCardParts.push(text.slice(segmentStart, i + 1));
                        parseCardObject(currentCardParts.join(''));
                        currentCardParts = [];
                        inCard = false;
                        segmentStart = -1;
                        i++;
                        continue;
                    }
                }
            }
            i++;
        }
        if (inCard && segmentStart >= 0) currentCardParts.push(text.slice(segmentStart));
    }

    flushBatch();
    if (!foundCardsArray) throw new Error('cards.bin JSON does not contain a cards array.');
    if (inCard) throw new Error('cards.bin ended in the middle of a card record.');
    if (!cardsArrayClosed) throw new Error('cards.bin cards array is truncated.');
    if (declaredCount && sourceCardCount !== declaredCount) {
        throw new Error(`cards.bin card count mismatch (${sourceCardCount} vs ${declaredCount}).`);
    }
    self.postMessage({
        type: 'cards-ready',
        requestId: data.requestId,
        version,
        payloadBuildId,
        sourceCardCount,
        byteLength: buffer.byteLength
    });
}

function cosineSimilarityQuantized(query, vector, dim, queryInverseNorm, vectorInverseNorm) {
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += query[i] * vector[i];
    if (!(queryInverseNorm > 0) || !(vectorInverseNorm > 0)) return 0;
    return dot * queryInverseNorm * vectorInverseNorm;
}

function calibrateSemanticBaseline(vectors, count, dim, normSquares) {
    const vectorCount = Math.min(96, count);
    if (vectorCount < 12) return 0.30;
    const sample = [];
    for (let i = 0; i < vectorCount; i++) {
        const row = vectors.subarray(i * dim, (i + 1) * dim);
        const f = new Float32Array(dim);
        for (let j = 0; j < dim; j++) f[j] = row[j] / 127;
        sample.push(f);
    }
    const sampleCount = Math.min(96, Math.floor(sample.length / 2));
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < sampleCount; i++) {
        const a = sample[(i * 17) % sample.length];
        const b = sample[(i * 43 + 11) % sample.length];
        if (!a || !b || a === b) continue;
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let j = 0; j < dim; j++) {
            dot += a[j] * b[j];
            normA += a[j] * a[j];
            normB += b[j] * b[j];
        }
        if (normA > 0 && normB > 0) {
            sum += dot / (Math.sqrt(normA) * Math.sqrt(normB));
            pairs++;
        }
    }
    if (pairs < 12) return 0.30;
    return Math.max(0.18, Math.min(0.52, sum / pairs));
}

async function loadSemanticIndex(data) {
    if (semanticIndexUrl === data.url && ready && indexChunks.length) {
        const chunk = indexChunks[0];
        const vectorCopy = chunk.vectors.slice();
        const normCopy = chunk.vectorNormSquares.slice();
        self.postMessage({
            type: 'semantic-ready',
            requestId: data.requestId,
            dim: indexDim,
            count: chunk.count,
            names: chunk.names,
            normalizedNames: chunk.normalizedNames,
            vectorBuffer: vectorCopy.buffer,
            normBuffer: normCopy.buffer,
            baseline: Number(data.baseline) || 0.30,
            byteLength: Number(data.byteLength) || 0
        }, [vectorCopy.buffer, normCopy.buffer]);
        return;
    }
    const buffer = await fetchArrayBuffer(data.url, data.timeoutMs, data.cacheMode);
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 32) throw new Error('semantic-index.bin is too small or empty.');
    const bytes = new Uint8Array(buffer);
    const magic = String.fromCharCode(...bytes.subarray(0, 6));
    if (magic !== 'MSIDX1') throw new Error('semantic-index.bin has an unknown binary format.');
    const view = new DataView(buffer);
    const version = view.getUint32(8, true);
    const dim = view.getUint32(12, true);
    const count = view.getUint32(16, true);
    const namesBytes = view.getUint32(20, true);
    const vectorsBytes = view.getUint32(24, true);
    if (version !== 1) throw new Error(`semantic-index.bin version ${version} is not supported.`);
    if (!dim || dim > 2048 || !count || !namesBytes || vectorsBytes !== count * dim) {
        throw new Error('semantic-index.bin metadata is invalid.');
    }
    const namesEnd = 32 + namesBytes;
    if (namesEnd > buffer.byteLength || namesEnd + vectorsBytes !== buffer.byteLength) {
        throw new Error('semantic-index.bin names or vector table is truncated.');
    }
    const decoder = new TextDecoder();
    const names = [];
    const normalizedNames = [];
    let cursor = 32;
    while (cursor < namesEnd && names.length < count) {
        if (cursor + 2 > namesEnd) throw new Error('semantic-index.bin name length is truncated.');
        const byteLength = view.getUint16(cursor, true);
        cursor += 2;
        if (cursor + byteLength > namesEnd) throw new Error('semantic-index.bin contains a truncated card name.');
        const name = decoder.decode(new Uint8Array(buffer, cursor, byteLength));
        names.push(name);
        normalizedNames.push(normalizeCardName(name));
        cursor += byteLength;
    }
    if (names.length !== count || cursor !== namesEnd) throw new Error('semantic-index.bin name table count does not match its metadata.');

    // The source embeddings are normalized by the index builder before Int8 quantization.
    // Quantization slightly perturbs their norms, so cache each inverse norm once here. Each
    // subsequent nearest-neighbour query is only a dot product plus two multiplications.
    const vectorBuffer = buffer.slice(namesEnd, namesEnd + vectorsBytes);
    const vectors = new Int8Array(vectorBuffer);
    const vectorNormSquares = new Float32Array(count);
    const vectorInverseNorms = new Float32Array(count);
    for (let row = 0; row < count; row++) {
        let normSquared = 0;
        const offset = row * dim;
        for (let j = 0; j < dim; j++) {
            const component = vectors[offset + j] || 0;
            normSquared += component * component;
        }
        vectorNormSquares[row] = normSquared;
        vectorInverseNorms[row] = normSquared > 0 ? 1 / Math.sqrt(normSquared) : 0;
    }

    const baseline = calibrateSemanticBaseline(vectors, count, dim, vectorNormSquares);
    const chunk = { names, normalizedNames, ids: [], vectors, vectorNormSquares, vectorInverseNorms, count };
    indexDim = dim;
    indexChunks = [chunk];
    semanticIndexUrl = data.url;
    ready = true;

    const vectorCopy = vectors.slice();
    const normCopy = vectorNormSquares.slice();
    self.postMessage({
        type: 'semantic-ready',
        requestId: data.requestId,
        dim,
        count,
        names,
        normalizedNames,
        vectorBuffer: vectorCopy.buffer,
        normBuffer: normCopy.buffer,
        baseline,
        byteLength: buffer.byteLength
    }, [vectorCopy.buffer, normCopy.buffer]);
}

function heapSwap(heap, a, b) {
    const value = heap[a];
    heap[a] = heap[b];
    heap[b] = value;
}
function heapUp(heap, index) {
    while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (heap[parent].similarity <= heap[index].similarity) break;
        heapSwap(heap, parent, index);
        index = parent;
    }
}
function heapDown(heap, index) {
    while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && heap[left].similarity < heap[smallest].similarity) smallest = left;
        if (right < heap.length && heap[right].similarity < heap[smallest].similarity) smallest = right;
        if (smallest === index) break;
        heapSwap(heap, smallest, index);
        index = smallest;
    }
}
function heapPushTop(heap, item, cap) {
    if (heap.length < cap) {
        heap.push(item);
        heapUp(heap, heap.length - 1);
        return;
    }
    if (item.similarity <= heap[0].similarity) return;
    heap[0] = item;
    heapDown(heap, 0);
}

function initializeTransferredIndex(data) {
    indexDim = Number(data.dim) || 384;
    indexChunks = (data.chunks || []).map(chunk => {
        const vectors = new Int8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength);
        const vectorNormSquares = chunk.normBuffer ? new Float32Array(chunk.normBuffer) : (chunk.vectorNormSquares || null);
        const count = Number(chunk.count) || (chunk.names || []).length;
        const vectorInverseNorms = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const norm = vectorNormSquares?.[i] || 0;
            vectorInverseNorms[i] = norm > 0 ? 1 / Math.sqrt(norm) : 0;
        }
        return {
            names: chunk.names || [],
            normalizedNames: chunk.normalizedNames || null,
            ids: chunk.ids || [],
            vectors,
            vectorNormSquares,
            vectorInverseNorms,
            count
        };
    });
    ready = indexChunks.length > 0;
}

self.onmessage = async function(event) {
    const data = event.data || {};
    if (Number.isFinite(data.generation)) latestGeneration = Math.max(latestGeneration, Number(data.generation));
    try {
        if (data.type === 'load-cards') {
            await loadCards(data);
            return;
        }
        if (data.type === 'load-semantic-index') {
            await loadSemanticIndex(data);
            return;
        }
        if (data.type === 'init') {
            initializeTransferredIndex(data);
            if (!ready) throw new Error('Semantic index has no transferable vectors.');
            self.postMessage({ type: 'ready', requestId: data.requestId });
            return;
        }
        if (data.type !== 'query' || !ready) return;

        const query = new Float32Array(data.queryBuffer);
        const dim = indexDim;
        let queryNormSquared = 0;
        for (let i = 0; i < dim; i++) {
            const q = Number(query[i]) || 0;
            queryNormSquared += q * q;
        }
        const queryInverseNorm = queryNormSquared > 0 ? 1 / Math.sqrt(queryNormSquared) : 0;
        const excludeKey = String(data.excludeKey || '');
        const limit = Math.max(1, Number(data.limit) || 72);
        const minSimilarity = Number.isFinite(data.minSimilarity) ? data.minSimilarity : 0.42;
        const baseline = Number.isFinite(data.baseline) ? data.baseline : 0.30;
        const keepCap = Math.max(limit * 2, 32);
        const heap = [];

        for (const chunk of indexChunks) {
            if (Number.isFinite(data.generation) && data.generation < latestGeneration) {
                self.postMessage({ type: 'result', requestId: data.requestId, results: [], cancelled: true });
                return;
            }
            for (let i = 0; i < chunk.count; i++) {
                if ((i & 2047) === 0 && Number.isFinite(data.generation) && data.generation < latestGeneration) {
                    self.postMessage({ type: 'result', requestId: data.requestId, results: [], cancelled: true });
                    return;
                }
                const name = chunk.names[i] || '';
                if (!name) continue;
                const normalizedName = chunk.normalizedNames?.[i] || normalizeCardName(name);
                if (normalizedName === excludeKey) continue;
                const vector = chunk.vectors.subarray(i * dim, (i + 1) * dim);
                let inverseNorm = chunk.vectorInverseNorms?.[i] || 0;
                if (!(inverseNorm > 0)) {
                    const normSquared = chunk.vectorNormSquares?.[i] || 0;
                    inverseNorm = normSquared > 0 ? 1 / Math.sqrt(normSquared) : 0;
                }
                const rawCos = cosineSimilarityQuantized(query, vector, dim, queryInverseNorm, inverseNorm);
                const calibrated = Math.max(0, Math.min(1, (rawCos - baseline) / Math.max(0.05, 1 - baseline)));
                if (calibrated >= minSimilarity) {
                    heapPushTop(heap, {
                        name,
                        id: chunk.ids?.[i] || null,
                        similarity: calibrated,
                        _normalizedName: normalizedName
                    }, keepCap);
                }
            }
        }

        heap.sort((a, b) => b.similarity - a.similarity);
        const seen = new Set();
        const results = [];
        for (const item of heap) {
            const key = item._normalizedName || normalizeCardName(item.name);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            results.push({ name: item.name, id: item.id || null, similarity: item.similarity });
            if (results.length >= limit) break;
        }
        self.postMessage({ type: 'result', requestId: data.requestId, results });
    } catch (error) {
        const message = error?.message || String(error);
        const type = data.type === 'init' ? 'init-error'
            : data.type === 'query' ? 'query-error'
            : 'load-error';
        self.postMessage({ type, requestId: data.requestId, error: message });
    }
};
