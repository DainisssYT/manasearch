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


## Semantic document coverage (builder v6)

`npm run build-static-data` is the canonical static-data build. It reads one Scryfall
`oracle_cards` revision and atomically generates `cards.bin`, `semantic-index.bin`, and
`static-data-meta.json` from that same revision.

The v6 semantic index stores multiple rows per Oracle card: each non-empty card face and each
separate Oracle-text ability gets its own embedding document. Documents are initially split at
sentence/semicolon boundaries. If one unusually long clause still needs splitting, continuation
chunks retain an opening trigger/cost anchor and overlapping words so later effect text is not
detached from its context.

The build uses the same scripts/semantic-text.mjs representation as browser-side source queries.
Each final document is passed through the actual Transformers.js model tokenizer with truncation
disabled; the builder fails rather than silently truncating a document, and requires every embedded
document to stay at or below 240 tokens (below the model's 256-token input ceiling). The 32-word
initial target is only a conservative first pass; the tokenizer check is authoritative.

Each document carries face type, mana cost, colors, color identity, produced mana, mana value,
keywords, layout, modifiers, and available face stats as context. Cards with no Oracle text still
receive searchable structured profiles. Parenthetical rules text is retained, and mana symbols are
normalized without collapsing all colors into one generic "colored mana" token.

The binary header remains `MSIDX1` v1 (384-dimensional Int8 vectors), so no new browser decoder is
required. Because the index contains repeated card names, `semantic-search-worker.js` aggregates
the strongest ability/face match per normalized card name before applying the requested result
limit. The main-thread fallback does the same. Candidate output therefore remains a list of unique
cards, not a list of individual abilities.

Source-card semantic retrieval mirrors this representation using the exact same module and actual
model tokenizer. Unhighlighted searches build distinct query vectors for each source face/ability in
addition to the whole-card intent query; each query is token-verified before embedding. Explicit
highlights remain scoped to the selected text.

Semantic result lists are merged with reciprocal-rank fusion across the independent intent/ability
views. The highest cosine similarity remains available to the scorer, while the merge also records
which views discovered a card and how many source ability views it matched. A bounded retrieval
consensus channel contributes only 3.5% of the ranking refinement weight, leaving mechanical and
functional evidence dominant.

The local lexical corpus includes face-level Oracle text and card metadata, uses smoothed IDF
(BM25-style inverse-document-frequency) weights so rare mechanic terms contribute more evidence,
and allows up to 48 unique query tokens per focused query. Static corpus retrieval is local; the
runtime search does not call Scryfall for card candidates.

### Refresh and legacy builder

`scripts/build-static-data.mjs` is the supported builder. The scheduled
`.github/workflows/refresh-static-data.yml` rebuilds from Scryfall on Sundays and can be started
manually. It validates the v6 manifest, including the 240-token safety budget, before committing generated assets. A changed asset set
then explicitly dispatches the Pages deployment workflow.

`scripts/build-semantic-index.mjs` is retained for compatibility and historical reference, but is
not used by package scripts or the deployment workflow. It predates the multi-document format;
do not run it to publish `semantic-index.bin`. Keeping it in the repository avoids a potentially
surprising deletion while making the supported path explicit.


## Retrieval quality measurements

The end-to-end search benchmark reports Recall@20, Recall@50, Recall@100, Precision@10 and
Precision@20, MRR, nDCG@10/@20, and stage-by-stage candidate-pool recall. It also records semantic
ability coverage and which intent/ability query views contributed candidates. Stage recall is kept
separate from final ranking metrics so a missing candidate can be distinguished from a candidate
that was retrieved but ranked too low. The separate 31-card/22-pair mechanical benchmark remains
focused on parser and scorer correctness; it is not a substitute for the end-to-end search benchmark.

The CI suite validates the shared builder, actual-tokenizer guard behavior (with a deterministic
test tokenizer), semantic rank fusion, clause-context preservation, and browser/module deployment.
It does not download the full corpus or regenerate the large model-backed binary index during PR
validation. After merge, the scheduled/manual refresh workflow rebuilds the v6 assets from one Scryfall
bulk revision before Pages deployment.
