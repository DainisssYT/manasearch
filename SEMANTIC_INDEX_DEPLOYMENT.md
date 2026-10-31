# ManaSearch static data and background search

ManaSearch still uses the same free, static data files and performs all card retrieval and similarity
calculations on the visitor's device. There is no runtime card API, paid backend, EDHREC dependency,
or server-side search.

On startup, cards.bin is downloaded and decoded in semantic-search-worker.js. The main UI becomes
searchable as soon as the local card corpus and lexical index are ready. semantic-index.bin continues
loading in the background and is decoded in the same worker; once ready, semantic nearest-neighbour
queries are executed there and the worker retains the original vector buffer.

The embeddings are generated with mean pooling and normalization before Int8 quantization. The
worker computes each quantized vector's inverse norm once, then uses a pre-normalized query vector
and cached candidate inverse norms for cosine comparisons. This avoids recalculating a square root
for every candidate on every search.

service-worker.js uses the browser Cache API to persist cards.bin and semantic-index.bin between
visits. The cache keys include the static data build ID from static-data-meta.json, so updated Scryfall
bulk data is fetched under a new key. The metadata request is network-first with a cached fallback;
the two large binary assets are cache-first. If Service Workers are unavailable, ManaSearch falls
back to normal browser HTTP caching and the original local decoders.

The result page size remains 50 by default. Preferences now also provide a maximum result-page count,
defaulting to 3 pages (up to 150 visible results). This affects the presentation list only; the
underlying ranked candidates and CSV export remain unchanged.

The deployment workflow publishes both worker scripts beside the existing static assets. No hosting
upgrade or paid infrastructure is required.
