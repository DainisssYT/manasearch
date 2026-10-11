ManaSearch mobile asset-loading fix — build 20261011-49

Replace these files in the root of your GitHub Pages repository:
  - app.js
  - index.html
  - style.css

Add these files to the same repository root if they are not already present:
  - pako.min.js
  - LICENSE.pako.txt

Keep the existing cards.bin, semantic-index.bin, and static-data-meta.json files in place.

What this build changes:
  - Starts loading cards.bin and semantic-index.bin before lengthy UI event wiring. If a later
    interface initializer throws on mobile, asset loading still continues rather than leaving
    the status stuck at “Search data is preparing…”.
  - Reports an interface initialization error in the status area, if one occurs, instead of
    failing silently.
  - Resolves data URLs relative to app.js for GitHub Pages project paths.
  - Streams/decompresses cards.bin and parses one card at a time to reduce peak mobile memory.
  - Uses browser-native gzip decompression where available and bundled pako as a fallback.
  - Bumps script/cache versions to avoid stale cached app code.

This archive does not include or replace cards.bin, semantic-index.bin, or static-data-meta.json.
