const response = await fetch('https://api.scryfall.com/bulk-data', {
    headers: {
        'User-Agent': 'ManaSearch/1.0 (Static Semantic Index Cache Key)',
        'Accept': 'application/json'
    }
});
if (!response.ok) throw new Error(`Scryfall bulk metadata request failed (${response.status}).`);
const json = await response.json();
const entries = Array.isArray(json) ? json : json?.data;
const oracle = entries?.find(x => String(x?.type || '').toLowerCase() === 'oracle_cards');
if (!oracle?.updated_at) throw new Error('Could not determine the oracle_cards bulk revision.');
process.stdout.write(oracle.updated_at);
