# ManaSearch semantic index deployment

ManaSearch now prefers a precomputed `semantic-index.bin` generated during the GitHub Pages deployment.
The deployment workflow fetches Scryfall's `oracle_cards` bulk data, embeds the normalized Oracle text
with the same `Xenova/all-MiniLM-L6-v2` model used in the browser, quantizes the 384-dimensional vectors
to int8, and publishes the binary index beside the site files.

The workflow caches the generated binary by Scryfall's `oracle_cards.updated_at` value. That means normal
app-only pushes reuse the existing semantic index; a new index is generated only when the Scryfall bulk
revision changes or the cache is unavailable.

Visitors download the already-built index in the background. Search never waits for the index. When the
static asset is available, no browser-side corpus build is performed. Only a failed/missing/invalid static
asset causes ManaSearch to fall back to the existing IndexedDB client-side build, also in the background.

## GitHub Pages setting

In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**. The workflow in
`.github/workflows/deploy-pages.yml` then publishes the site whenever `main` changes.
