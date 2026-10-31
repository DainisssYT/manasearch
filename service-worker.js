/* ManaSearch static-data cache. All search remains local to the visitor's browser. */
const CACHE_NAME = 'manasearch-static-data-v1';
const DATA_FILES = new Set(['cards.bin', 'semantic-index.bin']);
const META_FILE = 'static-data-meta.json';

self.addEventListener('install', event => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter(name => name.startsWith('manasearch-static-data-') && name !== CACHE_NAME)
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    const fileName = url.pathname.split('/').pop();
    if (fileName !== META_FILE && !DATA_FILES.has(fileName)) return;
    event.respondWith(fileName === META_FILE ? networkFirst(request) : cacheFirst(request));
});

function canonicalDataRequest(request) {
    const url = new URL(request.url);
    url.searchParams.delete('retry');
    return new Request(url.href, {
        method: 'GET',
        headers: request.headers,
        mode: 'same-origin',
        credentials: 'same-origin'
    });
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const originalUrl = new URL(request.url);
    const key = canonicalDataRequest(request);
    const forceNetwork = originalUrl.searchParams.has('retry');

    if (!forceNetwork) {
        const cached = await cache.match(key);
        if (cached) return cached;
    }

    // CacheStorage keys retain the build-ID query parameter. On a new data build, replace older
    // entries for the same pathname so old binary revisions do not accumulate on the device.
    const response = await fetch(request);
    if (response.ok && response.type !== 'opaque') {
        const existingKeys = await cache.keys();
        await Promise.all(existingKeys
            .filter(existing => new URL(existing.url).pathname === originalUrl.pathname && existing.url !== key.url)
            .map(existing => cache.delete(existing)));
        await cache.put(key, response.clone());
    }
    return response;
}

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response.ok && response.type !== 'opaque') await cache.put(request, response.clone());
        return response;
    } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
    }
}
