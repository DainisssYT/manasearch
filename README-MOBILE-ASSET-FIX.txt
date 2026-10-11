ManaSearch mobile asset-loading fix — build 20261011-48

Replace these files in the root of your GitHub Pages repository:
  - app.js
  - index.html
  - style.css

Add these files to the same repository root:
  - pako.min.js
  - LICENSE.pako.txt

Keep the existing cards.bin, semantic-index.bin, and static-data-meta.json files in place.

What this build changes:
  - Resolves cards.bin, semantic-index.bin, and static-data-meta.json relative to app.js,
    so project-page paths work even when the address bar URL lacks a trailing slash.
  - Streams/decompresses cards.bin and parses one card at a time instead of constructing
    a roughly 99 MB decoded JSON string in memory. This reduces the peak memory needed
    by mobile browsers.
  - Uses browser-native gzip decompression where available and the bundled pako fallback
    where native DecompressionStream is unavailable.
  - Shows the final asset-loading error details in the status message when loading fails.

pako is distributed under its included license. This archive does not include or replace
cards.bin or semantic-index.bin.
