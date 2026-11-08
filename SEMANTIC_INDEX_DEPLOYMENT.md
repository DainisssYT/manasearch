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


## Semantic document coverage (builder v5)

`npm run build-static-data` is the canonical static-data build. It reads one Scryfall
`oracle_cards` revision and atomically generates `cards.bin`, `semantic-index.bin`, and
`static-data-meta.json` from that same revision.

The v5 semantic index stores multiple rows per Oracle card: each non-empty card face and each
separate Oracle-text ability gets its own embedding document. Unusually long ability lines are
split into overlapping chunks (140 words by default), so a later clause is not lost when the
embedding model reaches its input limit. Each document carries face type, mana cost, colors,
keywords, color identity, produced mana, mana value, and available face stats as context.
Parenthetical text is retained, and mana symbols are normalized without collapsing all colors
into one generic "colored mana" token.

The binary header remains `MSIDX1` v1 (384-dimensional Int8 vectors), so no new browser decoder is
required. Because the index contains repeated card names, `semantic-search-worker.js` aggregates
the strongest ability/face match per normalized card name before applying the requested result
limit. The main-thread fallback does the same. Candidate output therefore remains a list of unique
cards, not a list of individual abilities.

Source-card semantic retrieval mirrors this representation: unhighlighted searches build distinct
query vectors for each source face/ability in addition to the whole-card intent query. Explicit
highlights remain scoped to the selected text. Functional lexical retrieval also distributes its
limited Scryfall query slots across several parsed source mechanics instead of spending every slot
on one ability. The local lexical corpus contains face-level metadata and uses a larger query-token
budget.

### Refresh and legacy builder

`scripts/build-static-data.mjs` is the supported builder. The scheduled
`.github/workflows/refresh-static-data.yml` rebuilds from Scryfall on Sundays and can be started
manually. It validates the v5 manifest before committing generated assets. A changed asset set
then explicitly dispatches the Pages deployment workflow.

`scripts/build-semantic-index.mjs` is retained for compatibility and historical reference, but is
not used by package scripts or the deployment workflow. It predates the multi-document format;
do not run it to publish `semantic-index.bin`. Keeping it in the repository avoids a potentially
surprising deletion while making the supported path explicit.
