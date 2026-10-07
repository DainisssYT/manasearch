/* ManaSearch build 20261007-13 */
// ManaSearch deployment build marker. Bump this whenever app.js changes so cached-module issues are easy to diagnose.
const MANASEARCH_APP_BUILD = '20261007-13';
console.info(`[ManaSearch] app.js build ${MANASEARCH_APP_BUILD}`);

// State Management
const ENABLE_LOCAL_CARD2VEC = false;
let currentSourceCard = null;
let lastSearchResults = [];
// Set after a search whose retrieval streams were capped mid-pagination (see fetchScryfallSearch's
// `.continuation`) while Scryfall still had more pages. Holds everything searchDeeper() needs to
// fetch more pages and score/merge/render them without re-deriving the whole search context from
// the DOM again. null whenever there's nothing more to fetch, or before any search has run.
let pendingDeeperSearch = null;
// Search instrumentation is kept in its OWN variable, never as a property hung off the results
// array. Attaching it to the array made it silently vanish the moment any step built a new array
// (renderResults' safety-net dedup did exactly that), which left the benchmark reporting 0% for
// every pipeline stage even on searches that plainly worked. Results data and instrumentation are
// now separate state (review Priority 1).
let lastSearchDiagnostics = null;
// User-facing search totals. This counts unique candidates that survived hard filters and reached
// the scoring/ranking stage, while lastSearchResults is the final relevance-qualified result set.
let lastSearchCandidateCount = null;
const searchCache = new Map();
const sourceCardCache = new Map();
// Bounded LRU cache for the immutable search intent derived from the current source card + highlights.
// This must live at module scope because getSearchIntent() is called by the search handlers.
const searchIntentRuntimeCache = new Map();
function getSearchIntentRuntimeCache() {
    return searchIntentRuntimeCache;
}
let nlpExtractor = null;
// Embedding cache, keyed by the exact text string that was embedded (oracle text or a canonical
// function string). The MiniLM embedding of a given string is deterministic and never changes
// across searches, but scoreCardBatch used to recompute it for every candidate on every search -
// including re-embedding the SAME card's oracle text repeatedly across broad/matrix/divergent
// sub-searches and repeat lookups within a session. Caching by text (not by card id) means it
// also transparently covers the two different embedding "views" of the same card (raw oracle
// text vs. canonical function text) without needing two separate cache structures.
const embeddingCache = new Map();
// Parsed/mechanical representations are deterministic for a given card Oracle text. Keep a bounded
// LRU-style cache so repeated retrieval streams, Search Deeper, and Related Cards do not repeatedly
// parse the same card.
const mechanicalProfileCache = new Map();
const SEARCH_INTENT_CACHE_MAX = 96;
const MECHANICAL_PROFILE_CACHE_MAX = 2500;
// Session semantic corpus: every card this session has actually scored (plus each search's
// source card) gets its function/oracle embedding vectors kept here, keyed by name. A new
// retrieval stream (Search G) queries this corpus by cosine similarity against the CURRENT
// source card's function vector, so a differently-worded match can be genuinely RETRIEVED by
// meaning - not merely re-ranked after the fact - even when none of the lexical streams (A, B, C,
// E, F) ever produced it as a candidate.
//
// Scope, honestly stated: this is NOT a precomputed vector index over the whole card corpus, and
// it can't be one without a backend (that's what the disabled ENABLE_LOCAL_CARD2VEC/Card2Vec path
// was reaching for). It only knows about cards this session has already seen via some other
// stream or search. So it does nothing useful on someone's very first search ever, and it can't
// find a wording-different match that's never once turned up here before. What it DOES do: once
// any search - by any source card, on any session - has pulled a differently-worded functional
// match into the corpus, every LATER search this session (from any source card) can retrieve it
// purely by meaning, even if that later search's own lexical streams would have missed it
// entirely. Recall compounds across a session instead of resetting to zero every search.
const sessionSemanticCorpus = new Map();
const SESSION_SEMANTIC_CORPUS_LIMIT = 4000;
// Each entry: { text: string, mode: 'exact' | 'variable' }. 'exact' means this highlighted span
// must be literally present on a matching card (feeds the exactness/literal-match channel);
// 'variable' means it marks a structural slot (e.g. "deals 3 damage") where the SHAPE matters but
// the specific value doesn't, so it's excluded from the literal-match requirement and only
// informs mechanical/semantic parsing.
let manualHighlights = [];
let highlightComposerOpen = false;
let highlightEditIndex = null;
let sortSelect;
// Incremented on every new source-card load or similarity search so that a slower,
// stale request can detect it's been superseded and avoid clobbering newer state.
let searchRequestId = 0;
// Related-card searches have their own generation so selecting/unselecting a result while the
// normal search is still progressively scoring cannot invalidate that main search.
let relatedSearchRequestId = 0;
// Only the current result-producing mode may paint into the Results grid. A Related Search can
// intentionally run while the main search continues in the background; stale main-search renders
// must not overwrite the Related Search results.
let activeResultView = { mode: 'main', requestId: 0 };
// Benchmark mode deliberately bypasses the app's persistent/browser-level GET cache so every
// benchmark test starts with no candidates inherited from a previous test or previous run.
let benchmarkColdMode = false;
let benchmarkUseLocalOracleCorpus = false;
let benchmarkLocalOracleCorpus = null;
// Benchmark-safe fallback: never build the full semantic index before Test #1. If a ready index
// already exists, use it; otherwise bound live API pagination so the suite can still execute.
let benchmarkApiConservativeMode = false;
const benchmarkSourceCardCatalog = new Map();
// Active search-method switches for the current user search. These are strategy switches, not
// hidden card constraints: they add retrieval evidence and/or bounded ranking preferences.
let activeSearchMethodFlags = {
    broad: false, divergent: false, wording: false, functional: false, target: false,
    role: false, alternate: false, synergy: false
};
// Primary result ranking plus optional presentation features. Matrix Sweep and Diverse Spread are
// intentionally features, not mutually-exclusive ranking categories.
let activeOrderFeatureFlags = {
    matrix: false,
    diverse: false
};

// Selected Related Cards State (Persistent across infinite searches)
const selectedRelatedCards = new Map();
// Stable result-card DOM cache. Progressive scoring frequently reorders the same cards; keeping
// their DOM nodes alive prevents image reload/flicker while still allowing scores/order to update.
const visibleResultCardData = new Map();

// Multi-source search context. The first card is the primary source shown in the existing inspector;
// additional cards participate in the shared-text retrieval lane.
const sourceCards = new Map();
const MAX_SOURCE_CARDS = 4;
let primarySourceCardKey = null;
// Routes live pagination/status updates from retrieval streams into the detailed loading checklist.
let activeSearchStreamProgressReporter = null;

// Local Storage Keys
const HISTORY_KEY = 'manamatch_history';
const HISTORY_CARD_PREVIEWS_KEY = 'manamatch_history_card_previews';
const FAVORITES_KEY = 'manamatch_favorites';
const THEME_KEY = 'manamatch_theme';
const DISPLAY_PREFERENCES_KEY = 'manasearch_display_preferences_v1';
const DEFAULT_DISPLAY_PREFERENCES = Object.freeze({
    maxResults: 50,
    showScoreBreakdown: true,
    theme: 'dark',
    resultDensity: 'comfortable',
    reduceMotion: false,
    showStreamProgress: true
});
let displayPreferences = { ...DEFAULT_DISPLAY_PREFERENCES };

function clampDisplayResultLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_DISPLAY_PREFERENCES.maxResults;
    return Math.max(1, Math.min(200, Math.round(parsed)));
}

function loadLegacyThemePreference() {
    try {
        const legacy = localStorage.getItem(THEME_KEY);
        return legacy === 'light' || legacy === 'dark' ? legacy : null;
    } catch (error) {
        return null;
    }
}

function loadDisplayPreferences() {
    let stored = null;
    try {
        stored = JSON.parse(localStorage.getItem(DISPLAY_PREFERENCES_KEY) || 'null');
    } catch (error) {
        stored = null;
    }
    displayPreferences = {
        maxResults: clampDisplayResultLimit(stored?.maxResults ?? DEFAULT_DISPLAY_PREFERENCES.maxResults),
        showScoreBreakdown: stored?.showScoreBreakdown !== false,
        theme: ['dark', 'light', 'system'].includes(stored?.theme) ? stored.theme : (loadLegacyThemePreference() || DEFAULT_DISPLAY_PREFERENCES.theme),
        resultDensity: ['comfortable', 'compact'].includes(stored?.resultDensity) ? stored.resultDensity : DEFAULT_DISPLAY_PREFERENCES.resultDensity,
        reduceMotion: Boolean(stored?.reduceMotion),
        showStreamProgress: stored?.showStreamProgress !== false
    };
    return displayPreferences;
}

function saveDisplayPreferences() {
    try {
        localStorage.setItem(DISPLAY_PREFERENCES_KEY, JSON.stringify(displayPreferences));
    } catch (error) {
        // Persistence is optional; the live preference still applies for this session.
    }
}

function getDisplayedResultLimit() {
    return clampDisplayResultLimit(displayPreferences?.maxResults);
}

function resolveTheme(theme = displayPreferences?.theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    try {
        return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch (_) {
        return 'dark';
    }
}

function applyPresentationPreferences() {
    const resolvedTheme = resolveTheme();
    document.body.classList.toggle('light-theme', resolvedTheme === 'light');
    document.body.classList.toggle('compact-results', displayPreferences.resultDensity === 'compact');
    document.body.classList.toggle('reduce-motion', Boolean(displayPreferences.reduceMotion));
    document.body.classList.toggle('hide-stream-progress', displayPreferences.showStreamProgress === false);
}


// UI Elements 
let cardSearchInput, searchBtn, sourceCardSection, sourceCardOracle, findSimilarBtn;
let loadingIndicator, resultsSection, resultsGrid, themeToggle, historyList;
let systemThemeMediaQuery = null;
let favoritesList, favoriteBtn, exportBtn, compareModal, compareContainer, compareStatus;
let sourceCardEmpty, sourceCardLoaded, sourceCardAddBtn, sourceCardPickerModal, sourceCardPickerInput, sourceCardPickerResults, sourceCardPickerStatus, closeSourceCardPickerBtn;
let sourceCardPickerRequestId = 0;
let sourceCardPickerDebounce = null;
let relatedCardsBar, selectedCardsChips, selectedRelatedMoreBtn, selectedRelatedModal, selectedRelatedModalGrid, selectedRelatedModalClose, relatedSearchBtn, clearSelectedBtn;
let compareQueue = [];

/* V20.10 benchmark highlight preview: makes simulated human selections visible while the suite runs.
   IMPORTANT: this preview deliberately keeps the benchmark's pre-existing visual language. The
   normal application highlight styles remain owned by style.css; this block only lays out the
   benchmark panel/legend and does not recolor the live highlight spans. */

if (typeof document !== 'undefined' && !document.getElementById('highlight-composer-style')) {
    const style = document.createElement('style');
    style.id = 'highlight-composer-style';
    style.textContent = `
        .highlight-chips-row { display:flex; flex-wrap:wrap; gap:7px; align-items:center; width:100%; }
        .highlight-chip { display:inline-flex; align-items:center; gap:6px; max-width:100%; }
        .highlight-origin-label { font-size:10px; opacity:.7; font-weight:700; }
        .highlight-chip-text { max-width:360px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .highlight-mode-btn, .highlight-composer-mode, .highlight-add-submit, .highlight-add-cancel {
            border:1px solid var(--border-color); border-radius:5px; background:var(--bg-secondary);
            color:var(--text-main); cursor:pointer; padding:4px 8px; font-size:12px;
        }
        .highlight-mode-btn.mode-exact { font-weight:700; }
        .highlight-mode-btn.mode-variable { font-weight:600; }
        .highlight-add-btn {
            display:flex; align-items:center; justify-content:center; width:30px; height:30px;
            margin:9px auto 0; border:1px solid var(--border-color); border-radius:50%;
            background:var(--bg-secondary); color:var(--text-main); cursor:pointer;
            font-size:20px; line-height:1; font-weight:600;
        }
        .highlight-add-btn:hover, .highlight-add-submit:hover, .highlight-add-cancel:hover,
        .highlight-mode-btn:hover, .highlight-composer-mode:hover { filter:brightness(1.08); }
        .highlight-add-composer {
            margin:8px auto 0; max-width:620px; padding:10px; border:1px solid var(--border-color);
            border-radius:7px; background:var(--bg-secondary); display:flex; flex-direction:column; gap:8px;
        }
        .highlight-add-label { font-size:12px; font-weight:700; }
        .highlight-add-input { width:100%; box-sizing:border-box; resize:vertical; min-height:52px; }
        .highlight-add-mode-row, .highlight-add-actions { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
        .highlight-add-mode-label { font-size:12px; opacity:.8; }
        .highlight-composer-mode.selected { outline:2px solid var(--accent-color); }
        .highlight-add-actions { justify-content:flex-end; }
        .highlight-add-submit { background:var(--accent-color); color:var(--text-on-accent, #fff); border-color:var(--accent-color); font-weight:700; }
        .highlight-user-chip { border-style:dashed; }
        @media (max-width:700px) { .highlight-chip-text { max-width:210px; } }
    `;
    document.head.appendChild(style);
}

if (typeof document !== 'undefined' && !document.getElementById('benchmark-highlight-preview-style')) {
    const style = document.createElement('style');
    style.id = 'benchmark-highlight-preview-style';
    style.textContent = `
        #benchmark-highlight-preview {
            margin: 10px 0 12px;
            padding: 10px 12px;
            border: 1px dashed rgba(120, 130, 150, .45);
            border-radius: 10px;
            background: rgba(120, 130, 150, .08);
            font-size: 12px;
            line-height: 1.45;
        }
        .benchmark-preview-title { font-weight: 700; margin-bottom: 3px; }
        .benchmark-preview-subtitle { opacity: .78; margin-bottom: 7px; }
        .benchmark-preview-legend { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 7px; opacity: .9; }
        .benchmark-preview-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; margin-top: 3px; }
        .benchmark-preview-mode { font-size: 10px; font-weight: 800; letter-spacing: .05em; }
        .benchmark-preview-text { font-weight: 600; }
        .benchmark-preview-intent { opacity: .72; }
        .benchmark-preview-style { margin-top: 6px; font-size: 11px; opacity: .72; }
        .highlight-intent-label { margin-left: 4px; font-size: 10px; opacity: .65; }
        .benchmark-legend-exact { color: var(--benchmark-exact-color); }
        .benchmark-legend-flexible { color: var(--benchmark-flexible-color); }
    `;
    document.head.appendChild(style);
}

const workerCode = `
    self.onmessage = function(e) {
        setTimeout(() => self.postMessage(e.data.id), e.data.ms);
    };
`;
const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
const bgTimerWorker = new Worker(URL.createObjectURL(workerBlob));

// Add to State Management at the top
let activeTags = [];

// benchmark.js - Local Test Benchmark Suite for ManaMatch / MTG Search Engine
// V20.11: benchmark highlights now model ordinary user intent and are rendered visibly in the live UI.

/**
 * Benchmark Test Cases defined with source cards, constraints, highlighted phrases, and expected
 * targets. Highlight definitions intentionally exercise both `exact` and `variable` modes so the
 * benchmark measures the same user-facing highlight semantics as the live search UI.
 * `highlightedOracle` remains accepted below only as a backwards-compatible single-highlight
 * shorthand; new tests should prefer `highlights: [{ text, mode }]`.
 */
// V20 tuning hook: keep the benchmark/ranker architecture ready for a larger labeled set. The
// optimizer below accepts any array of {source, expected[]} cases (including cases mined from
// Scryfall otags by a benchmark harness) and searches a compact grid around the current channel
// profiles. It is intentionally data-driven: the app never pretends a hand-tuned score is an
// NDCG optimum without actual labels/results.
const RANKING_TUNING_CANDIDATES = [
    { structural: 0.55, rawSemantic: 0.20, functionRole: 0.25 },
    { structural: 0.45, rawSemantic: 0.25, functionRole: 0.30 },
    { structural: 0.35, rawSemantic: 0.25, functionRole: 0.40 },
    { structural: 0.20, rawSemantic: 0.25, functionRole: 0.55 },
    { structural: 0.12, rawSemantic: 0.23, functionRole: 0.65 }
];
function ndcgAtKForRankedNames(rankedNames, expectedNames, k = 10) {
    const expected = new Set((expectedNames || []).map(normalizeCardNameForIdentity));
    if (!expected.size) return 0;
    let dcg = 0;
    const top = rankedNames.slice(0, k).map(normalizeCardNameForIdentity);
    top.forEach((name, i) => {
        if (expected.has(name)) dcg += 1 / Math.log2(i + 2);
    });
    const ideal = Array.from({ length: Math.min(k, expected.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a,b) => a+b, 0);
    return ideal > 0 ? dcg / ideal : 0;
}
async function buildOtagLabeledCases(otagNames, { pagesPerTag = 4, maxSourcesPerTag = 12, maxExpectedPerSource = 12 } = {}) {
    const tags = Array.from(new Set((otagNames || []).map(x => String(x || '').trim()).filter(Boolean)));
    const cases = [];
    for (const tag of tags) {
        const query = `otag:"${tag.replace(/\"/g, '\\\"')}"`;
        let cards = [];
        try { cards = await fetchScryfallSearch(query, Math.max(1, pagesPerTag), `Otag label mining (${tag})`); }
        catch (_) { cards = []; }
        const unique = [];
        const seen = new Set();
        for (const card of (cards || [])) {
            const key = normalizeCardNameForIdentity(card.name);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            unique.push(card.name);
            if (unique.length >= maxExpectedPerSource + maxSourcesPerTag) break;
        }
        for (const source of unique.slice(0, maxSourcesPerTag)) {
            const expected = unique.filter(name => normalizeCardNameForIdentity(name) !== normalizeCardNameForIdentity(source)).slice(0, maxExpectedPerSource);
            if (expected.length >= 2) cases.push({ source, expected, categories: [`otag:${tag}`] });
        }
    }
    return cases;
}

function evaluateRankingWeightsOnLabels(labeledCases, rankedResultsBySource) {
    const usable = (labeledCases || []).filter(c => rankedResultsBySource?.[c.source]);
    if (!usable.length) return [];
    return RANKING_TUNING_CANDIDATES.map(profile => {
        let sum = 0;
        for (const test of usable) {
            const rows = rankedResultsBySource[test.source] || [];
            const ranked = rows.map(r => ({ ...r }));
            ranked.sort((a,b) => {
                const scoreA = (a.mechanicalScore || 0) * profile.structural +
                    (a.oracleSemanticScore || 0) * profile.rawSemantic +
                    Math.max(a.functionScore || 0, a.roleScore || 0) * profile.functionRole;
                const scoreB = (b.mechanicalScore || 0) * profile.structural +
                    (b.oracleSemanticScore || 0) * profile.rawSemantic +
                    Math.max(b.functionScore || 0, b.roleScore || 0) * profile.functionRole;
                return scoreB - scoreA;
            });
            sum += ndcgAtKForRankedNames(ranked.map(r => r.name), test.expected, 10);
        }
        return { ...profile, meanNDCG10: sum / usable.length, cases: usable.length };
    }).sort((a,b) => b.meanNDCG10 - a.meanNDCG10);
}

const BENCHMARK_SUITE = [
    {
        id: 1,
        name: "White Board Wipe Rule Matcher",
        source: "Wrath of God",
        highlightStyle: "single-line-intent",
        highlightIntent: "find mass creature removal without requiring the same wording",
        constraints: {
            type: "sorcery",
            format: "modern",
            rarity: "rare",
            identity: "w",
            cmc: "4",
            extraOracle: "destroy all creatures"
        },
        // The benchmark mirrors a real selection from the source card. This is an exact
        // sentence-boundary anchor: all of the expected sweepers contain this actual Oracle phrase.
        highlights: [
            { text: "Destroy all creatures.", mode: "exact", intent: "require the mass creature-destruction clause" }
        ],
        expected: ["Day of Judgment", "Depopulate", "Shatter the Sky"],
        categories: ["single-effect", "same-function-same-outcome", "mass-removal", "highlight-exact"]
    },
    {
        id: 2,
        name: "Green Token Engine Synergies",
        source: "Parallel Lives",
        highlightStyle: "single-phrase-intent",
        highlightIntent: "find effects that make token production scale upward",
        constraints: {
            type: "enchantment",
            format: "commander",
            rarity: "rare",
            identity: "g",
            extraOracle: "tokens"
        },
        preferredConstraints: ["rarity"],
        // Use the longest exact span that is actually present on Parallel Lives AND on both
        // expected analogues. Parallel Lives says "it creates twice that many of those tokens
        // instead", while Primal Vigor says "twice that many of those tokens are created
        // instead"; the shared exact span preserves the intended meaning without inventing text
        // on the source card.
        highlights: [
            { text: "twice that many of those tokens", mode: "exact", intent: "require the token-doubling replacement outcome while preserving a phrase shared by the source and expected analogues" }
        ],
        expected: ["Doubling Season", "Primal Vigor"],
        categories: ["replacement-effects", "differently-worded", "multi-effect", "highlight-exact"]
    },
    {
        id: 3,
        name: "Low-Cost Blue Interaction",
        source: "Counterspell",
        highlightStyle: "single-phrase-intent",
        highlightIntent: "find cheap spells that interact with a spell on the stack",
        constraints: {
            type: "instant",
            format: "legacy",
            identity: "u",
            colors: "u",
            cmc: "2",
            extraOracle: "counter target"
        },
        // The exact phrase exists on Counterspell and is also contained in conditional
        // counterspells such as Deprive and Logic Knot. Keeping the phrase Exact while omitting
        // the terminal period makes it an exact structural anchor without requiring the candidate
        // to have no caveat.
        highlights: [
            { text: "Counter target spell", mode: "exact", intent: "counter an opposing spell" }
        ],
        expected: ["Deprive", "Logic Knot", "Memory Lapse"],
        categories: ["single-effect", "conditional-effects", "same-function-different-outcome", "highlight-exact"]
    },
    {
        id: 4,
        name: "Red Low-Cost Instant Burn Spells",
        source: "Lightning Bolt",
        highlightStyle: "single-phrase-intent",
        highlightIntent: "find cheap direct damage that can hit a chosen target",
        constraints: {
            type: "instant",
            format: "modern",
            identity: "r",
            colors: "r",
            cmc: "1"
        },
        // Preserve the real source wording while separating the fixed structure from the
        // variable damage amount. The surrounding Exact anchors must exist on the source card;
        // only the number itself is intentionally flexible.
        highlights: [
            { text: "deals", mode: "exact", intent: "perform direct damage" },
            { text: "3 damage", mode: "variable", intent: "allow the damage amount to vary" },
            { text: "to any target", mode: "exact", intent: "retain a chosen-target damage effect" }
        ],
        expected: ["Shard Volley", "Galvanic Blast", "Play with Fire", "Fiery Impulse", "Wild Slash"],
        categories: ["single-effect", "conditional-effects", "quantitative", "highlight-mixed-modes"]
    },
    {
        id: 5,
        name: "Black Cheap Reanimation Engines",
        source: "Reanimate",
        highlightStyle: "multi-span-line",
        highlightIntent: "find cheap ways to return a creature from a graveyard to the battlefield",
        constraints: {
            identity: "b",
            format: "legacy",
            cmc: "2"
        },
        // Anchor the actual source line with short Exact structural pieces that survive wording
        // changes such as "your/their graveyard" and "return/put". No fabricated phrase is used.
        highlights: [
            { text: "creature card", mode: "exact", intent: "restrict the returned object to a creature card" },
            { text: "graveyard", mode: "exact", intent: "require graveyard-based recursion" },
            { text: "battlefield", mode: "exact", intent: "require battlefield recursion" }
        ],
        expected: ["Animate Dead", "Exhume", "Persist"],
        categories: ["differently-worded", "same-outcome-different-function", "graveyard-to-battlefield", "highlight-multi-span"]
    },
    {
        id: 6,
        name: "Blue Merfolk Tribal Lords",
        source: "Lord of Atlantis",
        highlightStyle: "multi-span-line",
        highlightIntent: "find a tribal lord effect that specifically boosts other Merfolk",
        constraints: {
            type: "creature",
            format: "commander",
            identity: "u",
            cmc: "2"
        },
        // Mirror a human mixed selection: lock the tribe phrase and keep the stat magnitude
        // flexible so differently sized tribal bonuses remain relevant.
        highlights: [
            { text: "Other Merfolk", mode: "variable", intent: "focus on an effect centered on other Merfolk" },
            { text: "get +1/+1", mode: "variable", intent: "focus on a tribal benefit to Merfolk" }
        ],
        expected: ["Master of the Pearl Trident", "Vodalian Hexcatcher"],
        categories: ["tribal-effects", "differently-worded", "multi-effect", "highlight-mixed-modes"]
    },
    {
        id: 7,
        name: "White Catch-Up Land Ramp",
        source: "Knight of the White Orchid",
        highlightStyle: "multi-span-line",
        highlightIntent: "find ways to catch up by searching for a Plains",
        constraints: {
            type: "creature",
            format: "commander",
            identity: "w",
            colors: "w",
            cmc: "2"
        },
        // Use exact structural anchors from the actual source line, while allowing the quantity
        // and exact wording around the Plains search to vary across catch-up effects.
        highlights: [
            { text: "search your library for", mode: "exact", intent: "perform a library search" },
            { text: "Plains card", mode: "exact", intent: "search specifically for a Plains" }
        ],
        expected: ["Loyal Warhound", "Oreskos Explorer"],
        categories: ["conditional-effects", "differently-worded", "multi-effect", "highlight-exact"]
    },
    {
        id: 8,
        name: "Fast Mana Artifacts (Archetypal Role)",
        source: "Sol Ring",
        highlightStyle: "multi-span-line",
        highlightIntent: "find cheap artifacts that turn into more mana when tapped",
        constraints: {
            type: "artifact",
            format: "commander"
        },
        // Keep the activation structure Exact and let the produced amount vary: Mana Vault adds
        // more mana than Sol Ring, but it is still the same tap-for-mana mechanic.
        highlights: [
            { text: "{T}: Add", mode: "exact", intent: "activate the artifact to produce mana" },
            { text: "{C}{C}", mode: "variable", intent: "allow the amount of mana to vary" }
        ],
        expected: ["Mana Vault"],
        categories: ["same-archetypal-role", "fast-mana", "differently-worded", "highlight-mixed-modes"]
    },
    {
        id: 9,
        name: "Recurring Card Advantage For Life (Semantic Analogy)",
        source: "Phyrexian Arena",
        highlightStyle: "multi-span-line",
        highlightIntent: "find repeatable card advantage that costs life over time",
        constraints: {
            identity: "b"
        },
        // These are real source phrases, but both are Flexible because comparable engines may
        // draw/reveal a different card quantity and may charge a different life amount or timing.
        highlights: [
            { text: "draw a card", mode: "variable", intent: "gain recurring card advantage" },
            { text: "lose 1 life", mode: "variable", intent: "pay life as the recurring cost" }
        ],
        expected: ["Dark Confidant", "Necropotence"],
        categories: ["semantic-analogy", "card-advantage-engine", "same-archetypal-role", "highlight-flexible"]
    },
    {
        id: 10,
        name: "Modal Blue Instants (Modal Cards)",
        source: "Mystic Confluence",
        highlightStyle: "multi-span-effect",
        highlightIntent: "find flexible modal interaction/value spells",
        constraints: {
            type: "instant",
            identity: "u"
        },
        // Both selections are real phrases on Mystic Confluence. The modal count and the chosen
        // value mode are Flexible so a differently-sized modal spell such as Cryptic Command can
        // still be a valid semantic analogue.
        highlights: [
            { text: "Choose three", mode: "variable", intent: "choose among several selectable effects" },
            { text: "Draw a card", mode: "variable", intent: "one of the value-producing modes" }
        ],
        expected: ["Cryptic Command"],
        categories: ["modal-cards", "same-function-different-outcome", "multi-effect", "highlight-flexible", "source-text-valid"]
    },
    {
        id: 11,
        name: "Grand Arbiter Cost-Reduction Line",
        source: "Grand Arbiter Augustin IV",
        highlightStyle: "multi-span-line",
        highlightIntent: "find effects that reduce the casting cost of a particular class of spells",
        constraints: {
            format: "commander"
        },
        // This deliberately mirrors the user's real interaction: three selections from one
        // grammatical line, with the discount value Flexible and the surrounding wording Exact.
        highlights: [
            { text: "White spells you cast cost", mode: "exact", intent: "identify the spell class whose cost is being reduced" },
            { text: "{1}", mode: "variable", intent: "allow the discount amount to vary" },
            { text: "less to cast.", mode: "exact", intent: "require an actual spell-cost reduction effect" }
        ],
        expected: ["Pearl Medallion", "Thornscape Familiar", "The Wind Crystal"],
        categories: ["cost-reduction", "highlight-mixed-modes", "multi-span-highlight", "quantitative"]
    },
    {
        id: 12,
        name: "Unconditional Counter Exact Sentence",
        source: "Counterspell",
        highlightStyle: "single-sentence-exact",
        highlightIntent: "find a counterspell whose counter clause ends with no caveat",
        constraints: {
            type: "instant",
            identity: "u"
        },
        // The terminal period is intentional: this is a boundary test, not merely a keyword test.
        highlights: [
            { text: "Counter target spell.", mode: "exact", intent: "require the complete unconditional counter sentence" }
        ],
        expected: ["Cancel", "Dissipate", "Dissolve", "Dismiss", "Arcane Denial"],
        categories: ["highlight-exact", "sentence-boundary", "conditional-effects", "single-effect"]
    }
];

/**
 * Calculates Recall@K for a given set of ranked results against expected card names.
 * @param {Array<string>} rankedResultNames - Array of card names in ranked order.
 * @param {Array<string>} expectedNames - Array of expected target card names.
 * @param {number} k - Cutoff depth (e.g. 5, 10, 20).
 * @returns {number} Fraction of expected cards found in the top K.
 */
function calculateRecallAtK(rankedResultNames, expectedNames, k) {
    if (!expectedNames || expectedNames.length === 0) return 0;
    const topK = rankedResultNames.slice(0, k).map(name => name.toLowerCase());
    const hits = expectedNames.filter(exp => topK.includes(exp.toLowerCase())).length;
    return hits / expectedNames.length;
}

/**
 * Finds the 1-based ranks of expected cards within ranked results.
 * @param {Array<string>} rankedResultNames - Array of card names in ranked order.
 * @param {Array<string>} expectedNames - Array of expected target card names.
 * @param {number} unrankedPenalty - Rank assigned if card is not found in results.
 * @returns {Object} Map of expected card names to their 1-based ranks.
 */
function getExpectedCardRanks(rankedResultNames, expectedNames, unrankedPenalty = 100) {
    const lowerResults = rankedResultNames.map(name => name.toLowerCase());
    const ranks = {};

    for (const exp of expectedNames) {
        const index = lowerResults.indexOf(exp.toLowerCase());
        ranks[exp] = index !== -1 ? index + 1 : unrankedPenalty;
    }

    return ranks;
}

/**
 * Precision@K - of the top K results actually shown, what fraction were expected cards?
 * Recall asks "did we find them"; precision asks "how much noise came with them". A change that
 * lifts recall by flooding the list with near-misses will show up here as a precision drop.
 */
function calculatePrecisionAtK(rankedResultNames, expectedNames, k) {
    if (!rankedResultNames || rankedResultNames.length === 0 || k <= 0) return 0;
    const expectedLower = new Set((expectedNames || []).map(n => n.toLowerCase()));
    const topK = rankedResultNames.slice(0, k).map(n => n.toLowerCase());
    if (topK.length === 0) return 0;
    return topK.filter(n => expectedLower.has(n)).length / topK.length;
}

/**
 * Mean Reciprocal Rank - 1/(rank of the FIRST expected card), 0 if none appear.
 * Recall@K is a step function: it can't tell "the answer was #1" from "the answer was #19".
 * MRR is sensitive to exactly that, which is what you want when tuning ranking rather than
 * retrieval (review Priority 15).
 */
function calculateMRR(rankedResultNames, expectedNames) {
    if (!expectedNames || expectedNames.length === 0) return 0;
    const expectedLower = new Set(expectedNames.map(n => n.toLowerCase()));
    for (let i = 0; i < rankedResultNames.length; i++) {
        if (expectedLower.has(rankedResultNames[i].toLowerCase())) return 1 / (i + 1);
    }
    return 0;
}

/**
 * Normalized Discounted Cumulative Gain at K.
 * Unlike MRR (which only sees the first hit) or Recall@K (which ignores order entirely), NDCG
 * rewards getting ALL the expected cards high up, with a logarithmic position discount - the
 * metric that best reflects "the good alternatives are at the top of my list".
 */
function calculateNDCGAtK(rankedResultNames, expectedNames, k) {
    if (!expectedNames || expectedNames.length === 0) return 0;
    const expectedLower = new Set(expectedNames.map(n => n.toLowerCase()));

    let dcg = 0;
    rankedResultNames.slice(0, k).forEach((name, i) => {
        if (expectedLower.has(name.toLowerCase())) dcg += 1 / Math.log2(i + 2);
    });

    // Ideal DCG: every expected card packed into the top positions.
    let idcg = 0;
    const idealHits = Math.min(expectedNames.length, k);
    for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);

    return idcg > 0 ? dcg / idcg : 0;
}

/**
 * Per-stage recall from the diagnostics funnel: what fraction of expected cards survived each
 * pipeline stage. This separates "we never retrieved it" from "we retrieved it and then ranked it
 * badly" - two failures Recall@20 reports identically but which need completely different fixes.
 */
function calculateStageRecalls(diagnostics, expectedNames) {
    const empty = { retrieval: 0, filter: 0, dedup: 0, parse: 0, scoring: 0, pruning: 0 };
    if (!diagnostics || !expectedNames || expectedNames.length === 0) return empty;

    const lower = expectedNames.map(n => n.toLowerCase());
    const frac = (set) => set ? lower.filter(n => set.has(n)).length / lower.length : 0;

    return {
        retrieval: frac(diagnostics.rawCandidateNames),
        filter: frac(diagnostics.passedFilterNames),
        dedup: frac(diagnostics.dedupedNames),
        parse: frac(diagnostics.meaningfulParseNames),
        scoring: frac(diagnostics.scoredNames),
        pruning: frac(diagnostics.passedRelevanceFloorNames)
    };
}

/**
 * Identifies the pipeline stage where an expected card was lost, so a failing test says WHY it
 * failed rather than just reporting zero recall.
 */
function diagnoseFailureStage(diagnostics, expectedName, finalRankIndex) {
    if (finalRankIndex !== -1) return 'ranked';
    if (!diagnostics) return 'unknown (no diagnostics)';
    const n = expectedName.toLowerCase();
    if (!diagnostics.rawCandidateNames?.has(n)) return 'retrieval (never returned by any stream)';
    if (!diagnostics.passedFilterNames?.has(n)) return 'hard filters (excluded by constraints)';
    if (!diagnostics.dedupedNames?.has(n)) return 'deduplication';
    // The parse stage was missing from this chain, so a card that failed parsing was reported as
    // failing at "scoring" - pointing debugging at the wrong subsystem entirely (review
    // Priority 4). Checked here, between dedup and scoring, matching the real pipeline order.
    if (diagnostics.meaningfulParseNames && !diagnostics.meaningfulParseNames.has(n)
        && diagnostics.scoredNames?.has(n)) {
        return 'parsing (scored, but text fell back to generic - weak mechanical signal)';
    }
    if (!diagnostics.scoredNames?.has(n)) return 'scoring (not scored)';
    if (diagnostics.relevanceFloorRescued && diagnostics.passedRelevanceFloorNames?.has(n)) return 'relevance-floor rescue';
    if (!diagnostics.passedRelevanceFloorNames?.has(n)) return 'relevance floor (pruned)';
    return 'ranking (fell outside displayed results)';
}

/**
 * Loads SheetJS on demand from a CDN. Done lazily rather than as a page-level <script> so the
 * ~400KB library is only ever fetched when someone actually runs a benchmark.
 * @returns {Promise<Object|null>} the XLSX namespace, or null if it couldn't be loaded
 */
function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);

    return new Promise((resolve) => {
        const existing = document.querySelector('script[data-sheetjs]');
        if (existing) {
            existing.addEventListener('load', () => resolve(window.XLSX || null));
            existing.addEventListener('error', () => resolve(null));
            return;
        }

        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        script.dataset.sheetjs = 'true';
        script.onload = () => resolve(window.XLSX || null);
        script.onerror = () => resolve(null);
        document.head.appendChild(script);
    });
}

/**
 * Forces a browser download of a Blob. Creating the anchor, appending it to the document, and
 * revoking the object URL afterwards are all required - a detached anchor won't reliably fire a
 * download in Firefox, and skipping revokeObjectURL leaks the blob for the page's lifetime.
 * @param {Blob} blob
 * @param {string} filename
 */
function triggerBrowserDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Delay revocation slightly; revoking synchronously can cancel the download mid-flight.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Builds and downloads a multi-sheet workbook of a completed benchmark run.
 *
 * Sheets: Summary (headline metrics), Per-Test Metrics, Category Breakdown, Expected Card Trace
 * (the per-card funnel, including which stage lost each miss), Pipeline Diagnostics, and Stream
 * Coverage. Falls back to a CSV of the per-test metrics if SheetJS can't be loaded, so a run is
 * never lost just because the CDN was unreachable.
 *
 * @param {Object} report - the report object returned by runBenchmarkSuite
 * @returns {Promise<boolean>} whether an .xlsx (true) or the CSV fallback (false) was downloaded
 */
async function downloadBenchmarkWorkbook(report) {
    const stamp = formatBenchmarkDateStamp(report.generatedAt || new Date());
    const baseName = `Benchmark test_${stamp}`;

    const pct = (v) => v === null || v === undefined ? 'n/a' : `${((v || 0) * 100).toFixed(2)}%`;
    const num = (v, d = 4) => (v === null || v === undefined) ? '' : Number((v || 0).toFixed(d));
    const durStr = (ms) => (ms === null || ms === undefined) ? '' : `${(ms / 1000).toFixed(2)}s`;

    // --- Sheet: Overview (a proper dashboard, not just a metrics dump) ---
    const overviewRows = [
        { Metric: 'Run ID', Value: report.runId || '' },
        { Metric: 'Benchmark started', Value: (report.startedAt || report.generatedAt || new Date()).toLocaleString() },
        { Metric: 'Benchmark finished', Value: (report.finishedAt || report.generatedAt || new Date()).toLocaleString() },
        { Metric: 'Total runtime', Value: durStr(report.durationMs) },
        { Metric: 'Tests total', Value: report.structuredResults.length },
        { Metric: 'Tests successful', Value: report.structuredResults.filter(r => r.strict.testStatus === 'ok').length },
        { Metric: 'Tests errored', Value: report.structuredResults.filter(r => r.strict.testStatus === 'error').length },
        { Metric: 'Tests empty', Value: report.structuredResults.filter(r => r.strict.testStatus === 'empty').length },
        { Metric: '', Value: '' },
        { Metric: 'Mean Recall@5', Value: pct(report.meanRecall5) },
        { Metric: 'Mean Recall@10', Value: pct(report.meanRecall10) },
        { Metric: 'Mean Recall@20', Value: pct(report.meanRecall20) },
        { Metric: 'Mean Adjusted Recall@20', Value: pct(report.meanAdjustedRecall20) },
        { Metric: 'Mean Semantic Recall@20', Value: report.meanSemanticRecall20 !== null ? pct(report.meanSemanticRecall20) : 'n/a (no preferred-constraint tests)' },
        { Metric: 'Mean Retrieval Recall (ceiling)', Value: pct(report.meanRetrievalRecall) },
        { Metric: 'Mean MRR', Value: num(report.meanMRR) },
        { Metric: 'Mean NDCG@10', Value: num(report.meanNDCG10) },
        { Metric: 'Mean NDCG@20', Value: num(report.meanNDCG20) },
        { Metric: 'Mean Precision@10', Value: num(report.meanPrecision10) },
        { Metric: 'Overall Avg Card Rank', Value: num(report.overallAvgRank, 2) }
    ];

    // --- Sheet: vs Previous Run (regression tracking) ---
    let regressionRows = null;
    if (report.previousRun) {
        const p = report.previousRun;
        const rows = (label, key, isPct) => {
            const prev = p[key], curr = report[key];
            if (prev === undefined || prev === null || curr === undefined || curr === null) return null;
            const delta = curr - prev;
            return {
                'Metric': label,
                'Previous': isPct ? pct(prev) : key === 'durationMs' ? durStr(prev) : num(prev),
                'Current': isPct ? pct(curr) : key === 'durationMs' ? durStr(curr) : num(curr),
                'Change': key === 'durationMs' ? `${delta >= 0 ? '+' : ''}${(delta / 1000).toFixed(2)}s`
                    : isPct ? `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}pp`
                    : `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`
            };
        };
        regressionRows = [
            rows('Run compared', null, false) && { 'Metric': 'Run ID', 'Previous': p.runId || '', 'Current': report.runId || '', 'Change': '' },
            rows('Recall@20', 'meanRecall20', true),
            rows('Adjusted Recall@20', 'meanAdjustedRecall20', true),
            rows('Retrieval Recall', 'meanRetrievalRecall', true),
            rows('MRR', 'meanMRR', false),
            rows('NDCG@20', 'meanNDCG20', false),
            rows('Avg runtime', 'durationMs', false)
        ].filter(Boolean);
    }

    // --- Sheet: Per-Test Metrics (strict + semantic side by side) ---
    const perTestRows = report.structuredResults.map(r => {
        const s = r.strict;
        return {
            'Test ID': r.id,
            'Name': r.name,
            'Source Card': r.source,
            'Highlights': (r.highlights || []).map(h => `${h.mode}: ${h.text}`).join(' | '),
            'Categories': (r.categories || []).join(', '),
            'Preferred Constraints': (r.preferredConstraints || []).join(', '),
            'Status': s.testStatus,
            'Error': s.errorMessage || '',
            'Duration': durStr(r.durationMs),
            'Recall@5': num(s.recall5, 3),
            'Recall@10': num(s.recall10, 3),
            'Recall@20': num(s.recall20, 3),
            'Adj Recall@20': num(s.adjustedRecall20, 3),
            'Semantic Recall@20': r.semantic ? num(r.semantic.recall20, 3) : '',
            'MRR': num(s.mrr),
            'NDCG@10': num(s.ndcg10),
            'NDCG@20': num(s.ndcg20),
            'Precision@10': num(s.precision10),
            'Retrieval Recall': num(s.stageRecalls.retrieval, 3),
            'Filter Recall': num(s.stageRecalls.filter, 3),
            'Scoring Recall': num(s.stageRecalls.scoring, 3),
            'Pruning Recall': num(s.stageRecalls.pruning, 3),
            'Avg Expected Rank': num(s.avgTestRank, 2),
            'Results Returned': (s.rankedResults || []).length
        };
    });

    // --- Sheet: Test Timing ---
    const timingRows = report.structuredResults.map(r => {
        const t = r.strict.diagnostics?.timings || {};
        return {
            'Test ID': r.id, 'Source Card': r.source, 'Status': r.strict.testStatus,
            'Total Duration': durStr(r.durationMs),
            'Retrieval': durStr(t.retrievalMs), 'NLP + Scoring': durStr(t.scoringMs),
            'Ranking/Pruning': durStr(t.rankingMs), 'Rendering': durStr(t.renderMs),
            'Search Total (findSimilarCards)': durStr(t.totalMs),
            'Recall@20': pct(r.strict.recall20), 'MRR': num(r.strict.mrr)
        };
    });

    // --- Sheet: Expected Card Trace (per-card funnel + score breakdown, strict + semantic) ---
    const traceRows = [];
    const buildTraceRows = (pass, r, passLabel) => {
        if (!pass) return;
        const d = pass.diagnostics;
        const lowerResults = (pass.rankedResults || []).map(n => n.toLowerCase());
        const conflicts = new Set((r.constraintConflicts || []).map(c => c.toLowerCase()));

        r.expected.forEach(expCard => {
            const n = expCard.toLowerCase();
            const rankIndex = lowerResults.indexOf(n);
            const streams = d?.streams ? Object.entries(d.streams).filter(([, set]) => set.has(n)).map(([s]) => s).join(', ') : '';
            const scores = pass.scoreByName?.get(n);

            traceRows.push({
                'Test ID': r.id,
                'Source Card': r.source,
                'Pass': passLabel,
                'Expected Card': expCard,
                'Constraint Conflict': conflicts.has(n) ? 'YES' : '',
                'Retrieved': d?.rawCandidateNames?.has(n) ? 'Y' : 'N',
                'Passed Filters': d?.passedFilterNames?.has(n) ? 'Y' : 'N',
                'Deduplicated': d?.dedupedNames?.has(n) ? 'Y' : 'N',
                'Parsed Meaningfully': d?.meaningfulParseNames?.has(n) ? 'Y' : 'N',
                'Scored': d?.scoredNames?.has(n) ? 'Y' : 'N',
                'Passed Relevance Floor': d?.passedRelevanceFloorNames?.has(n) ? 'Y' : 'N',
                'Final Rank': rankIndex !== -1 ? rankIndex + 1 : '',
                'Mechanical Score': num(scores?.mechanicalScore, 3),
                'Functional Score': num(scores?.functionScore, 3),
                'Semantic Score': num(scores?.contextScore, 3),
                'Synergy Score': num(scores?.synergyScore, 3),
                'Exactness Score': num(scores?.exactnessScore, 3),
                'Category Score': num(scores?.categoryScore, 3),
                'Overall Score': num(scores?.similarityScore, 3),
                'Lost At Stage': diagnoseFailureStage(d, expCard, rankIndex),
                'Filter Mismatch': (d?.filterFailureReasons?.get(n) || [])
                    .map(fr => `${fr.field}: expected ${fr.expected}, actual ${fr.actual}`).join('; '),
                'Retrieved Via': streams
            });
        });
    };
    report.structuredResults.forEach(r => {
        buildTraceRows(r.strict, r, 'Strict');
        buildTraceRows(r.semantic, r, 'Semantic');
    });

    // --- Sheet: Pipeline Diagnostics ---
    const pipelineRows = report.structuredResults.map(r => ({
        'Test ID': r.id,
        'Source Card': r.source,
        'Retrieved': r.strict.diagnostics?.retrieved ?? '',
        'Passed Filters (raw)': r.strict.diagnostics?.passedFiltersRaw ?? '',
        'After Dedup': r.strict.diagnostics?.afterHardFilters ?? '',
        'After Relevance Floor': r.strict.diagnostics?.afterRelevanceFloor ?? '',
        'Final Results': r.strict.diagnostics?.finalResults ?? ''
    }));

    // --- Sheet: Retrieval Cost (per-stream cost vs. haystack size, review Priority 4/10-4) ---
    const retrievalCostRows = report.retrievalCostRows || [];

    // --- Sheet: Stream Coverage (kept for backward compatibility with earlier workbooks) ---
    const coverageRows = [];
    report.structuredResults.forEach(r => {
        const cov = r.strict.diagnostics?.streamCoverage;
        if (!cov) return;
        Object.entries(cov).forEach(([streamName, c]) => {
            if (!c) return;
            coverageRows.push({
                'Test ID': r.id, 'Source Card': r.source, 'Stream': streamName, 'Query': c.query || '',
                'Total Matching Cards': c.totalCards ?? '', 'Retrieved': c.retrievedCount ?? '',
                'Pages Fetched': c.pagesFetched ?? '', 'Page Budget': c.maxPages ?? '',
                'Fully Covered': c.fullyCovered ? 'Y' : 'N'
            });
        });
    });

    const XLSX = await loadSheetJS();

    if (!XLSX) {
        // CSV fallback so the run still leaves the browser with something usable.
        console.warn("SheetJS unavailable - exporting benchmark as CSV instead of .xlsx");
        const csv = rowsToCSV(perTestRows);
        triggerBrowserDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${baseName}.csv`);
        return false;
    }

    const workbook = XLSX.utils.book_new();

    // Columns default to a narrow fixed width, which truncates almost everything useful here -
    // Scryfall queries, filter-mismatch explanations and stream lists are all long strings that
    // get visually clipped by the neighbouring cell. Size every column to its widest actual value
    // (clamped, so one long query can't produce a 400-character column).
    //
    // NOTE ON STYLING: `!cols` widths and `!rows` heights are honoured by the free SheetJS
    // community build, and are what actually make this readable. Cell styles (`.s` - wrapText,
    // bold) are a SheetJS Pro feature and are silently ignored by the community build, so they're
    // set as a no-cost upgrade for style-capable builds but nothing depends on them. That's why
    // MAX_WIDTH is generous rather than relying on text wrapping to reveal long values.
    const WRAP_COLUMNS = new Set(['Query', 'Filter Mismatch', 'Lost At Stage', 'Error', 'Card Ranks', 'Categories', 'Retrieved Via']);
    const MIN_WIDTH = 12;
    const MAX_WIDTH = 40;
    // Long free-text columns get a much higher cap. Because wrapText is unavailable in the
    // community build, width is the ONLY thing that makes a long value fully visible - a 115-char
    // Scryfall query in a 40-wide column is simply cut off on screen.
    const MAX_WIDTH_WRAPPED = 120;

    const addSheet = (rows, name) => {
        if (!rows || rows.length === 0) return;

        const sheet = XLSX.utils.json_to_sheet(rows);
        const headers = Object.keys(rows[0]);

        // Column widths, measured from the header and every cell value in that column.
        sheet['!cols'] = headers.map(header => {
            const longest = rows.reduce((max, row) => {
                const len = String(row[header] ?? '').length;
                return len > max ? len : max;
            }, header.length);
            // +2 for cell padding so text isn't flush against the gridline.
            const cap = WRAP_COLUMNS.has(header) ? MAX_WIDTH_WRAPPED : MAX_WIDTH;
            return { wch: Math.min(cap, Math.max(MIN_WIDTH, longest + 2)) };
        });

        // Wrap long free-text columns and enable wrapping on every header cell.
        const range = XLSX.utils.decode_range(sheet['!ref']);
        let maxWrappedLines = 1;

        for (let col = range.s.c; col <= range.e.c; col++) {
            const header = headers[col];
            const headerAddr = XLSX.utils.encode_cell({ r: 0, c: col });
            if (sheet[headerAddr]) {
                sheet[headerAddr].s = { font: { bold: true }, alignment: { wrapText: true, vertical: 'top' } };
            }
            if (!WRAP_COLUMNS.has(header)) continue;

            const colWidth = sheet['!cols'][col].wch;
            for (let row = 1; row <= range.e.r; row++) {
                const addr = XLSX.utils.encode_cell({ r: row, c: col });
                if (!sheet[addr]) continue;
                sheet[addr].s = { alignment: { wrapText: true, vertical: 'top' } };
                const lines = Math.ceil(String(sheet[addr].v ?? '').length / colWidth);
                if (lines > maxWrappedLines) maxWrappedLines = lines;
            }
        }

        // Give every row enough height for the tallest wrapped cell, capped so one outlier can't
        // leave the sheet mostly whitespace.
        const rowHeight = Math.min(90, 15 * Math.min(maxWrappedLines, 6));
        sheet['!rows'] = Array.from({ length: range.e.r + 1 }, () => ({ hpt: rowHeight }));

        // Freeze the header row so column meaning stays visible while scrolling long sheets.
        sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
        sheet['!autofilter'] = { ref: sheet['!ref'] };

        XLSX.utils.book_append_sheet(workbook, sheet, name);
    };

    addSheet(overviewRows, 'Overview');
    if (regressionRows?.length) addSheet(regressionRows, 'vs Previous Run');
    addSheet(perTestRows, 'Per-Test Metrics');
    addSheet(timingRows, 'Test Timing');
    addSheet(report.categoryBreakdown, 'Category Breakdown');
    addSheet(traceRows, 'Expected Card Trace');
    addSheet(retrievalCostRows, 'Retrieval Cost');
    addSheet(pipelineRows, 'Pipeline Diagnostics');
    addSheet(coverageRows, 'Stream Coverage');

    // Write to an ArrayBuffer and download via Blob rather than using XLSX.writeFile, so the
    // download path is identical to the CSV fallback and works in environments where writeFile's
    // own anchor handling misbehaves.
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    triggerBrowserDownload(blob, `${baseName}.xlsx`);

    console.log(`Benchmark workbook downloaded: ${baseName}.xlsx`);
    return true;
}

/**
 * Date stamp for benchmark filenames: YYYY-MM-DD_HH-MM.
 * Uses local time (the user's own clock is what they'll compare against) and only characters that
 * are legal in filenames on Windows, macOS and Linux - colons in particular are not.
 * @param {Date} date
 * @returns {string}
 */
function formatBenchmarkDateStamp(date) {
    const d = date instanceof Date ? date : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

/**
 * Serializes an array of flat objects to CSV, quoting and escaping every field.
 * @param {Array<Object>} rows
 * @returns {string}
 */
function rowsToCSV(rows) {
    if (!rows || rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(escape).join(',')];
    rows.forEach(row => lines.push(headers.map(h => escape(row[h])).join(',')));
    return lines.join('\n');
}

/**
 * Short unique identifier for a benchmark run, so separate exported workbooks (or console runs)
 * can be told apart and eventually compared - "MS-20260915-163717-A7F3" (review Priority 10,
 * "Benchmark run ID").
 * @param {Date} date
 * @returns {string}
 */
function generateBenchmarkRunId(date) {
    const d = date instanceof Date ? date : new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const rand = Math.random().toString(16).slice(2, 6).toUpperCase();
    return `MS-${stamp}-${rand}`;
}

const BENCHMARK_HISTORY_KEY = 'manamatch_benchmark_last_run';

/**
 * Runs one search pass (via searchFn) and reduces it to every metric the suite needs, without
 * touching suite-level aggregation. Pulled out into its own function so a test with
 * `preferredConstraints` can be run TWICE - once with every constraint as declared ("strict") and
 * once with the preferred fields omitted ("semantic") - without duplicating this whole block
 * (review Priority 2 / Priority 9: hard vs. preferred constraints, Strict vs. Semantic Recall).
 * @param {Function} searchFn
 * @param {Object} test - a BENCHMARK_SUITE entry (or a relaxed clone of one)
 * @returns {Promise<Object>} everything needed for console output + the workbook
 */
async function runBenchmarkPass(searchFn, test) {
    let rankedResults = [];
    let diagnostics = null;
    let scoreByName = new Map();
    let testStatus = 'ok';
    let errorMessage = null;

    try {
        const rawResults = await searchFn(test);

        // searchFn returns a structured { results, diagnostics } object. Recovering diagnostics
        // from a property hung off the results array was fragile - any step that built a new
        // array silently dropped it. A plain array is still accepted for backwards compatibility,
        // just without instrumentation (review Priority 3).
        const resultList = Array.isArray(rawResults) ? rawResults : (rawResults?.results || []);
        diagnostics = Array.isArray(rawResults) ? (rawResults.diagnostics || null) : (rawResults?.diagnostics || null);

        rankedResults = resultList.map(card => typeof card === 'string' ? card : card.name);

        // findSimilarCards keeps partial results usable when a Scryfall stream gets a 429, but a
        // benchmark must not count that partial retrieval as a complete measurement. Surface the
        // rate-limit signal so the benchmark runner can wait out the cooldown and retry this pass.
        const coverageRateLimited = (() => {
            const streamCoverage = diagnostics?.streamCoverage && typeof diagnostics.streamCoverage === 'object'
                ? Object.values(diagnostics.streamCoverage).some(cov => cov?.bailedAfterRetries)
                : false;
            const functionalCoverage = Array.isArray(diagnostics?.searchFQueryDetail)
                && diagnostics.searchFQueryDetail.some(item => item?.coverage?.bailedAfterRetries);
            const exactCoverage = Array.isArray(diagnostics?.exactHighlightQueryDetail)
                && diagnostics.exactHighlightQueryDetail.some(item => item?.coverage?.bailedAfterRetries);
            const circuitActive = Boolean(scryfallCircuitOpen && Date.now() < scryfallGlobalBackoffUntil);
            return streamCoverage || functionalCoverage || exactCoverage || circuitActive;
        })();

        // Per-card score breakdown, keyed by lowercase name, so the Expected Card Trace can show
        // WHY a card ranked where it did (mechanical/functional/semantic/exactness/category),
        // not just that it did (review Priority 10, "Expected Card Trace should include score
        // information").
        resultList.forEach(card => {
            if (typeof card === 'string' || !card?.name) return;
            scoreByName.set(card.name.toLowerCase(), {
                mechanicalScore: card.mechanicalScore ?? null,
                contextScore: card.contextScore ?? null,
                functionScore: card.functionScore ?? null,
                synergyScore: card.synergyScore ?? null,
                exactnessScore: card.exactnessScore ?? null,
                categoryScore: card.categoryScore ?? null,
                roleScore: card.roleScore ?? null,
                relevanceEvidenceScore: card.relevanceEvidenceScore ?? null,
                coreEvidenceScore: card.coreEvidenceScore ?? null,
                supportingEvidenceScore: card.supportingEvidenceScore ?? null,
                evidenceAgreement: card.evidenceAgreement ?? null,
                contradictionPenalty: card.contradictionPenalty ?? null,
                similarityScore: card.similarityScore ?? null
            });
        });

        if (coverageRateLimited) {
            testStatus = 'blocked_rate_limit';
            errorMessage = 'Scryfall rate-limit/network circuit affected this benchmark pass; partial results were not counted as a complete measurement.';
        } else if (rankedResults.length === 0) {
            testStatus = 'empty';
        }
    } catch (err) {
        if (isScryfallRateLimitError(err) || err?.scryfallCircuitOpen || (scryfallCircuitOpen && Date.now() < scryfallGlobalBackoffUntil)) {
            testStatus = 'blocked_rate_limit';
            errorMessage = err?.message || 'Scryfall rate-limit/network circuit blocked live benchmark retrieval.';
        } else {
            testStatus = 'error';
            errorMessage = err.message;
        }
    }

    const conflictSet = new Set((test.constraintConflicts || []).map(c => c.toLowerCase()));
    const recall5 = calculateRecallAtK(rankedResults, test.expected, 5);
    const recall10 = calculateRecallAtK(rankedResults, test.expected, 10);
    const recall20 = calculateRecallAtK(rankedResults, test.expected, 20);

    const adjustedExpected = test.expected.filter(c => !conflictSet.has(c.toLowerCase()));
    const adjustedRecall5 = adjustedExpected.length > 0 ? calculateRecallAtK(rankedResults, adjustedExpected, 5) : recall5;
    const adjustedRecall10 = adjustedExpected.length > 0 ? calculateRecallAtK(rankedResults, adjustedExpected, 10) : recall10;
    const adjustedRecall20 = adjustedExpected.length > 0 ? calculateRecallAtK(rankedResults, adjustedExpected, 20) : recall20;

    const mrr = calculateMRR(rankedResults, test.expected);
    const ndcg10 = calculateNDCGAtK(rankedResults, test.expected, 10);
    const ndcg20 = calculateNDCGAtK(rankedResults, test.expected, 20);
    const precision10 = calculatePrecisionAtK(rankedResults, test.expected, 10);
    const stageRecalls = calculateStageRecalls(diagnostics, test.expected);

    const cardRanks = getExpectedCardRanks(rankedResults, test.expected, 100);
    const rankValues = Object.values(cardRanks);
    const avgTestRank = rankValues.reduce((a, b) => a + b, 0) / (rankValues.length || 1);

    return {
        rankedResults, diagnostics, scoreByName, testStatus, errorMessage, conflictSet,
        recall5, recall10, recall20, adjustedRecall5, adjustedRecall10, adjustedRecall20,
        mrr, ndcg10, ndcg20, precision10, stageRecalls, cardRanks, avgTestRank
    };
}

/**
 * Prints the Stage 1-7 funnel trace for every expected card in a pass, plus its score breakdown
 * when available.
 * @param {Object} pass - result of runBenchmarkPass
 * @param {Object} test
 * @param {string} label - "STRICT" or "SEMANTIC", for the console header
 */
function printExpectedCardTrace(pass, test, label) {
    const { diagnostics } = pass || {};
    const rankedResults = Array.isArray(pass?.rankedResults) ? pass.rankedResults : [];
    const conflictSet = pass?.conflictSet instanceof Set ? pass.conflictSet : new Set();
    const scoreByName = pass?.scoreByName instanceof Map ? pass.scoreByName : new Map();
    const lowerResults = rankedResults.map(r => String(r).toLowerCase());
    const expectedCards = Array.isArray(test?.expected) ? test.expected : [];

    console.log(`\nExpected Card Funnel Trace [${label}]:`);
    if (!diagnostics) {
        console.log(`  [Warning] No pipeline diagnostics returned.`);
    }

    expectedCards.forEach(expCard => {
        const expLower = expCard.toLowerCase();
        const inCandidatePool  = diagnostics?.rawCandidateNames?.has(expLower) || false;
        const passedFilters    = diagnostics?.passedFilterNames?.has(expLower) || false;
        const wasDeduped       = diagnostics?.dedupedNames?.has(expLower) || false;
        const parsedMeaningful = diagnostics?.meaningfulParseNames?.has(expLower) || false;
        const isScored         = diagnostics?.scoredNames?.has(expLower) || false;
        const passedFloor      = diagnostics?.passedRelevanceFloorNames?.has(expLower) || false;

        const rankIndex = lowerResults.indexOf(expLower);
        const finalRank = rankIndex !== -1 ? `#${rankIndex + 1}` : 'Not found';
        const conflictNote = conflictSet.has(expLower) ? '  [constraint-conflict: excluded from adjusted recall]' : '';

        console.log(`\n  Card: ${expCard}${conflictNote}`);
        console.log(`    Stage 1: Candidate pool?     : ${inCandidatePool ? 'Yes' : 'No'}`);
        console.log(`    Stage 2: Passed filters?     : ${passedFilters ? 'Yes' : 'No'}`);
        console.log(`    Stage 3: Deduplicated?       : ${wasDeduped ? 'Yes' : 'No'}`);
        console.log(`    Stage 4: Parsed meaningfully?: ${parsedMeaningful ? 'Yes' : (isScored ? 'No (fell back to generic)' : 'n/a')}`);
        console.log(`    Stage 5: Scored?             : ${isScored ? 'Yes' : 'No'}`);
        console.log(`    Stage 6: Passed relev. floor?: ${passedFloor ? 'Yes' : 'No'}`);
        console.log(`    Stage 7: Final rank?         : ${finalRank}`);

        const scores = scoreByName.get(expLower);
        if (scores) {
            console.log(`    Scores                       : mech ${fmtScore(scores.mechanicalScore)} | fn ${fmtScore(scores.functionScore)} | sem ${fmtScore(scores.oracleSemanticScore ?? scores.contextScore)} | exact ${fmtScore(scores.exactnessScore)} | cat ${fmtScore(scores.categoryScore)} | role ${fmtScore(scores.roleScore)} | core ${fmtScore(scores.coreEvidenceScore)} | agree ${fmtScore(scores.evidenceAgreement)} | rel ${fmtScore(scores.relevanceEvidenceScore)} | overall ${fmtScore(scores.similarityScore)}`);
        }

        if (rankIndex === -1) {
            console.log(`    >> LOST AT                   : ${diagnoseFailureStage(diagnostics, expCard, rankIndex)}`);
            const reasons = diagnostics?.filterFailureReasons?.get(expLower);
            if (reasons?.length) {
                console.log(`    >> FILTER MISMATCH           : ${reasons.map(r => `${r.field}: expected ${r.expected}, actual ${r.actual}`).join('; ')}`);
            }
        }

        if (diagnostics?.streams) {
            const foundStreams = Object.entries(diagnostics.streams).filter(([, set]) => set.has(expLower)).map(([s]) => s);
            if (foundStreams.length > 0) console.log(`    Retrieved via                : ${foundStreams.join(', ')}`);
        }
    });
}

function fmtScore(v) {
    return (v === null || v === undefined) ? 'n/a' : v.toFixed(2);
}

/**
 * Runs the full benchmark suite against a provided search function.
 * @param {Function} searchFn - Async function taking (testCase) and returning array of ranked card objects with a `.name` property.
 */
function resetBenchmarkColdState({ keepSourceCard = false } = {}) {
    // Benchmark tests must not inherit result-derived state from earlier tests. The transport
    // limiter is deliberately retained so a real HTTP 429 cannot be forgotten and retriggered.
    searchCache.clear();
    // Clear the localStorage-backed search cache too; otherwise a benchmark test could receive
    // a previously stored result even though the in-memory Map was reset.
    try {
        localStorage.removeItem(PERSISTENT_CACHE_STORAGE_KEY);
    } catch (err) {
        // Storage may be unavailable in private/locked-down browser contexts; in that case the
        // in-memory cache reset above is still applied.
    }
    embeddingCache.clear();
    sessionSemanticCorpus.clear();
    pendingDeeperSearch = null;
    lastSearchResults = [];
    lastSearchDiagnostics = null;
    manualHighlights = [];
    highlightComposerOpen = false;
    selectedRelatedCards.clear();
    sourceCards.clear();
    primarySourceCardKey = null;

    // Source-card metadata is immutable input, not retrieval state. Keep the source cache across
    // benchmark tests so a previously loaded benchmark source can be reused without another
    // Scryfall /cards/named request. Candidate/search/embedding state is still fully cold.
    if (!keepSourceCard) {
        currentSourceCard = null;
    }
}

function buildBenchmarkHighlightState(testCase, sourceCard = currentSourceCard) {
    const declared = Array.isArray(testCase?.highlights) && testCase.highlights.length
        ? testCase.highlights
        : (testCase?.highlightedOracle
            ? [{ text: testCase.highlightedOracle, mode: 'exact', intent: testCase.highlightIntent || 'benchmark focus' }]
            : []);
    if (!declared.length) return [];

    const sourceText = getCurrentSourceOracleText(sourceCard);
    const lowerSource = sourceText.toLowerCase();
    let cursor = 0;
    const resolved = [];
    const warnings = [];

    for (const h of declared) {
        const text = String(h?.text || '').trim();
        if (!text) continue;

        let start = Number.isFinite(h?.start) ? h.start : null;
        let end = Number.isFinite(h?.end) ? h.end : null;

        if (start === null && text) {
            const fromCursor = lowerSource.indexOf(text.toLowerCase(), Math.max(0, cursor));
            const anywhere = fromCursor >= 0 ? fromCursor : lowerSource.indexOf(text.toLowerCase());
            if (anywhere >= 0) {
                start = anywhere;
                end = anywhere + text.length;
                cursor = end;
            } else {
                warnings.push(`Could not locate benchmark highlight: "${text}"`);
                continue;
            }
        }

        if (start !== null && end !== null && (start < 0 || end <= start || end > sourceText.length)) {
            warnings.push(`Invalid benchmark highlight range for: "${text}"`);
            continue;
        }

        resolved.push({
            text,
            mode: h?.mode === 'variable' ? 'variable' : 'exact',
            start,
            end,
            intent: String(h?.intent || testCase?.highlightIntent || '').trim()
        });
    }

    // Benchmark authoring guardrails: human selections are usually meaningful phrases, not tiny
    // parser atoms or nearly the entire card. These are warnings only; the benchmark must still
    // be able to exercise short exact phrases such as "{1}" and sentence-boundary tests.
    const longSource = sourceText.length > 0 && resolved.some(h => h.text.length > sourceText.length * 0.72);
    if (longSource) warnings.push('One benchmark highlight covers most of the source Oracle text; consider a more natural intent-sized excerpt.');
    if (resolved.length > 4) warnings.push(`Benchmark uses ${resolved.length} highlights; human-style tests are easier to interpret with fewer, broader selections.`);

    // A normal user usually selects one meaningful clause/phrase or a small number of
    // fragments from the same effect. Warn on highly fragmented tests without forbidding legitimate
    // short selections such as mana symbols and exact boundary phrases.
    const tinyFragmentCount = resolved.filter(h =>
        h.text.length <= 3 &&
        !/[{}]/.test(h.text) &&
        h.mode === 'exact'
    ).length;
    if (tinyFragmentCount > 0) {
        warnings.push('Benchmark contains a tiny Exact fragment; prefer a meaningful phrase unless the fragment itself is the intended constraint.');
    }
    if ((testCase?.highlightStyle === 'multi-span-line' || testCase?.highlightStyle === 'multi-span-effect') &&
        resolved.length < 2) {
        warnings.push('Multi-span benchmark style declares fewer than two selections.');
    }

    if (warnings.length) {
        console.warn(`Benchmark highlight authoring warnings — Test #${testCase?.id}:`, warnings);
    }
    if (resolved.length !== declared.length) {
        console.error(`Benchmark Test #${testCase?.id}: one or more declared highlights were not found in the source Oracle text and were excluded from scoring.`);
    }

    // Benchmark selections keep their origin so mixed Exact/Variable selections can behave as
    // semantic intent when they form one grammatical effect (Test #11), while ordinary live-user
    // Exact highlights keep their existing hard-literal semantics.
    const benchmarkResolved = resolved.map(h => ({ ...h, origin: 'benchmark' }));
    annotateHighlightGroups(benchmarkResolved, sourceText);
    return benchmarkResolved;
}

function renderBenchmarkHighlightPreview(testCase, sourceCard = currentSourceCard) {
    const highlights = buildBenchmarkHighlightState(testCase, sourceCard);
    manualHighlights = highlights;
    reapplyOracleHighlights();
    renderHighlightChips();

    // Benchmark selections are shown in the same Oracle markup as real user selections.
    // Keep the benchmark state for scoring, but do not expose a benchmark-only debug panel in
    // the normal Source Card UI.
    document.getElementById('benchmark-highlight-preview')?.remove();
    sourceCardOracle?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return highlights;
}
function clearBenchmarkHighlightPreview() {
    const panel = document.getElementById('benchmark-highlight-preview');
    if (panel) panel.remove();
}

/* V20.17 benchmark runtime status: the benchmark used to spend its first several seconds
   preparing the local corpus before the website showed anything. Keep this deliberately small
   and theme-neutral: it reuses the app's existing CSS variables and does not redefine the
   application's palette or the normal highlight colors. */
function ensureBenchmarkDashboard() {
    if (typeof document === 'undefined') return null;
    let panel = document.getElementById('benchmark-runtime-dashboard');
    if (panel) return panel;

    const styleId = 'benchmark-runtime-dashboard-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            #benchmark-runtime-dashboard {
                position: relative;
                margin: 0 auto 16px;
                max-width: 1200px;
                padding: 12px 44px 12px 16px;
                background: var(--bg-secondary);
                color: var(--text-main);
                border: 1px solid var(--border-color);
                border-radius: 8px;
                box-sizing: border-box;
            }
            #benchmark-runtime-dashboard[hidden] { display: none !important; }
            .benchmark-runtime-top {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
                flex-wrap: wrap;
            }
            .benchmark-runtime-title { font-weight: 700; }
            .benchmark-runtime-state { color: var(--text-muted); font-size: 12px; }
            .benchmark-runtime-close {
                position: absolute;
                top: 7px;
                right: 7px;
                width: 30px;
                height: 30px;
                padding: 0;
                border: 1px solid transparent;
                border-radius: 7px;
                background: transparent;
                color: var(--text-muted);
                font-size: 22px;
                line-height: 1;
                cursor: pointer;
            }
            .benchmark-runtime-close:hover,
            .benchmark-runtime-close:focus-visible {
                border-color: var(--border-color);
                background: var(--bg-accent);
                color: var(--text-main);
                outline: none;
            }
            .benchmark-runtime-progress {
                position: relative;
                height: 7px;
                margin-top: 9px;
                background: var(--bg-accent);
                border-radius: 999px;
                overflow: hidden;
            }
            .benchmark-runtime-progress > span {
                position: relative;
                display: block;
                height: 100%;
                width: 0%;
                background: var(--accent-color);
                transition: width .55s cubic-bezier(.22,.61,.36,1);
                will-change: width;
            }
            /* The width communicates completed benchmark stages; the moving sheen communicates
               that the current test is actively running even when its exact completion percentage
               is not yet known. This prevents a static 15%-ish bar from looking frozen for a 40s
               live Scryfall retrieval. */
            .benchmark-runtime-progress.is-active::after {
                content: '';
                position: absolute;
                top: 0;
                bottom: 0;
                left: -35%;
                width: 35%;
                background: linear-gradient(90deg, transparent, rgba(255,255,255,.40), transparent);
                animation: benchmark-runtime-sheen 1.35s linear infinite;
                pointer-events: none;
            }
            @keyframes benchmark-runtime-sheen {
                from { transform: translateX(0); }
                to { transform: translateX(386%); }
            }
            .benchmark-runtime-detail {
                margin-top: 7px;
                color: var(--text-muted);
                font-size: 12px;
            }
            .benchmark-runtime-test { font-size: 13px; }
        `;
        document.head.appendChild(style);
    }

    panel = document.createElement('section');
    panel.id = 'benchmark-runtime-dashboard';
    panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = `
        <button type="button" class="benchmark-runtime-close" aria-label="Close benchmark panel" title="Close benchmark panel" hidden>&times;</button>
        <div class="benchmark-runtime-top">
            <div class="benchmark-runtime-title">Benchmark</div>
            <div class="benchmark-runtime-state">Starting…</div>
        </div>
        <div class="benchmark-runtime-test">Preparing benchmark…</div>
        <div class="benchmark-runtime-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <span></span>
        </div>
        <div class="benchmark-runtime-detail"></div>
    `;

    const closeBtn = panel.querySelector('.benchmark-runtime-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            panel.remove();
        });
    }

    const main = document.querySelector('main');
    if (main) main.insertBefore(panel, main.firstChild);
    else document.body.insertBefore(panel, document.body.firstChild);
    return panel;
}

function updateBenchmarkDashboard({ state, testIndex = 0, totalTests = BENCHMARK_SUITE.length, test = null, detail = '', percent = null } = {}) {
    const panel = ensureBenchmarkDashboard();
    if (!panel) return;
    const stateEl = panel.querySelector('.benchmark-runtime-state');
    const testEl = panel.querySelector('.benchmark-runtime-test');
    const detailEl = panel.querySelector('.benchmark-runtime-detail');
    const fillEl = panel.querySelector('.benchmark-runtime-progress > span');
    const progressEl = panel.querySelector('.benchmark-runtime-progress');
    const closeBtn = panel.querySelector('.benchmark-runtime-close');

    if (stateEl) stateEl.textContent = state || 'Running';
    if (testEl) {
        testEl.textContent = test
            ? `Test #${test.id} of ${totalTests}: ${test.name} — ${test.source}`
            : (detail || 'Preparing benchmark…');
    }
    if (detailEl) detailEl.textContent = detail || '';

    const computed = percent !== null
        ? Math.max(0, Math.min(100, percent))
        : (totalTests > 0 ? Math.max(0, Math.min(100, (testIndex / totalTests) * 100)) : 0);
    if (fillEl) fillEl.style.width = `${computed}%`;
    if (progressEl) {
        const finished = state === 'Finished' || state === 'Stopped';
        progressEl.classList.toggle('is-active', !finished);
        progressEl.setAttribute('aria-valuenow', String(Math.round(computed)));
    }
    if (closeBtn) {
        const finished = state === 'Finished' || state === 'Stopped';
        closeBtn.hidden = !finished;
    }
}

async function preloadBenchmarkSourceCards() {
    const uniqueSources = [...new Set((BENCHMARK_SUITE || []).map(test => String(test?.source || '').trim()).filter(Boolean))];
    for (const source of uniqueSources) {
        const key = source.toLowerCase();
        if (benchmarkSourceCardCatalog.has(key)) continue;
        if (scryfallCircuitOpen && Date.now() < scryfallGlobalBackoffUntil) {
            throw createScryfallRateLimitError('Scryfall is rate-limited before benchmark source preload completed.');
        }
        const response = await scryfallThrottledFetch(
            `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(source)}`,
            {
                headers: {
                    'User-Agent': 'ManaMatch/1.0 (Semantic Magic Search)',
                    'Accept': 'application/json'
                }
            }
        );
        if (!response?.ok) {
            if (response?.status === 429) throw createScryfallRateLimitError(`Scryfall rate-limited source-card preload for ${source}.`);
            throw new Error(`Could not preload benchmark source card "${source}" (${response?.status || 'network error'}).`);
        }
        const card = await response.json();
        benchmarkSourceCardCatalog.set(key, card);
        await backgroundAwareDelay(0);
    }
    return uniqueSources.length;
}

function withBenchmarkTimeout(promise, timeoutMs, label = 'operation') {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        Promise.resolve(promise).then(value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}

function validateBenchmarkSuiteConfiguration() {
    const errors = [];
    const warnings = [];
    const requiredSelectors = [
        'card-search-input', 'filter-type', 'filter-format', 'filter-rarity', 'filter-identity',
        'filter-colors', 'filter-cmc', 'filter-power', 'filter-toughness', 'filter-extra-oracle'
    ];
    if (typeof document !== 'undefined') {
        requiredSelectors.forEach(id => {
            if (!document.getElementById(id)) errors.push(`Missing benchmark UI control #${id}`);
        });
        if (!document.querySelector('main')) warnings.push('No <main> element; benchmark dashboard will fall back to document.body.');
    }
    if (!Array.isArray(BENCHMARK_SUITE) || BENCHMARK_SUITE.length === 0) errors.push('BENCHMARK_SUITE is empty.');

    const ids = new Set();
    for (const test of (BENCHMARK_SUITE || [])) {
        if (!Number.isFinite(test?.id)) errors.push('Benchmark test has no numeric id.');
        if (ids.has(test.id)) errors.push(`Duplicate benchmark test id: ${test.id}`);
        ids.add(test.id);
        if (!test?.source) errors.push(`Benchmark test #${test?.id ?? '?'} has no source card.`);
        if (!Array.isArray(test?.expected) || test.expected.length === 0) errors.push(`Benchmark test #${test?.id ?? '?'} has no expected cards.`);
        const hs = Array.isArray(test?.highlights) ? test.highlights : [];
        hs.forEach((h, i) => {
            if (!h?.text?.trim()) errors.push(`Benchmark test #${test.id} highlight #${i + 1} has no text.`);
            if (!['exact', 'variable'].includes(h?.mode)) errors.push(`Benchmark test #${test.id} highlight #${i + 1} has invalid mode.`);
        });
    }
    if (errors.length) throw new Error(`Benchmark configuration invalid: ${errors.join(' | ')}`);
    if (warnings.length) console.warn('Benchmark configuration warnings:', warnings);
    return { tests: BENCHMARK_SUITE.length, warnings };
}


// Public benchmark preflight. This performs only deterministic checks and never contacts Scryfall,
// so it is safe to run before a benchmark when debugging the browser integration.
function validateBenchmarkRuntimeInApp() {
    const result = { ok: true, tests: 0, errors: [], warnings: [] };
    try {
        const cfg = validateBenchmarkSuiteConfiguration();
        result.tests = cfg.tests;
        result.warnings = cfg.warnings || [];

        const requiredFunctions = [
            'runBenchmarkSuite', 'runBenchmarkPass', 'resetBenchmarkColdState',
            'buildBenchmarkHighlightState', 'renderBenchmarkHighlightPreview',
            'findSessionSemanticMatches', 'findFullSemanticMatches', 'findFullSemanticExactMatches',
            'calculateRecallAtK', 'calculateMRR', 'calculateNDCGAtK', 'calculatePrecisionAtK'
        ];
        for (const name of requiredFunctions) {
            if (typeof window !== 'undefined' && typeof window[name] === 'undefined' && typeof globalThis[name] !== 'function') {
                // Top-level lexical function bindings are not necessarily properties of window.
                // The typeof check above is therefore intentionally supplemented by globalThis.
                result.warnings.push(`Benchmark function is not exposed on window: ${name}`);
            }
        }

        if (typeof document !== 'undefined') {
            const dashboard = ensureBenchmarkDashboard();
            if (!dashboard) result.errors.push('Benchmark dashboard could not be created.');
            const sourceOracle = document.getElementById('source-card-oracle');
            if (!sourceOracle) result.errors.push('Source Oracle text element is missing; benchmark highlights cannot be rendered.');
        }

        result.ok = result.errors.length === 0;
        console.info(`Benchmark preflight: ${result.ok ? 'PASS' : 'FAIL'} — ${result.tests} test(s) configured.`, result);
    } catch (error) {
        result.ok = false;
        result.errors.push(error?.message || String(error));
        console.error('Benchmark preflight: FAIL', result);
    }
    return result;
}


/**
 * Deterministic result used when the benchmark suite cannot access Scryfall because the shared
 * client-side circuit is open. This is intentionally a recorded BLOCKED status, not a fake pass.
 * The suite can therefore visit every test without generating retry traffic or contaminating the
 * measured quality metrics with outage-driven zeroes.
 * @param {Object} test
 * @param {string} reason
 * @returns {Object}
 */
function createBenchmarkBlockedPass(test, reason) {
    const expected = Array.isArray(test?.expected) ? test.expected : [];
    const emptyRanks = {};
    expected.forEach(cardName => { emptyRanks[cardName] = 100; });
    return {
        testStatus: 'blocked_rate_limit',
        errorMessage: reason,
        diagnostics: null,
        rankedResults: [],
        scoreByName: new Map(),
        conflictSet: new Set((test?.constraintConflicts || []).map(c => String(c).toLowerCase())),
        results: [],
        recall5: 0,
        recall10: 0,
        recall20: 0,
        adjustedRecall5: 0,
        adjustedRecall10: 0,
        adjustedRecall20: 0,
        mrr: 0,
        ndcg10: 0,
        ndcg20: 0,
        precision10: 0,
        avgTestRank: 100,
        cardRanks: emptyRanks,
        stageRecalls: { retrieval: 0, filter: 0, dedup: 0, scoring: 0, pruning: 0 }
    };
}

/**
 * Wait out an already-open Scryfall cooldown before a benchmark test. Unlike the interactive app,
 * the benchmark contract is to give every configured test a real search attempt. Waiting here is
 * safer than probing the API and turning one 429 into a retry storm.
 */
async function waitForBenchmarkScryfallAvailability(label = 'benchmark') {
    if (benchmarkUseLocalOracleCorpus) return;

    while (scryfallCircuitOpen && Date.now() < scryfallGlobalBackoffUntil) {
        const remainingMs = Math.max(0, scryfallGlobalBackoffUntil - Date.now());
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        console.warn(`Benchmark waiting for Scryfall cooldown before ${label}: ~${remainingSeconds}s remaining; no API probe will be sent.`);
        try {
            updateBenchmarkDashboard({
                state: 'Waiting for Scryfall',
                totalTests: BENCHMARK_SUITE.length,
                detail: `Waiting ~${remainingSeconds}s for Scryfall's existing rate-limit cooldown before ${label}. The benchmark will then run this test normally.`,
                percent: null
            });
        } catch (_) {}
        await backgroundAwareDelay(Math.min(1000, Math.max(250, remainingMs)));
    }

    // Cooldown has elapsed. It is safe to clear the local gate without issuing a test request.
    if (scryfallCircuitOpen && Date.now() >= scryfallGlobalBackoffUntil) {
        scryfallCircuitOpen = false;
        if (scryfallDispatchTimer) {
            clearTimeout(scryfallDispatchTimer);
            scryfallDispatchTimer = null;
        }
        scryfallDispatchTimerPending = false;
    }
}

/**
 * Give a rate-limited benchmark pass another chance after its cooldown. Each retry is run from a
 * cold state so a partial candidate pool cannot become hidden carry-over data.
 */
async function runBenchmarkPassWithRateLimitRecovery(searchFn, test, label = 'benchmark pass', maxAttempts = 3) {
    let lastPass = null;
    const attempts = Math.max(1, maxAttempts);

    for (let attempt = 1; attempt <= attempts; attempt++) {
        await waitForBenchmarkScryfallAvailability(`${label} (attempt ${attempt}/${attempts})`);
        resetBenchmarkColdState();

        if (attempt > 1) {
            console.warn(`Benchmark ${label}: retrying after Scryfall cooldown (attempt ${attempt}/${attempts}).`);
            try {
                updateBenchmarkDashboard({
                    state: 'Retrying test',
                    totalTests: BENCHMARK_SUITE.length,
                    detail: `Scryfall cooldown cleared; rerunning ${label} from a cold state (attempt ${attempt}/${attempts})…`,
                    percent: null
                });
            } catch (_) {}
            await backgroundAwareDelay(0);
        }

        const pass = await runBenchmarkPass(searchFn, test);
        lastPass = pass;

        if (pass?.testStatus !== 'blocked_rate_limit') return pass;

        if (attempt < attempts) {
            console.warn(`Benchmark ${label}: rate-limited. The suite will wait for the cooldown before retrying this same test.`);
            await waitForBenchmarkScryfallAvailability(`${label} retry`);
        }
    }

    return lastPass || createBenchmarkBlockedPass(
        test,
        `Scryfall remained rate-limited after ${attempts} benchmark attempts.`
    );
}

async function runBenchmarkSuite(searchFn) {
    const benchmarkValidation = validateBenchmarkSuiteConfiguration();
    benchmarkColdMode = true;
    ensureBenchmarkDashboard();
    updateBenchmarkDashboard({
        state: 'Starting',
        testIndex: 0,
        totalTests: BENCHMARK_SUITE.length,
        detail: 'Preparing the model and local benchmark data before Test #1…',
        percent: 2
    });
    await backgroundAwareDelay(0);
    let completedBenchmarkTests = 0;
    let measuredBenchmarkTests = 0;
    let blockedBenchmarkTests = 0;
    let erroredBenchmarkTests = 0;
    try {
        const startedAt = new Date();
    const runId = generateBenchmarkRunId(startedAt);

    benchmarkUseLocalOracleCorpus = false;
    benchmarkLocalOracleCorpus = null;
    benchmarkApiConservativeMode = false;
    try {
        updateBenchmarkDashboard({
            state: 'Checking local corpus',
            totalTests: BENCHMARK_SUITE.length,
            detail: 'Using an already-loaded semantic index if available; never blocking Test #1 on a full index build…',
            percent: 5
        });
        await backgroundAwareDelay(0);

        // IMPORTANT: do not await IndexedDB chunk loading here. A persisted full index can be
        // hundreds of MB in memory and loading it before Test #1 was the V20.17 startup hang.
        // Only use an index already resident in memory; otherwise the benchmark starts immediately
        // in bounded API-conservative mode. Normal searches may still build/load the full index.
        if (fullSemanticIndexMemory && fullSemanticIndexMemory.source !== 'static') {
            benchmarkUseLocalOracleCorpus = true;
            benchmarkLocalOracleCorpus = fullSemanticIndexMemory;
            console.info('Benchmark retrieval mode: in-memory client Scryfall Oracle semantic index.');
        } else {
            // The deployed static index intentionally stores only names + quantized vectors; normal
            // users hydrate the small semantic hit set from Scryfall after retrieval. Keep benchmark
            // local-corpus mode off for that compact asset rather than pretending its card payloads
            // are present.
            benchmarkApiConservativeMode = true;
            console.info('Benchmark retrieval mode: API-conservative fallback; no in-memory semantic index is ready.');
        }
    } catch (err) {
        benchmarkApiConservativeMode = true;
        console.info('Benchmark local-index check skipped; using API-conservative fallback:', err?.message || err);
    }

    // Load the NLP model opportunistically, but never let model startup block the whole suite.
    try {
        updateBenchmarkDashboard({
            state: 'Preparing model',
            totalTests: BENCHMARK_SUITE.length,
            detail: 'Preparing semantic model; benchmark will continue with structural/lexical scoring if it is unavailable…',
            percent: 8
        });
        await withBenchmarkTimeout(getNLPModel(), 20000, 'Semantic model startup');
    } catch (err) {
        console.info('Benchmark semantic model unavailable; continuing with non-ML scoring:', err?.message || err);
        nlpExtractor = { type: 'fallback' };
    }

    // Source-card metadata is immutable benchmark input. Reuse anything already present in the
    // benchmark catalog or normal source-card cache; do NOT make a dozen API requests up front.
    // Missing source cards are fetched only when their individual test starts.
    if (typeof updateBenchmarkDashboard === 'function') {
        updateBenchmarkDashboard({
            state: benchmarkUseLocalOracleCorpus ? 'Using local corpus' : 'API-conservative mode',
            totalTests: BENCHMARK_SUITE.length,
            detail: benchmarkUseLocalOracleCorpus
                ? 'Ready semantic index found; starting benchmark tests…'
                : 'No ready semantic index found; starting with bounded live retrieval…',
            percent: 12
        });
        await backgroundAwareDelay(0);
    }

    // Every benchmark test is independently cold. Search-result caches, embeddings, and the
    // session semantic corpus are cleared before each test (and before its optional semantic
    // pass), so a later test cannot receive free candidates from an earlier test. Search G keeps
    // its normal session behavior in the live application; this isolation applies only to the
    // benchmark.
    resetBenchmarkColdState();

    console.log("==================================================");
    console.log("     ManaMatch Local Search Benchmark Suite       ");
    console.log(`     Run ID: ${runId}`);
    console.log("==================================================\n");

    const suiteResults = [];
    const retrievalCostRows = [];
    let totalRecall5 = 0, totalRecall10 = 0, totalRecall20 = 0;
    // "Adjusted" recall excludes expected cards flagged as constraintConflicts (see
    // BENCHMARK_SUITE) from the denominator - a card the engine's own hard filters correctly
    // exclude (because the card itself doesn't satisfy the test's own supplied constraints) isn't
    // a retrieval/ranking failure, it's a data problem with the test case.
    let totalAdjustedRecall5 = 0, totalAdjustedRecall10 = 0, totalAdjustedRecall20 = 0;
    let totalMRR = 0, totalNDCG10 = 0, totalNDCG20 = 0, totalPrecision10 = 0, totalRetrievalRecall = 0;
    let allExpectedRanks = [];
    const categoryTotals = {};
    const structuredResults = [];

    // Semantic recall totals are only meaningful for tests that actually declared preferred
    // constraints, so they're averaged over that subset, not the whole suite - diluting them
    // across every test would make "preferred constraints matter a lot for these 2 tests" look
    // like "barely matters at all" (review Priority 2 / Priority 9).
    let semanticTestCount = 0;
    let totalSemanticRecall20 = 0, totalSemanticMRR = 0, totalSemanticNDCG20 = 0;

    for (let benchmarkIndex = 0; benchmarkIndex < BENCHMARK_SUITE.length; benchmarkIndex++) {
        const test = BENCHMARK_SUITE[benchmarkIndex];
        const benchmarkTestStartedAt = Date.now();
        try {
        updateBenchmarkDashboard({
            state: 'Running',
            testIndex: benchmarkIndex,
            totalTests: BENCHMARK_SUITE.length,
            test,
            detail: 'Resetting cold search state…',
            percent: 15 + (benchmarkIndex / Math.max(1, BENCHMARK_SUITE.length)) * 80
        });
        await backgroundAwareDelay(0);
        // EVERY configured test gets an actual search attempt. If a previous test opened the
        // Scryfall cooldown, wait for the already-announced cooldown instead of skipping this test.
        await waitForBenchmarkScryfallAvailability(`Test #${test.id}`);

        // True cold test: no retrieval/scoring state from the preceding benchmark test.
        resetBenchmarkColdState();

        console.log(`\n--------------------------------------------------`);
        console.log(`Test #${test.id}: ${test.name} (${test.source})`);
        console.log(`--------------------------------------------------`);

        const testStartedAt = benchmarkTestStartedAt;
        updateBenchmarkDashboard({
            state: 'Running test',
            testIndex: benchmarkIndex,
            totalTests: BENCHMARK_SUITE.length,
            test,
            detail: 'Loading source card, applying benchmark highlights, and running the search pipeline…',
            percent: 15 + (benchmarkIndex / Math.max(1, BENCHMARK_SUITE.length)) * 80
        });
        await backgroundAwareDelay(0);

        console.log(`  Benchmark search attempt: Test #${test.id} — contacting the live search pipeline.`);
        const strictPass = await runBenchmarkPassWithRateLimitRecovery(
            searchFn,
            test,
            `Test #${test.id} strict pass`,
            3
        );

        if (strictPass.testStatus === 'blocked_rate_limit') {
            console.warn(`Benchmark Test #${test.id}: Scryfall remained rate-limited after the retry budget; recording this test as blocked, then continuing.`);
        } else if (strictPass.testStatus === 'error') {
            console.error(`Benchmark Test #${test.id}: isolated strict-pass error; continuing.`);
        }

        // A test with preferredConstraints gets a SECOND pass with those specific fields omitted
        // entirely (not loosened engine-side - the live filters stay exactly as strict as they
        // are). This measures "how well would ManaSearch have done on this source card's real
        // function" separately from "how well did it do while also matching this test's rarity
        // preference" (review Priority 2, "three filter modes"; Priority 9, "Semantic Recall").
        const preferredFields = test.preferredConstraints || [];
        let semanticPass = null;
        if (preferredFields.length > 0) {
            // Preferred-constraint/semantic comparison is also a real search. Never silently skip
            // it because the strict pass encountered a 429; the recovery helper waits for the
            // cooldown and gives the relaxed pass the same opportunity to run.
            const relaxedConstraints = { ...test.constraints };
            preferredFields.forEach(f => { delete relaxedConstraints[f]; });
            semanticPass = await runBenchmarkPassWithRateLimitRecovery(
                searchFn,
                { ...test, constraints: relaxedConstraints },
                `Test #${test.id} semantic pass`,
                3
            );
        }

        const testDurationMs = Date.now() - testStartedAt;
        updateBenchmarkDashboard({
            state: 'Test complete',
            testIndex: benchmarkIndex + 1,
            totalTests: BENCHMARK_SUITE.length,
            test,
            detail: `Completed in ${fmtMs(testDurationMs)}. Preparing the next cold test…`,
            percent: 15 + ((benchmarkIndex + 1) / Math.max(1, BENCHMARK_SUITE.length)) * 80
        });
        await backgroundAwareDelay(0);
        if (strictPass.testStatus === 'error') {
            console.error(`  [ERROR] Test #${test.id} failed:`, strictPass.errorMessage);
        } else if (strictPass.testStatus === 'blocked_rate_limit') {
            console.warn(`  [BLOCKED] Test #${test.id}: ${strictPass.errorMessage}`);
        }

        // Print Funnel Pipeline Counts (strict pass - this is what the live UI actually returns)
        const d = strictPass.diagnostics;
        if (d) {
            console.log(`Pipeline Diagnostics:`);
            console.log(`  Candidates retrieved:        ${d.retrieved}`);
            console.log(`  Passed hard filters (raw):   ${d.passedFiltersRaw ?? 'n/a'}`);
            console.log(`  After dedup:                 ${d.afterHardFilters}`);
            console.log(`  After relevance floor:       ${d.afterRelevanceFloor}`);
    if (d.relevanceFloorRescued) console.log(`  Relevance-floor rescue:      ${d.relevanceFloorRescued} (strict pass was ${d.relevanceFloorStrictCount ?? 0})`);
            console.log(`  Final results:               ${d.finalResults}`);
            if (d.timings) {
                console.log(`  Timing: retrieval ${fmtMs(d.timings.retrievalMs)} | scoring ${fmtMs(d.timings.scoringMs)} | ranking ${fmtMs(d.timings.rankingMs)} | render ${fmtMs(d.timings.renderMs)} | total ${fmtMs(d.timings.totalMs)}`);
            }

            // Search G (session semantic corpus) is new relative to the other streams: it can
            // retrieve zero results on a session's first-ever test and grow more useful as later
            // tests populate the corpus, so its count is worth calling out on its own rather than
            // folding silently into the other stream sizes (see the corpus's own comment for why).
            const searchGCount = d.streams?.['Search G']?.size ?? 0;
            if (searchGCount > 0) {
                console.log(`  Search G (session semantic corpus): ${searchGCount} candidate(s) retrieved by meaning alone`);
            }

            // Embedding cache health for this test: how many candidates needed a fresh model
            // call vs. were already cached, and how many silently fell back to lexical-only
            // scoring because a model call failed (review: embedding diagnostics).
            if (d.embeddingDiagnostics) {
                const { cacheHits, computed, failed, skippedForBudget } = d.embeddingDiagnostics;
                console.log(`  Embedding cache: ${cacheHits} cache hit(s), ${computed} computed, ${failed} failed (fell back to lexical-only)${skippedForBudget ? `, ${skippedForBudget} skipped (semantic-scoring budget, fell back to lexical-only)` : ''}`);
            }

            // Coverage warnings: flag any stream that hit its page cap while a large fraction of
            // its own Scryfall match set was left unfetched (review Priority 4 / E).
            if (d.streamCoverage) {
                const undercovered = Object.entries(d.streamCoverage).filter(([, cov]) => cov && !cov.fullyCovered && cov.totalCards > 0);
                if (undercovered.length > 0) {
                    console.log(`  Coverage warnings:`);
                    undercovered.forEach(([streamName, cov]) => {
                        console.log(`    ${streamName}: fetched ${cov.retrievedCount}/${cov.totalCards} matching cards (${cov.pagesFetched} of ~${Math.ceil(cov.totalCards / 175)} pages)`);
                    });
                }
            }
            if (d.searchFQueryDetail?.length) {
                console.log(`  Search F formulations:`);
                d.searchFQueryDetail.forEach((q, i) => {
                    console.log(`    Query ${i + 1} (${q.narrow ? 'narrow' : 'broad'}): ${q.retrieved} retrieved - ${q.query}`);
                });
            }

            // Retrieval Cost sheet rows: cost (cards fetched vs. haystack size) per stream, so
            // "we're spending N seconds retrieving M cards out of a K-card haystack" is directly
            // visible rather than implied by console warnings alone (review Priority 4 / 10-4).
            Object.entries(d.streamCoverage || {}).forEach(([streamName, cov]) => {
                if (!cov) return;
                retrievalCostRows.push({
                    'Test ID': test.id, 'Source Card': test.source, 'Stream': streamName,
                    'Query': cov.query || '', 'Matches': cov.totalCards ?? '', 'Retrieved': cov.retrievedCount ?? '',
                    'Pages': cov.pagesFetched ?? '', 'Page Budget': cov.maxPages ?? '',
                    'Fully Covered': cov.fullyCovered ? 'Y' : 'N',
                    '% of Haystack Retrieved': cov.totalCards ? `${((cov.retrievedCount / cov.totalCards) * 100).toFixed(2)}%` : ''
                });
            });
            (d.searchFQueryDetail || []).forEach((q, i) => {
                retrievalCostRows.push({
                    'Test ID': test.id, 'Source Card': test.source, 'Stream': `Search F (query ${i + 1})`,
                    'Query': q.query, 'Matches': q.coverage?.totalCards ?? '', 'Retrieved': q.retrieved,
                    'Pages': q.coverage?.pagesFetched ?? '', 'Page Budget': q.coverage?.maxPages ?? '',
                    'Fully Covered': q.coverage?.fullyCovered ? 'Y' : 'N',
                    '% of Haystack Retrieved': q.coverage?.totalCards ? `${((q.retrieved / q.coverage.totalCards) * 100).toFixed(2)}%` : ''
                });
            });
            // Search G has no Scryfall page/coverage concept (it's a local corpus lookup, not a
            // paged network query) - those columns are left blank rather than filled with a
            // fabricated "fully covered" value that wouldn't mean anything for this stream.
            if (d.streams?.['Search G']) {
                retrievalCostRows.push({
                    'Test ID': test.id, 'Source Card': test.source, 'Stream': 'Search G (session semantic corpus)',
                    'Query': '', 'Matches': '', 'Retrieved': d.streams['Search G'].size,
                    'Pages': '', 'Page Budget': '', 'Fully Covered': '', '% of Haystack Retrieved': ''
                });
            }
        } else {
            console.log(`  [Warning] No pipeline diagnostics returned.`);
        }

        printExpectedCardTrace(strictPass, test, 'STRICT');
        if (semanticPass) {
            printExpectedCardTrace(semanticPass, test, 'SEMANTIC (preferred constraints relaxed)');
            console.log(`\n  Strict vs Semantic Recall@20: ${(strictPass.recall20 * 100).toFixed(1)}% -> ${(semanticPass.recall20 * 100).toFixed(1)}%`);
        }

        console.log(`\nRanking metrics: MRR ${strictPass.mrr.toFixed(3)} | NDCG@10 ${strictPass.ndcg10.toFixed(3)} | NDCG@20 ${strictPass.ndcg20.toFixed(3)} | P@10 ${strictPass.precision10.toFixed(3)}`);
        console.log(`Stage recall: retrieval ${(strictPass.stageRecalls.retrieval * 100).toFixed(0)}% -> filter ${(strictPass.stageRecalls.filter * 100).toFixed(0)}% -> dedup ${(strictPass.stageRecalls.dedup * 100).toFixed(0)}% -> scored ${(strictPass.stageRecalls.scoring * 100).toFixed(0)}% -> pruned ${(strictPass.stageRecalls.pruning * 100).toFixed(0)}%`);
        console.log(`Duration: ${(testDurationMs / 1000).toFixed(2)}s`);

        const isBlocked = strictPass.testStatus === 'blocked_rate_limit';
        if (isBlocked) {
            blockedBenchmarkTests++;
        } else {
            measuredBenchmarkTests++;
            totalRecall5 += strictPass.recall5;
            totalRecall10 += strictPass.recall10;
            totalRecall20 += strictPass.recall20;
            totalAdjustedRecall5 += strictPass.adjustedRecall5;
            totalAdjustedRecall10 += strictPass.adjustedRecall10;
            totalAdjustedRecall20 += strictPass.adjustedRecall20;
            totalMRR += strictPass.mrr;
            totalNDCG10 += strictPass.ndcg10;
            totalNDCG20 += strictPass.ndcg20;
            totalPrecision10 += strictPass.precision10;
            totalRetrievalRecall += strictPass.stageRecalls.retrieval;
            allExpectedRanks.push(...Object.values(strictPass.cardRanks));

            (test.categories || ['uncategorized']).forEach(cat => {
                if (!categoryTotals[cat]) categoryTotals[cat] = { count: 0, recall20: 0, ndcg20: 0, mrr: 0, retrieval: 0 };
                categoryTotals[cat].count++;
                categoryTotals[cat].recall20 += strictPass.recall20;
                categoryTotals[cat].ndcg20 += strictPass.ndcg20;
                categoryTotals[cat].mrr += strictPass.mrr;
                categoryTotals[cat].retrieval += strictPass.stageRecalls.retrieval;
            });
        }

        if (semanticPass && semanticPass.testStatus !== 'blocked_rate_limit') {
            semanticTestCount++;
            totalSemanticRecall20 += semanticPass.recall20;
            totalSemanticMRR += semanticPass.mrr;
            totalSemanticNDCG20 += semanticPass.ndcg20;
        }

        const traceSourceCard = isBlocked ? findBenchmarkSourceCard(test.source) : currentSourceCard;
        structuredResults.push({
            id: test.id, name: test.name, source: test.source,
            highlights: buildBenchmarkHighlightState(test, traceSourceCard),
            categories: test.categories || [], constraints: test.constraints || {},
            highlightStyle: test.highlightStyle || 'user-like intent excerpt',
            highlightIntent: test.highlightIntent || '',
            highlightDefinitions: (test.highlights || []).map(h => ({
                text: h.text, mode: h.mode, intent: h.intent || ''
            })),
            expected: test.expected, constraintConflicts: test.constraintConflicts || [],
            preferredConstraints: preferredFields,
            durationMs: testDurationMs,
            strict: strictPass,
            semantic: semanticPass
        });

        suiteResults.push({
            "Test ID": test.id,
            "Source Card": test.source,
            "Highlight Style": test.highlightStyle || 'user-like intent excerpt',
            "Highlight Intent": test.highlightIntent || '',
            "Highlights": (test.highlights || (test.highlightedOracle ? [{ text: test.highlightedOracle, mode: 'exact' }] : [])).map(h => `${h.mode}: ${h.text}${h.intent ? ` [intent: ${h.intent}]` : ''}`).join(' | '),
            "Status": strictPass.testStatus,
            "Duration": `${(testDurationMs / 1000).toFixed(2)}s`,
            "Recall@5": `${(strictPass.recall5 * 100).toFixed(1)}%`,
            "Recall@10": `${(strictPass.recall10 * 100).toFixed(1)}%`,
            "Recall@20": `${(strictPass.recall20 * 100).toFixed(1)}%`,
            "Adj. Recall@20": test.constraintConflicts?.length ? `${(strictPass.adjustedRecall20 * 100).toFixed(1)}%` : '-',
            "Semantic Recall@20": semanticPass ? `${(semanticPass.recall20 * 100).toFixed(1)}%` : '-',
            "MRR": strictPass.mrr.toFixed(3),
            "NDCG@20": strictPass.ndcg20.toFixed(3),
            "P@10": strictPass.precision10.toFixed(3),
            "Retrieval Recall": `${(strictPass.stageRecalls.retrieval * 100).toFixed(0)}%`,
            "Avg Exp Rank": strictPass.avgTestRank.toFixed(1),
            "Card Ranks": JSON.stringify(strictPass.cardRanks)
        });

        completedBenchmarkTests++;
    } catch (testError) {
        // Hard per-test safety boundary: a trace/reporting bug or unexpected runtime error in one
        // benchmark case must never abort the remaining suite. Record the isolated failure and continue.
        const elapsedMs = Date.now() - benchmarkTestStartedAt;
        const blocked = isScryfallRateLimitError(testError) || testError?.scryfallCircuitOpen ||
            (scryfallCircuitOpen && Date.now() < scryfallGlobalBackoffUntil);
        const fallbackStatus = blocked ? 'blocked_rate_limit' : 'error';
        const fallbackMessage = testError?.message || String(testError);
        const expected = Array.isArray(test?.expected) ? test.expected : [];
        const fallbackRanks = {};
        expected.forEach(cardName => { fallbackRanks[cardName] = 100; });
        const fallbackPass = createBenchmarkBlockedPass(test, fallbackMessage);
        if (!blocked) {
            fallbackPass.testStatus = 'error';
        }
        if (blocked) blockedBenchmarkTests++;
        else erroredBenchmarkTests++;
        completedBenchmarkTests++;

        console.error(`Benchmark Test #${test?.id ?? benchmarkIndex + 1}: ${fallbackStatus}; continuing to the next test.`, testError);
        suiteResults.push({
            "Test ID": test?.id ?? benchmarkIndex + 1,
            "Source Card": test?.source || '',
            "Highlight Style": test?.highlightStyle || 'user-like intent excerpt',
            "Highlight Intent": test?.highlightIntent || '',
            "Highlights": (test?.highlights || (test?.highlightedOracle ? [{ text: test.highlightedOracle, mode: 'exact' }] : []))
                .map(h => `${h.mode}: ${h.text}${h.intent ? ` [intent: ${h.intent}]` : ''}`).join(' | '),
            "Status": fallbackStatus,
            "Duration": `${(elapsedMs / 1000).toFixed(2)}s`,
            "Recall@5": '0.0%', "Recall@10": '0.0%', "Recall@20": '0.0%',
            "Adj. Recall@20": '-', "Semantic Recall@20": '-', "MRR": '0.000',
            "NDCG@20": '0.000', "P@10": '0.000', "Retrieval Recall": '0%',
            "Avg Exp Rank": '100.0', "Card Ranks": JSON.stringify(fallbackRanks),
            "Error": fallbackMessage
        });
        structuredResults.push({
            id: test?.id ?? benchmarkIndex + 1,
            name: test?.name || `Benchmark Test ${benchmarkIndex + 1}`,
            source: test?.source || '',
            highlights: [],
            categories: test?.categories || [],
            constraints: test?.constraints || {},
            highlightStyle: test?.highlightStyle || 'user-like intent excerpt',
            highlightIntent: test?.highlightIntent || '',
            highlightDefinitions: (test?.highlights || []).map(h => ({ text: h.text, mode: h.mode, intent: h.intent || '' })),
            expected,
            constraintConflicts: test?.constraintConflicts || [],
            preferredConstraints: test?.preferredConstraints || [],
            durationMs: elapsedMs,
            strict: fallbackPass,
            semantic: null
        });
        try {
            updateBenchmarkDashboard({
                state: 'Test complete',
                testIndex: benchmarkIndex + 1,
                totalTests: BENCHMARK_SUITE.length,
                test,
                detail: `${blocked ? 'Blocked by Scryfall; ' : 'Error isolated; '}continuing through the suite…`,
                percent: 15 + ((benchmarkIndex + 1) / Math.max(1, BENCHMARK_SUITE.length)) * 80
            });
            await backgroundAwareDelay(0);
        } catch (dashboardError) {
            console.warn('Benchmark dashboard update failed while recovering from a test error:', dashboardError);
        }
    }
    }

    // Aggregate quality metrics over tests that actually reached the ranking pipeline. A blocked
    // test still gets a full result row, but treating its forced-zero scores as measured data would
    // make the benchmark quality numbers depend on temporary API outages rather than ManaSearch.
    const testCount = Math.max(1, measuredBenchmarkTests);
    const benchmarkCompleted = completedBenchmarkTests >= BENCHMARK_SUITE.length;
    const benchmarkFullyMeasured = benchmarkCompleted && blockedBenchmarkTests === 0 && erroredBenchmarkTests === 0;
    const overallAvgRank = allExpectedRanks.length
        ? allExpectedRanks.reduce((a, b) => a + b, 0) / allExpectedRanks.length
        : null;
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    const categoryBreakdown = Object.entries(categoryTotals).map(([cat, t]) => ({
        "Category": cat, "Tests": t.count,
        "Recall@20": `${((t.recall20 / t.count) * 100).toFixed(1)}%`,
        "NDCG@20": (t.ndcg20 / t.count).toFixed(3),
        "MRR": (t.mrr / t.count).toFixed(3),
        "Retrieval Recall": `${((t.retrieval / t.count) * 100).toFixed(1)}%`
    }));

    console.log("\n==================================================");
    console.log("              TEST SUMMARY BREAKDOWN              ");
    console.log("==================================================");
    console.table(suiteResults);

    console.log("\n--- BREAKDOWN BY CARD CATEGORY ---");
    console.table(categoryBreakdown);

    console.log("--- OVERALL BENCHMARK METRICS ---");
    console.log(`Mean Recall@5:            ${((totalRecall5 / testCount) * 100).toFixed(2)}%`);
    console.log(`Mean Recall@10:           ${((totalRecall10 / testCount) * 100).toFixed(2)}%`);
    console.log(`Mean Recall@20:           ${((totalRecall20 / testCount) * 100).toFixed(2)}%`);
    console.log(`Mean Adjusted Recall@20:  ${((totalAdjustedRecall20 / testCount) * 100).toFixed(2)}%  (excludes constraint-conflict expected cards)`);
    if (semanticTestCount > 0) {
        console.log(`Mean Semantic Recall@20:  ${((totalSemanticRecall20 / semanticTestCount) * 100).toFixed(2)}%  (${semanticTestCount} tests with preferred constraints, preferred fields omitted)`);
    }
    console.log(`Mean Retrieval Recall:    ${((totalRetrievalRecall / testCount) * 100).toFixed(2)}%  (ceiling - ranking can never beat this)`);
    console.log(`Mean MRR:                 ${(totalMRR / testCount).toFixed(4)}`);
    console.log(`Mean NDCG@10:             ${(totalNDCG10 / testCount).toFixed(4)}`);
    console.log(`Mean NDCG@20:             ${(totalNDCG20 / testCount).toFixed(4)}`);
    console.log(`Mean Precision@10:        ${(totalPrecision10 / testCount).toFixed(4)}`);
    console.log(`Overall Avg Card Rank: ${overallAvgRank === null ? 'n/a' : overallAvgRank.toFixed(2)} (Penalty for unranked: 100)`);
    console.log(`Total runtime: ${(durationMs / 1000).toFixed(2)}s`);
    if (benchmarkCompleted) {
        console.log(`Benchmark traversed all tests: ${completedBenchmarkTests}/${BENCHMARK_SUITE.length}.`);
        if (blockedBenchmarkTests > 0 || erroredBenchmarkTests > 0) {
            console.log(`Non-measured tests: ${blockedBenchmarkTests} API-blocked, ${erroredBenchmarkTests} isolated error(s). Quality metrics below report only ${measuredBenchmarkTests} measured test(s).`);
        } else {
            console.log('All tests were fully measured.');
        }
    } else {
        console.log(`Benchmark did not traverse the full suite: ${completedBenchmarkTests}/${BENCHMARK_SUITE.length} tests reached the result-recording stage.`);
    }
    console.log("==================================================\n");

    const summaryMetrics = {
        meanRecall5: totalRecall5 / testCount,
        meanRecall10: totalRecall10 / testCount,
        meanRecall20: totalRecall20 / testCount,
        meanAdjustedRecall20: totalAdjustedRecall20 / testCount,
        meanSemanticRecall20: semanticTestCount > 0 ? totalSemanticRecall20 / semanticTestCount : null,
        meanRetrievalRecall: totalRetrievalRecall / testCount,
        meanMRR: totalMRR / testCount,
        meanNDCG10: totalNDCG10 / testCount,
        meanNDCG20: totalNDCG20 / testCount,
        meanPrecision10: totalPrecision10 / testCount,
        overallAvgRank,
        durationMs,
        completedTests: completedBenchmarkTests,
        measuredTests: measuredBenchmarkTests,
        blockedTests: blockedBenchmarkTests,
        erroredTests: erroredBenchmarkTests,
        totalTests: BENCHMARK_SUITE.length,
        benchmarkCompleted,
        benchmarkFullyMeasured
    };

    // Regression comparison against the previous run, so a change's actual effect is visible
    // immediately rather than requiring the user to keep old workbooks open side by side
    // (review Priority 10, "Add regression comparison"). Best-effort: unavailable outside a
    // browser (no localStorage), or on a machine's very first run, simply skips this section.
    let previousRun = null;
    try {
        if (typeof localStorage !== 'undefined') {
            const stored = localStorage.getItem(BENCHMARK_HISTORY_KEY);
            if (stored) previousRun = JSON.parse(stored);
            localStorage.setItem(BENCHMARK_HISTORY_KEY, JSON.stringify({ runId, generatedAt: finishedAt.toISOString(), ...summaryMetrics }));
        }
    } catch (err) {
        console.warn("Benchmark history read/write skipped:", err.message);
    }

    if (previousRun) {
        console.log("--- VS PREVIOUS RUN ---");
        console.log(`Previous run: ${previousRun.runId || '(unknown)'} at ${previousRun.generatedAt || '(unknown)'}`);
        [['Recall@20', 'meanRecall20', true], ['Retrieval Recall', 'meanRetrievalRecall', true], ['MRR', 'meanMRR', false], ['Avg runtime', 'durationMs', false]]
            .forEach(([label, key, isPct]) => {
                const prev = previousRun[key];
                const curr = summaryMetrics[key];
                if (prev === undefined || prev === null || curr === undefined || curr === null) return;
                const delta = curr - prev;
                const deltaStr = key === 'durationMs'
                    ? `${delta >= 0 ? '+' : ''}${(delta / 1000).toFixed(2)}s`
                    : isPct ? `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}pp` : `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`;
                console.log(`  ${label}: ${isPct ? (prev * 100).toFixed(2) + '%' : key === 'durationMs' ? (prev / 1000).toFixed(2) + 's' : prev.toFixed(4)} -> ${isPct ? (curr * 100).toFixed(2) + '%' : key === 'durationMs' ? (curr / 1000).toFixed(2) + 's' : curr.toFixed(4)}  (${deltaStr})`);
            });
        console.log("==================================================\n");
    }

    const report = {
        runId,
        startedAt,
        finishedAt,
        generatedAt: finishedAt,
        ...summaryMetrics,
        categoryBreakdown,
        structuredResults,
        retrievalCostRows,
        previousRun,
        details: suiteResults,
        completedTests: completedBenchmarkTests,
        measuredTests: measuredBenchmarkTests,
        blockedTests: blockedBenchmarkTests,
        erroredTests: erroredBenchmarkTests,
        totalTests: BENCHMARK_SUITE.length,
        benchmarkCompleted,
        benchmarkFullyMeasured,
        scryfallRateLimited: scryfallConsecutiveRateLimits > 0
    };

    // Automatically download the full run as a spreadsheet.
    try {
        await downloadBenchmarkWorkbook(report);
    } catch (err) {
        console.error("Benchmark workbook export failed:", err);
    }

        return report;
    } finally {
        const dashboard = ensureBenchmarkDashboard();
        if (dashboard) {
            const completed = typeof completedBenchmarkTests === 'number' ? completedBenchmarkTests : 0;
            const complete = completed >= BENCHMARK_SUITE.length;
            updateBenchmarkDashboard({
                state: complete ? 'Finished' : 'Stopped',
                testIndex: completed,
                totalTests: BENCHMARK_SUITE.length,
                detail: complete
                    ? ((blockedBenchmarkTests > 0 || erroredBenchmarkTests > 0)
                        ? `Benchmark run finished. All ${completed}/${BENCHMARK_SUITE.length} tests were traversed; ${blockedBenchmarkTests} were blocked by the Scryfall API circuit and ${erroredBenchmarkTests} had isolated errors. Results and traces are shown below.`
                        : 'Benchmark run finished. The results and traces are shown below.')
                    : `Benchmark stopped after ${completed}/${BENCHMARK_SUITE.length} completed test${completed === 1 ? '' : 's'}.`,
                percent: complete ? 100 : (BENCHMARK_SUITE.length ? (completed / BENCHMARK_SUITE.length) * 100 : 0)
            });
        }
        benchmarkColdMode = false;
        benchmarkUseLocalOracleCorpus = false;
        benchmarkLocalOracleCorpus = null;
        benchmarkApiConservativeMode = false;
    }
}

function fmtMs(v) {
    return (v === undefined || v === null) ? 'n/a' : `${(v / 1000).toFixed(2)}s`;
}

// Benchmark source-card resolver. Source-card metadata is immutable benchmark input, so it is
// safe to reuse it across cold tests. Prefer an already-loaded local semantic corpus or benchmark
// catalog, then the normal source cache, and only hit Scryfall as a last resort. This prevents a
// benchmark run from spending its API budget repeatedly resolving the same 12 source cards.
function findBenchmarkSourceCard(sourceName) {
    const key = normalizeCardNameForIdentity(sourceName || '');
    if (!key) return null;

    if (benchmarkLocalOracleCorpus?.chunks) {
        for (const chunk of benchmarkLocalOracleCorpus.chunks) {
            const names = chunk.names || [];
            const cards = chunk.cards || [];
            for (let i = 0; i < Math.min(chunk.count || names.length, names.length); i++) {
                if (normalizeCardNameForIdentity(names[i]) === key && cards[i]) return cards[i];
            }
        }
    }

    for (const [catalogKey, card] of benchmarkSourceCardCatalog) {
        if (normalizeCardNameForIdentity(catalogKey) === key || normalizeCardNameForIdentity(card?.name) === key) return card;
    }

    return sourceCardCache.get(String(sourceName).trim().toLowerCase()) || null;
}

async function loadBenchmarkSourceCard(sourceName) {
    const localCard = findBenchmarkSourceCard(sourceName);
    if (localCard) {
        ++searchRequestId;
        currentSourceCard = localCard;
        lastSearchResults = [];
        lastSearchDiagnostics = null;
        pendingDeeperSearch = null;
        manualHighlights = [];
        displaySourceCard(localCard);
        activeTags = generateTags(localCard);
        renderTags();
        return localCard;
    }
    return loadSourceCard(sourceName);
}

// Example Integration Handler for browser environment (App context):
let benchmarkRunPromise = null;

async function runLocalBenchmarkInApp() {
    if (benchmarkRunPromise) return benchmarkRunPromise;

    benchmarkRunPromise = runBenchmarkSuite(async (testCase) => {
        updateBenchmarkDashboard({
            state: 'Preparing test',
            test: testCase,
            totalTests: BENCHMARK_SUITE.length,
            detail: 'Applying benchmark filters and simulated user highlights…'
        });
        await backgroundAwareDelay(0);
        document.getElementById('card-search-input').value = testCase.source;
        document.getElementById('filter-type').value = testCase.constraints.type || '';
        document.getElementById('filter-format').value = testCase.constraints.format || '';
        document.getElementById('filter-rarity').value = testCase.constraints.rarity || '';
        const identityField = document.getElementById('filter-identity');
        identityField.value = testCase.constraints.identity || '';
        identityField.dispatchEvent(new Event('input'));
        const colorsField = document.getElementById('filter-colors');
        colorsField.value = testCase.constraints.colors || '';
        colorsField.dispatchEvent(new Event('input'));
        document.getElementById('filter-cmc').value = testCase.constraints.cmc || '';
        document.getElementById('filter-power').value = testCase.constraints.power || '';
        document.getElementById('filter-toughness').value = testCase.constraints.toughness || '';
        const benchmarkExtraOracle = document.getElementById('filter-extra-oracle');
        if (benchmarkExtraOracle) benchmarkExtraOracle.value = testCase.constraints.extraOracle || '';

        // Cold benchmark: load this test's source card normally instead of reusing a card loaded
        // for another benchmark test.
        await loadBenchmarkSourceCard(testCase.source);
        manualHighlights = renderBenchmarkHighlightPreview(testCase, currentSourceCard);
        updateBenchmarkDashboard({
            state: 'Searching',
            test: testCase,
            totalTests: BENCHMARK_SUITE.length,
            detail: 'Source card and simulated highlights are visible; running the search pipeline now…'
        });
        await backgroundAwareDelay(0);
        console.log(`  Highlight spec: ${manualHighlights.length ? manualHighlights.map(h => `${h.mode.toUpperCase()}: ${h.text}${h.intent ? ` [${h.intent}]` : ''}`).join(' | ') : 'none'}`);
        await findSimilarCards();
        
        return { results: lastSearchResults, diagnostics: lastSearchDiagnostics };
    }).finally(() => {
        benchmarkRunPromise = null;
    });

    // Return the actual suite promise to the console/caller. Without this return, the async
    // wrapper itself resolves immediately with undefined while the benchmark continues in the
    // background, making DevTools misleadingly show `Promise {<fulfilled>: undefined}`.
    return benchmarkRunPromise;
}

window.runLocalBenchmarkInApp = runLocalBenchmarkInApp;
window.validateBenchmarkRuntimeInApp = validateBenchmarkRuntimeInApp;

// Add Tagging Engine Functions
/**
 * Title-cases a keyword/phrase for tag display, matching the style of the existing hand-written
 * tags ("First Strike", "Double Strike") - e.g. Scryfall's own `keywords` array casing is
 * inconsistent ("First strike", "Ninjutsu", "double strike" depending on source), so without
 * normalizing, a keyword the generic loop below picks up could land as a same-word-different-case
 * near-duplicate of an already-hand-tagged entry instead of the same Set entry.
 * @param {string} str
 * @returns {string}
 */
function toTitleCase(str) {
    return str.replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

/**
 * Adds a tag only if no case-insensitively-equal tag is already present, so a canonical-function
 * tag and a hand-written regex tag that happen to differ only in casing collapse to one entry
 * instead of showing up as two separate, redundant Set members.
 * @param {Set<string>} tagSet
 * @param {string} candidate
 */
function addTagCaseInsensitive(tagSet, candidate) {
    const lower = candidate.toLowerCase();
    for (const existing of tagSet) {
        if (existing.toLowerCase() === lower) return;
    }
    tagSet.add(candidate);
}

// Maps a canonical function (from deriveCanonicalFunction) to the SAME tag name its hand-written
// regex counterpart already uses above, so the parser's judgment and the regex's judgment
// reconcile onto one Set entry instead of silently disagreeing as two different-cased tags
// (review: tag system item 2). A canonical function with no entry here falls back to a
// Title-Cased version of its own name in generateTags.
const CANONICAL_FUNCTION_TAG_NAMES = {
    reanimate: "Reanimate",
    recursion: "Recursion",
    bounce: "Bounce",
    removal: "Removal",
    exile_removal: "Removal",
    counter: "Counterspell",
    tutor: "Tutor",
    token_creation: "Token",
    token_multiplier: "Token Doubler",
    tribal_anthem: "Anthem",
    anthem: "Anthem",
    card_draw: "Draw",
    mill: "Graveyard",
    discard: "Discard",
    direct_damage: "Burn",
    mana_ability: "Ramp",
    self_sacrifice: "Sac Outlet",
    gain_life: "Lifegain",
    // Not "Drain" - the existing Drain tag specifically means life loss paired with the opponent's
    // loss becoming your gain ("target opponent loses X life and you gain X life" / extort). A
    // bare, one-sided life-loss effect (a symmetrical edict-style drawback, "each player loses 1
    // life") isn't drain, so it gets its own name instead of overloading Drain's meaning.
    lose_life: "Life Loss",
    // "tap" has no existing hand tag counterpart (falls through to the generic Title-Case
    // fallback, "Tap") - only untap already had one, reused here.
    untap: "Untap"
    // place_counter deliberately has no flat entry here - see the compositional block in
    // generateTags, which maps it to "+1/+1 Counters" or "-1/-1 Counters" depending on
    // counterType. A flat mapping to the existing "+1/+1 Counters" tag would be wrong for a
    // -1/-1 counter placement, which is a debuff/removal-adjacent effect, not the tribal
    // counters-matter archetype that tag means.
};

function generateTags(card, currentTags = []) {
    const text = (card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text).join(' ') : '')).toLowerCase();
    const type = (card.type_line || '').toLowerCase();
    const keywords = (card.keywords || []).map(k => k.toLowerCase());
    const tags = new Set();
    
    // Helper to check keywords array or text
    const hasKeyword = (kw) => keywords.includes(kw) || new RegExp(`\\b${kw}\\b`, 'i').test(text);

    // Some patterns use `.*` broadly enough to span past the end of one ability and into an
    // unrelated one on a multi-ability card - "whenever ... enters" matching because clause 1 has
    // "whenever" and an unrelated clause 2 happens to contain "enters" somewhere. Testing against
    // each sentence individually instead of the whole oracle-text blob at once closes that gap for
    // the patterns most exposed to it (review: tag system item 3). A plain sentence split (not the
    // full clause parser) is enough here - this only needs to stop `.*` from crossing a period, not
    // to structurally parse the ability.
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
    const matchesAnySentence = (regex) => sentences.some(s => regex.test(s));

    // --- KEYWORDS & SPEED ---

    if (hasKeyword('flash')) {
        tags.add("Flash");
    }

    if (hasKeyword('haste')) {
        tags.add("Haste");
    }

    if (hasKeyword('deathtouch')) {
        tags.add("Deathtouch");
    }

    // Ward
    if (hasKeyword('ward')) {
        tags.add("Ward");
    }

    // First Strike 
    if (hasKeyword('first strike')) {
        tags.add("First Strike");
    }

    // Double Strike
    if (hasKeyword('double strike')) {
        tags.add("Double Strike");
    }

    // Vigilance
    if (hasKeyword('vigilance')) {
        tags.add("Vigilance");
    }

    // Proliferate
    if (hasKeyword('proliferate') || /proliferate/i.test(text)) {
        tags.add("Proliferate");
    }

    // Connive
    if (hasKeyword('connive') || /connive \d+/i.test(text)) {
        tags.add("Connive");
    }

    // Incubate 
    if (hasKeyword('incubate') || /incubate \d+/i.test(text)) {
        tags.add("Incubate");
    }
    // Amass
    if (hasKeyword('amass') || /amass/i.test(text)) {
        tags.add("Amass");
    }

    // Ninjutsu
    if (hasKeyword('ninjutsu') || /ninjutsu/i.test(text)) {
        tags.add("Ninjutsu");
    }

    // Devotion
    if (/devotion to/i.test(text)) {
        tags.add("Devotion");
    }

    // Affinity
    if (hasKeyword('affinity') || /affinity for/i.test(text)) {
        tags.add("Affinity");
    }

    // Delirium
    if (hasKeyword('delirium') || /delirium/i.test(text)) {
        tags.add("Delirium");
    }

    // Threshold 
    if (hasKeyword('threshold') || /threshold/i.test(text)) {
        tags.add("Threshold");
    }

    // --- CARD ADVANTAGE & TUTORS ---

    // Draw
    if (/draws?|investigate|reveal the top .* put .* into your hand|look at the top .* put .* into your hand/.test(text)) {
        tags.add("Draw");
    }

    // Impulse Draw
    if (/exile the top .* card.* (you may|until) .* (play|cast)|exile .* card.* from top of your library.* you may (play|cast)/.test(text)) {
        tags.add("Impulse Draw");
    }

    // Tutor
    if (/search your library for a (card|creature|instant|sorcery|artifact|enchantment|planeswalker) card/i.test(text) && !/search your library for a (basic )?land/i.test(text)) {
        tags.add("Tutor");
    }

    // --- MANA & LANDS ---

    // Land Fetcher (Fetches land to hand, top of library, or exile)
    if (/search your library for a .* land card/i.test(text) && (!/onto the battlefield/i.test(text) || /(into your hand|onto your library|top of your library)/i.test(text))) {
        tags.add("Land Fetcher");
    }

    // Ramp (Mana acceleration / direct battlefield placement)
    if (
        /add \{|add .* mana|treasure token|powerstone token|gold token|eldrazi scion token|eldrazi spawn token/i.test(text) ||
        /search your library for .*land card.* put .* onto the battlefield/i.test(text) ||
        /put .* land card.* from .* onto the battlefield/i.test(text) ||
        /play (an|a|\d+)? additional land/i.test(text)
    ) {
        tags.add("Ramp");
    }

    // --- TOKENS & MULTIPLIERS ---

    // Token Generation - also tag roughly how many tokens per activation, since "create a 1/1"
    // and "create six 1/1s" are the same family but very different in degree (project spec F).
    if (/create (a|an|\d+|x|two|three|four) .* token|tokens? .* (are|is) created/.test(text)) {
        tags.add("Token");
        const singleToken = /create (a|an)\b/.test(text);
        const manyTokens = /create (\d+|two|three|four|five|six|x) .* tokens/.test(text);
        if (manyTokens && !singleToken) tags.add("Token:multiple");
        else if (singleToken) tags.add("Token:single");
    }

    // Token Doubler / Multiplier
    if (/if one or more tokens would be created|twice as many|twice that many|those tokens plus a .* token/.test(text)) {
        tags.add("Token Doubler");
    }

    // Counter Doubler / Multiplier
    if (/if one or more (\+1\/\+1| counters?) would be put|twice that many \+1\/\+1|twice that many counters|proliferate/.test(text)) {
        tags.add("Counter Doubler");
    }

    // --- OTHER ARTIFACT TOKENS ---
    if (/food token|clue token|blood token|map token/i.test(text)) {
        tags.add("Tokens (Artifact)");
    }

    // --- INTERACTION & CONTROL ---

    // Theft (Fixed: strictly targets control changes and stealing from opponents)
    if (/gain control of|you control target|cast .* (card|spell)s? (you don't own|an opponent owns)|(play|cast) .* (from|top of) (an opponent's|target opponent's)|control of target/.test(text)) {
        tags.add("Theft");
    }

    // Removal - also tag WHAT it removes (creature/permanent/player) and whether it's
    // conditional, since "destroy target creature" and "destroy target creature unless its
    // controller pays {2}" are not equally strong removal (project spec F/B: compositional tags,
    // outcome-aware matching).
    if (/destroy target|exile target|damage to target|destroy each creature chosen/.test(text)) {
        tags.add("Removal");
        const removalObject = /destroy target creature|exile target creature|damage to target creature/.test(text) ? 'creature'
            : /destroy target permanent|exile target permanent/.test(text) ? 'permanent'
            : /damage to target player|damage to any target/.test(text) ? 'any'
            : null;
        if (removalObject) tags.add(`Removal:${removalObject}`);
        if (/unless (its|that player's|their) controller pays/.test(text)) tags.add("Removal:conditional");
    }

    // Boardwipe
    if (/destroy all|exile all|damage to (each|all) creature/.test(text)) {
        tags.add("Boardwipe");
    }

    // Counterspell
    if (/counter target/.test(text)) {
        tags.add("Counterspell");
    }

    // Bounce
    if (/return target .* to its owner's hand/.test(text)) {
        tags.add("Bounce");
    }

    // Protection (Broadened for Teferi's Protection, Grand Abolisher, Phasing, Ward, Shroud, Damage Prevention, and Spell Safety)
    if (
        hasKeyword('hexproof') || 
        hasKeyword('indestructible') || 
        hasKeyword('ward') || 
        hasKeyword('shroud') || 
        hasKeyword('phasing') ||
        /protection (from|of)|phases? out|can't be countered|prevent all damage|prevent that damage/i.test(text) ||
        /opponents? can't cast spells|opponents? can't activate abilities|during your turn/i.test(text) ||
        /your life total can't change|you can't lose the game|you can't lose damage/i.test(text) ||
        /(gains?|have) (hexproof|indestructible|shroud|ward|protection)/i.test(text) ||
        /spells you control can't be targeted|permanents you control gain/i.test(text)
    ) {
        tags.add("Protection");
    }

    // Tax (Mana penalties, cost increases, and conditional payments)
    if (
        /costs? (\{\d+\}|\d+) more|whenever an opponent .* unless|unless (you|they|that player) pay/i.test(text)
    ) {
        tags.add("Tax");
    }

    // Stax (Resource denial, lockouts, forced sac, and hard restrictions)
    if (
        /opponents? can't|players? can't|can't cast more than|can't draw more than/i.test(text) ||
        /don't untap|can't untap|doesn't untap|skip (their|your)? (untap|draw|main) phase/i.test(text) ||
        /can't activate abilities|abilities of .* can't be activated/i.test(text) ||
        /can't search libraries|can't cast spells from/i.test(text) ||
        /each player sacrifices|whenever a .* enters .* sacrifice/i.test(text)
    ) {
        tags.add("Stax");
    }

    // Graveyard Hate
    if (/exile target card from a graveyard|exile all cards from all graveyards|exile all graveyards/.test(text)) {
        tags.add("Graveyard Hate");
    }

    // --- GRAVEYARD & RECURSION ---

    // Graveyard / Mill
    if (/into your graveyard|mill \d+/.test(text) || /\bmill(s|\d+)?\b/i.test(text) || /puts? the top .* card.* into (their|his or her) graveyard/i.test(text)) {
        tags.add("Graveyard");
    }

    // Recursion (Graveyard to hand)
    if (/return target .* from your graveyard to your hand|return .* card from your graveyard to your hand/.test(text)) {
        tags.add("Recursion");
    }

    // Reanimate (Graveyard to battlefield). Fixed a real regex bug: `your?` does NOT mean "the
    // word 'your' is optional" - in regex, `?` only applies to the single preceding character, so
    // `your?` matches "you" or "your" but still REQUIRES that literal "you" substring. Real cards
    // overwhelmingly phrase this as "from A graveyard" (Animate Dead, Reanimate itself) or "from
    // THEIR graveyard" (Exhume) rather than "from YOUR graveyard", so this regex was silently
    // failing on the most common real-world phrasing - confirmed on a live benchmark run where
    // Reanimate's own oracle text failed to produce this tag via this path (the canonical-function
    // reconciliation below happened to compensate for THIS specific case, but this regex is
    // independently wrong regardless and other complex cards may rely on it directly).
    if (/return target .* card from (?:a|your|their)? ?graveyard to the battlefield|put target .* card from (?:a|your|their)? ?graveyard onto the battlefield/.test(text)) {
        tags.add("Reanimate");
    }

    // Sac Outlet
    if (/sacrifice a (creature|permanent|artifact|land):/.test(text)) {
        tags.add("Sac Outlet");
    }

    // Aristocrats
    if (/whenever a creature dies|whenever another creature dies|whenever you sacrifice/.test(text)) {
        tags.add("Aristocrats");
    }

    // --- OTHER MECHANICS ---

    // Modal
    if (/choose one\b|choose two\b|choose three\b|spree\b/.test(text)) {
        tags.add("Modal");
    }

    // Scry
    if (hasKeyword('scry') || /scry \d+/i.test(text)) {
        tags.add("Scry");
    }

    // Surveil
    if (hasKeyword('surveil') || /surveil \d+/i.test(text)) {
        tags.add("Surveil");
    }

    // Blink / Flicker
    if (/exile target .* then return (it|that card) to the battlefield/.test(text)) {
        tags.add("Blink");
    }

    // Lifegain
    if (/gains? (\d+\s+)?life|lifelink/.test(text)) {
        tags.add("Lifegain");
    }

    // --- PARTNER & COMPANIONS ---

    // Partner / Partner with
    if (/partner\b/i.test(text)) {
        tags.add("Partner");
    }

    // Doctor's Companion
    if (/doctor's companion/i.test(text)) {
        tags.add("Doctor's Companion");
    }

    // Companion
    if (hasKeyword('companion') || (/\bcompanion\b/i.test(text) && !/doctor's companion/i.test(text))) {
        tags.add("Companion");
    }

    // --- COMBAT & MECHANICS ---

    // Anthem (Static continuous power/toughness boost to your team). Beyond the coarse label,
    // also add compositional sub-tags (which subtype, how broad the scope is, what magnitude) so
    // category scoring can reward two cards being the SAME kind of anthem - not just both being
    // "some anthem" (project spec F: richer compositional tags, function family + parameters).
    const anthemParams = parseAnthemEffect(text);
    if (anthemParams && anthemParams.action === "stat_buff") {
        tags.add("Anthem");
        if (anthemParams.subtype && anthemParams.subtype !== "all") {
            tags.add(`Anthem:${anthemParams.subtype}`);
        }
        tags.add(`Anthem:scope-${anthemParams.isOther ? 'other' : 'all'}`);
        if (anthemParams.powerToughness) {
            tags.add(`Anthem:${anthemParams.powerToughness}`);
        }
    }

    // Pump (Temporary or target power/toughness boosts)
    if (/gets? \+\d+\/\+\d+|get \+\d+\/\+\d+/i.test(text)) {
        tags.add("Pump");
    }

    // Untap
    if (/untap (target|all|each|another|permanent|creature|land)/i.test(text) || hasKeyword('untap')) {
        tags.add("Untap");
    }

    // Extra Combat
    if (/additional combat phase|extra combat phase|after this phase, there is an additional combat/i.test(text)) {
        tags.add("Extra Combat");
    }

    // Copy (Spell copying, creature copying, token copies)
    if (/copy target|create a token that's a copy|becomes a copy|copy of target|copy that spell|copy of it/i.test(text)) {
        tags.add("Copy");
    }

    // The Ring Tempts You
    if (/the ring tempts you/i.test(text)) {
        tags.add("The Ring Tempts You");
    }

    // Living Weapon
    if (hasKeyword('living weapon') || /living weapon/i.test(text)) {
        tags.add("Living Weapon");
    }

    // Equip Cheat
    if (/attach .* to target creature|equip cost.*\{0\}|equip \{0\}|pay \{0\} rather than pay.*equip|you may pay \{0\} rather than/i.test(text)) {
        tags.add("Equip Cheat");
    }

    // --- GAME ENDERS & FINISHERS ---

    // Finisher (Broad enough for game-ending swings, targeted direct wins, and massive X drains)
    if (
        /win the game|opponents? lose the game/i.test(text) ||
        /each opponent loses x life|target player loses x life/i.test(text) ||
        /for each creature you control, .* get \+x\/\+x/i.test(text) ||
        /creatures you control get \+\d+\/\+\d+ and gain (trample|infect)/i.test(text) ||
        /gain control of all creatures .* until end of turn/i.test(text)
    ) {
        tags.add("Finisher");
    }

    // --- ADDITIONAL POPULAR COMMUNITY TAGS ---

    // Extra Turn
    if (/take an extra turn/i.test(text)) {
        tags.add("Extra Turn");
    }

    // Wheel
    if (/each player discards (their|his or her) hand|discard your hand, then draw/i.test(text)) {
        tags.add("Wheel");
    }

    // Cost Reduction
    if (/spells you cast cost \{\d+\} less|costs? \{\d+\} less to cast/i.test(text)) {
        tags.add("Cost Reduction");
    }

    // Group Hug. "players may" alone was too loose (matches plenty of non-group-hug cards with an
    // optional-action clause naming "players" for an unrelated reason); requiring "each player"
    // specifically keeps the everyone-benefits shape the tag is meant to capture.
    if (/each player (draws|gains|searches|puts|may)/i.test(text) && !/opponents?/i.test(text)) {
        tags.add("Group Hug");
    }

    // Storm
    if (hasKeyword('storm') || /\bstorm\b/i.test(text)) {
        tags.add("Storm");
    }

    // Cascade
    if (hasKeyword('cascade') || /\bcascade\b/i.test(text)) {
        tags.add("Cascade");
    }

    // Cantrip (Instants and Sorceries that draw exactly 1 card)
    if (
        (type.includes('instant') || type.includes('sorcery')) && 
        /draw a card\b/i.test(text) && 
        !/draws? (\d+|two|three|four|x) cards/i.test(text)
    ) {
        tags.add("Cantrip");
    }

    // --- TREASURE & MANA ---

    // Treasure Generation
    if (/treasure token/i.test(text)) {
        tags.add("Treasure");
    }

    // --- COMBAT & EVASION ---

    // Evasion
    if (
        hasKeyword('flying') || 
        hasKeyword('trample') || 
        hasKeyword('menace') || 
        hasKeyword('shadow') || 
        hasKeyword('horsemanship') || 
        /can't be blocked/i.test(text)
    ) {
        tags.add("Evasion");
    }

    // Infect & Toxic
    if (hasKeyword('infect') || hasKeyword('toxic') || /poison counter/i.test(text)) {
        tags.add("Infect / Toxic");
    }

    // --- TRIGGERS & ETB ---

    // ETB (Enters). Per-sentence, not against the whole blob - `.*` here previously let clause 1's
    // "whenever" pair with clause 2's unrelated "enters" on a multi-ability card.
    if (matchesAnySentence(/when(ever)? .* enters/i)) {
        tags.add("ETB");
    }

    // Death Trigger / Dies. Same cross-clause risk as ETB above.
    if (matchesAnySentence(/when(ever)? .* dies/i)) {
        tags.add("Death Trigger");
    }

    /////
    // --- LANDFALL & TRIGGERS ---
    if (/whenever a land enters/i.test(text) || hasKeyword('landfall')) {
        tags.add("Landfall");
    }

    if (/whenever you cast or copy an instant or sorcery|magecraft/i.test(text)) {
        tags.add("Spellslinger");
    }

    // --- MECHANICS & KEYWORDS ---
    if (hasKeyword('discover') || /\bdiscover \d+\b/i.test(text)) {
        tags.add("Discover");
    }

    if (hasKeyword('flashback') || hasKeyword('escape') || hasKeyword('unearth') || hasKeyword('encore') || hasKeyword('jump-start') || hasKeyword('disturb')) {
        tags.add("Graveyard Cast");
    }

    if (hasKeyword('crew') || type.includes('vehicle')) {
        tags.add("Vehicle");
    }

    if (hasKeyword('fight') || /deals damage equal to its power to target/i.test(text)) {
        tags.add("Fight");
    }

    // --- GAME STATE & EMBLEMS ---
    if (/you become the monarch/i.test(text)) {
        tags.add("Monarch");
    }

    if (/take the initiative|into the dungeon/i.test(text)) {
        tags.add("Dungeon / Initiative");
    }

    // --- DRAIN & X SPELLS ---
    if (/each opponent loses .* and you gain/i.test(text) || hasKeyword('extort')) {
        tags.add("Drain");
    }

    if (/\{x\}/i.test(card.mana_cost || '') || /\{x\}/i.test(text)) {
        tags.add("X Spells");
    }

    // --- BURN & DAMAGE MULTIPLIERS ---

    // Burn (Direct damage)
    if (/deals? (\d+|x) damage to (any target|target (player|opponent|creature|planeswalker)|each opponent|each player)/i.test(text)) {
        tags.add("Burn");
    }

    // Burn Doubler / Damage Multiplier
    if (/if a .* source would deal damage|deals double that damage|deals triple that damage|deals that much damage plus \d+/i.test(text)) {
        tags.add("Damage Multiplier");
    }

    // --- MANA & CHEATING ---

    // Mana Doubler
    if (/whenever a (land|permanent) is tapped for mana, add|adds (twice|three times) as much|it produces (twice|three times) that much|adds that much mana of any/i.test(text)) {
        tags.add("Mana Doubler");
    }

    // Free Cast / Mana Cheat
    if (/without paying its mana cost|cast it without paying/i.test(text)) {
        tags.add("Free Cast");
    }

    // --- DISCARD & FORCED COMBAT ---

    // Discard (Hand Disruption & Self-Discard)
    if (/discards? (\d+|a|an|x|two|three|four|their|your|that|all) card|discard your hand|discard a card/i.test(text)) {
        tags.add("Discard");
    }

    // Goad & Forced Combat
    if (hasKeyword('goad') || /goads? target|attacks (each|this) combat if able|attacks each turn if able/i.test(text)) {
        tags.add("Goad");
    }

    // --- CARD TYPES & SUPERTYPES ---

    // Sagas & Battles
    if (type.includes('saga')) {
        tags.add("Saga");
    }

    if (type.includes('battle')){
        tags.add("Battle");
    }

    // Planeswalker Synergies / Superfriends
    if (type.includes('planeswalker') || /loyalty counter|planeswalker/i.test(text)) {
        tags.add("Planeswalker");
    }

    // --- POLYMORPH & REPLACEMENT ---

    // Polymorph (Destroying/exiling/sacrificing/shuffling a permanent to reveal top cards into a replacement)
    if (
        /(reveal|exile|look at)s? cards from (the )?top of (your|their|a player's|his or her) library until/i.test(text) ||
        /(destroy|exile|sacrifice|shuffle|put) .* (reveals?|exiles?) cards from (the )?top of (their|your|a player's) library/i.test(text)
    ) {
        tags.add("Polymorph");
    }

    // Looting (Draw first, then discard)
    if (/draws? .* then discards?/i.test(text)) {
        tags.add("Looting");
    }

    // Rummaging (Discard first, then draw)
    if (/discards? .* then draws?/i.test(text)) {
        tags.add("Rummaging");
    }

    // Enchantress (Draw/triggers on playing or entering enchantments)
    if (/whenever you cast an enchantment spell|whenever an enchantment enters/i.test(text)) {
        tags.add("Enchantress");
    }

    // Pod / Birthing Pod (Sacrifice a permanent to search and put onto the battlefield)
    if (/sacrifice a (creature|permanent).*,? search your library for a .* card .* onto the battlefield/i.test(text)) {
        tags.add("Pod");
    }

    // Group Slug (Punishing players/opponents for standard game actions)
    if (/whenever an opponent (casts|draws|taps|plays)|whenever a land is tapped for mana, .* deals/i.test(text)) {
        tags.add("Group Slug");
    }

    // --- POLITICS & DEALS ---
    // Tightened: "if another player" and "target opponent draws" were broad enough to fire on
    // plenty of cards with nothing to do with multiplayer politics (any conditional referencing
    // another player, or a symmetrical draw effect, tripped them). "each opponent may" was
    // dropped too - that's usually an Edict-style optional sacrifice/discard, not a political deal
    // (review: tag system item 4).
    if (
        hasKeyword('assist') ||
        hasKeyword('gift') ||
        hasKeyword('friend or foe') ||
        hasKeyword('secret council') ||
        hasKeyword('council\'s dilemma') ||
        hasKeyword('will of the council') ||
        hasKeyword('tempting offer') ||
        hasKeyword('join forces') ||
        hasKeyword('parley') ||
        /vote|votes|voting|voted|villainous choice|tempting offer|tempt with|join forces|parley/i.test(text) ||
        /starting with (you|the next opponent|an opponent)|each player chooses|choose a (second|third|another) player|an opponent chooses/i.test(text) ||
        /target opponent gains control|an opponent gains control|you and that player each/i.test(text) ||
        /any player may activate|each mode must target a different player|attacks a player other than/i.test(text)
    ) {
        tags.add("Politics");
    }

    // --- POPULAR COMMUNITY TAGS ---

    // +1/+1 Counters
    if (/\+1\/\+1 counter/i.test(text) || hasKeyword('proliferate') || hasKeyword('adapt') || hasKeyword('evolve') || hasKeyword('graft')) {
        tags.add("+1/+1 Counters");
    }

    // Pillowfort (Deterring attacks against you)
    if (/can't attack you|attack you or planeswalkers you control unless|whenever a creature attacks you|for each creature attacking you/i.test(text)) {
        tags.add("Pillowfort");
    }

    // Equipment & Auras (Voltron support)
    if (type.includes('equipment') || type.includes('aura') || /equipped creature|enchanted creature|attach target (equipment|aura)/i.test(text)) {
        tags.add("Equipment / Auras");
    }

    // Chaos & Coin Flips
    if (/flip .* coin|flips? a coin|at random|chaos ensues/i.test(text)) {
        tags.add("Chaos");
    }

    // Generic keyword coverage: Magic has 100+ official keyword abilities and ships new ones
    // every set (Convoke, Delve, Kicker, Riot, Mentor, Exert, Bestow, Outlast, Rebound, Suspend,
    // Splice, Overload, Buyback, Madness, Miracle, Blitz, Backup, Offspring, Plot, Bargain,
    // Freerunning...). Hand-writing an `if (hasKeyword('x'))` line per keyword above means any
    // keyword nobody explicitly checked for gets zero tag, and that list is stale the day a new
    // set ships. Read Scryfall's own `keywords` array directly instead - every keyword ability the
    // card actually has becomes a tag with no per-keyword code needed, so coverage is
    // self-updating (review: tag system item 1). This is purely additive: title-cased to match
    // the existing named tags' style, so a keyword already handled above (e.g. "flying" ->
    // "Flying") lands on the exact same tag string and the Set simply dedupes it - it never
    // creates a same-keyword-different-casing near-duplicate.
    (card.keywords || []).forEach(kw => {
        if (kw) tags.add(toTitleCase(kw));
    });

    // Retain custom tags matching text or type line. Word-boundary matched, not a raw substring
    // check - a custom tag like "war" previously matched "reward," "warrior," and "toward" since
    // `text.includes(tag)` has no concept of word edges (review: tag system item 6).
    currentTags.forEach(ut => {
        const utLower = ut.toLowerCase();
        const wordBoundaryRegex = new RegExp(`\\b${utLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (wordBoundaryRegex.test(text) || wordBoundaryRegex.test(type)) {
            tags.add(ut);
        }
    });

    // --- FUNCTION-DERIVED TAGS (canonical, wording-independent) ---
    // Every tag above is regex/keyword-matched against literal Oracle wording - exactly as
    // brittle to rewording as the rest of the engine is designed NOT to be. The rule parser
    // already derives a canonical function (reanimate, removal, counter, direct_damage...) for
    // scoring, so cards that read nothing alike but do the same thing can share this signal even
    // when neither side's literal wording tripped a regex above.
    //
    // This used to just dump `cf.function.replace(/_/g,' ')` in as a fresh lowercase tag - which
    // meant a card whose text matched, say, the "Reanimate" regex above got BOTH "Reanimate" (from
    // the regex) AND "reanimate" (from this layer) as two separate, case-distinct Set entries:
    // visible clutter in the UI, double-counted weight in category scoring, and no actual
    // reconciliation between the parser's and the regex's independent judgments - exactly the
    // "two competing implementations that can quietly disagree, with nothing surfacing it" problem
    // (review: tag system item 2). CANONICAL_FUNCTION_TAG_NAMES below maps every canonical
    // function to the SAME tag name its hand-written regex counterpart already uses, so the two
    // signals land on one Set entry - which also means a card the regex missed but the parser
    // caught now correctly gets that tag (recall improves), and a function with no hand-tag
    // counterpart still gets a sensible, properly-cased fallback name instead of a bare
    // underscore-stripped function identifier.
    const rawTextForParsing = card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text).join(' ') : '');
    const parsedForTags = card._parsedEffects || (rawTextForParsing ? parseMTGEffect(rawTextForParsing) : null);
    // Tag derivation deliberately excludes isSecondaryAtom/isCostEffect entries: those come from
    // extractClauseAtoms re-scanning from each verb's raw text position rather than the clause's
    // own full context (built for multi-effect scoring, not tagging), and can mis-derive a
    // canonical function - e.g. "search for a land, put it onto the battlefield tapped" produced
    // a spurious "cheat_into_play" atom from the word "put" in isolation, on a card that's really
    // just Ramp. The clause-level parse (the effect the sub-parser chain actually matched for that
    // whole clause) is a stable enough signal for a tag; the secondary/cost atoms are not.
    const canonicalFns = getCanonicalFunctions((parsedForTags || []).filter(e => !e.isSecondaryAtom && !e.isCostEffect));

    canonicalFns.forEach(cf => {
        const mappedName = CANONICAL_FUNCTION_TAG_NAMES[cf.function];
        // ramp_tutor and place_counter are both fully handled by the compositional block below
        // (Ramp vs. Land Fetcher depends on destination; +1/+1 vs -1/-1 Counters depends on
        // counterType), so both deliberately have no flat mapping and must not also fall through
        // to a generic "Ramp Tutor"/"Place Counter" tag here.
        if (mappedName) {
            addTagCaseInsensitive(tags, mappedName);
        } else if (cf.function !== 'ramp_tutor' && cf.function !== 'place_counter') {
            addTagCaseInsensitive(tags, toTitleCase(cf.function.replace(/_/g, ' ')));
        }

        // Compositional sub-tags derived straight from the canonical function's own params,
        // extending the same pattern already used for Anthem/Token/Removal to two more families
        // now that the damage and mana parsers exist to support them (review: tag system item 5).
        if (cf.function === 'removal' || cf.function === 'exile_removal' || cf.function === 'direct_damage') {
            const method = cf.function === 'exile_removal' ? 'exile' : cf.function === 'direct_damage' ? 'damage' : 'destroy';
            tags.add(`Removal:${method}`);
            const p = cf.params || {};
            if (p.target === 'all' || p.target === 'each') {
                addTagCaseInsensitive(tags, 'Boardwipe');
            }
        }
        if (cf.function === 'mana_ability') {
            const rampMethod = type.includes('creature') ? 'dork'
                : type.includes('artifact') ? 'rock'
                : (type.includes('instant') || type.includes('sorcery')) ? 'ritual'
                : null;
            addTagCaseInsensitive(tags, 'Ramp');
            if (rampMethod) tags.add(`Ramp:${rampMethod}`);
        }
        if (cf.function === 'ramp_tutor') {
            // A land tutor that lands on the battlefield is ramp (extra mana this turn); one that
            // goes to hand/library/exile is card selection for a land drop later, not
            // acceleration - the existing hand-written tags already draw exactly this line, so
            // the canonical-function path respects it too instead of collapsing both into one tag.
            if ((cf.params || {}).to === 'battlefield') {
                addTagCaseInsensitive(tags, 'Ramp');
                tags.add('Ramp:land');
            } else {
                addTagCaseInsensitive(tags, 'Land Fetcher');
            }
        }
        if (cf.function === 'place_counter') {
            // "+1/+1 Counters" already exists as a hand tag for the counters-matter archetype -
            // reused here for the +1/+1 case specifically. A -1/-1 counter is a debuff/removal-
            // adjacent effect (closer in spirit to a pump-down or -X/-X effect than to the
            // tribal counters archetype), so it gets its own distinct tag rather than being
            // folded into the same one.
            const magnitude = (cf.params || {}).magnitude || '';
            addTagCaseInsensitive(tags, magnitude.includes('-1/-1') ? '-1/-1 Counters' : '+1/+1 Counters');
        }
    });

    return Array.from(tags);
}

function renderTags() {
    const container = document.getElementById('card-tags-list');
    container.innerHTML = '';
    activeTags.forEach(tag => {
        const chip = document.createElement('div');
        chip.className = 'card-chip';

        const label = document.createElement('span');
        label.textContent = tag;

        const removeBtn = document.createElement('span');
        removeBtn.className = 'card-chip-remove';
        removeBtn.textContent = '\u00D7';
        removeBtn.addEventListener('click', () => removeTag(tag));

        chip.appendChild(label);
        chip.appendChild(removeBtn);
        container.appendChild(chip);
    });
}

function removeTag(tagToRemove) {
    activeTags = activeTags.filter(tag => tag.toLowerCase() !== tagToRemove.toLowerCase());
    renderTags();
}

/**
 * Re-wraps every currently-active highlight in the oracle text display, starting from the
 * untouched original HTML (sourceCardOracle.dataset.originalHtml) each time rather than the
 * currently-displayed (already-wrapped) HTML - otherwise removing or re-adding one highlight
 * while others are active would compound stale <strong> wrappers instead of cleanly reflecting
 * the current set.
 *
 * Match positions for every highlight are found against the SAME untouched original text (not
 * against a string other highlights have already wrapped), and overlapping ranges are resolved
 * by claiming longest-highlight-text matches first, before any wrapping happens. Wrapping is
 * done in a single final pass over the resolved ranges. This matters because the previous
 * implementation applied one highlight's regex, then ran the next highlight's regex against the
 * RESULT (now containing that first highlight's <strong> tag) - if two highlights' text
 * overlapped or sat adjacent to each other, the inserted tag could break the plain-text run the
 * next regex needed to match, silently failing to re-apply it or matching an unintended
 * occurrence elsewhere in the text instead.
 */
function escapeHtmlText(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function reapplyOracleHighlights() {
    if (!sourceCardOracle) return;

    // Highlight offsets are text offsets, not HTML offsets.  Reconstructing markup by slicing
    // innerHTML is incorrect for characters that are represented as entities (&, <, >, etc.),
    // and it also used to ignore a highlight's recorded start/end position and highlight every
    // occurrence of the same phrase.  Keep one canonical plain-text representation instead.
    const originalText = sourceCardOracle.dataset.originalText ?? sourceCardOracle.textContent ?? '';
    const ranges = [];

    for (const h of manualHighlights) {
        if (!h || !h.text) continue;

        // User-authored additions are search-intent tags, not selections from the source
        // Oracle text. They must participate in search/scoring, but should never be rendered as
        // if the same words had been highlighted on the source card.
        if (h.origin === 'user') continue;

        let start = Number.isFinite(h.start) ? h.start : -1;
        let end = Number.isFinite(h.end) ? h.end : -1;

        // Backward-compatible fallback for older highlight objects that did not retain offsets.
        if (start < 0 || end <= start || originalText.slice(start, end).toLowerCase() !== h.text.toLowerCase()) {
            const fallback = originalText.toLowerCase().indexOf(h.text.toLowerCase());
            if (fallback < 0) continue;
            start = fallback;
            end = fallback + h.text.length;
        }

        start = Math.max(0, Math.min(start, originalText.length));
        end = Math.max(start, Math.min(end, originalText.length));
        if (end > start) ranges.push({ start, end, mode: h.mode });
    }

    // Resolve overlaps deterministically.  A user selection's stored position wins; when two
    // highlights overlap, prefer the longer range, then the earlier range in the source text.
    ranges.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const claimed = [];
    for (const range of ranges) {
        if (claimed.some(r => range.start < r.end && range.end > r.start)) continue;
        claimed.push(range);
    }
    claimed.sort((a, b) => a.start - b.start);

    let html = '';
    let cursor = 0;
    for (const range of claimed) {
        html += escapeHtmlText(originalText.slice(cursor, range.start));
        const modeClass = range.mode === 'variable' ? 'highlight-variable' : 'highlight-exact';
        html += `<strong class="highlight-active ${modeClass}">${escapeHtmlText(originalText.slice(range.start, range.end))}</strong>`;
        cursor = range.end;
    }
    html += escapeHtmlText(originalText.slice(cursor));
    sourceCardOracle.innerHTML = html;
}

/**
 * Captures a completed Oracle-text selection and records its exact text offsets so the same
 * occurrence can be re-rendered without accidentally highlighting every matching phrase.
 */
function handleOracleTextSelection() {
    if (!sourceCardOracle) return;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const commonAncestor = range.commonAncestorContainer;
    if (!sourceCardOracle.contains(commonAncestor)) return;

    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    if (!sourceCardOracle.dataset.originalText) {
        sourceCardOracle.dataset.originalText = sourceCardOracle.textContent || '';
        sourceCardOracle.dataset.originalHtml = sourceCardOracle.innerHTML;
    }

    const offsets = normalizeHighlightSelectionOffsets(sourceCardOracle, range);
    const trimmedSelection = offsets
        ? trimHighlightRangeText(selectedText, offsets.start, offsets.end)
        : { text: selectedText, start: null, end: null };

    if (!trimmedSelection.text) return;

    // The same phrase may legitimately be highlighted more than once. Treat an identical
    // phrase at a different source-text position as a distinct selection.
    const alreadyHighlighted = manualHighlights.some(h =>
        h.text.toLowerCase() === trimmedSelection.text.toLowerCase() &&
        Number.isFinite(h.start) && Number.isFinite(trimmedSelection.start) &&
        h.start === trimmedSelection.start && h.end === trimmedSelection.end
    );

    if (!alreadyHighlighted) {
        manualHighlights.push({
            text: trimmedSelection.text,
            mode: 'exact',
            origin: 'source',
            start: trimmedSelection.start,
            end: trimmedSelection.end,
            attachedTo: null
        });
        reapplyOracleHighlights();
        renderHighlightChips();
    }

    selection.removeAllRanges();
}

/**
 * Renders the highlight chip list beneath the oracle text - one chip per active highlight, each
 * with a mode-toggle button (exact/required vs. variable/flexible) and a remove button, mirroring
 * the existing tag-chip pattern (renderTags/removeTag above).
 */
function findHighlightRangeInSource(text, preferredStart = null) {
    const sourceText = getCurrentSourceOracleText();
    const needle = String(text || '').trim();
    if (!sourceText || !needle) return null;
    const hay = sourceText.toLowerCase();
    const lowNeedle = needle.toLowerCase();
    const matches = [];
    let from = 0;
    while (from < hay.length) {
        const idx = hay.indexOf(lowNeedle, from);
        if (idx < 0) break;
        matches.push({ start: idx, end: idx + needle.length });
        from = idx + Math.max(1, needle.length);
    }
    if (!matches.length) return null;
    if (!Number.isFinite(preferredStart)) return matches[0];
    return matches.reduce((best, item) =>
        Math.abs(item.start - preferredStart) < Math.abs(best.start - preferredStart) ? item : best,
        matches[0]
    );
}

function highlightParentOptions(excludeIndex = null) {
    return manualHighlights
        .map((h, idx) => ({ h, idx }))
        .filter(({ h, idx }) => idx !== excludeIndex && h && h.origin !== 'user' && typeof h.text === 'string' && h.text.trim());
}

function getHighlightParentLabel(index) {
    const parent = manualHighlights[index];
    if (!parent) return 'Independent';
    const text = String(parent.text || '').trim();
    return text.length > 34 ? text.slice(0, 31) + '\u2026' : text;
}

function renderHighlightEditor(idx) {
    if (highlightEditIndex !== idx || !manualHighlights[idx]) return null;
    const h = manualHighlights[idx];
    const editor = document.createElement('div');
    editor.className = 'highlight-edit-composer';
    editor.setAttribute('role', 'group');
    editor.setAttribute('aria-label', 'Edit highlighted search detail');

    const title = document.createElement('div');
    title.className = 'highlight-edit-title';
    title.textContent = h.origin === 'user' ? 'Edit search detail' : 'Edit highlight';

    const textLabel = document.createElement('label');
    textLabel.className = 'highlight-edit-label';
    textLabel.textContent = h.origin === 'user' ? 'Search detail' : 'Highlighted text';

    const input = document.createElement('textarea');
    input.className = 'highlight-edit-input';
    input.rows = 2;
    input.maxLength = 300;
    input.value = String(h.text || '');
    input.setAttribute('aria-label', textLabel.textContent);

    const modeRow = document.createElement('div');
    modeRow.className = 'highlight-edit-row';
    const modeLabel = document.createElement('span');
    modeLabel.className = 'highlight-edit-label-inline';
    modeLabel.textContent = 'Match:';
    modeRow.appendChild(modeLabel);

    let selectedMode = h.mode === 'variable' ? 'variable' : 'exact';
    const makeModeButton = (mode, label, titleText) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `highlight-composer-mode ${mode === selectedMode ? 'selected' : ''}`;
        btn.textContent = label;
        btn.title = titleText;
        btn.addEventListener('click', () => {
            selectedMode = mode;
            modeRow.querySelectorAll('.highlight-composer-mode').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
        return btn;
    };
    modeRow.appendChild(makeModeButton('variable', '\u2248 Flexible', 'Match the underlying mechanic/intent; values and wording may differ.'));
    modeRow.appendChild(makeModeButton('exact', '= Exact', 'Require the text/value to occur literally in a matching card.'));

    const connectRow = document.createElement('div');
    connectRow.className = 'highlight-edit-row';
    const connectLabel = document.createElement('label');
    connectLabel.className = 'highlight-edit-label-inline';
    connectLabel.textContent = 'Connected to:';
    const connectSelect = document.createElement('select');
    connectSelect.className = 'highlight-edit-select';
    connectSelect.setAttribute('aria-label', 'Connect this search detail to a highlight');

    const independent = document.createElement('option');
    independent.value = '';
    independent.textContent = 'Independent';
    connectSelect.appendChild(independent);
    highlightParentOptions(idx).forEach(({ h: parent, idx: parentIdx }) => {
        const option = document.createElement('option');
        option.value = String(parentIdx);
        option.textContent = getHighlightParentLabel(parentIdx);
        connectSelect.appendChild(option);
    });
    if (Number.isInteger(h.attachedTo) && manualHighlights[h.attachedTo]) {
        connectSelect.value = String(h.attachedTo);
    } else {
        connectSelect.value = '';
    }
    connectLabel.htmlFor = `highlight-edit-connect-${idx}`;
    connectSelect.id = connectLabel.htmlFor;
    connectRow.appendChild(connectLabel);
    connectRow.appendChild(connectSelect);

    const help = document.createElement('div');
    help.className = 'highlight-edit-help';
    help.textContent = h.origin === 'user'
        ? 'Connected details become part of the same search intent without pretending the wording exists on the source card.'
        : 'Changing this to text that exists on the source card moves the visual highlight. New wording becomes a search-only detail.';

    const actions = document.createElement('div');
    actions.className = 'highlight-add-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'highlight-add-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
        highlightEditIndex = null;
        renderHighlightChips();
    });

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'highlight-add-submit';
    save.textContent = 'Save';

    const commit = () => {
        const nextText = input.value.trim();
        if (!nextText) {
            input.focus();
            return;
        }
        const target = manualHighlights[idx];
        if (!target) return;
        const parentValue = connectSelect.value;
        const nextAttachedTo = /^\d+$/.test(parentValue) ? Number(parentValue) : null;

        const textChanged = nextText.toLowerCase() !== String(target.text || '').trim().toLowerCase();
        target.text = nextText;
        target.mode = selectedMode;
        target.attachedTo = Number.isInteger(nextAttachedTo) && nextAttachedTo !== idx ? nextAttachedTo : null;

        // Keep source-backed highlights visually anchored to a real occurrence. If the user
        // intentionally edits one into new wording, convert it to a search-only detail rather than
        // rendering a fake highlight that does not exist on the card.
        if (target.origin !== 'user' && (textChanged || !Number.isFinite(target.start) || !Number.isFinite(target.end))) {
            const found = findHighlightRangeInSource(nextText, target.start);
            if (found) {
                target.start = found.start;
                target.end = found.end;
                target.origin = target.origin === 'benchmark' ? 'benchmark' : 'source';
            } else {
                target.start = null;
                target.end = null;
                target.origin = 'user';
            }
        }

        highlightEditIndex = null;
        reapplyOracleHighlights();
        renderHighlightChips();
    };
    save.addEventListener('click', commit);
    input.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            commit();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            highlightEditIndex = null;
            renderHighlightChips();
        }
    });

    actions.appendChild(cancel);
    actions.appendChild(save);
    editor.appendChild(title);
    editor.appendChild(textLabel);
    editor.appendChild(input);
    editor.appendChild(modeRow);
    editor.appendChild(connectRow);
    editor.appendChild(help);
    editor.appendChild(actions);
    return editor;
}

function renderHighlightChips() {
    const container = document.getElementById('highlight-chips-list');
    if (!container) return;
    container.innerHTML = '';

    const chipsRow = document.createElement('div');
    chipsRow.className = 'highlight-chips-row';

    manualHighlights.forEach((h, idx) => {
        const chip = document.createElement('div');
        chip.className = `card-chip highlight-chip ${h.origin === 'user' ? 'highlight-user-chip' : 'highlight-source-chip'} ${Number.isInteger(h.attachedTo) ? 'highlight-linked-chip' : ''}`;

        if (Number.isInteger(h.attachedTo) && manualHighlights[h.attachedTo]) {
            const linked = document.createElement('span');
            linked.className = 'highlight-linked-marker';
            linked.textContent = '\u21b3';
            linked.title = `Connected to: ${manualHighlights[h.attachedTo].text || 'highlight'}`;
            chip.appendChild(linked);
        }

        const origin = document.createElement('span');
        origin.className = 'highlight-origin-label';
        origin.textContent = h.origin === 'user' ? '+' : 'Highlight';
        origin.title = h.origin === 'user'
            ? (Number.isInteger(h.attachedTo) ? `User-added search detail connected to: ${getHighlightParentLabel(h.attachedTo)}` : 'Independent user-added search detail')
            : 'Selected from this card\'s Oracle text';

        const modeBtn = document.createElement('button');
        modeBtn.type = 'button';
        modeBtn.className = `highlight-mode-btn ${h.mode === 'variable' ? 'mode-variable' : 'mode-exact'}`;
        modeBtn.textContent = h.mode === 'variable' ? '\u2248 Flexible' : '= Exact';
        modeBtn.title = h.mode === 'variable'
            ? 'Flexible: wording/value can differ while the underlying intent should remain similar. Click to require exact text instead.'
            : 'Exact: the matching card must contain this text/value. Click to make it flexible instead.';
        modeBtn.addEventListener('click', () => toggleHighlightMode(idx));

        const label = document.createElement('span');
        label.className = 'highlight-chip-text';
        label.textContent = h.text.length > 55 ? h.text.slice(0, 52) + '\u2026' : h.text;
        label.title = h.text;

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'highlight-edit-btn';
        editBtn.textContent = 'Edit';
        editBtn.title = 'Edit text, match mode, or connection';
        editBtn.setAttribute('aria-label', `Edit ${h.text}`);
        editBtn.addEventListener('click', () => {
            highlightEditIndex = highlightEditIndex === idx ? null : idx;
            highlightComposerOpen = false;
            renderHighlightChips();
            if (highlightEditIndex === idx) {
                requestAnimationFrame(() => document.querySelector('.highlight-edit-input')?.focus());
            }
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'card-chip-remove highlight-remove-btn';
        removeBtn.textContent = '\u00D7';
        removeBtn.title = 'Remove this highlight/search detail';
        removeBtn.setAttribute('aria-label', `Remove ${h.text}`);
        removeBtn.addEventListener('click', () => removeHighlight(idx));

        chip.appendChild(origin);
        chip.appendChild(modeBtn);
        chip.appendChild(label);
        chip.appendChild(editBtn);
        chip.appendChild(removeBtn);
        chipsRow.appendChild(chip);

        const editor = renderHighlightEditor(idx);
        if (editor) container.appendChild(editor);
    });

    container.appendChild(chipsRow);

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'highlight-add-btn';
    addButton.textContent = '+';
    addButton.title = 'Add another search detail';
    addButton.setAttribute('aria-label', 'Add another highlighted-text search detail');
    addButton.setAttribute('aria-expanded', highlightComposerOpen ? 'true' : 'false');
    addButton.addEventListener('click', () => {
        highlightComposerOpen = !highlightComposerOpen;
        highlightEditIndex = null;
        renderHighlightChips();
        if (highlightComposerOpen) {
            requestAnimationFrame(() => document.getElementById('highlight-add-text')?.focus());
        }
    });
    container.appendChild(addButton);

    if (highlightComposerOpen) {
        const composer = document.createElement('div');
        composer.className = 'highlight-add-composer';
        composer.setAttribute('role', 'group');
        composer.setAttribute('aria-label', 'Add search detail');

        const label = document.createElement('label');
        label.className = 'highlight-add-label';
        label.htmlFor = 'highlight-add-text';
        label.textContent = 'Add a search detail';

        const input = document.createElement('textarea');
        input.id = 'highlight-add-text';
        input.className = 'highlight-add-input';
        input.rows = 2;
        input.placeholder = 'e.g. produces 3 colorless mana, can target creatures, costs 2 or less';
        input.maxLength = 300;
        input.setAttribute('aria-label', 'Search detail');

        const modeRow = document.createElement('div');
        modeRow.className = 'highlight-add-mode-row';
        const modeLabel = document.createElement('span');
        modeLabel.className = 'highlight-add-mode-label';
        modeLabel.textContent = 'Match:';
        modeRow.appendChild(modeLabel);

        let selectedMode = 'variable';
        const makeModeButton = (mode, text, title) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `highlight-composer-mode ${mode === selectedMode ? 'selected' : ''}`;
            btn.textContent = text;
            btn.title = title;
            btn.addEventListener('click', () => {
                selectedMode = mode;
                modeRow.querySelectorAll('.highlight-composer-mode').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
            });
            return btn;
        };
        modeRow.appendChild(makeModeButton('variable', '\u2248 Flexible', 'Match the underlying meaning/mechanics; wording and exact values may differ.'));
        modeRow.appendChild(makeModeButton('exact', '= Exact', 'Require the added wording/value to occur in the candidate Oracle text.'));

        const connectRow = document.createElement('div');
        connectRow.className = 'highlight-add-connection-row';
        const connectLabel = document.createElement('label');
        connectLabel.className = 'highlight-add-mode-label';
        connectLabel.textContent = 'Connect to:';
        const connectSelect = document.createElement('select');
        connectSelect.className = 'highlight-edit-select';
        connectSelect.setAttribute('aria-label', 'Connect added search detail to a highlight');
        const independent = document.createElement('option');
        independent.value = '';
        independent.textContent = 'Independent';
        connectSelect.appendChild(independent);
        const parents = highlightParentOptions(null);
        parents.forEach(({ idx }) => {
            const option = document.createElement('option');
            option.value = String(idx);
            option.textContent = getHighlightParentLabel(idx);
            connectSelect.appendChild(option);
        });
        connectRow.appendChild(connectLabel);
        connectRow.appendChild(connectSelect);

        const help = document.createElement('div');
        help.className = 'highlight-add-help';
        help.textContent = 'Connect a search-only detail to a highlighted Oracle effect when it describes a property of that effect rather than a separate requirement.';

        const actionRow = document.createElement('div');
        actionRow.className = 'highlight-add-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'highlight-add-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            highlightComposerOpen = false;
            renderHighlightChips();
        });

        const addTagBtn = document.createElement('button');
        addTagBtn.type = 'button';
        addTagBtn.className = 'highlight-add-submit';
        addTagBtn.textContent = 'Add';

        const submit = () => {
            const text = input.value.trim();
            if (!text) return;
            const duplicate = manualHighlights.some(h =>
                h.origin === 'user' && h.text.trim().toLowerCase() === text.toLowerCase() &&
                h.mode === selectedMode && h.attachedTo === (connectSelect.value === '' ? null : Number(connectSelect.value))
            );
            if (!duplicate) {
                manualHighlights.push({
                    text,
                    mode: selectedMode,
                    origin: 'user',
                    start: null,
                    end: null,
                    attachedTo: /^\d+$/.test(connectSelect.value) ? Number(connectSelect.value) : null
                });
            }
            input.value = '';
            highlightComposerOpen = false;
            renderHighlightChips();
        };
        addTagBtn.addEventListener('click', submit);
        input.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                highlightComposerOpen = false;
                renderHighlightChips();
            }
        });

        actionRow.appendChild(cancelBtn);
        actionRow.appendChild(addTagBtn);
        composer.appendChild(label);
        composer.appendChild(input);
        composer.appendChild(modeRow);
        composer.appendChild(connectRow);
        composer.appendChild(help);
        composer.appendChild(actionRow);
        container.appendChild(composer);
    }
}

function toggleHighlightMode(idx) {
    if (!manualHighlights[idx]) return;
    manualHighlights[idx].mode = manualHighlights[idx].mode === 'variable' ? 'exact' : 'variable';
    renderHighlightChips();
    reapplyOracleHighlights();
}

function removeHighlight(idx) {
    manualHighlights.splice(idx, 1);
    // Keep explicit connection references valid after a removal. A child attached to the removed
    // highlight becomes independent; references after the removed index shift down by one.
    manualHighlights.forEach(h => {
        if (!Number.isInteger(h.attachedTo)) return;
        if (h.attachedTo === idx) h.attachedTo = null;
        else if (h.attachedTo > idx) h.attachedTo -= 1;
    });
    if (highlightEditIndex === idx) highlightEditIndex = null;
    else if (Number.isInteger(highlightEditIndex) && highlightEditIndex > idx) highlightEditIndex -= 1;
    renderHighlightChips();
    reapplyOracleHighlights();
}

// Configurable tag weights (Primary: 1.0, Secondary: 0.5, Broad Category: 0.2, Default fallback: 0.5)
const TAG_WEIGHTS = {
    // --- PRIMARY MECHANICS (1.0) ---
    "reanimate": 1.0,
    "tutor": 1.0,
    "counterspell": 1.0,
    "boardwipe": 1.0,
    "extra turn": 1.0,
    "storm": 1.0,
    "cascade": 1.0,
    "polymorph": 1.0,
    "pod": 1.0,
    "stax": 1.0,
    "wheel": 1.0,
    "free cast": 1.0,

    // --- SECONDARY MECHANICS (0.5) ---
    "recursion": 0.5,
    "aristocrats": 0.5,
    "blink": 0.5,
    "ramp": 0.5,
    "token": 0.5,
    "draw": 0.5,
    "removal": 0.5,
    "bounce": 0.5,
    "theft": 0.5,
    "spellslinger": 0.5,
    "landfall": 0.5,
    "sac outlet": 0.5,
    "impulse draw": 0.5,
    "protection": 0.5,
    "tax": 0.5,
    // "Finisher" detects a shape ("this effect ends the game" / "massive X drain"), not a defined
    // mechanic the way Reanimate or Counterspell are - it's inherently the fuzziest tag in this
    // table, so it's deliberately kept out of the 1.0 tier rather than let a heuristic-with-no-
    // precise-definition carry the same scoring authority as an unambiguous rule match
    // (review: tag system item 4).
    "finisher": 0.5,

    // --- BROAD CATEGORIES & GENERAL CONTEXT (0.2) ---
    "graveyard": 0.2,
    "etb": 0.2,
    "death trigger": 0.2,
    "evasion": 0.2,
    "treasure": 0.2,
    "cantrip": 0.2,
    "scry": 0.2,
    "surveil": 0.2,
    "+1/+1 counters": 0.2,
    "untap": 0.2
};

function getTagWeight(tag) {
    const lowerTag = tag.toLowerCase();
    if (TAG_WEIGHTS[lowerTag] !== undefined) return TAG_WEIGHTS[lowerTag];

    // Compositional sub-tags (e.g. "anthem:merfolk", "removal:creature", "token:multiple") carry
    // their base tag's family weight, scaled down since they're a refinement of that family
    // rather than the primary signal on their own - so matching the specific parameter is worth
    // something extra without ever outweighing matching the base family itself
    // (project spec F: richer compositional tags, function family + parameters).
    const colonIndex = lowerTag.indexOf(':');
    if (colonIndex > 0) {
        const baseTag = lowerTag.slice(0, colonIndex);
        const baseWeight = TAG_WEIGHTS[baseTag] !== undefined ? TAG_WEIGHTS[baseTag] : 0.5;
        return baseWeight * 0.6;
    }

    return 0.5;
}

/**
 * Extracts normalized MTG rule restriction keywords (e.g., "noncreature", "basic", "plains").
 * @param {string} text 
 * @returns {string[]} Array of normalized restriction keywords
 */
/**
 * Normalizes a card name for identity comparison ("is this the source card itself?"). A plain
 * `.toLowerCase()` comparison assumes both sides format the name identically, but that can break
 * in ways that are easy to miss: incidental leading/trailing or doubled internal whitespace (from
 * copy-paste, a search-history entry, or a manually-typed search), and double-faced/split/adventure
 * cards, where different Scryfall response shapes can carry the combined "Front // Back" name in
 * one place and just the front face's name in another. This is deliberately generous - it
 * normalizes whitespace AND treats a name as "the same card" if it matches either the full
 * combined name or just the part before " // ", so a DFC comparison can't silently miss due to
 * that asymmetry. Used both for the main hard-filter exclusion and as a last-resort safety net
 * right before rendering, so the source card can never appear in its own results regardless of
 * which comparison point a mismatch slips past.
 * @param {string} name
 * @returns {string}
 */
function normalizeCardNameForIdentity(name) {
    return (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * True if two card names refer to the same card for exclusion purposes - exact normalized match,
 * or either side's normalized name equals the other's front-face component (before " // ").
 * @param {string} nameA
 * @param {string} nameB
 * @returns {boolean}
 */
function isSameCardName(nameA, nameB) {
    const a = normalizeCardNameForIdentity(nameA);
    const b = normalizeCardNameForIdentity(nameB);
    if (!a || !b) return false;
    if (a === b) return true;
    const aFront = a.split(' // ')[0];
    const bFront = b.split(' // ')[0];
    return aFront === b || bFront === a || aFront === bFront;
}

function extractMTGRestrictions(text) {
    if (!text) return [];

    // "creature you control" vs "creature an opponent controls" describe very different
    // restrictions (self-affecting vs opponent-affecting) but the pronoun words below are
    // otherwise stripped as noise - capture that distinction as an explicit token first so it
    // isn't lost (project spec 2.3 / 2.4: restrictions and target structure).
    const controlTokens = [];
    if (/\byou control\b/i.test(text)) controlTokens.push('controlledbyyou');
    if (/\b(?:an? )?opponents?\s+control(?:s)?\b|\beach opponent\s+control(?:s)?\b/i.test(text)) controlTokens.push('controlledbyopponent');

    const ignoreList = new Set([
        'a', 'an', 'the', 'target', 'each', 'all', 'other', 'another', 'card', 'cards',
        'permanent', 'permanents', 'spell', 'spells', 'or', 'and', 'with', 'you', 'control',
        'your', 'their', 'opponent', 'controls', 'it', 'they', 'from', 'onto', 'into',
        'to', 'under', 'its', 'owner\'s', 'owners', 'then', 'put', 'return', 'have', 'has'
    ]);

    const normalizedText = text.toLowerCase()
        .replace(/non\-([a-z]+)/g, 'non$1') // Normalize "non-creature" to "noncreature"
        .replace(/[^a-z0-9\s\-]/g, '');

    const words = normalizedText
        .split(/\s+/)
        .filter(word => word.length > 1 && !ignoreList.has(word));

    return [...controlTokens, ...words];
}

/**
 * Separates an activation-cost prefix (e.g. "{1}, Sacrifice a creature:") from the effect
 * text that follows it. This matters because the cost prefix often contains its own verb
 * (sacrifice, discard, tap, exile) that is NOT the ability's actual effect - e.g. for
 * "Sacrifice a creature: Draw a card.", the mechanical action is "draw", not "sacrifice".
 * Before this split existed, the whole string was handed to the action sub-parsers, and
 * parseZoneMovementEffect's verb-priority chain would match "sacrifice" first and never see
 * "draw" at all, mis-classifying the ability's real effect (project spec: cost-then-effect
 * sequencing).
 * @param {string} clauseText
 * @returns {{costText: string|null, effectText: string}}
 */
function splitActivationCost(clauseText) {
    const match = clauseText.match(/^\s*([^:]{1,60}):\s*(.+)$/s);
    if (!match) return { costText: null, effectText: clauseText };

    const prefix = match[1];
    // Only treat the prefix as a genuine activation cost when it actually looks like one
    // (mana symbols, sacrifice/discard/exile/pay, or the tap symbol/word). A trigger condition
    // like "When this creature dies:" or "If you control a Merfolk:" uses a colon too but is
    // NOT a cost, so it must stay attached to the effect text.
    const looksLikeCost = /\{[^}]+\}|\bsacrifice\b|\bdiscard\b|\bpay\s+\d|\btap\b/i.test(prefix)
        && !/^\s*(when|whenever|if|at the beginning|as long as)\b/i.test(prefix);

    if (!looksLikeCost) return { costText: null, effectText: clauseText };
    return { costText: prefix.trim(), effectText: match[2].trim() };
}

/**
 * Classifies an isolated activation-cost prefix into a structured shape instead of a single
 * opaque label, so e.g. a compound cost ("{1}, Sacrifice a creature, Discard a card:") can be
 * compared component-by-component rather than only matching on whichever cost type happened
 * to be detected first.
 * @param {string} costText
 * @returns {{raw: string, type: string, parts: string[]}}
 */
function classifyActivationCost(costText) {
    const lower = costText.toLowerCase();
    const parts = [];
    if (/\{t\}|\btap\b/.test(lower)) parts.push('tap');
    if (/\{[\dwubrgx/]+\}/.test(lower)) parts.push('mana');
    if (/\bsacrifice\b/.test(lower)) parts.push('sacrifice');
    if (/\bdiscard\b/.test(lower)) parts.push('discard');
    if (/\bexile\b/.test(lower)) parts.push('exile');
    if (/\bpay\s+\d+\s+life\b/.test(lower)) parts.push('life');
    return { raw: costText, type: parts[0] || 'other', parts };
}

/**
 * Extracts conditions, payment/activation costs, and secondary ("additional") effects that
 * commonly ride alongside a clause's primary action - e.g. "unless its controller pays {2}",
 * "if you control a Merfolk", "Sacrifice a creature:", "then draw a card". Applied uniformly to
 * every clause type in parseMTGEffect (not just counterspells, where this used to live), so
 * mechanical comparison can actually use this structure instead of it only ever being populated
 * for one specific effect type (project spec 2.3: "Conditions and costs", "Additional effects").
 * @param {string} text
 * @returns {{condition: string|null, conditionDetail: string[]|null, payCost: string|null, additionalEffects: string[]}}
 */
function extractConditionsAndCosts(text) {
    const result = { condition: null, conditionDetail: null, payCost: null, additionalEffects: [], quantity: null };
    if (!text) return result;

    const unlessPay = text.match(/\bunless (?:its|that player's|their)?\s*controller pays\s*(\{[\dwubrgx/]+\}|\d+|[a-z\s]+)/i);
    const ifMatch = text.match(/\bif\s+([^,.:;]+)/i);
    if (unlessPay) {
        result.condition = "unless_pay";
        result.payCost = unlessPay[1].trim();
    } else if (/\bunless\b/i.test(text)) {
        result.condition = "unless_other";
        const unlessDetail = text.match(/\bunless\s+([^,.:;]+)/i);
        if (unlessDetail) result.conditionDetail = extractMTGRestrictions(unlessDetail[1]);
    } else if (/^\s*if\b/i.test(text) || /\bif you control\b|\bif [a-z\s]+ entered\b/i.test(text)) {
        result.condition = "if";
        // Capture WHAT the condition actually checks (e.g. "you control a merfolk"), not just
        // that a condition exists, so two cards with different "if" conditions aren't scored
        // as equivalent just because they're both conditional (project spec: condition detail).
        if (ifMatch) result.conditionDetail = extractMTGRestrictions(ifMatch[1]);
    }

    // Additional/activation cost paid before the ability's colon, e.g.
    // "{1}, Sacrifice a creature: Draw a card."
    const costMatch = text.match(/^\s*([^:]{1,60}):/);
    if (costMatch) {
        const costText = costMatch[1].toLowerCase();
        if (/sacrifice/.test(costText)) result.payCost = result.payCost || "sacrifice";
        else if (/\{[\dwubrgx/]+\}/.test(costText)) result.payCost = result.payCost || "mana";
        else if (/discard/.test(costText)) result.payCost = result.payCost || "discard";
        else if (/\{t\}|\btap\b/.test(costText)) result.payCost = result.payCost || "tap";
    }

    // A numeric quantity attached to the clause's action - "draw 1" vs "draw 3", "deal 2" vs
    // "deal 5", "mill 3" vs "mill 10" describe the *same function at different strength*, not
    // simply "same" or "different" (review #5: quantitative similarity, generalized past just
    // token/anthem counts to every effect type).
    const QTY_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, x: 'X', any: 'ANY' };
    const qtyGeneralMatch = text.match(/\b(?:draws?|deals?|gains?|loses?|mills?|scries?|surveils?|exiles? the top|puts?(?: [a-z]+)? counters?)\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|any(?: number of)?|\d+)\b/i);
    if (qtyGeneralMatch) {
        const rawQty = qtyGeneralMatch[1].toLowerCase().split(' ')[0];
        result.quantity = QTY_WORDS[rawQty] !== undefined ? QTY_WORDS[rawQty] : (isNaN(parseInt(rawQty, 10)) ? null : parseInt(rawQty, 10));
    }

    // Secondary/chained effects riding along with the clause's primary action.
    if (/\bdraws? a card\b/i.test(text)) result.additionalEffects.push("draw_card");
    if (/\bscry\s*\d*/i.test(text)) result.additionalEffects.push("scry");
    if (/\bsurveil\s*\d*/i.test(text)) result.additionalEffects.push("surveil");
    if (/\bcreates? [a-z\s]*token/i.test(text)) result.additionalEffects.push("create_token");
    if (/\bgains? \d+ life\b/i.test(text)) result.additionalEffects.push("gain_life");
    if (/\bloses? \d+ life\b/i.test(text)) result.additionalEffects.push("lose_life");

    return result;
}

/**
 * Parses one-shot +1/+1 or -1/-1 counter PLACEMENT: "put a +1/+1 counter on target creature",
 * "put two -1/-1 counters on target creature". Distinct from the STATIC team-wide buff
 * parseAnthemEffect already handles ("creatures you control get +1/+1") - a counter placement is
 * a one-time, permanent change to one specific permanent, not a continuous effect over the whole
 * team, and previously had no recognition of its own at all.
 * @param {string} clause
 * @returns {Object|null}
 */
function parseCounterPlacementEffect(clause) {
    const text = clause.toLowerCase();
    const match = text.match(/\bputs?\s+(a|an|one|two|three|four|five|x)\s+([+-]1\/[+-]1)\s+counters?\s+on\s+(target creature|target permanent|each creature|that creature|it)\b/i);
    if (!match) return null;

    const qtyWords = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, x: 'X' };
    const rawQty = match[1].toLowerCase();

    return {
        action: 'place_counter',
        object: 'creature',
        target: /^each\b/.test(match[3]) ? 'each' : (/^target\b/.test(match[3]) ? 'target' : null),
        counterType: match[2],
        quantity: qtyWords[rawQty] !== undefined ? qtyWords[rawQty] : null,
        restriction: extractMTGRestrictions(text)
    };
}

/**
 * Parses direct tap/untap effects on a permanent - "tap target creature", "untap all lands you
 * control" - distinct from a mana ability's own {T} activation cost (already stripped out before
 * this runs by splitActivationCost) and from keyword reminder text like "doesn't untap". Requires
 * an explicit target/each/all phrase after the verb specifically so a bare mention isn't misread
 * as an effect. Previously unparsed entirely.
 * @param {string} clause
 * @returns {Object|null}
 */
function parseTapEffect(clause) {
    const text = clause.toLowerCase();
    const verbMatch = text.match(/\b(untaps?|taps?)\b/i);
    if (!verbMatch) return null;

    const { object, target } = extractTargetPhrase(text, ['creature', 'permanent', 'land']);
    if (!object && !target) return null;

    return {
        action: verbMatch[1].toLowerCase().startsWith('untap') ? 'untap' : 'tap',
        object: object === 'any target' ? 'permanent' : (object || 'permanent'),
        target,
        restriction: extractMTGRestrictions(text)
    };
}

/**
 * Parses control-changing effects such as:
 *   "Gain control of target nonland permanent with mana value 1 or less."
 *   "Gain control of target creature until end of turn."
 * These are first-class effects so modal cards can explain non-counterspell modes instead of
 * reducing them to generic/unmatched text.
 */
function parseControlChangeEffect(clause) {
    const text = String(clause || '').trim();
    const match = text.match(/\b(?:gain|gains|take|takes)\s+control\s+of\s+(target\s+)?(.+?)(?:\s+until\s+(.+))?\.?$/i);
    if (!match) return null;

    let objectText = String(match[2] || '').trim().replace(/[.!]+$/g, '').trim();
    let duration = String(match[3] || '').trim();
    const untilIndex = objectText.search(/\s+until\s+/i);
    if (untilIndex >= 0) {
        duration = objectText.slice(untilIndex + 7).trim();
        objectText = objectText.slice(0, untilIndex).trim();
    }
    if (!objectText) return null;

    return {
        action: 'gain_control',
        object: objectText.toLowerCase(),
        target: match[1] ? 'target' : (objectText.toLowerCase().startsWith('target ') ? 'target' : null),
        restriction: extractMTGRestrictions(text),
        duration: duration ? 'temporary' : null,
        controlChangeDuration: duration || null,
        controller: 'you'
    };
}

/**
 * Parses static/continuous spell-cost reductions such as:
 *   "White spells you cast cost {1} less to cast."
 *   "White spells cost {1} less to cast."
 *   "Artifact spells you cast cost {2} less."
 *
 * Cost reduction is a first-class mechanical effect. Previously these clauses fell through to
 * `generic`, which made an otherwise equivalent cost-reduction source/candidate pair report 0.
 */
function parseCostReductionEffect(clause) {
    const text = String(clause || '').trim();
    const patterns = [
        /\b(.+?)\s+spells?\s+(you\s+cast|cast)\s+costs?\s+(\{[^}]+\}|\d+)\s+less(?:\s+to\s+cast)?\b/i,
        /\b(.+?)\s+spells?\s+costs?\s+(\{[^}]+\}|\d+)\s+less(?:\s+to\s+cast)?\b/i,
        /\b(spells?)\s+(you\s+cast|cast)\s+costs?\s+(\{[^}]+\}|\d+)\s+less(?:\s+to\s+cast)?\b/i,
        /\b(spells?)\s+costs?\s+(\{[^}]+\}|\d+)\s+less(?:\s+to\s+cast)?\b/i
    ];
    let match = null;
    for (const pattern of patterns) {
        match = text.match(pattern);
        if (match) break;
    }
    if (!match) return null;

    let qualifier = '';
    let controller = null;
    let discount = null;
    if (match.length === 4) {
        // Qualified + controlled form: [qualifier, controller phrase, discount].
        qualifier = /^spells?$/i.test(match[1] || '') ? '' : String(match[1] || '');
        controller = /^(?:you\s+cast|cast)$/i.test(match[2] || '') ? 'you' : null;
        discount = match[3];
    } else if (match.length === 3) {
        // Either "<qualifier> spells cost ..." or the unqualified "spells you cast cost ..." form.
        qualifier = /^spells?$/i.test(match[1] || '') ? '' : String(match[1] || '');
        discount = match[2];
    }

    const normalizedQualifier = qualifier
        .replace(/^\s*the\s+first\s+/i, '')
        .replace(/\bspells?\b/ig, ' ')
        .replace(/\byou\s+cast\b/ig, ' ')
        .trim();

    const restriction = [];
    if (normalizedQualifier) {
        normalizedQualifier
            .toLowerCase()
            .replace(/\bnon-([a-z]+)/g, 'non$1')
            .split(/\s+(?:or|and)\s+|\s*,\s*|\s+/)
            .map(v => v.trim())
            .filter(Boolean)
            .filter(v => !['the','first','that','this','one'].includes(v))
            .forEach(v => { if (!restriction.includes(v)) restriction.push(v); });
    }

    const manaCost = String(discount || '').trim();
    const inner = manaCost.match(/^\{([^}]+)\}$/)?.[1] || manaCost;
    const numericDiscount = /^\d+$/.test(inner) ? Number(inner) : null;

    return {
        action: 'cost_reduction',
        object: 'spell',
        target: null,
        controller,
        restriction,
        amount: numericDiscount,
        quantity: numericDiscount,
        manaCost,
        effectMode: 'reduction',
        isStatic: true,
        costRestriction: normalizedQualifier || null
    };
}

/**
 * Parses counterspell and counter-ability clauses.
 * @param {string} clause 
 * @returns {Object|null}
 */
function parseCounterEffect(clause) {
    const text = clause.toLowerCase();
    if (!/\bcounter\b/i.test(text)) return null;

    // "Counter" is also a NOUN for permanent counters (+1/+1, loyalty, charge, poison...) - a
    // completely different effect from countering a spell or ability (see
    // parseCounterPlacementEffect for +1/+1 placement specifically). This guard previously matched
    // ANY clause containing the bare word "counter" anywhere, so "put a +1/+1 counter on target
    // creature" was silently misparsed as a fake counterspell (object defaulting to 'spell', which
    // never actually appears in that text) - and because this parser runs first in the chain and
    // always "succeeded", parseCounterPlacementEffect could never run at all for such a clause.
    // Require an actual counterspell/counter-ability shape, and explicitly rule out the permanent-
    // counter noun forms first.
    if (/[+-]1\/[+-]1 counters?|loyalty counters?|charge counters?|poison counters?|\bcounters?\s+(?:on|from|equal to)\b/i.test(text)) {
        return null;
    }
    if (!/\bcounters?\s+(?:target|all|each|that|up to)\b/i.test(text) && !/\b(?:spell|ability|activated ability|triggered ability)\b/i.test(text)) {
        return null;
    }

    const effect = {
        action: "counter",
        object: "spell",
        target: /\btarget\b/i.test(text) ? "target" : (/\ball\b/i.test(text) ? "all" : "each"),
        restriction: [],
        condition: null,
        payCost: null
    };

    if (text.includes("ability") || text.includes("activated ability") || text.includes("triggered ability")) {
        effect.object = "ability";
    }

    const spellMatch = text.match(/\bcounter\s+(?:target\s+|all\s+)?([a-z\s\-]+?)\s*(?:spell|ability)\b/i);
    if (spellMatch) {
        effect.restriction = extractMTGRestrictions(spellMatch[1]);
    }

    const payMatch = text.match(/\bunless (?:its|that player's|their)?\s*controller pays\s*(\{[\dwubrgx/]+\}|\d+|[a-z\s]+)/i);
    if (payMatch) {
        effect.condition = "unless_pay";
        effect.payCost = payMatch[1].trim();
    }

    // condition/payCost (if not already set above) and additionalEffects (e.g. "then draw a
    // card", "then scry") are filled in uniformly by parseMTGEffect via extractConditionsAndCosts.
    return effect;
}

/**
 * Parses movement between battlefield, hand, graveyard, library, and exile.
 * @param {string} clause 
 * @returns {Object|null}
 */
function parseZoneMovementEffect(clause) {
    const text = clause.toLowerCase();
    
    // Every verb here needs its third-person-plural conjugation too ("puts", "returns", "moves",
    // "destroys"), not just the bare/imperative form - most spells say "Put target creature..."
    // (imperative), but a common and completely different template says "Each player puts a
    // creature card..." (third person), and that conjugated form was missing for return/put/move/
    // destroy specifically, even though exile/sacrifice/discard/mill/draw already handled it a few
    // lines down. A clause using only the missing form (no other recognized verb) failed this gate
    // entirely and fell straight to "generic" - confirmed on a real benchmark run where Exhume
    // ("Each player puts a creature card from their graveyard onto the battlefield") produced zero
    // canonical functions at all, the single highest-impact case found by scoring analysis.
    const hasMovementVerb = /\b(returns?|puts?|moves?|sacrifices?|destroys?|exiles?|discards?|mills?|draws?)\b/i.test(text);
    if (!hasMovementVerb) return null;

    const effect = {
        action: null,
        object: "card",
        from: null,
        to: null,
        target: null,
        restriction: [],
        tapped: text.includes("tapped")
    };

    if (/\btarget\b/i.test(text)) effect.target = "target";
    else if (/\beach\b/i.test(text)) effect.target = "each";
    else if (/\ball\b/i.test(text)) effect.target = "all";

    const fromMatch = text.match(/\bfrom\s+(?:a|an|the|your|their|any|all|top of your|top of their)?\s*(graveyard|battlefield|hand|library|exile|command zone)\b/i);
    if (fromMatch) effect.from = fromMatch[1].toLowerCase();

    const toMatch = text.match(/\b(?:to|onto|into)\s+(?:a|an|the|your|their|its owner's|top of your|bottom of your|top of their)?\s*(battlefield|graveyard|hand|library|exile|command zone)\b/i);
    if (toMatch) effect.to = toMatch[1].toLowerCase();

    if (/\b(returns?|puts?|moves?)\b/i.test(text)) {
        effect.action = /\breturns?\b/i.test(text) ? "return" : "put";
        const match = text.match(/\b(?:returns?|puts?|moves?)\s+(?:target\s+|all\s+|each\s+)?([a-z\s\-]+?)\s*(?:card|creature|permanent|artifact|enchantment|land|planeswalker)s?\b/i);
        if (match) effect.restriction = extractMTGRestrictions(match[1]);
        effect.object = text.includes('creature') ? 'creature' : (text.includes('land') ? 'land' : 'card');
    } else if (/\bsacrifices?\b/i.test(text)) {
        effect.action = "sacrifice";
        effect.object = "permanent";
        if (!effect.from) effect.from = "battlefield";
        if (!effect.to) effect.to = "graveyard";
        const sacMatch = text.match(/\bsacrifices?\s+(?:a|an|target|each)?\s*([a-z\s\-]+?)\s*(?:creature|permanent|artifact|enchantment|land)s?\b/i);
        if (sacMatch) effect.restriction = extractMTGRestrictions(sacMatch[1]);
    } else if (/\bdestroys?\b/i.test(text)) {
        effect.action = "destroy";
        effect.object = "permanent";
        if (!effect.from) effect.from = "battlefield";
        if (!effect.to) effect.to = "graveyard";
        const destroyMatch = text.match(/\bdestroys?\s+(?:target|all|each)?\s*([a-z\s\-]+?)\s*(?:creature|permanent|artifact|enchantment|land|planeswalker)s?\b/i);
        if (destroyMatch) effect.restriction = extractMTGRestrictions(destroyMatch[1]);
    } else if (/\bexiles?\b/i.test(text)) {
        effect.action = "exile";
        effect.object = text.includes('spell') ? 'spell' : 'card';
        if (!effect.to) effect.to = "exile";
        const exileMatch = text.match(/\bexiles?\s+(?:target|all|each)?\s*([a-z\s\-]+?)\s*(?:card|creature|permanent|artifact|enchantment|land|spell)s?\b/i);
        if (exileMatch) effect.restriction = extractMTGRestrictions(exileMatch[1]);
    } else if (/\bdiscards?\b/i.test(text)) {
        effect.action = "discard";
        effect.object = "card";
        if (!effect.from) effect.from = "hand";
        if (!effect.to) effect.to = "graveyard";
    } else if (/\bmills?\b/i.test(text)) {
        effect.action = "mill";
        effect.object = "card";
        if (!effect.from) effect.from = "library";
        if (!effect.to) effect.to = "graveyard";
    } else if (/\bdraws?\b/i.test(text)) {
        effect.action = "draw";
        effect.object = "card";
        if (!effect.from) effect.from = "library";
        if (!effect.to) effect.to = "hand";
    }

    return effect.action ? effect : null;
}

// Shared "what can this effect target" vocabulary. Several parsers each used to spell out their
// own version of "target creature / any target / each opponent / all creatures", with slightly
// different coverage between them - a phrasing gap found in one (e.g. "target creature or
// battle") had to be separately noticed and fixed in every other parser that also handles
// targets. New parsers below call this one shared helper instead, so a coverage fix here benefits
// all of them at once (review: parser item 3). Existing, already-working parsers (damage, zone
// movement) keep their own inline patterns rather than being retrofitted onto this - lower risk
// than touching parsers that are already relied on, for the same reconciliation benefit new code
// gets automatically by using the shared helper from the start.
const TARGETABLE_OBJECT_WORDS = ['creature', 'player', 'opponent', 'permanent', 'artifact', 'enchantment', 'planeswalker', 'battle', 'land'];

/**
 * @param {string} text - lowercased clause text
 * @param {string[]} [objectWords] - which object nouns this effect can target
 * @returns {{object: string|null, target: string|null}}
 */
function extractTargetPhrase(text, objectWords = TARGETABLE_OBJECT_WORDS) {
    const objectAlt = objectWords.join('|');
    const re = new RegExp(`\\b(any target|target (?:${objectAlt})|each (?:opponent|player|${objectAlt})|all (?:${objectAlt})s?|that (?:${objectAlt}))\\b`, 'i');
    const match = text.match(re);
    if (!match) return { object: null, target: null };

    const phrase = match[0].toLowerCase();
    let object = null;
    if (phrase.includes('any target')) object = 'any target';
    else object = objectWords.find(w => phrase.includes(w))
        || (phrase.includes('opponent') ? 'opponent' : phrase.includes('player') ? 'player' : null);

    const target = /^each\b/.test(phrase) ? 'each'
        : /^all\b/.test(phrase) ? 'all'
        : (phrase.startsWith('target') || phrase.includes('any target')) ? 'target'
        : null;

    return { object, target };
}

/**
 * Parses direct-damage effects: "deals N damage to X", including "any target", a specific target
 * type, "each opponent/player/creature", and non-fixed amounts (X, "that much damage"). This is
 * one of the most common effect shapes in Magic - burn spells, damage-based removal, reach - and
 * previously had no dedicated recognition at all.
 * @param {string} clause
 * @returns {Object|null}
 */
function parseDamageEffect(clause) {
    const text = clause.toLowerCase();

    // Divided damage (Fireball-style): "deals X damage divided as you choose among any number of
    // target creatures and/or players." A materially different sentence shape from "deals X
    // damage to Y" - there's no single target phrase at all - so the main pattern below never
    // matched it; these X-damage finishers are common and distinct enough to deserve their own
    // case rather than falling to "generic" (review: parser item 2, broaden the damage parser).
    const dividedMatch = text.match(/\bdeals?\s+(\d+|x)\s+damage,?\s+divided\s+as\s+you\s+choose\s+among\s+(?:any number of\s+)?(?:target\s+)?(creatures?|players?|opponents?|any number of targets?)/i);
    if (dividedMatch) {
        const rawAmount = dividedMatch[1].toLowerCase();
        const amount = /^\d+$/.test(rawAmount) ? parseInt(rawAmount, 10) : rawAmount;
        const objPhrase = dividedMatch[2].toLowerCase();
        return {
            action: 'damage',
            object: objPhrase.includes('creature') ? 'creature' : objPhrase.includes('target') ? 'any target' : 'player',
            target: 'divided',
            amount,
            restriction: extractMTGRestrictions(text)
        };
    }

    // Fight-style / stat-scaled damage: "deals damage equal to its power to target creature", or
    // the "fights target creature" shorthand (which is defined by the rules as each dealing
    // damage equal to its power to the other). The amount scales with a creature's own stat rather
    // than being a fixed number printed on the card, so this is functionally its own family - two
    // "fight" effects should match each other more than either matches a same-fixed-number burn
    // spell, and collapsing them into "generic" (as before) lost that entirely.
    const statMatch = text.match(/\bdeals?\s+damage\s+equal\s+to\s+its\s+(power|toughness)\s+to\s+(any target|target (?:creature|player|planeswalker)|that creature)/i);
    const fightMatch = !statMatch && /\bfights?\s+target\s+creature\b/i.test(text);
    if (statMatch || fightMatch) {
        const targetPhrase = statMatch ? statMatch[2].toLowerCase() : 'target creature';
        const object = targetPhrase.includes('any target') ? 'any target'
            : targetPhrase.includes('player') ? 'player'
            : 'creature';
        return {
            action: 'damage',
            object,
            target: 'target',
            // Deliberately unified on "its power" for both a power-based stat effect and a fight
            // effect (which the rules define as power-for-power) so the two canonicalize to the
            // same magnitude and score as the close match they are; a toughness-based effect keeps
            // its own distinct string since that's a genuinely different, rarer shape.
            amount: statMatch && statMatch[1] === 'toughness' ? 'its toughness' : 'its power',
            restriction: extractMTGRestrictions(text)
        };
    }

    const match = text.match(/\bdeals?\s+(\d+|x|that much|twice that much)\s+damage\s+to\s+(any target|target (?:creature or planeswalker|creature or player|player|opponent|creature|planeswalker)|each (?:opponent|player|creature)|that (?:permanent|player|creature))/i);
    if (!match) return null;

    const rawAmount = match[1].toLowerCase();
    // Kept as a string ("x", "that much damage") when it isn't a fixed number - two spells that
    // both scale off something (X spells, or "twice that much") are a closer functional match to
    // each other than either is to a card with a fixed, unrelated amount, so this shouldn't just
    // collapse to null.
    const amount = /^\d+$/.test(rawAmount) ? parseInt(rawAmount, 10) : rawAmount;

    const targetPhrase = match[2].toLowerCase();
    let object;
    if (targetPhrase.includes('any target')) object = 'any target';
    else if (targetPhrase.includes('creature') && targetPhrase.includes('planeswalker')) object = 'creature or planeswalker';
    else if (targetPhrase.includes('creature') && targetPhrase.includes('player')) object = 'creature or player';
    else if (targetPhrase.includes('opponent')) object = 'opponent';
    else if (targetPhrase.includes('planeswalker')) object = 'planeswalker';
    else if (targetPhrase.includes('creature')) object = 'creature';
    else if (targetPhrase.includes('player')) object = 'player';
    else object = 'permanent';

    const target = /^each\b/.test(targetPhrase) ? 'each' : (/^target\b/.test(targetPhrase) || targetPhrase.includes('any target') ? 'target' : null);

    return {
        action: 'damage',
        object,
        target,
        amount,
        restriction: extractMTGRestrictions(text)
    };
}

/**
 * Parses mana-producing abilities: "Add {C}{C}", "Add one mana of any color", "Add X mana of any
 * one color", etc. A mana ability's cost ("{T}:") is already stripped out by splitActivationCost
 * before this runs, leaving just the production clause itself - which matched none of the
 * existing zone-movement/counter/search/token/anthem patterns, so every mana rock and ritual fell
 * to "generic". Requires an actual mana symbol or the word "mana" near "add" so an unrelated
 * "add a +1/+1 counter"-style clause elsewhere isn't misread as mana production.
 * @param {string} clause
 * @returns {Object|null}
 */
function parseManaAbilityEffect(clause) {
    const text = clause.toLowerCase();
    if (!/\badd\b/i.test(text)) return null;

    const manaSymbols = clause.match(/\{[wubrgc0-9x]+\}/gi) || [];
    const readsAsManaProduction = manaSymbols.length > 0 || /\badd\b[^.]{0,40}\bmana\b/i.test(text);
    if (!readsAsManaProduction) return null;

    const colors = [];
    if (/\{c\}/i.test(clause) || /\bcolorless mana\b/i.test(text)) colors.push('colorless');
    ['w', 'u', 'b', 'r', 'g'].forEach(c => { if (new RegExp(`\\{${c}\\}`, 'i').test(clause)) colors.push(c); });
    if (/\bany (?:one )?color\b/i.test(text) || /\bany combination of colors\b/i.test(text)) colors.push('any');

    let amount = manaSymbols.length > 0 ? manaSymbols.length : null;
    if (!amount) {
        const wordMatch = text.match(/\badd\s+(one|two|three|four|five|x)\b/i);
        if (wordMatch) {
            const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
            amount = words[wordMatch[1].toLowerCase()] || wordMatch[1].toLowerCase();
        }
    }

    return {
        action: 'add_mana',
        object: 'mana',
        colors: colors.length > 0 ? [...new Set(colors)] : null,
        amount,
        restriction: extractMTGRestrictions(text)
    };
}

/**
 * Parses direct life-total changes: "target player gains 4 life", "each opponent loses 2 life",
 * "you gain life equal to the damage dealt". Extremely common (lifegain-matters decks, extort,
 * drain finishers) but previously had no canonical function at all - only a loose tag regex
 * (Lifegain/Drain) with nothing structured behind it, so two cards built entirely around life
 * swings had no scorable signal in common beyond both containing the word "life" somewhere.
 * @param {string} clause
 * @returns {Object|null}
 */
function parseLifeEffect(clause) {
    const text = clause.toLowerCase();

    const fixedMatch = text.match(/\b(you|target player|target opponent|each player|each opponent|that player|its controller|their controller|controller)\s+(gains?|loses?)\s+(\d+|x|that much)\s+life\b/i);
    const equalToMatch = !fixedMatch && text.match(/\b(you|target player|target opponent|each player|each opponent|that player)\s+(gains?|loses?)\s+life\s+equal\s+to\b/i);
    const match = fixedMatch || equalToMatch;
    if (!match) return null;

    const subjectPhrase = match[1];
    const verb = match[2];
    const rawAmount = fixedMatch ? fixedMatch[3] : 'variable';
    const amount = /^\d+$/.test(rawAmount) ? parseInt(rawAmount, 10) : rawAmount;

    let object;
    if (subjectPhrase === 'you') object = 'you';
    else if (subjectPhrase.includes('opponent')) object = 'opponent';
    else if (subjectPhrase.includes('player')) object = 'player';
    else object = 'controller';

    const target = /^each\b/.test(subjectPhrase) ? 'each' : (subjectPhrase.startsWith('target') ? 'target' : null);

    return {
        action: verb.startsWith('gain') ? 'gain_life' : 'lose_life',
        object,
        target,
        amount,
        restriction: extractMTGRestrictions(text)
    };
}

/**
 * Parses tutor and land-fetch abilities.
 * @param {string} clause 
 * @returns {Object|null}
 */
function parseSearchEffect(clause) {
    const text = clause.toLowerCase();
    if (!/\bsearch\b/i.test(text)) return null;

    const effect = {
        action: "search",
        from: "library",
        to: "hand", 
        object: "card",
        restriction: [],
        tapped: text.includes("tapped"),
        shuffle: text.includes("shuffle")
    };

    const fromMatch = text.match(/\bsearch\s+(?:your|target player's)?\s*(library|graveyard)\b/i);
    if (fromMatch) effect.from = fromMatch[1].toLowerCase();

    const tutorMatch = text.match(/\bsearch\s+[^.]+?\s+for\s+(?:a|an)?\s*([a-z\s\-]+?)\s*card\b/i);
    if (tutorMatch) {
        effect.restriction = extractMTGRestrictions(tutorMatch[1]);
    } else {
        const landMatch = text.match(/\bsearch\s+[^.]+?\s+for\s+(?:a|an)?\s*([a-z\s\-]+?)\s*land\b/i);
        if (landMatch) {
            effect.restriction = extractMTGRestrictions(landMatch[1] + " land");
        }
    }

    const toMatch = text.match(/\b(?:put|place)\s+[^.]+?\s+(?:onto|into|to|on)\s+(?:the\s+)?(battlefield|hand|graveyard|top of your library|exile)\b/i);
    if (toMatch) {
        effect.to = toMatch[1].toLowerCase();
    } else if (text.includes("onto the battlefield")) {
        effect.to = "battlefield";
    }

    return effect;
}

/**
 * Parses token creation, token duplication, and replacement doublers.
 * @param {string} clause 
 * @returns {Object|null}
 */
function parseTokenEffect(clause) {
    const text = clause.toLowerCase();
    
    if (/\bif\b.*?\btokens?\b.*?\bwould be created\b/i.test(text) || text.includes("twice that many")) {
        return {
            action: "multiply",
            object: "token",
            multiplier: 2,
            isReplacement: true
        };
    }

    if (/\bcopy\b/i.test(text) && text.includes("token")) {
        return {
            action: "copy_token",
            object: "token",
            target: /\btarget\b/i.test(text) ? "target" : "chosen",
            isReplacement: false
        };
    }

    if (!/\bcreate\b/i.test(text)) return null;

    const effect = {
        action: "create",
        object: "token",
        to: "battlefield",
        quantity: 1,
        stats: null,
        keywords: [],
        tokenType: "token",
        isReplacement: false
    };

    const qtyMap = { 'a': 1, 'an': 1, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'x': 'X' };
    const qtyMatch = text.match(/\bcreate\s+(a|an|one|two|three|four|five|six|x|\d+)\b/i);
    if (qtyMatch) {
        const rawQty = qtyMatch[1].toLowerCase();
        effect.quantity = qtyMap[rawQty] !== undefined ? qtyMap[rawQty] : (isNaN(rawQty) ? rawQty : parseInt(rawQty, 10));
    }

    // Extract P/T stats (e.g., 2/2, 1/1)
    const ptMatch = text.match(/(\d+\/\d+|\*[\/*]\*)/);
    if (ptMatch) {
        effect.stats = ptMatch[1];
    }

    // Extract keywords granted to the token
    const keywordCheck = ['flying', 'haste', 'trample', 'lifelink', 'deathtouch', 'vigilance', 'menace'];
    effect.keywords = keywordCheck.filter(kw => text.includes(kw));

    const typeMatch = text.match(/\bcreate\s+(?:a|an|one|two|three|four|five|six|x|\d+)\s+([a-z0-9\/\s\-]+?)\s*token/i);
    if (typeMatch) {
        effect.tokenType = typeMatch[1].trim();
    }

    return effect;
}

/**
 * Parses static team buffs, tribal anthems, and granted abilities.
 * @param {string} clause 
 * @returns {Object|null}
 */
function parseAnthemEffect(clause) {
    const text = clause.toLowerCase();
    const anthemMatch = text.match(/(other\s+)?([a-z\s\-]*?)\s*creatures?\s*(you control)?\s*get\s*([\+\-][\dx\/*]+\/[\+\-][\dx\/*]+)/i);
    const keywordMatch = text.match(/(other\s+)?([a-z\s\-]*?)\s*creatures?\s*(you control)?\s*have\s+([a-z\s,]+)/i);

    if (!anthemMatch && !keywordMatch) return null;

    let rawSubtype = "all";
    let isOther = false;
    let controller = "all";
    let pt = null;
    let grantedKeywords = [];

    if (anthemMatch) {
        isOther = Boolean(anthemMatch[1]);
        rawSubtype = anthemMatch[2] ? anthemMatch[2].trim() : "all";
        controller = anthemMatch[3] ? "you_control" : "all";
        pt = anthemMatch[4];
    }

    if (keywordMatch) {
        isOther = isOther || Boolean(keywordMatch[1]);
        if (rawSubtype === "all" && keywordMatch[2]) rawSubtype = keywordMatch[2].trim();
        controller = keywordMatch[3] ? "you_control" : controller;
        
        const possibleKeywords = ['flying', 'trample', 'lifelink', 'deathtouch', 'vigilance', 'islandwalk', 'haste', 'reach'];
        grantedKeywords = possibleKeywords.filter(kw => keywordMatch[4].includes(kw));
    }

    return {
        action: "stat_buff",
        object: "creature",
        isOther: isOther,
        subtype: rawSubtype || "all",
        controller: controller,
        powerToughness: pt,
        grantedKeywords: grantedKeywords,
        isStatic: !/until end of turn/i.test(text)
    };
}
// =============================================================================================
// ARCHITECTURE NOTE: THE PARSER IS EVIDENCE, NOT AUTHORITY (review Priority 6)
// =============================================================================================
//
// It's tempting to read a function like calculateMechanicalSimilarity() and think the engine's
// idea of "what this card does" comes from the rule-based parser below - action, canonical
// function, zones, restrictions, quantity. That would be the wrong mental model, and it's worth
// being explicit about why, since nothing about the code itself announces it.
//
// The parser is a REGEX-BASED HEURISTIC. It is confidently wrong on unanticipated phrasing,
// modal spells with unusual headers, triple-nested conditions, and anything using vocabulary
// its patterns don't cover - it will happily emit a structured, plausible-looking {action:
// "generic"} for a card it has completely failed to understand. Treating its output as ground
// truth (a "verdict") rather than as one fallible witness among several would mean the ranking
// silently inherits every one of the parser's blind spots as if they were facts about the card.
//
// So the architecture is not:
//
//         Oracle text --> [Rule Parser] --> "the meaning" --> ranking
//
// it is:
//
//                              Raw Oracle Text
//                                     |
//                    +----------------+----------------+
//                    |                                 |
//                    v                                 v
//          +-------------------+           +-----------------------+
//          |   RULE PARSER      |           |  SEMANTIC EMBEDDING    |
//          |  (parseMTGEffect)  |           |  (MiniLM, holistic -   |
//          |  structured but    |           |   never "confused",   |
//          |  narrow; can miss  |           |   but never precise   |
//          |  or misread text   |           |   about mechanics     |
//          |  it wasn't built   |           |   either)              |
//          |  to recognize      |           |                        |
//          +---------+----------+           +-----------+------------+
//                    |                                  |
//                    v                                  v
//          field-level confidence              contextScore / functionScore
//          (calculateFieldConfidence /                  |
//           calculateCardFieldConfidence)                |
//                    |                                  |
//                    +----------------+-----------------+
//                                     v
//                    CONFIDENCE-WEIGHTED BLEND, not a handoff
//                    (scoreCardBatch's adaptive weighting: effectiveWM/
//                     effectiveWC/effectiveWE shift authority AWAY from
//                     mechanical/exactness and TOWARD semantic precisely
//                     when the parser's own confidence in this pair is low)
//                                     |
//                                     v
//                            Final similarity score
//
// Concretely, this already exists in the code as three separate, real mechanisms - this comment
// names them as one coherent design rather than three unrelated-looking features:
//
//   1. calculateFieldConfidence() / calculateCardFieldConfidence() - the parser reports HOW SURE
//      it is about each field (action, zone, restriction, quantity...), not just an action label.
//   2. calculateParseConfidence() - the coarser clause-level signal (fraction of clauses that
//      resolved to a real action vs. fell back to "generic").
//   3. scoreCardBatch()'s adaptive weighting - both confidence signals are combined into
//      `combinedConfidence`, which then scales how much mechanical/exactness evidence gets to
//      count relative to semantic/functional evidence, for THIS SPECIFIC PAIR of cards. A
//      clean parse on both sides lets the structured read dominate (it's the most precise signal
//      available); a shaky parse on either side automatically defers more to the embedding.
//
// The parser is never given veto power, and the embedding is never given veto power either -
// each is one input the blend trusts in proportion to how reliable it looks for this comparison.
// That's the whole point of confidence-WEIGHTED, as opposed to confidence-GATED: there's no
// threshold below which the parser is ignored or above which it's the only thing that matters.
// =============================================================================================

// Rule-based MTG Effect Parser with Enhanced Zone Movement & Restriction Extraction
/**
 * Master parser splitting text into clauses and running category sub-parsers.
 * @param {string} oracleText 
 * @returns {Array<Object>}
 */
/**
 * Fraction of a card's parsed clauses that resolved to a recognized action rather than falling
 * back to "generic". Used to scale down how much authority a low-confidence parse gets in the
 * final ranking, instead of always trusting the mechanical score at full strength regardless of
 * how much of the text the rule-based parser actually understood (project spec ranking A:
 * confidence-aware mechanical weighting).
 * @param {Array<Object>} parsedEffects
 * @returns {number} 0.0 (nothing recognized) to 1.0 (every clause recognized)
 */
function calculateParseConfidence(parsedEffects) {
    if (!parsedEffects || parsedEffects.length === 0) return 0;
    const meaningful = parsedEffects.filter(e => e.action && e.action !== "generic").length;
    return meaningful / parsedEffects.length;
}

/**
 * Per-FIELD parse confidence for a single effect, rather than one blanket number for the card.
 *
 * "70% parsed" is too coarse to act on: a clause can have a rock-solid action and zones while its
 * restriction list is junk, or a perfect restriction with no quantity found at all. Reporting
 * confidence per field lets the mechanical scorer weight each comparison by how much it actually
 * trusts that specific piece, instead of trusting or distrusting everything at once
 * (review Priority 9).
 *
 * @param {Object} effect
 * @returns {Object} confidence 0..1 per field
 */
function calculateFieldConfidence(effect) {
    if (!effect) return { action: 0, object: 0, zone: 0, target: 0, restriction: 0, quantity: 0, condition: 0 };

    const recognized = Boolean(effect.action && effect.action !== "generic");
    const restrictions = effect.restriction || [];
    // A single stray token is weak evidence; a few coherent tokens is a real restriction.
    const restrictionConfidence = restrictions.length === 0 ? 0
        : restrictions.length === 1 ? 0.45
        : Math.min(1, 0.45 + restrictions.length * 0.18);

    const zoneKnown = (effect.from ? 0.5 : 0) + (effect.to ? 0.5 : 0);

    return {
        action: recognized ? 1 : 0,
        object: effect.object ? 1 : 0,
        zone: zoneKnown,
        target: effect.target ? 1 : 0,
        restriction: restrictionConfidence,
        quantity: (effect.quantity !== null && effect.quantity !== undefined) ? 1 : 0,
        condition: effect.condition ? (effect.conditionDetail?.length ? 1 : 0.6) : 0
    };
}

/**
 * Aggregate field-level confidence across a whole card, weighted toward the effects that matter.
 * @param {Array<Object>} parsedEffects
 * @returns {Object} per-field averages plus an `overall` figure
 */
function calculateCardFieldConfidence(parsedEffects) {
    const fields = ['action', 'object', 'zone', 'target', 'restriction', 'quantity', 'condition'];
    const totals = Object.fromEntries(fields.map(f => [f, 0]));
    let weightSum = 0;

    (parsedEffects || []).forEach(eff => {
        const weight = Math.max(0.05, eff.importance || 0.05);
        const conf = calculateFieldConfidence(eff);
        fields.forEach(f => { totals[f] += conf[f] * weight; });
        weightSum += weight;
    });

    if (weightSum === 0) return { ...Object.fromEntries(fields.map(f => [f, 0])), overall: 0 };

    const result = Object.fromEntries(fields.map(f => [f, totals[f] / weightSum]));
    // Action/zone confidence say the most about whether the structural read is trustworthy.
    result.overall = (result.action * 0.45) + (result.zone * 0.2) + (result.object * 0.15)
        + (result.restriction * 0.1) + (result.target * 0.1);
    return result;
}

// Verbs that can each introduce an independent effect inside a single clause. Conjugated forms
// (puts?, returns?, destroys?) included for the same reason as parseZoneMovementEffect's own
// gate - a third-person "each player puts..." construction needs the same recognition as the
// imperative "put target..." form.
const ATOM_VERBS = 'returns?|puts?|sacrifices?|destroys?|exiles?|discards?|mills?|draws?|search|create|counter|deals?|gains?|loses?|taps?|untaps?';

/**
 * Extracts EVERY effect atom in one clause, not just its dominant verb.
 *
 * The sub-parsers each pick a single action via a verb-priority chain, so a compound clause like
 * "Sacrifice a creature, then search your library for a creature card and put it onto the
 * battlefield" collapsed to just `sacrifice` - the tutor and the battlefield entry, which are the
 * whole point of the card, were silently dropped. This re-runs the sub-parsers from each verb
 * occurrence so the clause becomes a SEQUENCE of atoms (review Priority 4: multiple effects per
 * clause).
 *
 * @param {string} effectText
 * @param {string|null} primaryAction - action already captured for this clause, to avoid duplicates
 * @returns {Array<Object>} additional effect atoms, in text order
 */
function extractClauseAtoms(effectText, primaryAction) {
    if (!effectText) return [];

    const atoms = [];
    const seenActions = new Set(primaryAction ? [primaryAction] : []);
    const verbRegex = new RegExp(`\\b(${ATOM_VERBS})\\b`, 'gi');

    let match;
    let guard = 0;
    while ((match = verbRegex.exec(effectText)) !== null && guard++ < 12) {
        // Parse from this verb onward, so each atom sees its own object/zones rather than the
        // whole clause's.
        const slice = effectText.slice(match.index);
        const atom =
            parseCounterEffect(slice) ||
            parseSearchEffect(slice) ||
            parseTokenEffect(slice) ||
            parseCounterPlacementEffect(slice) ||
            parseControlChangeEffect(slice) ||
            parseTapEffect(slice) ||
            parseDamageEffect(slice) ||
            parseLifeEffect(slice) ||
            parseZoneMovementEffect(slice);

        if (atom && atom.action && !seenActions.has(atom.action)) {
            seenActions.add(atom.action);
            atom.raw = slice.trim();
            atom.isSecondaryAtom = true;
            atoms.push(atom);
        }
    }

    return atoms;
}


// ---------------------------------------------------------------------------
// V14 STRUCTURAL RELATIONSHIP LAYER
// ---------------------------------------------------------------------------
// The parser already recognizes individual effects well enough for ranking. The next level is
// preserving *relationships* around those effects: who/what is targeted, when the effect fires,
// how a quantity is derived, and whether a clause is conditional, a cost, or a follow-up.
// These helpers intentionally add metadata instead of replacing the existing heuristic parser.
function parseStructuredTarget(text) {
    const t = String(text || '').toLowerCase();
    let kind = null;
    if (/\bany target\b/.test(t)) kind = 'any';
    else if (/\beach\s+(?:player|opponent|creature|permanent|artifact|enchantment|planeswalker|spell)\b/.test(t)) kind = 'each';
    else if (/\ball\s+(?:creatures?|players?|opponents?|permanents?|artifacts?|enchantments?|planeswalkers?|spells?)\b/.test(t)) kind = 'all';
    else if (/\btarget\b/.test(t)) kind = 'target';
    else if (/\byou\b/.test(t) && /\b(?:gain|lose|draw|discard|scry|surveil)\b/.test(t)) kind = 'you';

    let scope = null;
    if (/\byou control\b/.test(t)) scope = 'you_control';
    else if (/\ban opponent controls?\b|\bopponent controls?\b/.test(t)) scope = 'opponent_control';
    else if (/\byou own\b/.test(t)) scope = 'you_own';
    else if (/\ban opponent owns?\b|\bopponent owns?\b/.test(t)) scope = 'opponent_own';
    else if (/\byou\b/.test(t)) scope = 'you';
    else if (/\bopponent\b/.test(t)) scope = 'opponent';

    let object = null;
    const objectPatterns = [
        ['creature','creature'], ['permanent','permanent'], ['artifact','artifact'],
        ['enchantment','enchantment'], ['planeswalker','planeswalker'], ['instant or sorcery','spell'],
        ['spell','spell'], ['ability','ability'], ['card','card'], ['player','player'], ['opponent','opponent']
    ];
    for (const [needle, value] of objectPatterns) {
        if (new RegExp('\\b' + needle.replace(/ /g,'\\s+') + '\\b','i').test(t)) { object=value; break; }
    }
    return { kind, scope, object };
}

function parseQuantityProfile(text, parsedQuantity = null) {
    const t = String(text || '').toLowerCase();
    const out = { kind: parsedQuantity != null ? 'fixed' : null, value: parsedQuantity, relation: null, source: null, bound: null };
    if (/\bequal to\b/.test(t)) out.relation = 'equal_to';
    if (/\bfor each\b/.test(t)) out.relation = 'for_each';
    if (/\bthat many\b/.test(t)) out.relation = 'that_many';
    if (/\bbased on\b/.test(t)) out.relation = 'based_on';
    if (/\bequal to the number of\b/.test(t)) { out.relation = 'equal_to'; out.source = 'count'; }
    if (/\bequal to (?:its|their|that)\s+(?:power|toughness)\b/.test(t)) { out.relation = 'derived_stat'; out.source = 'power_or_toughness'; }
    if (/\bup to\b/.test(t)) { out.bound = 'up_to'; out.kind = 'bounded'; }
    if (/\bat least\b/.test(t)) { out.bound = 'at_least'; out.kind = 'bounded'; }
    if (/\bdouble\b|\btwice\b/.test(t)) { out.relation = 'multiplier'; out.source = /\btwice\b/.test(t) ? '2x' : '2x'; }
    if (/(?:\b|^)x(?:\b|\s)/i.test(t) || /\bX\b/i.test(text)) out.kind = 'variable';
    if (out.relation && out.kind === null) out.kind = 'derived';
    if (out.kind === null && parsedQuantity != null) out.kind = 'fixed';
    return out;
}

function parseTriggerProfile(text) {
    const t = String(text || '').toLowerCase();
    if (!/\b(?:when|whenever|at the beginning of|at the end of|at the start of|at the end of|if)\b/.test(t)) return null;
    let type = 'conditional';
    if (/\bwhenever\b/.test(t)) type = 'event';
    else if (/\bwhen\b/.test(t)) type = 'event';
    else if (/\bat the beginning of\b|\bat the start of\b/.test(t)) type = 'turn_window';
    else if (/\bat the end of\b/.test(t)) type = 'turn_window';
    const window = /\bat the beginning of your turn\b|\bat the start of your turn\b/.test(t) ? 'beginning_of_your_turn'
        : /\bat the end of your turn\b/.test(t) ? 'end_of_your_turn'
        : /\bat the beginning of each turn\b/.test(t) ? 'beginning_of_each_turn'
        : null;
    let event = null;
    const eventPatterns = [
        ['enters','enter_battlefield'], ['dies','dies'], ['attacks','attacks'], ['blocks','blocks'],
        ['casts','casts_spell'], ['cast','casts_spell'], ['draws a card','draw_card'], ['draw a card','draw_card'],
        ['discards','discard'], ['sacrifices','sacrifice'], ['deals damage','deals_damage'],
        ['gains life','gain_life'], ['loses life','lose_life'], ['creates','create'], ['is put into','zone_change']
    ];
    for (const [needle, value] of eventPatterns) { if (t.includes(needle)) { event=value; break; } }
    const threshold = (t.match(/\b(?:three|four|five|six|seven|eight|nine|ten|\d+)\+?\b/) || [null])[0];
    return { type, event, window, threshold, conditional: type === 'conditional' };
}

function annotateEffectRelationships(effect, sourceText) {
    const raw = String(effect.raw || sourceText || '');
    const targetProfile = parseStructuredTarget(raw);
    effect.targetProfile = targetProfile;
    if (!effect.target && targetProfile.kind) effect.target = targetProfile.kind;
    if (targetProfile.scope) {
        effect.controllerScope = targetProfile.scope;
        effect.restriction = Array.from(new Set([...(effect.restriction || []),
            ...(targetProfile.scope === 'you_control' ? ['controlledbyyou'] : []),
            ...(targetProfile.scope === 'opponent_control' ? ['controlledbyopponent'] : [])
        ]));
    }
    effect.quantityProfile = parseQuantityProfile(raw, effect.quantity);
    effect.triggerProfile = parseTriggerProfile(raw);
    effect.isTriggered = Boolean(effect.triggerProfile && effect.triggerProfile.type === 'event');
    effect.isConditional = Boolean(effect.condition || effect.triggerProfile?.conditional);
    effect.dependencyProfile = {
        hasThen: /\bthen\b/i.test(raw),
        hasIfYouDo: /\bif you do\b/i.test(raw),
        hasForEach: /\bfor each\b/i.test(raw),
        hasBasedOn: /\bbased on\b/i.test(raw),
        hasInstead: /\binstead\b/i.test(raw),
        hasUntil: /\buntil\b/i.test(raw),
        hasAsLongAs: /\bas long as\b/i.test(raw),
        role: effect.isCostEffect ? 'cost' : (/\bif you do\b/i.test(raw) ? 'dependent_followup' : (/\bthen\b/i.test(raw) ? 'followup' : 'primary'))
    };
    if (/\buntil end of turn\b|\bthis turn\b/i.test(raw)) effect.durationProfile = 'until_end_of_turn';
    else if (/\bas long as\b/i.test(raw)) effect.durationProfile = 'conditional_static';
    else if (/\bwhile\b/i.test(raw)) effect.durationProfile = 'while_condition';
    else if (effect.isStatic) effect.durationProfile = 'static';
    else effect.durationProfile = null;
    effect.effectMode = /\binstead\b/i.test(raw) ? 'replacement'
        : /\bprevent\b/i.test(raw) ? 'prevention'
        : /\bredirect\b/i.test(raw) ? 'redirection'
        : /\bcan't|cannot|can't be|prohibit/i.test(raw) ? 'prohibition'
        : 'normal';
    return effect;
}

function annotateEffectArray(effects) {
    (effects || []).forEach(e => annotateEffectRelationships(e, e.raw));
    return effects;
}

function parseMTGEffect(oracleText) {
    if (!oracleText) return [];

    // Split on sentences, semicolons, bullet points, and rule keywords. Newlines are always a
    // hard boundary (not just when preceded by sentence punctuation) - otherwise a modal header
    // ending in an em dash ("Choose one —") never separates from its first bullet line, since
    // "—" isn't sentence punctuation.
    const clauses = oracleText
        .split(/\n+|(?<=[.!?;])\s+|\b(?:then|otherwise)\b/i)
        .map(s => s.trim())
        .filter(Boolean);

    // Modal spells ("Choose one —" / "Choose two —" / "Choose one or more —") list their modes
    // as separate bullet-prefixed lines. Track the active mode group across clauses so each
    // mode is tagged with which group and "choose how many" header it belongs to, instead of
    // looking like unrelated standalone effects (project spec: multiple simultaneous modes).
    const modalHeaderRegex = /^\s*choose\s+(one|two|up to two|up to three|one or more|any number)\b.*[—-]\s*$/i;
    const bulletPrefixRegex = /^[•●]\s*|^-\s+/;
    let activeModeGroup = null;
    let modeGroupCounter = 0;

    const results = [];

    for (const rawClause of clauses) {
        const modalHeaderMatch = rawClause.match(modalHeaderRegex);
        if (modalHeaderMatch) {
            modeGroupCounter++;
            activeModeGroup = { count: modalHeaderMatch[1].toLowerCase(), groupId: modeGroupCounter };
            continue; // the header itself isn't a scoreable effect
        }

        const isBulletLine = bulletPrefixRegex.test(rawClause);
        const clause = rawClause.replace(bulletPrefixRegex, '');

        const { costText, effectText } = splitActivationCost(clause);

        const parsed =
            parseCostReductionEffect(effectText) ||
            parseCounterEffect(effectText) ||
            parseSearchEffect(effectText) ||
            parseTokenEffect(effectText) ||
            parseAnthemEffect(effectText) ||
            parseCounterPlacementEffect(effectText) ||
            parseControlChangeEffect(effectText) ||
            parseTapEffect(effectText) ||
            parseDamageEffect(effectText) ||
            parseManaAbilityEffect(effectText) ||
            parseLifeEffect(effectText) ||
            parseZoneMovementEffect(effectText) ||
            {
                raw: clause,
                action: "generic",
                object: null,
                target: /\btarget\b/i.test(effectText) ? "target" : null,
                restriction: extractMTGRestrictions(effectText)
            };
        parsed.raw = parsed.raw || clause;

        // The sub-parsers capture restrictions from the text BEFORE the noun ("destroy target
        // [artifact] creature"), so a qualifier that trails the noun - "destroy target creature
        // YOU CONTROL" - was being dropped entirely. That's the single most important restriction
        // there is: it flips an effect from removal into a sacrifice outlet. Re-scan the whole
        // clause for control scope and merge it in, so the contradiction penalty can actually see
        // it (review Priority 7).
        const clauseControlTokens = extractMTGRestrictions(effectText)
            .filter(t => t === 'controlledbyyou' || t === 'controlledbyopponent');
        if (clauseControlTokens.length > 0) {
            parsed.restriction = Array.from(new Set([...(parsed.restriction || []), ...clauseControlTokens]));
        }

        // Layer in condition/payCost/additionalEffects for every clause type, not just the ones
        // whose specialized sub-parser happens to detect them - fills gaps only, so a sub-parser's
        // own (more precise) detection is never overwritten (project spec 2.3).
        const extra = extractConditionsAndCosts(clause);
        if (parsed.condition === undefined || parsed.condition === null) parsed.condition = extra.condition;
        if (!parsed.conditionDetail) parsed.conditionDetail = extra.conditionDetail;
        if (parsed.payCost === undefined || parsed.payCost === null) parsed.payCost = extra.payCost;
        if (parsed.quantity === undefined || parsed.quantity === null) parsed.quantity = extra.quantity;
        parsed.additionalEffects = Array.from(new Set([...(parsed.additionalEffects || []), ...extra.additionalEffects]));

        // A genuine activation cost (isolated above from the actual effect text) is kept as its
        // own structured field rather than folded into the single opaque payCost string, so a
        // compound cost can be compared part-by-part (project spec: cost-then-effect sequencing).
        if (costText) {
            parsed.activationCost = classifyActivationCost(costText);
            if (!parsed.payCost) parsed.payCost = parsed.activationCost.type;
        }

        if (activeModeGroup && isBulletLine) {
            parsed.isMode = true;
            parsed.modeGroupId = activeModeGroup.groupId;
            parsed.modeCount = activeModeGroup.count;
        } else {
            activeModeGroup = null;
        }

        results.push(parsed);

        // A compound clause contributes every effect it contains, not only its dominant verb.
        const extraAtoms = extractClauseAtoms(effectText, parsed.action);
        for (const atom of extraAtoms) {
            if (parsed.isMode) {
                atom.isMode = true;
                atom.modeGroupId = parsed.modeGroupId;
                atom.modeCount = parsed.modeCount;
            }
            results.push(atom);
        }

        // The activation cost is itself an effect (sacrificing, discarding, exiling something),
        // but it's a price paid rather than the ability's purpose - captured so cost structure can
        // be compared, flagged so the importance model never mistakes it for the payoff.
        if (costText) {
            const costAtom = parseZoneMovementEffect(costText);
            if (costAtom && costAtom.action) {
                costAtom.raw = costText;
                costAtom.isCostEffect = true;
                results.push(costAtom);
            }
        }
    }

    // Add relationship metadata before canonicalization so the canonical representation can carry
    // target/quantity/trigger/dependency structure downstream.
    annotateEffectArray(results);

    // Derive the canonical function for every effect and work out which one actually defines the
    // card, rather than leaving downstream code to assume "the first one parsed".
    return assignEffectImportance(results);
}

/**
 * Calculates mechanical similarity percentage (0.0 to 1.0) between two parsed card structures.
 * @param {Array<Object>} parsedA 
 * @param {Array<Object>} parsedB 
 * @returns {number} Score between 0.0 and 1.0
 */
// Two-level action taxonomy: family groups actions that serve a similar strategic role
// (e.g. "removal"), while outcome captures what actually happens to the affected object at a
// rules level - "destroy" and "sacrifice" both put a creature in the graveyard (same outcome,
// so death-trigger synergies still line up), while "exile" removes it entirely (same family,
// different outcome, since exile bypasses graveyard-recursion answers). This lets action
// alignment reward a true rules-level equivalent more than a same-family-but-different-effect
// verb, instead of only ever being right or a single flat "related" tier
// (project spec ranking B: Action -> Function -> Outcome hierarchy).
const ACTION_TAXONOMY = {
    destroy:     { family: "removal",               outcome: "creature_to_graveyard" },
    sacrifice:   { family: "removal",               outcome: "creature_to_graveyard" },
    exile:       { family: "removal",               outcome: "removed_from_game" },
    return:      { family: "reanimation_recursion", outcome: "to_battlefield_or_hand" },
    put:         { family: "reanimation_recursion", outcome: "to_battlefield_or_hand" },
    create:      { family: "tokens",                outcome: "new_permanent" },
    multiply:    { family: "tokens",                outcome: "new_permanent" },
    copy_token:  { family: "tokens",                outcome: "new_permanent" },
    draw:        { family: "card_advantage",        outcome: "cards_to_hand" },
    mill:        { family: "card_advantage",        outcome: "cards_to_graveyard" },
    counter:     { family: "counter",                outcome: "spell_or_ability_stopped" },
    gain_control:{ family: "control_change",         outcome: "permanent_control_changed" },
    cost_reduction:{ family: "cost_modification",   outcome: "spell_cost_reduced" },
    search:      { family: "tutor",                  outcome: "card_found" },
    stat_buff:   { family: "stat_buff",              outcome: "stats_or_keywords_changed" },
    discard:     { family: "discard",                outcome: "cards_hand_to_graveyard" },
    damage:      { family: "damage",                 outcome: "damage_dealt" },
    add_mana:    { family: "mana",                   outcome: "mana_added" },
    gain_life:   { family: "life_total",             outcome: "life_total_increased" },
    lose_life:   { family: "life_total",             outcome: "life_total_decreased" },
    // Shares a family with stat_buff (both change a creature's stats/board presence) but a
    // different outcome - a one-shot targeted counter is structurally very different from a
    // continuous team-wide anthem, even though both are "stats go up/down" in spirit.
    place_counter: { family: "stat_buff",            outcome: "stats_changed_one_shot" },
    // Tap and untap share a family (both change a permanent's tapped state) but opposite
    // outcomes - tapping down a blocker and untapping your own permanent for an extra activation
    // serve opposite strategic purposes despite the shared verb family.
    tap:         { family: "tap_control",            outcome: "permanent_tapped" },
    untap:       { family: "tap_control",            outcome: "permanent_untapped" }
};

// Backward-compatible view used anywhere only the coarse family grouping is needed.
const ACTION_GROUPS = Object.fromEntries(Object.entries(ACTION_TAXONOMY).map(([action, t]) => [action, t.family]));

// ---------------------------------------------------------------------------
// CANONICAL MTG FUNCTION LAYER
// ---------------------------------------------------------------------------
// The raw parser tells us the VERB a clause uses (action: "return"). That isn't enough on its
// own, because the same verb serves completely different strategic purposes depending on the
// zones involved: "return ... from graveyard to battlefield" is reanimation, "return ... to its
// owner's hand" is a bounce/tempo effect, and "return ... from graveyard to hand" is recursion.
// Conversely, different verbs can mean the same thing ("return"/"put" onto the battlefield).
//
// deriveCanonicalFunction() collapses (action + zones + object + params) into one canonical
// {function, outcome, params} record. That record - not the raw verb - is what retrieval query
// generation, mechanical scoring, and the functional embedding all consume, so adding a new
// mechanic means adding a mapping here rather than another special-case branch in three
// different places (review Priority 2 / Priority 5: canonical representation + outcome hierarchy).
//
// "function" = the strategic purpose ("reanimate"). "outcome" = the rules-level game-state change
// ("permanent_enters_from_graveyard"). Two cards can share an outcome without sharing a function
// and vice versa, so both tiers are scored separately.
const FUNCTION_OUTCOMES = {
    reanimate:        "permanent_enters_from_graveyard",
    recursion:        "card_returns_to_hand",
    bounce:           "permanent_leaves_battlefield",
    cheat_into_play:  "permanent_enters",
    tuck:             "permanent_leaves_battlefield",
    zone_change:      "card_changes_zone",
    removal:          "permanent_to_graveyard",
    self_sacrifice:   "own_permanent_to_graveyard",
    exile_removal:    "permanent_exiled",
    counter:          "spell_or_ability_stopped",
    gain_control:     "permanent_control_changed",
    cost_reduction:   "spell_cost_reduced",
    tutor:            "card_found",
    ramp_tutor:       "resources_increase",
    token_creation:   "new_permanent",
    token_multiplier: "new_permanent",
    tribal_anthem:    "stats_or_keywords_changed",
    anthem:           "stats_or_keywords_changed",
    card_draw:        "cards_to_hand",
    mill:             "cards_to_graveyard",
    discard:          "cards_hand_to_graveyard",
    direct_damage:    "damage_dealt",
    mana_ability:     "mana_added",
    gain_life:        "life_total_increased",
    lose_life:        "life_total_decreased",
    place_counter:    "stats_changed_one_shot",
    tap:              "permanent_tapped",
    untap:            "permanent_untapped"
};

/**
 * Collapses one parsed effect into its canonical {function, outcome, params} form.
 * @param {Object} effect - a single parsed clause/atom from parseMTGEffect
 * @returns {Object|null} canonical record, or null when the clause had no recognized action
 */
function deriveCanonicalFunction(effect) {
    if (!effect || !effect.action || effect.action === "generic") return null;

    const a = effect.action;
    const from = effect.from || null;
    const to = effect.to || null;
    const obj = effect.object || null;
    const restriction = effect.restriction || [];

    let fn = null;

    if (a === "return" || a === "put") {
        if (from === "graveyard" && to === "battlefield") fn = "reanimate";
        else if (from === "graveyard" && to === "hand") fn = "recursion";
        else if (to === "hand") fn = "bounce";
        else if (to === "battlefield") fn = "cheat_into_play";
        else if (to === "library") fn = "tuck";
        else fn = "zone_change";
    } else if (a === "destroy" || a === "sacrifice") {
        // "Destroy TARGET creature" is removal aimed at something. "Sacrifice a creature" with no
        // target is you giving up your own permanent - a cost or an aristocrats enabler, not an
        // answer to an opponent's threat. Treating both as plain "removal" made Birthing Pod look
        // like a removal spell and let its sacrifice clause outrank the tutor that actually
        // defines the card.
        const isSelfSacrifice = (a === "sacrifice") && effect.target !== "target" && !restriction.includes('controlledbyopponent');
        fn = isSelfSacrifice ? "self_sacrifice" : "removal";
    } else if (a === "exile") {
        fn = "exile_removal";
    } else if (a === "counter") {
        fn = "counter";
    } else if (a === "gain_control") {
        fn = "gain_control";
    } else if (a === "cost_reduction") {
        fn = "cost_reduction";
    } else if (a === "search") {
        fn = restriction.includes("land") ? "ramp_tutor" : "tutor";
    } else if (a === "multiply" || a === "copy_token") {
        fn = "token_multiplier";
    } else if (a === "create") {
        fn = "token_creation";
    } else if (a === "stat_buff") {
        fn = (effect.subtype && effect.subtype !== "all") ? "tribal_anthem" : "anthem";
    } else if (a === "draw") {
        fn = "card_draw";
    } else if (a === "mill") {
        fn = "mill";
    } else if (a === "discard") {
        fn = "discard";
    } else if (a === "damage") {
        fn = "direct_damage";
    } else if (a === "add_mana") {
        fn = "mana_ability";
    } else if (a === "gain_life" || a === "lose_life") {
        // Kept as two distinct functions, not one "life_change" - gaining and losing life are
        // opposite effects that happen to share a family (see ACTION_TAXONOMY), and collapsing
        // them into one function would let a lifegain card and a life-loss/drain card score as
        // equivalent, which they clearly aren't.
        fn = a;
    } else if (a === "place_counter") {
        fn = "place_counter";
    } else if (a === "tap" || a === "untap") {
        // Same reasoning as gain_life/lose_life: opposite effects, kept as separate functions
        // rather than one "tap_state_change" that would score a Falter effect and an Untap-all
        // ramp effect as equivalent.
        fn = a;
    } else {
        return null;
    }

    // A tutor that ends on the battlefield is a materially different outcome from one that ends
    // in hand, so refine the generic outcome where the destination zone is actually known.
    let outcome = FUNCTION_OUTCOMES[fn] || "unknown";
    if (fn === "tutor" && to === "battlefield") outcome = "permanent_enters";
    if (fn === "tutor" && to === "hand") outcome = "card_found_to_hand";

    // Damage amount and mana amount/color both live outside the shared from/to/object shape every
    // other function uses, so they're folded into the existing magnitude/quantity params here
    // rather than adding function-specific fields that every OTHER consumer of a canonical
    // function record would need to know to ignore.
    let magnitude = effect.powerToughness || null;
    let quantity = effect.quantity ?? null;
    if (fn === "direct_damage") {
        magnitude = `${effect.amount} damage`;
        quantity = typeof effect.amount === 'number' ? effect.amount : null;
    } else if (fn === "mana_ability") {
        const colorPart = effect.colors && effect.colors.length > 0 ? effect.colors.join('/') : null;
        magnitude = [effect.amount, colorPart, 'mana'].filter(Boolean).join(' ');
        quantity = typeof effect.amount === 'number' ? effect.amount : null;
    } else if (fn === "gain_life" || fn === "lose_life") {
        magnitude = `${effect.amount} life`;
        quantity = typeof effect.amount === 'number' ? effect.amount : null;
    } else if (fn === "place_counter") {
        magnitude = effect.counterType || null;
        quantity = typeof effect.quantity === 'number' ? effect.quantity : null;
    }

    return {
        function: fn,
        outcome,
        params: {
            object: obj,
            from,
            to,
            target: effect.target || null,
            subtype: effect.subtype && effect.subtype !== "all" ? effect.subtype : null,
            scope: effect.isOther === true ? "other" : (effect.isOther === false ? "all" : null),
            magnitude,
            quantity,
            duration: effect.isStatic === true ? "static" : (effect.isStatic === false ? "temporary" : null),
            controller: effect.controller || null,
            restriction,
            targetProfile: effect.targetProfile || null,
            quantityProfile: effect.quantityProfile || null,
            triggerProfile: effect.triggerProfile || null,
            dependencyProfile: effect.dependencyProfile || null,
            durationProfile: effect.durationProfile || null,
            effectMode: effect.effectMode || "normal",
            controllerScope: effect.controllerScope || null,
            isMode: Boolean(effect.isMode),
            modeGroupId: effect.modeGroupId ?? null,
            modeCount: effect.modeCount || null,
            controlChangeDuration: effect.controlChangeDuration || null,
            condition: effect.condition || null,
            conditionDetail: effect.conditionDetail || null,
            payCost: effect.payCost || null,
            activationCost: effect.activationCost || null,
            additionalEffects: effect.additionalEffects || [],
            isCostEffect: Boolean(effect.isCostEffect),
            raw: effect.raw || null
        }
    };
}

/**
 * Renders a canonical function as a short natural-language sentence. This is what gets fed to
 * the sentence-embedding model as the *functional* embedding, so the model compares normalized
 * MTG meaning ("reanimate a creature from graveyard to battlefield") rather than being asked to
 * infer mechanics from arbitrary Oracle phrasing itself (review Priority 8).
 * @param {Array<Object>} canonicalFunctions
 * @returns {string}
 */
function canonicalFunctionToText(canonicalFunctions) {
    if (!canonicalFunctions || canonicalFunctions.length === 0) return "";
    return canonicalFunctions.map(cf => {
        const p = cf.params || {};
        const bits = [cf.function.replace(/_/g, ' ')];
        if (p.object) bits.push(p.object);
        if (p.subtype) bits.push(p.subtype);
        if (p.scope === "other") bits.push("other");
        if (p.from) bits.push(`from ${p.from}`);
        if (p.to) bits.push(`to ${p.to}`);
        if (p.magnitude) bits.push(p.magnitude);
        if (typeof p.quantity === 'number') bits.push(`${p.quantity}`);
        if (p.duration) bits.push(p.duration);
        bits.push(cf.outcome.replace(/_/g, ' '));
        return bits.join(' ');
    }).join('; ');
}

// How strategically defining each canonical function tends to be. Used by the importance model
// below to pick a card's PRIMARY function: on "Sacrifice a creature: Draw a card, then return a
// creature from your graveyard", the reanimation is what defines the card, not the incidental
// draw - and neither is simply "whichever effect was parsed first" (review Priority 1).
const FUNCTION_IMPORTANCE = {
    reanimate: 1.0, counter: 1.0, token_multiplier: 1.0, tribal_anthem: 1.0, gain_control: 0.85,
    removal: 0.9, exile_removal: 0.9, tutor: 0.9, ramp_tutor: 0.85, direct_damage: 0.9,
    self_sacrifice: 0.4,
    cheat_into_play: 0.85, recursion: 0.75, anthem: 0.75, token_creation: 0.7, mana_ability: 0.85,
    bounce: 0.65, tuck: 0.6, mill: 0.55, discard: 0.5, card_draw: 0.45, cost_reduction: 0.90,
    gain_life: 0.55, lose_life: 0.55,
    // A targeted +1/+1 counter is a real combat trick/pump effect - meaningfully defining for a
    // card built around it (an "outlast"/counters deck payoff), on par with recursion or a
    // one-shot anthem. Tap/untap are usually a supporting piece of a bigger card (a Falter effect,
    // an untap-lands ramp trick) rather than the point of the card on their own, so they sit lower.
    place_counter: 0.7, tap: 0.5, untap: 0.5,
    zone_change: 0.4
};

/**
 * Assigns an importance score to every parsed effect and marks the primary one.
 * Importance combines: how defining the canonical function is, whether the effect is the clause's
 * main action or a trailing atom, whether it's part of an activation COST rather than the payoff,
 * and (weakly) its position. Position alone is a poor proxy - plenty of cards open with a rider.
 * @param {Array<Object>} effects - parsed effects from parseMTGEffect (mutated in place)
 * @returns {Array<Object>} the same array, with .canonical/.importance/.isPrimary set
 */
function assignEffectImportance(effects) {
    if (!effects || effects.length === 0) return effects || [];

    effects.forEach((eff, index) => {
        eff.canonical = deriveCanonicalFunction(eff);

        if (!eff.canonical) {
            eff.importance = 0.05; // unparsed/generic filler
            return;
        }

        let score = FUNCTION_IMPORTANCE[eff.canonical.function] ?? 0.5;

        // An effect extracted as a trailing atom of a compound clause ("..., then draw a card")
        // is by construction a follow-on, not the headline.
        if (eff.isSecondaryAtom) score *= 0.6;

        // Something you PAY (an activation cost) is a price, not the card's purpose.
        if (eff.isCostEffect) score *= 0.35;

        // A mode of a modal spell is one option among several, so no single mode fully defines
        // the card the way a lone unconditional effect does.
        if (eff.isMode) score *= 0.85;

        // Mild positional prior: leading clauses are somewhat more likely to be the headline.
        score *= (index === 0 ? 1.1 : 1.0);

        eff.importance = Math.min(1, score);
    });

    let best = null;
    effects.forEach(eff => {
        if (!best || (eff.importance || 0) > (best.importance || 0)) best = eff;
    });
    effects.forEach(eff => { eff.isPrimary = (eff === best && (eff.importance || 0) > 0.05); });

    return effects;
}

/**
 * Returns a card's canonical functions ordered by importance (primary first).
 * @param {Array<Object>} effects
 * @returns {Array<Object>} canonical records
 */
function getCanonicalFunctions(effects) {
    return (effects || [])
        .filter(e => e.canonical)
        .slice()
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .map(e => e.canonical);
}


// ---------------------------------------------------------------------------
// STRATEGIC / ARCHETYPAL ROLE LAYER (V16)
// ---------------------------------------------------------------------------
// Mechanical similarity answers "does the candidate perform the same rules action?".
// Strategic-role similarity answers a different question: "does this card occupy a similar
// deckbuilding role, even when the implementation is different?"  This layer is intentionally
// conservative. A role is emitted only when multiple MTG-specific anchors agree, because broad
// words like "card", "mana", or "creature" by themselves are not useful evidence.
const STRATEGIC_ROLE_GROUPS = {
    fast_mana: 'acceleration',
    land_ramp: 'acceleration',
    catch_up_ramp: 'acceleration',
    card_advantage_engine: 'card_advantage',
    token_engine: 'tokens',
    token_multiplier: 'tokens',
    tribal_anthem: 'tribal',
    anthem: 'combat_synergy',
    board_wipe: 'interaction',
    single_target_removal: 'interaction',
    counterspell: 'interaction',
    bounce: 'interaction',
    burn: 'interaction',
    graveyard_recursion: 'recursion',
    tutor: 'tutor',
    discard_engine: 'disruption',
    mill_engine: 'disruption',
    life_gain_engine: 'life_resource',
    life_loss_engine: 'life_resource'
};

const STRATEGIC_ROLE_MIN_SCORE = 0.62;

function strategicRoleCardText(card) {
    if (!card) return '';
    return String(card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text || '').join(' ') : '') || '').trim();
}

function strategicRoleFunctions(parsedEffects) {
    return (parsedEffects || [])
        .filter(e => e && e.canonical)
        .map(e => e.canonical.function)
        .filter(Boolean);
}

function strategicRoleHasFunction(parsedEffects, fn) {
    return strategicRoleFunctions(parsedEffects).includes(fn);
}

function strategicRoleHasTrigger(parsedEffects) {
    return (parsedEffects || []).some(e => e.triggerProfile || e.isTriggered || /\b(?:whenever|at the beginning of|at the end of)\b/i.test(e.raw || ''));
}

function strategicRoleMaxNumber(parsedEffects, fn) {
    let max = 0;
    for (const e of (parsedEffects || [])) {
        if (!e.canonical || e.canonical.function !== fn) continue;
        if (typeof e.quantity === 'number') max = Math.max(max, e.quantity);
        if (typeof e.amount === 'number') max = Math.max(max, e.amount);
        if (typeof e.canonical.params?.quantity === 'number') max = Math.max(max, e.canonical.params.quantity);
    }
    return max;
}

function strategicRoleAdd(out, role, score, anchors, confidenceBoost = 0) {
    const cleanAnchors = Array.from(new Set((anchors || []).filter(Boolean)));
    const anchorBonus = Math.min(0.10, cleanAnchors.length * 0.025) + confidenceBoost;
    const finalScore = Math.min(1, score + anchorBonus);
    if (finalScore < STRATEGIC_ROLE_MIN_SCORE) return;
    const existing = out.find(x => x.role === role);
    const record = {
        role,
        group: STRATEGIC_ROLE_GROUPS[role] || role,
        score: finalScore,
        anchors: cleanAnchors
    };
    if (!existing || finalScore > existing.score) {
        if (existing) Object.assign(existing, record);
        else out.push(record);
    }
}

function inferStrategicRoleProfile(card, parsedEffects = [], intentText = '') {
    const text = strategicRoleCardText(card);
    const lower = `${text} ${String(intentText || '')}`.toLowerCase();
    const typeLine = String(card?.type_line || '').toLowerCase();
    const roles = [];
    const functions = new Set(strategicRoleFunctions(parsedEffects));
    const recurring = strategicRoleHasTrigger(parsedEffects) || /\b(?:whenever|at the beginning of|at the end of)\b/.test(lower);
    const activated = /\bpay\b|\{t\}|\b:\s*(?:add|draw|return|exile|search|create)/i.test(text);
    const permanent = /\b(?:creature|artifact|enchantment|planeswalker)\b/.test(typeLine);

    // Fast mana: require an explicit mana-producing ability plus either >1 mana per activation,
    // or a clearly early/efficient nonland permanent. A generic "add one mana" land is not enough.
    const maxMana = strategicRoleMaxNumber(parsedEffects, 'mana_ability');
    if (functions.has('mana_ability')) {
        const multiManaText = /\badd\s+(?:\{[wubrgc]\}\s*){2,}|\badd\s+(?:two|three|four)\b/i.test(text);
        const lowCostPermanent = permanent && Number.isFinite(card?.cmc) && card.cmc <= 2;
        if (maxMana >= 2 || multiManaText) {
            strategicRoleAdd(roles, 'fast_mana', 0.82, ['reusable mana production', 'multiple mana per activation'], lowCostPermanent ? 0.05 : 0);
        } else if (lowCostPermanent && activated) {
            strategicRoleAdd(roles, 'fast_mana', 0.64, ['early permanent mana source', 'activated mana ability']);
        }
    }

    // Land ramp / catch-up ramp. These rely on explicit library/basic-land language plus moving
    // a land into play or a known catch-up condition. This is intentionally narrower than "tutor".
    const searchesLand = functions.has('ramp_tutor') || (functions.has('tutor') && /\b(?:basic|land|plains|island|swamp|mountain|forest)\b/.test(lower));
    const putLandIntoPlay = /\bsearch your library\b[^.]{0,120}\b(?:land|basic land|plains|island|swamp|mountain|forest)\b[^.]{0,120}\bput (?:it|that card|the card)\b[^.]{0,60}\b(?:onto|to) the battlefield\b/.test(lower)
        || /\b(?:put|return)\b[^.]{0,120}\b(?:land|basic land|plains|island|swamp|mountain|forest)\b[^.]{0,60}\b(?:onto|to) the battlefield\b/.test(lower);
    if (searchesLand && putLandIntoPlay) {
        const catchUp = /\b(?:opponent|opponents)\b[^.]{0,90}\b(?:more lands|more land)\b|\bfewer lands\b|\bif an opponent controls more lands\b/.test(lower);
        strategicRoleAdd(roles, catchUp ? 'catch_up_ramp' : 'land_ramp', catchUp ? 0.88 : 0.72,
            [catchUp ? 'opponent has more lands' : 'land-search', 'land into play']);
    }

    // Recurring card advantage engine: a draw effect alone is too broad. Require repeated timing,
    // an activated resource payment, or explicit top-of-library/exile-to-hand acquisition. This
    // intentionally catches Arena, Dark Confidant and Necropotence despite different wording.
    const directDraw = /\bdraw\s+(?:a|one|two|three|four|five|x)\s+cards?\b/.test(lower);
    const handAcquisition = /\b(?:put|puts|return|returns)\b[^.]{0,90}\b(?:card|cards|that card|those cards)\b[^.]{0,50}\b(?:into|to) your hand\b/.test(lower);
    const topCardAcquisition = /\b(?:reveal|exile)\s+the top card\b[^.]{0,100}\b(?:hand|put it into your hand|cards? exiled)\b/.test(lower);
    const recurringAcquisition = directDraw || handAcquisition || topCardAcquisition;
    const resourceExchange = /\b(?:pay|lose)\s+\d+\s+life\b|\bpay\s+life\b|\breveal the top card\b|\bskip your draw step\b/.test(lower);
    if (recurringAcquisition && (recurring || activated || resourceExchange)) {
        strategicRoleAdd(roles, 'card_advantage_engine', 0.84,
            [directDraw ? 'card draw' : 'card acquisition', recurring ? 'repeat timing' : null, resourceExchange ? 'resource exchange' : null]);
    }

    // Token roles. A multiplier is distinct from a token creator; recurring creation requires a
    // trigger or permanent-based source rather than a one-shot spell.
    if (functions.has('token_multiplier') || /\b(?:twice|double|two times)\b[^.]{0,70}\b(?:token|tokens)\b/.test(lower)) {
        strategicRoleAdd(roles, 'token_multiplier', 0.90, ['token multiplication']);
    }
    if (functions.has('token_creation')) {
        strategicRoleAdd(roles, 'token_engine', recurring || permanent ? 0.75 : 0.63,
            ['token creation', recurring ? 'repeated creation' : null]);
    }

    // Tribal anthem: subtype-specific team buff is much more discriminating than a generic anthem.
    const tribalBuffPattern = /\bother\s+(?:[a-z]+\s+)?(?:creatures?|merfolk|elves?|goblins?|zombies?|soldiers?|humans?|spirits?|knights?|wizards?|cats?|dogs?|dragons?|angels?|vampires?|clerics?|warriors?)\s+get\s+[+−+\-]\d+\/[+−+\-]\d+/i;
    if (functions.has('tribal_anthem') || tribalBuffPattern.test(lower)) {
        const tribeMatch = lower.match(/\b(?:other\s+)?([a-z]+)\s+(?:creatures?|merfolk|elves?|goblins?|zombies?|soldiers?|humans?|spirits?|knights?|wizards?|cats?|dogs?|dragons?|angels?|vampires?|clerics?|warriors?)\s+get\s+[+−+\-]\d+\/[+−+\-]\d+/i);
        strategicRoleAdd(roles, 'tribal_anthem', 0.86, ['tribe-specific anthem', tribeMatch ? tribeMatch[1] : null]);
    }

    // General anthem: reserve for team-wide stat/keyword changes that are not clearly tribal.
    if (functions.has('anthem') && !functions.has('tribal_anthem')) {
        strategicRoleAdd(roles, 'anthem', 0.70, ['team stat/keyword buff']);
    }

    // Interaction roles. Board wipe needs explicit mass language; removal needs a target; counter
    // needs the canonical counter function. Burn is constrained to direct damage + low investment
    // so a big creature's damage trigger doesn't become "Lightning Bolt-like".
    if (functions.has('counter')) {
        strategicRoleAdd(roles, 'counterspell', 0.90, ['counter magic']);
    }
    const massText = /\b(?:destroy|exile)\s+(?:all|each)\s+(?:creatures?|permanents?|planeswalkers?|artifacts?|enchantments?|players?)\b/.test(lower);
    if (massText) {
        strategicRoleAdd(roles, 'board_wipe', 0.90, ['mass removal']);
    } else if ((functions.has('removal') || functions.has('exile_removal')) && /\b(?:destroy|exile)\b/.test(lower)) {
        strategicRoleAdd(roles, 'single_target_removal', 0.75, ['permanent removal']);
    }
    if (/\breturn\b[^.]{0,100}\btarget\b[^.]{0,80}(?:to|into) its owner(?:'s|s) hand\b/.test(lower) || /\breturn\b[^.]{0,100}\b(?:permanent|creature|artifact|enchantment|planeswalker)\b[^.]{0,80}\bto its owner(?:'s|s) hand\b/.test(lower)) {
        strategicRoleAdd(roles, 'bounce', 0.78, ['bounce/tempo']);
    }
    const damage = functions.has('direct_damage');
    if (damage) {
        const lowCost = Number.isFinite(card?.cmc) && card.cmc <= 2;
        const smallSpell = /\b(?:instant|sorcery)\b/.test(typeLine) || /\bdeal(?:s|)\s+\d+\s+damage\b/.test(lower);
        strategicRoleAdd(roles, 'burn', lowCost || smallSpell ? 0.78 : 0.66, ['direct damage', lowCost ? 'low cost' : null]);
    }

    // Recursion and tutors.
    if (functions.has('reanimate') || functions.has('recursion')) {
        strategicRoleAdd(roles, 'graveyard_recursion', 0.88, ['graveyard return']);
    }
    if (functions.has('tutor') || functions.has('ramp_tutor')) {
        strategicRoleAdd(roles, 'tutor', 0.72, ['search library']);
    }
    if (functions.has('discard')) {
        strategicRoleAdd(roles, 'discard_engine', recurring ? 0.72 : 0.63, ['discard', recurring ? 'repeated disruption' : null]);
    }
    if (functions.has('mill')) {
        strategicRoleAdd(roles, 'mill_engine', recurring ? 0.72 : 0.63, ['mill', recurring ? 'repeated mill' : null]);
    }
    if (functions.has('gain_life') && /\b(?:gain|gains)\s+(?:\d+|life)\s+life\b/.test(lower)) strategicRoleAdd(roles, 'life_gain_engine', recurring ? 0.72 : 0.63, ['life gain']);
    if (functions.has('lose_life') && /\b(?:you|target|each opponent|opponent)\s+(?:lose|loses)\s+(?:\d+|life)\s+life\b/.test(lower)) strategicRoleAdd(roles, 'life_loss_engine', recurring ? 0.72 : 0.63, ['life loss']);

    roles.sort((a, b) => b.score - a.score);
    return roles.slice(0, 4);
}

function calculateStrategicRoleScore(sourceProfile, candidateProfile, sourceFingerprint = null, candidateFingerprint = null) {
    if (!sourceProfile?.length || !candidateProfile?.length) return 0;
    let best = 0;
    for (const sourceRole of sourceProfile) {
        for (const candidateRole of candidateProfile) {
            const sameRole = sourceRole.role === candidateRole.role;
            const sameGroup = sourceRole.group && candidateRole.group && sourceRole.group === candidateRole.group;
            if (!sameRole && !sameGroup) continue;

            const strength = Math.sqrt(Math.max(0, sourceRole.score) * Math.max(0, candidateRole.score));
            let match = 0;
            if (sameRole) {
                const anchorOverlap = new Set(sourceRole.anchors || []).size > 0
                    ? (candidateRole.anchors || []).filter(a => (sourceRole.anchors || []).includes(a)).length / Math.max(1, new Set(sourceRole.anchors || []).size)
                    : 0;
                const fingerprintMatch = roleFingerprintSimilarity(sourceFingerprint, candidateFingerprint);
                // Same role is only a hypothesis. Specific role fingerprints carry most of the
                // evidence so generic rocks/card-draw permanents do not all cluster near 1.0.
                match = 0.15 + (0.30 * strength) + (0.45 * fingerprintMatch) + (0.10 * anchorOverlap);
            } else {
                match = 0.20 + 0.22 * strength;
            }
            best = Math.max(best, Math.min(1, match));
        }
    }
    return best;
}

function extractNumericWords(text) {
    const lower = String(text || '').toLowerCase();
    const wordValues = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12 };
    const out = [];
    for (const m of lower.matchAll(/\b(\d+)\b/g)) out.push(Number(m[1]));
    for (const m of lower.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g)) out.push(wordValues[m[1]]);
    return out.filter(Number.isFinite);
}

function buildStrategicRoleFingerprint(card, parsedEffects = [], profile = []) {
    const text = strategicRoleCardText(card);
    const lower = text.toLowerCase();
    const topRole = profile?.[0]?.role || null;
    const recurring = strategicRoleHasTrigger(parsedEffects) || /\b(?:whenever|at the beginning of|at the end of|each upkeep|each turn|every turn)\b/.test(lower);
    const permanent = /\b(?:creature|artifact|enchantment|planeswalker)\b/.test(String(card?.type_line || '').toLowerCase());
    const damageAmounts = [...lower.matchAll(/\b(?:deal|deals)\s+(\d+)\s+damage\b/g)].map(m => Number(m[1])).filter(Number.isFinite);
    const manaBraces = lower.match(/\{[wubrgc]\}/g) || [];
    const manaPerActivation = Math.max(
        strategicRoleMaxNumber(parsedEffects, 'mana_ability') || 0,
        (manaBraces.length >= 2 && /\badd\b/.test(lower)) ? manaBraces.length : 0,
        /\badd\s+(?:two|three|four)\b/.test(lower) ? (lower.includes('four') ? 4 : lower.includes('three') ? 3 : 2) : 0
    );
    const drawAmount = Math.max(
        ...[...lower.matchAll(/\bdraw\s+(\d+)\s+cards?\b/g)].map(m => Number(m[1])).filter(Number.isFinite),
        /\bdraw\s+(?:a|one)\s+card\b/.test(lower) ? 1 : 0,
        0
    );
    const lifePaid = /\b(?:pay|lose)\s+(?:\d+|a|one)\s+life\b|\bpay\s+life\b|\breveal the top card\b|\bskip your draw step\b/.test(lower);
    const lifeLoss = [...lower.matchAll(/\b(?:lose|loses)\s+(\d+)\s+life\b/g)].map(m => Number(m[1])).filter(Number.isFinite);
    const tribeMatch = lower.match(/\b(?:other\s+)?([a-z]+)\s+(?:creatures?|merfolk|elves?|goblins?|zombies?|soldiers?|humans?|spirits?|knights?|wizards?|cats?|dogs?|dragons?|angels?|vampires?|clerics?|warriors?)\s+get\b/i);
    const sourceRole = profile?.find(r => r.role === topRole) || profile?.[0] || null;
    return {
        role: topRole,
        group: sourceRole?.group || null,
        recurring,
        permanent,
        cmc: Number.isFinite(card?.cmc) ? Number(card.cmc) : null,
        primaryFunction: strategicRoleFunctions(parsedEffects)[0] || null,
        manaPerActivation,
        drawAmount,
        damageAmount: Math.max(...damageAmounts, 0),
        lifePaid,
        lifeLoss: Math.max(...lifeLoss, 0),
        tribe: tribeMatch ? tribeMatch[1] : null,
        activated: /\bpay\b|\{t\}|\bsacrifice\b.*:\s*/i.test(text),
        strength: sourceRole?.score || 0
    };
}

const STRATEGIC_INTENT_ROLES = new Set([
    'fast_mana', 'card_advantage_engine', 'token_multiplier', 'tribal_anthem',
    'catch_up_ramp', 'land_ramp', 'token_engine'
]);

function inferRankingIntent(sourceCard, parsedSourceEffects = [], targetText = '', sourceRoleProfile = [], highlights = []) {
    const exactHighlights = (highlights || []).filter(h => h?.mode !== 'variable');
    const flexibleHighlights = (highlights || []).filter(h => h?.mode === 'variable');
    const topRole = sourceRoleProfile?.[0];
    const roleIsStrong = Boolean(topRole && STRATEGIC_INTENT_ROLES.has(topRole.role) && topRole.score >= 0.74);
    const effectCount = (parsedSourceEffects || []).filter(e => e && e.action && e.action !== 'generic').length;
    if ((highlights || []).length) {
        return { kind:'highlighted_effect', confidence: exactHighlights.length ? 0.94 : 0.86, role: roleIsStrong ? topRole.role : null, hasExactHighlight: exactHighlights.length > 0, hasFlexibleHighlight: flexibleHighlights.length > 0 };
    }
    if (roleIsStrong) {
        return { kind:'strategic_role', confidence:Math.min(1, 0.72 + topRole.score * 0.28), role:topRole.role, hasExactHighlight:false, hasFlexibleHighlight:false };
    }
    if (effectCount >= 2) {
        return { kind:'hybrid_effect', confidence:Math.min(1, 0.70 + Math.min(0.25, effectCount * 0.04)), role:topRole?.role || null, hasExactHighlight:false, hasFlexibleHighlight:false };
    }
    return { kind:'effect_match', confidence:Math.max(0.55, Math.min(1, 0.55 + (topRole?.score || 0) * 0.20)), role:topRole?.role || null, hasExactHighlight:false, hasFlexibleHighlight:false };
}

function roleFingerprintSimilarity(sourceFingerprint, candidateFingerprint) {
    if (!sourceFingerprint?.role || !candidateFingerprint?.role || sourceFingerprint.role !== candidateFingerprint.role) return 0;
    let score = 0, weight = 0;
    const add = (a, b, w) => {
        if (a === null || a === undefined || b === null || b === undefined) return;
        weight += w;
        if (typeof a === 'boolean' || typeof b === 'boolean' || typeof a === 'string' || typeof b === 'string') {
            score += a === b ? w : 0;
        } else {
            score += w * Math.max(0, 1 - Math.abs(Number(a) - Number(b)) / Math.max(Number(a), Number(b), 1));
        }
    };
    if (sourceFingerprint.role === 'fast_mana') {
        add(sourceFingerprint.manaPerActivation, candidateFingerprint.manaPerActivation, 0.45);
        add(sourceFingerprint.cmc, candidateFingerprint.cmc, 0.20);
        add(sourceFingerprint.recurring, candidateFingerprint.recurring, 0.20);
        add(sourceFingerprint.activated, candidateFingerprint.activated, 0.10);
    } else if (sourceFingerprint.role === 'card_advantage_engine') {
        add(sourceFingerprint.recurring, candidateFingerprint.recurring, 0.30);
        add(sourceFingerprint.lifePaid, candidateFingerprint.lifePaid, 0.20);
        add(sourceFingerprint.drawAmount || 1, candidateFingerprint.drawAmount || 1, 0.20);
        add(sourceFingerprint.permanent, candidateFingerprint.permanent, 0.15);
        add(sourceFingerprint.activated, candidateFingerprint.activated, 0.10);
    } else if (sourceFingerprint.role === 'tribal_anthem') {
        if (sourceFingerprint.tribe || candidateFingerprint.tribe) {
            weight += 0.55;
            score += sourceFingerprint.tribe && candidateFingerprint.tribe && sourceFingerprint.tribe === candidateFingerprint.tribe ? 0.55 : 0;
        }
        add(sourceFingerprint.permanent, candidateFingerprint.permanent, 0.20);
    } else if (sourceFingerprint.role === 'burn') {
        add(sourceFingerprint.damageAmount || 0, candidateFingerprint.damageAmount || 0, 0.60);
        add(sourceFingerprint.cmc, candidateFingerprint.cmc, 0.20);
        add(sourceFingerprint.recurring, candidateFingerprint.recurring, 0.10);
    } else {
        add(sourceFingerprint.recurring, candidateFingerprint.recurring, 0.25);
        add(sourceFingerprint.permanent, candidateFingerprint.permanent, 0.15);
        add(sourceFingerprint.primaryFunction, candidateFingerprint.primaryFunction, 0.30);
    }
    return weight > 0 ? Math.max(0, Math.min(1, score / weight)) : 0;
}

function strategicRoleToText(profile) {
    if (!profile?.length) return '';
    return profile.map(r => `${r.role.replace(/_/g, ' ')} ${r.anchors?.join(' ') || ''}`.trim()).join('; ');
}

// Sparse function-affinity matrix. Related functions get a graded relationship instead of
// collapsing into the old same-function/same-outcome/same-family tiers.
const FUNCTION_LABELS = [
    'removal', 'exile_removal', 'bounce', 'tuck', 'sacrifice', 'self_sacrifice',
    'reanimate', 'recursion', 'cheat_into_play', 'token_creation', 'token_multiplier',
    'card_draw', 'tutor', 'ramp_tutor', 'counter', 'cost_reduction', 'stat_buff', 'tribal_anthem',
    'direct_damage', 'lose_life', 'gain_life', 'discard', 'mill', 'mana_ability',
    'tap', 'untap', 'anthem'
];
const FUNCTION_INDEX = new Map(FUNCTION_LABELS.map((name, i) => [name, i]));
const FUNCTION_AFFINITY_MATRIX = Array.from({ length: FUNCTION_LABELS.length }, () => Array(FUNCTION_LABELS.length).fill(0));
FUNCTION_LABELS.forEach((fn, i) => { FUNCTION_AFFINITY_MATRIX[i][i] = 1; });
function setFunctionAffinity(a, b, value) {
    const ia = FUNCTION_INDEX.get(a), ib = FUNCTION_INDEX.get(b);
    if (ia === undefined || ib === undefined) return;
    FUNCTION_AFFINITY_MATRIX[ia][ib] = Math.max(FUNCTION_AFFINITY_MATRIX[ia][ib], value);
    FUNCTION_AFFINITY_MATRIX[ib][ia] = Math.max(FUNCTION_AFFINITY_MATRIX[ib][ia], value);
}
[
    ['removal','exile_removal',0.88], ['removal','bounce',0.78], ['removal','tuck',0.72], ['removal','sacrifice',0.62], ['removal','self_sacrifice',0.35],
    ['exile_removal','bounce',0.72], ['exile_removal','tuck',0.82],
    ['bounce','tuck',0.64], ['reanimate','recursion',0.90], ['reanimate','cheat_into_play',0.76],
    ['recursion','cheat_into_play',0.52], ['token_creation','token_multiplier',0.72], ['card_draw','tutor',0.38],
    ['tutor','ramp_tutor',0.72], ['direct_damage','lose_life',0.55], ['lose_life','gain_life',0.35],
    ['counter','removal',0.42], ['counter','bounce',0.30], ['stat_buff','tribal_anthem',0.72], ['stat_buff','anthem',0.68],
    ['stat_buff','token_creation',0.28], ['tribal_anthem','token_creation',0.28], ['discard','card_draw',0.25],
    ['mill','discard',0.25], ['tap','removal',0.18], ['untap','mana_ability',0.32], ['mana_ability','ramp_tutor',0.16]
].forEach(([a,b,v]) => setFunctionAffinity(a,b,v));

function getFunctionAffinity(a, b) {
    if (!a || !b) return 0;
    const ia = FUNCTION_INDEX.get(a), ib = FUNCTION_INDEX.get(b);
    if (ia === undefined || ib === undefined) return 0;
    return FUNCTION_AFFINITY_MATRIX[ia][ib] || 0;
}

function fieldSimilarity(weight, a, b, comparator = null) {
    if (a == null && b == null) return null;
    if (a == null || b == null) return { weight, value: 0 };
    return { weight, value: comparator ? comparator(a, b) : (a === b ? 1 : 0) };
}

function normalizedFieldScore(parts) {
    const usable = parts.filter(Boolean);
    const denominator = usable.reduce((s, p) => s + p.weight, 0);
    return denominator > 0 ? usable.reduce((s, p) => s + p.weight * p.value, 0) / denominator : 0;
}

function scoreContradictions(effA, effB) {
    let penalty = 0;
    const restrA = effA.restriction || [];
    const restrB = effB.restriction || [];

    // "destroy target creature you control" vs "...an opponent controls" - same verb, opposite
    // purpose (one is a drawback/sacrifice outlet, the other is removal).
    const controlClash = (restrA.includes('controlledbyyou') && restrB.includes('controlledbyopponent')) ||
        (restrA.includes('controlledbyopponent') && restrB.includes('controlledbyyou'));
    if (controlClash) penalty += 18;

    // One side restricts to "you control" while the other is unrestricted: narrower, but not
    // opposite, so a smaller penalty than an outright clash.
    const oneSidedControl = !controlClash && (
        (restrA.includes('controlledbyyou') && !restrB.includes('controlledbyyou')) ||
        (restrB.includes('controlledbyyou') && !restrA.includes('controlledbyyou'))
    );
    if (oneSidedControl) penalty += 6;

    // "counter target spell" vs "counter target NONCREATURE spell" - close, but one is
    // conditional on spell type. Any non-/type restriction present on exactly one side narrows
    // that side's applicability.
    const nonRestrA = restrA.filter(r => r.startsWith('non'));
    const nonRestrB = restrB.filter(r => r.startsWith('non'));
    const nonClash = nonRestrA.some(r => !restrB.includes(r)) || nonRestrB.some(r => !restrA.includes(r));
    if (nonClash) penalty += 8;

    // Same function but opposite permanence: a static anthem is not a combat trick.
    if (effA.isStatic !== undefined && effB.isStatic !== undefined && effA.isStatic !== effB.isStatic) {
        penalty += 7;
    }

    // "target one thing" vs "affects everything" is a large practical difference (spot removal
    // vs a board wipe), even though both canonicalize to removal.
    const massA = effA.target === 'all' || effA.target === 'each';
    const massB = effB.target === 'all' || effB.target === 'each';
    if (massA !== massB) penalty += 10;

    // An effect gated behind a cost/condition is strictly worse than the same effect unconditional.
    const gatedA = Boolean(effA.condition || effA.payCost);
    const gatedB = Boolean(effB.condition || effB.payCost);
    if (gatedA !== gatedB) penalty += 5;

    return penalty;
}

function restrictionSimilarityForMechanical(a = [], b = []) {
    const aa = new Set((a || []).filter(Boolean));
    const bb = new Set((b || []).filter(Boolean));
    if (aa.size === 0 && bb.size === 0) return 1;
    if (aa.size === 0 || bb.size === 0) return 0.35;
    const union = new Set([...aa, ...bb]);
    let intersection = 0;
    aa.forEach(v => { if (bb.has(v)) intersection++; });
    return intersection / Math.max(1, union.size);
}

function manaDiscountSimilarity(a, b) {
    if (a == null && b == null) return 1;
    const na = Number.isFinite(a) ? a : null;
    const nb = Number.isFinite(b) ? b : null;
    if (na != null && nb != null) return Math.max(0, 1 - Math.abs(na - nb) / Math.max(na, nb, 1));
    return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase() ? 1 : 0.45;
}

function directionalMechanicalSimilarity(parsedA, parsedB) {
    if (!parsedA || !parsedB || parsedA.length === 0 || parsedB.length === 0) return 0;
    let weightedSource = 0, sourceWeight = 0;

    for (const effA of parsedA) {
        if (!effA?.canonical) continue;
        let best = 0;
        for (const effB of parsedB) {
            if (!effB?.canonical) continue;
            const cfA = effA.canonical || {}, cfB = effB.canonical || {};
            const fnA = cfA.function || null, fnB = cfB.function || null;
            const outcomeA = cfA.outcome || null, outcomeB = cfB.outcome || null;
            const taxA = effA.action ? ACTION_TAXONOMY[effA.action] : null;
            const taxB = effB.action ? ACTION_TAXONOMY[effB.action] : null;

            const affinity = getFunctionAffinity(fnA, fnB);
            const sameAction = effA.action && effB.action && effA.action === effB.action;
            const sameOutcome = outcomeA && outcomeB && outcomeA === outcomeB;
            const sameFamily = taxA?.family && taxB?.family && taxA.family === taxB.family;
            const coreAlignment = Math.max(
                affinity,
                sameAction ? 0.96 : 0,
                sameOutcome ? 0.74 : 0,
                sameFamily ? 0.50 : 0
            );
            if (coreAlignment <= 0) continue;

            const parts = [];
            parts.push(fieldSimilarity(14, cfA.object ?? effA.object, cfB.object ?? effB.object));
            parts.push(fieldSimilarity(10, cfA.target ?? effA.target, cfB.target ?? effB.target));
            if (fnA === 'cost_reduction' || fnB === 'cost_reduction') {
                parts.push({ weight: 9, value: restrictionSimilarityForMechanical(effA.restriction, effB.restriction) });
                parts.push(fieldSimilarity(6, effA.controller, effB.controller));
                parts.push({ weight: 7, value: manaDiscountSimilarity(effA.amount ?? effA.quantity, effB.amount ?? effB.quantity) });
                parts.push(fieldSimilarity(4, effA.effectMode, effB.effectMode));
            }
            parts.push(fieldSimilarity(9, effA.from, effB.from));
            parts.push(fieldSimilarity(9, effA.to, effB.to));
            parts.push(fieldSimilarity(7, effA.subtype, effB.subtype));
            parts.push(fieldSimilarity(6, effA.controller, effB.controller));
            if (typeof effA.quantity === 'number' || typeof effB.quantity === 'number') {
                parts.push(fieldSimilarity(7, effA.quantity, effB.quantity,
                    (a,b) => Math.max(0, 1 - Math.abs(a-b) / Math.max(a,b,1))));
            } else if (effA.quantity != null || effB.quantity != null) {
                parts.push(fieldSimilarity(5, effA.quantity, effB.quantity));
            }
            const tpA = effA.targetProfile || {}, tpB = effB.targetProfile || {};
            parts.push(fieldSimilarity(4, tpA.kind, tpB.kind));
            parts.push(fieldSimilarity(4, tpA.scope, tpB.scope));
            const qpA = effA.quantityProfile || {}, qpB = effB.quantityProfile || {};
            parts.push(fieldSimilarity(4, qpA.relation, qpB.relation));
            parts.push(fieldSimilarity(2, qpA.bound, qpB.bound));
            const trA = effA.triggerProfile || {}, trB = effB.triggerProfile || {};
            parts.push(fieldSimilarity(4, trA.event, trB.event));
            parts.push(fieldSimilarity(3, trA.window, trB.window));
            parts.push(fieldSimilarity(3, effA.durationProfile, effB.durationProfile));
            parts.push(fieldSimilarity(4, effA.effectMode, effB.effectMode));
            parts.push(fieldSimilarity(4, effA.condition, effB.condition));
            parts.push(fieldSimilarity(3, effA.isStatic, effB.isStatic));
            if (effA.action === 'stat_buff' || effB.action === 'stat_buff') {
                parts.push(fieldSimilarity(4, effA.powerToughness, effB.powerToughness));
            }
            if (effA.action === 'create' || effB.action === 'create') {
                parts.push(fieldSimilarity(5, effA.stats, effB.stats));
            }

            const structuralEvidence = normalizedFieldScore(parts);
            // Core function alignment is multiplicative: structural agreement can refine a real
            // function match, but an action-family coincidence can never create a near-perfect score
            // on its own. When no structural field is available, retain only a conservative floor.
            const fieldFactor = parts.some(Boolean) ? (0.52 + 0.48 * structuralEvidence) : 0.52;
            let score = coreAlignment * fieldFactor;
            score *= (1 - Math.min(0.45, scoreContradictions(effA, effB) / 100));
            best = Math.max(best, score);
        }
        const importance = effA.importance ?? 0.05;
        weightedSource += best * Math.max(0.05, importance);
        sourceWeight += Math.max(0.05, importance);
    }
    return sourceWeight > 0 ? Math.max(0, Math.min(1, weightedSource / sourceWeight)) : 0;
}

// ---------------------------------------------------------------------------
// Reconstruct highlighted text from the source card's original Oracle text instead of
// inserting synthetic sentence boundaries between separately selected spans. A user can highlight
// "White spells you cast cost", then "{1}", then "less to cast"; those are three UI selections
// but one grammatical effect. Synthetic ". " separators turn that into three broken clauses and
// poison the mechanical parser. Position-aware reconstruction keeps the original connective text.
function getCurrentSourceOracleText(sourceCard = currentSourceCard) {
    if (!sourceCard) return '';
    return sourceCard.oracle_text ||
        (sourceCard.card_faces
            ? sourceCard.card_faces.map(f => f.oracle_text || '').filter(Boolean).join('\n\n')
            : '');
}

function normalizeHighlightSelectionOffsets(root, range) {
    if (!root || !range) return null;
    try {
        const pre = document.createRange();
        pre.selectNodeContents(root);
        pre.setEnd(range.startContainer, range.startOffset);
        const rawStart = pre.toString().length;
        pre.selectNodeContents(root);
        pre.setEnd(range.endContainer, range.endOffset);
        const rawEnd = pre.toString().length;
        let start = Math.min(rawStart, rawEnd);
        let end = Math.max(rawStart, rawEnd);
        if (end <= start) return null;
        return { start, end };
    } catch (_) {
        return null;
    }
}

function trimHighlightRangeText(text, start, end) {
    const raw = String(text || '');
    const left = raw.match(/^\s+/)?.[0].length || 0;
    const right = raw.match(/\s+$/)?.[0].length || 0;
    return {
        text: raw.trim(),
        start: start + left,
        end: Math.max(start + left, end - right)
    };
}

function buildHighlightScoringText(highlights, sourceText = getCurrentSourceOracleText()) {
    const hs = (highlights || [])
        .filter(h => h && typeof h.text === 'string' && h.text.trim());
    if (!hs.length) return '';

    // Use the same explicit grouping logic as the mechanical highlight-intent layer. This means
    // a user-added search detail can be attached to an actual source selection and contribute to
    // the semantic target without being mistaken for literal Oracle grammar.
    const groups = annotateHighlightGroups(hs, sourceText);
    if (!groups.length) return '';

    return groups.map(group => {
        const sourceContext = String(group.contextText || '').trim();
        const intentHints = (group.connectedIntentTexts || []).filter(Boolean).map(v => String(v).trim());
        return [sourceContext, ...intentHints]
            .filter(Boolean)
            .join(' ');
    }).filter(Boolean).join('. ');
}


// HIGHLIGHT INTENT LAYER
// ---------------------------------------------------------------------------
// Highlights are user-authored intent, not merely a shorter Oracle string.  Keep each
// highlight as its own structural request so multiple disjoint highlights do not get
// accidentally blended into one clause.  Exact highlights still participate in literal
// matching; both exact and flexible highlights also participate in mechanical matching.
function highlightRestrictionSimilarity(a = [], b = []) {
    const aa = new Set(a || []);
    const bb = new Set(b || []);
    if (aa.size === 0 && bb.size === 0) return 1;
    if (aa.size === 0 || bb.size === 0) return 0.35;
    let intersection = 0;
    aa.forEach(v => { if (bb.has(v)) intersection++; });
    return intersection / new Set([...aa, ...bb]).size;
}

function highlightQuantitySimilarity(a, b, mode) {
    a = a || {}; b = b || {};
    if (mode === 'variable') {
        if (a.relation && b.relation && a.relation !== b.relation) return 0.45;
        if (a.kind && b.kind) return 1;
        return (a.kind || b.kind) ? 0.65 : 1;
    }
    if (a.relation || b.relation) {
        if (a.relation && b.relation && a.relation === b.relation) return 0.9;
        return 0.35;
    }
    const av = a.value, bv = b.value;
    if (typeof av === 'number' && typeof bv === 'number') return Math.max(0, 1 - Math.abs(av - bv) / Math.max(av, bv, 1));
    if (av == null && bv == null) return 1;
    if (av === bv) return 1;
    if (av == null || bv == null) return 0.35;
    return 0.45;
}

function highlightTargetSimilarity(a = {}, b = {}, mode) {
    if (!a.kind && !b.kind && !a.scope && !b.scope) return 1;
    let score = 0, weight = 0;
    if (a.kind || b.kind) { weight += 0.55; score += a.kind === b.kind ? 0.55 : (mode === 'variable' && (!a.kind || !b.kind) ? 0.30 : 0); }
    if (a.object || b.object) { weight += 0.25; score += a.object === b.object ? 0.25 : 0; }
    if (a.scope || b.scope) { weight += 0.20; score += a.scope === b.scope ? 0.20 : 0; }
    return weight ? score / weight : 1;
}

function highlightRelationshipSimilarity(a, b, mode) {
    const ta = a.triggerProfile || null, tb = b.triggerProfile || null;
    let score = 0, weight = 0;
    if (ta || tb) {
        weight += 0.45;
        if (ta && tb && ta.type === tb.type && (!ta.event || !tb.event || ta.event === tb.event)) score += 0.45;
        else if (mode === 'variable' && (!ta || !tb)) score += 0.18;
    }
    const da = a.dependencyProfile || {}, db = b.dependencyProfile || {};
    const keys = ['hasIfYouDo','hasForEach','hasBasedOn','hasInstead','role'];
    for (const k of keys) {
        if (da[k] !== undefined || db[k] !== undefined) {
            weight += 0.11;
            if (da[k] === db[k]) score += 0.11;
        }
    }
    if (a.durationProfile || b.durationProfile) {
        weight += 0.15;
        if (a.durationProfile === b.durationProfile) score += 0.15;
        else if (mode === 'variable' && (!a.durationProfile || !b.durationProfile)) score += 0.06;
    }
    return weight ? score / weight : 1;
}

function scoreHighlightEffectMatch(highlightEffect, candidateEffect, mode) {
    if (!highlightEffect || !candidateEffect) return 0;
    const ca = highlightEffect.canonical || null, cb = candidateEffect.canonical || null;
    const sameFunction = Boolean(ca && cb && ca.function === cb.function);
    const sameOutcome = Boolean(ca && cb && ca.outcome === cb.outcome);
    const sameAction = Boolean(highlightEffect.action && candidateEffect.action && highlightEffect.action === candidateEffect.action);
    if (!sameFunction && !sameOutcome && !sameAction) return 0;

    let score = sameFunction ? 0.38 : (sameOutcome ? 0.22 : 0.16);
    if (highlightEffect.object && candidateEffect.object) score += highlightEffect.object === candidateEffect.object ? 0.10 : 0;
    else score += (!highlightEffect.object && !candidateEffect.object) ? 0.10 : 0.03;
    score += 0.12 * highlightTargetSimilarity(highlightEffect.targetProfile || {}, candidateEffect.targetProfile || {}, mode);
    score += 0.08 * highlightRestrictionSimilarity(highlightEffect.restriction, candidateEffect.restriction);
    score += 0.10 * highlightQuantitySimilarity(highlightEffect.quantityProfile, candidateEffect.quantityProfile, mode);
    score += 0.10 * highlightRelationshipSimilarity(highlightEffect, candidateEffect, mode);
    if (highlightEffect.effectMode || candidateEffect.effectMode) {
        score += highlightEffect.effectMode === candidateEffect.effectMode ? 0.07 : (mode === 'variable' ? 0.01 : 0);
    } else score += 0.07;
    return Math.min(1, score);
}

// Maximum-weight one-to-one assignment. A candidate effect can satisfy at most one highlighted
// effect. This prevents one broad candidate clause from falsely satisfying several independent
// highlighted spans. The DP is bounded to the small effect lists produced by Oracle clauses.
function maxOneToOneHighlightAssignment(sourceEffects, candidateEffects, mode) {
    const sources = sourceEffects || [], candidates = candidateEffects || [];
    if (!sources.length || !candidates.length) return { score: 0, matches: [] };
    const memo = new Map();
    function solve(i, usedMask) {
        if (i >= sources.length) return { score: 0, matches: [] };
        const key = `${i}|${usedMask}`;
        if (memo.has(key)) return memo.get(key);
        let best = solve(i + 1, usedMask); // source effect may remain unmatched
        for (let j = 0; j < candidates.length; j++) {
            const bit = (1n << BigInt(j));
            if (usedMask & bit) continue;
            const pair = scoreHighlightEffectMatch(sources[i], candidates[j], mode);
            if (pair <= 0) continue;
            const rest = solve(i + 1, usedMask | bit);
            const candidate = { score: pair + rest.score, matches: [[i,j,pair], ...rest.matches] };
            if (candidate.score > best.score) best = candidate;
        }
        memo.set(key, best);
        return best;
    }
    const result = solve(0, 0n);
    const maxPossible = sources.reduce((sum, e) => sum + Math.max(...candidates.map(c => scoreHighlightEffectMatch(e,c,mode)), 0), 0) || 1;
    return { score: result.score / maxPossible, matches: result.matches };
}

// Group multiple UI selections that belong to one grammatical effect. The source text between
// the selections is preserved, because the connective words often carry the actual rules syntax.
function annotateHighlightGroups(highlights, sourceText = getCurrentSourceOracleText()) {
    const original = Array.isArray(highlights) ? highlights : [];
    const hs = original
        .filter(h => h && typeof h.text === 'string' && h.text.trim())
        .map((h, index) => ({ ...h, _highlightIndex: index }));
    if (!hs.length) return [];

    // Start with the normal position-based grouping. This keeps nearby selections from the same
    // Oracle sentence/effect together without requiring the user to perfectly select the whole
    // sentence in one drag.
    const parent = hs.map((_, i) => i);
    const find = (x) => {
        let root = x;
        while (parent[root] !== root) root = parent[root];
        while (parent[x] !== x) {
            const next = parent[x];
            parent[x] = root;
            x = next;
        }
        return root;
    };
    const union = (a, b) => {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };

    const positioned = hs
        .filter(h => Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start)
        .sort((a, b) => a.start - b.start || a._highlightIndex - b._highlightIndex);
    for (let i = 1; i < positioned.length; i++) {
        const prev = positioned[i - 1];
        const next = positioned[i];
        const gap = String(sourceText || '').slice(prev.end, next.start);
        if (!/[.!?\n]/.test(gap) && gap.length <= 96) {
            union(hs.indexOf(prev), hs.indexOf(next));
        }
    }

    // Explicit user connections override physical proximity. This is the important part for
    // cases such as: highlight "{T}: Add {C}{C}" and then attach an intent like "produces 3
    // colorless mana". The attached intent belongs to that effect even though it does not exist
    // literally in the source Oracle text.
    const indexByOriginal = new Map(hs.map((h, i) => [h._highlightIndex, i]));
    hs.forEach((h, localIndex) => {
        const targetOriginalIndex = Number.isInteger(h.attachedTo) ? h.attachedTo : null;
        if (targetOriginalIndex === null || targetOriginalIndex === h._highlightIndex) return;
        const targetLocalIndex = indexByOriginal.get(targetOriginalIndex);
        if (targetLocalIndex == null) return;
        union(localIndex, targetLocalIndex);
    });

    const buckets = new Map();
    hs.forEach((h, localIndex) => {
        const root = find(localIndex);
        if (!buckets.has(root)) buckets.set(root, []);
        buckets.get(root).push(h);
    });

    const groups = Array.from(buckets.values())
        .map(group => group.sort((a, b) => {
            const as = Number.isFinite(a.start) ? a.start : Number.POSITIVE_INFINITY;
            const bs = Number.isFinite(b.start) ? b.start : Number.POSITIVE_INFINITY;
            return as - bs || a._highlightIndex - b._highlightIndex;
        }))
        .sort((a, b) => {
            const as = Number.isFinite(a[0]?.start) ? a[0].start : Number.POSITIVE_INFINITY;
            const bs = Number.isFinite(b[0]?.start) ? b[0].start : Number.POSITIVE_INFINITY;
            return as - bs || (a[0]?._highlightIndex || 0) - (b[0]?._highlightIndex || 0);
        });

    groups.forEach((group, groupId) => {
        const positionedMembers = group.filter(h => Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start);
        const start = positionedMembers.length ? Math.min(...positionedMembers.map(h => h.start)) : null;
        const end = positionedMembers.length ? Math.max(...positionedMembers.map(h => h.end)) : null;
        // Only text that actually occurs in the source card belongs in the parser context.
        // User-added/attached text is kept separately as search intent so it cannot corrupt the
        // MTG rule parser while still influencing retrieval and ranking.
        const contextText = start !== null && end !== null
            ? String(sourceText || '').slice(start, end).trim()
            : '';
        const connectedIntentTexts = group
            .filter(h => h.origin === 'user' || !Number.isFinite(h.start) || !Number.isFinite(h.end))
            .map(h => String(h.text || '').trim())
            .filter(Boolean);
        const hasExact = group.some(h => h.mode !== 'variable');
        const hasVariable = group.some(h => h.mode === 'variable');
        const groupMode = hasExact && hasVariable ? 'mixed' : (hasVariable ? 'variable' : 'exact');
        const benchmarkIntentOnly = group.some(h => h.origin === 'benchmark') && groupMode === 'mixed';
        const exactTexts = group.filter(h => h.mode !== 'variable').map(h => h.text.trim());
        const variableTexts = group.filter(h => h.mode === 'variable').map(h => h.text.trim());
        const modes = group.map(h => h.mode === 'variable' ? 'variable' : 'exact');
        group.contextText = contextText || group.filter(h => Number.isFinite(h.start)).map(h => h.text.trim()).join(' ');
        group.connectedIntentTexts = connectedIntentTexts;
        group.searchIntentText = [group.contextText, ...connectedIntentTexts].filter(Boolean).join(' ');
        group.sourceStart = start;
        group.sourceEnd = end;
        group.mode = groupMode;
        group.modes = modes;
        group.selections = group.map(h => ({
            text: h.text.trim(),
            mode: h.mode === 'variable' ? 'variable' : 'exact',
            intent: h.intent || '',
            origin: h.origin || 'user',
            attachedTo: Number.isInteger(h.attachedTo) ? h.attachedTo : null
        }));
        group.exactTexts = exactTexts;
        group.variableTexts = variableTexts;
        group.benchmarkIntentOnly = benchmarkIntentOnly;
        group.origin = group.some(h => h.origin === 'benchmark') ? 'benchmark' : 'user';
        group.forEach(h => {
            h.groupId = groupId;
            h.groupStart = start;
            h.groupEnd = end;
            h.groupContextText = group.contextText;
            h.groupMode = groupMode;
            h.benchmarkIntentOnly = benchmarkIntentOnly;
        });
    });
    return groups;
}

function buildHighlightIntentProfiles(highlights) {
    const groups = annotateHighlightGroups(highlights, getCurrentSourceOracleText());
    return groups.map((group, index) => {
        // Parse only text that actually exists on the source card. Attached search details are
        // intentionally NOT injected into the rules parser because phrases like "produces 3
        // colorless mana" can be useful search intent but are not necessarily valid Oracle grammar.
        // They are carried separately as semantic/retrieval hints below.
        let parsedEffects = parseMTGEffect(group.contextText || group.map(h => h.text).filter(Boolean).join(' '));
        if (group.length && Number.isFinite(group.sourceStart) && Number.isFinite(group.sourceEnd)) {
            const sourceText = getCurrentSourceOracleText();
            const contextual = String(sourceText || '').slice(group.sourceStart, group.sourceEnd).trim();
            if (contextual) parsedEffects = parseMTGEffect(contextual);
        }
        let canonicalFunctions = getCanonicalFunctions(parsedEffects);
        let recognizedEffects = parsedEffects.filter(e => e.action && e.action !== 'generic');

        // Fallback: mask Variable selections only if the unmasked excerpt failed to parse. This is
        // useful for numeric/custom tokens that would otherwise interrupt a parser pattern while
        // keeping the surrounding grammar intact.
        if (!recognizedEffects.length && group.some(h => h.mode === 'variable')) {
            let normalized = group.map(h => h.text).join(' ');
            for (const h of group.filter(x => x.mode === 'variable')) {
                const escaped = h.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                normalized = normalized.replace(new RegExp(escaped, 'g'), 'N');
            }
            const normalizedEffects = parseMTGEffect(normalized);
            const normalizedRecognized = normalizedEffects.filter(e => e.action && e.action !== 'generic');
            if (normalizedRecognized.length) {
                parsedEffects = normalizedEffects;
                recognizedEffects = normalizedRecognized;
                canonicalFunctions = getCanonicalFunctions(normalizedEffects);
            }
        }

        return {
            index,
            groupId: index,
            text: group.contextText,
            contextText: group.contextText,
            searchIntentText: group.searchIntentText,
            connectedIntentTexts: group.connectedIntentTexts || [],
            selections: group.selections,
            modes: group.modes,
            mode: group.mode,
            exactTexts: group.exactTexts,
            variableTexts: group.variableTexts,
            benchmarkIntentOnly: Boolean(group.benchmarkIntentOnly),
            origin: group.origin,
            parsedEffects,
            recognizedEffects,
            canonicalFunctions,
            parserConfidence: calculateCardFieldConfidence(parsedEffects).overall || 0,
            canonicalText: canonicalFunctionToText(canonicalFunctions)
        };
    });
}

function calculateHighlightIntentMatch(profiles, candidateEffects, candidateCard = null) {
    if (!profiles?.length || !candidateEffects?.length) return 0;
    const profileScores = profiles.map(profile => {
        const sourceEffects = profile.recognizedEffects.length ? profile.recognizedEffects : profile.parsedEffects;
        const matchingMode = profile.mode === 'mixed' ? 'variable' : profile.mode;
        const assignment = maxOneToOneHighlightAssignment(sourceEffects, candidateEffects, matchingMode);
        const coverage = sourceEffects.length ? assignment.matches.length / sourceEffects.length : 0;
        const confidence = 0.55 + 0.45 * (profile.parserConfidence || 0);
        let lexicalSupport = 0;
        if (candidateCard && profile.exactTexts?.length) {
            const oracle = getCardOracleText(candidateCard).toLowerCase();
            lexicalSupport = profile.exactTexts.filter(t => oracle.includes(String(t).toLowerCase())).length / profile.exactTexts.length;
        }
        // In mixed benchmark groups the parsed whole-effect is the main signal. Literal wording is
        // only a small bonus because the point is to permit a changed qualifier/amount while still
        // preserving the highlighted effect's structure.
        const lexicalWeight = profile.benchmarkIntentOnly ? 0.05 : 0.12;
        const structuralWeight = profile.benchmarkIntentOnly ? 0.78 : 0.76;
        const coverageWeight = profile.benchmarkIntentOnly ? 0.17 : 0.12;
        return Math.min(1, assignment.score * structuralWeight + coverage * coverageWeight + lexicalSupport * lexicalWeight) * confidence;
    });
    const average = profileScores.reduce((a,b) => a+b,0) / profileScores.length;
    const fullCoverage = profileScores.filter(v => v >= 0.55).length / profileScores.length;
    return Math.min(1, average * 0.80 + fullCoverage * 0.20);
}

function calculateHighlightIntentRetrievalText(profiles) {
    if (!profiles || profiles.length === 0) return '';
    const canonical = profiles.flatMap(p => p.canonicalFunctions || []);
    const canonicalText = canonicalFunctionToText(canonical);
    const groupedText = profiles.map(p => p.searchIntentText || p.contextText || p.text).filter(Boolean);
    const connected = profiles.flatMap(p => p.connectedIntentTexts || []).filter(Boolean);
    return [...new Set([canonicalText, ...groupedText, ...connected].filter(Boolean))].join('. ');
}

/**
 * Estimates how much *candidate-only* functionality is unrelated to the source.
 *
 * This is intentionally NOT a reciprocal similarity score. Reciprocal scoring was the source of
 * the old harmonic-mean problem: a useful card with the same core effect plus a drawback or rider
 * could be dragged down by its extra text. Instead we measure the amount of candidate functionality
 * that fails to map back to the source, weight it by effect importance, and apply only a bounded
 * penalty. Secondary riders therefore cost much less than an unrelated primary function.
 */
function calculateCandidateMechanicalExcess(parsedSource, parsedCandidate) {
    if (!parsedSource || !parsedCandidate || parsedCandidate.length === 0) return 1;

    let weightedExcess = 0;
    let weightTotal = 0;

    parsedCandidate.forEach(effB => {
        const baseImportance = Math.max(0.05, effB.importance ?? (effB.isPrimary ? 1 : 0.35));
        // Substantial standalone effects deserve a little more excess weight; tiny riders/costs
        // remain intentionally cheap. This is what distinguishes "same function + drawback" from
        // "same function + an entire unrelated second purpose" without reverting to symmetry.
        const importance = baseImportance * (baseImportance >= 0.70 ? 1.20 : 0.80);
        const bestCoverage = directionalMechanicalSimilarity([effB], parsedSource);
        const excess = Math.max(0, 1 - bestCoverage);
        weightedExcess += excess * importance;
        weightTotal += importance;
    });

    return weightTotal > 0 ? Math.min(1, weightedExcess / weightTotal) : 1;
}

/**
 * Source-centric mechanical similarity.
 *
 * The score answers the useful search question first: "How much of the SOURCE card's important
 * functionality is represented by this candidate?" Candidate-only functionality is considered
 * separately as a small excess penalty. This prevents extra drawbacks, riders, costs, or secondary
 * abilities from overwhelming an otherwise excellent match, while still keeping a genuinely
 * unrelated multi-function card from receiving a free perfect score.
 */

/**
 * Ranking-specific effect coverage.
 *
 * directionalMechanicalSimilarity() is intentionally source-centric, but the ranker also needs
 * to know HOW that coverage was achieved. A compound card that matches 2/3 important effects is
 * meaningfully different from a card that matches only its strongest effect. This profile keeps
 * those distinctions separate from the legacy mechanicalScore so the existing score presentation
 * remains stable while the final ordering gets better evidence.
 */
function calculateEffectCoverageProfile(parsedSource, parsedCandidate) {
    const source = (parsedSource || []).filter(e => e?.canonical);
    const candidate = (parsedCandidate || []).filter(e => e?.canonical);
    if (!source.length || !candidate.length) {
        return {
            sourceCoverage: 0, candidateCoverage: 0, balancedCoverage: 0,
            primaryMatch: 0, matchedWeight: 0, sourceWeight: 0,
            candidateWeight: 0, unmatchedSourceWeight: 1, unmatchedCandidateWeight: 1,
            matches: []
        };
    }

    const sourceWeights = source.map(e => Math.max(0.05, e.importance ?? (e.isPrimary ? 1 : 0.35)));
    const candidateWeights = candidate.map(e => Math.max(0.05, e.importance ?? (e.isPrimary ? 1 : 0.35)));
    const memo = new Map();

    function pairScore(a, b) {
        return directionalMechanicalSimilarity([a], [b]);
    }
    function solve(i, usedMask) {
        if (i >= source.length) return { score: 0, matches: [] };
        const key = `${i}|${usedMask}`;
        if (memo.has(key)) return memo.get(key);
        let best = solve(i + 1, usedMask); // leave source effect unmatched
        for (let j = 0; j < candidate.length; j++) {
            const bit = 1n << BigInt(j);
            if (usedMask & bit) continue;
            const pair = pairScore(source[i], candidate[j]);
            if (pair <= 0.02) continue;
            const rest = solve(i + 1, usedMask | bit);
            const weighted = pair * sourceWeights[i];
            const option = { score: weighted + rest.score, matches: [[i, j, pair], ...rest.matches] };
            if (option.score > best.score) best = option;
        }
        memo.set(key, best);
        return best;
    }

    const assignment = solve(0, 0n);
    const sourceWeight = sourceWeights.reduce((a,b) => a+b, 0) || 1;
    const candidateWeight = candidateWeights.reduce((a,b) => a+b, 0) || 1;
    const sourceCoverage = Math.max(0, Math.min(1, assignment.score / sourceWeight));

    let candidateMatchedWeight = 0;
    const matchedCandidateIndexes = new Set();
    for (const [, j, pair] of assignment.matches) {
        candidateMatchedWeight += candidateWeights[j] * pair;
        matchedCandidateIndexes.add(j);
    }
    const candidateCoverage = Math.max(0, Math.min(1, candidateMatchedWeight / candidateWeight));
    const balancedCoverage = Math.sqrt(sourceCoverage * candidateCoverage);

    let primaryMatch = 0;
    const sourcePrimaryIndex = source.findIndex(e => e.isPrimary);
    if (sourcePrimaryIndex >= 0) {
        const match = assignment.matches.find(([i]) => i === sourcePrimaryIndex);
        primaryMatch = match ? match[2] : 0;
    }

    return {
        sourceCoverage,
        candidateCoverage,
        balancedCoverage,
        primaryMatch,
        matchedWeight: assignment.score,
        sourceWeight,
        candidateWeight,
        unmatchedSourceWeight: Math.max(0, 1 - sourceCoverage),
        unmatchedCandidateWeight: Math.max(0, 1 - candidateCoverage),
        matches: assignment.matches
    };
}

/**
 * Functional substitute similarity. This intentionally operates above exact mechanics: exile,
 * bounce, and destroy can all be useful creature-interaction substitutes, while draw and discard
 * are related resource/card-advantage functions without being treated as identical.
 */
function calculateFunctionalSimilarity(parsedSource, parsedCandidate) {
    const source = (parsedSource || []).filter(e => e?.canonical);
    const candidate = (parsedCandidate || []).filter(e => e?.canonical);
    const sourceProfile = parsedSource?._mechanicProfile || buildUniversalMechanicProfile(null, '', parsedSource || []);
    const candidateProfile = parsedCandidate?._mechanicProfile || buildUniversalMechanicProfile(null, '', parsedCandidate || []);
    const universal = calculateUniversalMechanicSimilarity(sourceProfile, candidateProfile);
    if (!source.length || !candidate.length) return universal.score * 0.88;
    const sourceFns = source.map(e => e.canonical.function).filter(Boolean);
    const candidateFns = candidate.map(e => e.canonical.function).filter(Boolean);
    let total = 0, weight = 0;
    for (const fnA of sourceFns) {
        const importance = FUNCTION_IMPORTANCE[fnA] ?? 0.5;
        const best = candidateFns.reduce((m, fnB) => Math.max(m, getFunctionAffinity(fnA, fnB)), 0);
        total += best * Math.max(0.05, importance);
        weight += Math.max(0.05, importance);
    }
    const canonicalScore = weight ? total / weight : 0;
    const graphA = parsedSource?._mechanicalGraph || buildMechanicalEffectGraph(null, '', parsedSource || []);
    const graphB = parsedCandidate?._mechanicalGraph || buildMechanicalEffectGraph(null, '', parsedCandidate || []);
    const graphScore = calculateMechanicalGraphSimilarity(graphA, graphB).score;
    return Math.max(0, Math.min(1, canonicalScore * 0.62 + graphScore * 0.23 + universal.score * 0.15));
}

/**
 * Quantity compatibility rewards nearby magnitudes without confusing unrelated numeric values.
 * The parser's effect-level comparison already uses quantities; this aggregate signal helps the
 * final ranker preserve that information when a compound card contains several effects.
 */
function calculateAggregateQuantitySimilarity(parsedSource, parsedCandidate, coverageProfile) {
    if (!coverageProfile?.matches?.length) return 0;
    let total = 0, weight = 0;
    for (const [i, j, pair] of coverageProfile.matches) {
        const a = parsedSource?.[i], b = parsedCandidate?.[j];
        const qa = a?.quantity ?? a?.amount ?? a?.canonical?.params?.quantity ?? null;
        const qb = b?.quantity ?? b?.amount ?? b?.canonical?.params?.quantity ?? null;
        if (qa == null || qb == null || !Number.isFinite(Number(qa)) || !Number.isFinite(Number(qb))) continue;
        const av = Number(qa), bv = Number(qb);
        const similarity = Math.max(0, 1 - Math.abs(av - bv) / Math.max(Math.abs(av), Math.abs(bv), 1));
        const w = Math.max(0.05, a?.importance ?? 0.35);
        total += similarity * w * Math.max(0.25, pair);
        weight += w;
    }
    return weight ? Math.max(0, Math.min(1, total / weight)) : 0;
}


// ---------------------------------------------------------------------------
// UNIVERSAL MECHANIC SIGNATURE
// ---------------------------------------------------------------------------
// The finite effect parser remains useful for detailed rules structure, but Magic's mechanic
// vocabulary is much larger than any sensible hand-written parser table. Scryfall card objects carry
// the card's structured `keywords` array, so use that as the universal mechanic layer. This means
// obscure, historic, and newly introduced keyword abilities/actions can participate in mechanical
// matching without adding a new branch to the parser each time Wizards adds a mechanic.
//
// The current 2026 Comprehensive Rules/releases demonstrate why this matters: new mechanics such as
// sneak, storied, heal, blight, increment, paradigm, preparation, power-up, and teamwork have been
// added during 2026. The keyword metadata path catches those automatically. The text-derived action
// and rules-context signature then handles keyword actions and mechanically meaningful text that is
// not represented as a single keyword field.
const UNIVERSAL_RULE_ACTION_TERMS = [
    'activate','adapt','amass','assemble','attach','bolster','bury','cast','clash','cloak','connive',
    'counter','create','crew','cycle','dash','discover','discard','disguise','double','draw','embalm',
    'enlist','escape','exert','explore','fight','foretell','goad','investigate','learn','manifest',
    'meld','mill','monstrous','mutate','phase out','populate','proliferate','plot','regenerate',
    'reveal','sacrifice','scry','search','shuffle','skirmish','solve','sneak','spree','support',
    'surveil','suspect','tap','transform','turn face up','untap','venture','vote','ward','roll',
    'choose','exchange','exile','heal','blight','recruit','increment','prepare','preparation',
    'power-up','teamwork','storied','refine','offspring','saddle','craft','collect evidence',
    'incubate','incite','train','open an attraction','take the initiative','become the monarch',
    'initiative','dungeon','daybound','nightbound','convert','stash','impending','bargain',
    'corrupted','for mirrodin','living weapon','reconfigure','equip','fortify','level up','level-up',
    'transfigure','transmute','cycling','kicker','flashback','madness','suspend','cascade','storm',
    'prowess','convoke','delve','affinity','improvise','offering','evoke','ninjutsu','jutsu','channel',
    'splice','buyback','retrace','recover','scavenge','unearth','encore','disturb','decayed','aftermath',
    'adventure','partner','battle cry','bloodthirst','bushido','flanking','fading','vanishing','undying',
    'persist','infect','wither','deathtouch','defender','double strike','first strike','flying','haste',
    'hexproof','indestructible','lifelink','menace','protection','reach','shroud','trample','vigilance',
    'fear','intimidate','shadow','skulk','horsemanship','landwalk','extort','cipher','evolve','bestow',
    'tribute','surge','delirium','revolt','ascend','enrage','riot','mentor','spectacle','afterlife',
    'saga','constellation','landfall','metalcraft','spell mastery','ferocious','raid','formidable','morbid',
    'threshold','hellbent','magecraft','paradigm','preparation'
];

function escapeMechanicRegexTerm(term) {
    return String(term || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const UNIVERSAL_RULE_ACTION_REGEX = new RegExp(
    '\\b(?:' + UNIVERSAL_RULE_ACTION_TERMS
        .slice()
        .sort((a, b) => b.length - a.length)
        .map(term => escapeMechanicRegexTerm(term).replace(/\s+/g, '\\s+'))
        .join('|') + ')\\b',
    'gi'
);

const UNIVERSAL_ZONE_TERMS = [
    'battlefield','graveyard','hand','library','stack','exile','command zone','outside the game',
    'ante','sideboard','dungeon','attraction','sticker sheet'
];
const UNIVERSAL_CONTEXT_PATTERNS = {
    target: /\b(?:target|each|all|any|another|one or more|up to|a|an)\s+(?:creature|permanent|artifact|enchantment|land|planeswalker|battle|player|opponent|spell|ability|card|kindred|token|permanents?|creatures?|cards?)\b/gi,
    scope: /\b(?:you control|your opponents? control|each player|each opponent|all players|nonland|nontoken|legendary|nonlegendary|nonbasic|basic|multicolored|monocolored|historic|modified|attacking|blocking|tapped|untapped|dying|damaged|discarded|sacrificed|cast|crewed|equipped|enchanted|opponents?|you|your)\b/gi,
    trigger: /\b(?:when|whenever|at the beginning of|at the end of|if|unless|as long as|while|after|before|until|the next time|each upkeep|each end step|your upkeep|your end step)\b/gi,
    cost: /\b(?:pay|sacrifice|discard|exile|tap|untap|remove|spend|return|reveal|mill|cast)\b|\{[^}]+\}/gi,
    choice: /\b(?:choose|chosen|may|modal|one or more|any number|up to|for each|x|random|vote|secretly)\b/gi
};
const UNIVERSAL_RESOURCE_REGEX = /\b(?:life|mana|cards?|counters?|tokens?|treasure|clue|food|blood|map|powerstone|incubator|energy|poison|experience|rad|stun|finality|shield|ticket|evidence|junk|role|ring-bearer|attraction|dungeon|initiative|monarch|city's blessing)\b/gi;
const UNIVERSAL_STAT_REGEX = /(?:[+\-−]\d+\/[+\-−]\d+|[+\-−]\d+|\bdouble\b|\bhalf\b|\btriple\b|\bgets?\b|\bbecomes?\b)/gi;
const UNIVERSAL_COUNTER_REGEX = /(?:[+\-−]\d+\/[+\-−]\d+\s*)?\b[a-z][a-z0-9-]*\s+counters?\b/gi;
const UNIVERSAL_TOKEN_REGEX = /\b([a-z][a-z0-9' -]{1,32})\s+tokens?\b/gi;
const UNIVERSAL_MANA_SYMBOL_REGEX = /\{[^}]+\}/g;

function normalizeMechanicToken(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[’']/g, "'")
        .replace(/[‐‑‒–—]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

function setCoverage(sourceSet, candidateSet) {
    const a = sourceSet instanceof Set ? sourceSet : new Set(sourceSet || []);
    const b = candidateSet instanceof Set ? candidateSet : new Set(candidateSet || []);
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    a.forEach(v => { if (b.has(v)) overlap++; });
    return overlap / a.size;
}

function extractMechanicKeywords(card, text) {
    const fromCard = Array.isArray(card?.keywords) ? card.keywords : [];
    const fullOracle = String(card?.oracle_text || (card?.card_faces ? card.card_faces.map(f => f.oracle_text || '').join(' ') : '') || '');
    const normalizedText = normalizeMechanicToken(text);
    const normalizedFull = normalizeMechanicToken(fullOracle);
    const isTextSubset = Boolean(normalizedText && normalizedFull && normalizedText !== normalizedFull);

    // Scryfall's `keywords` field is authoritative. When the scorer is working from a highlighted
    // subset of Oracle text, keep only the keyword mechanics actually present in that highlighted
    // span so an unrelated keyword elsewhere on the source card cannot inflate the mechanical score.
    const keywords = new Set(fromCard.map(normalizeMechanicToken).filter(Boolean));
    if (isTextSubset) {
        for (const keyword of [...keywords]) {
            const escaped = escapeMechanicRegexTerm(keyword).replace(/\s+/g, '\\s+');
            if (!(new RegExp('\\b' + escaped + '\\b', 'i')).test(String(text))) keywords.delete(keyword);
        }
    }
    return keywords;
}

function extractMechanicKeywordParameters(keywords, text) {
    const params = new Set();
    const lowerText = String(text || '').toLowerCase();
    for (const keyword of keywords || []) {
        const escaped = escapeMechanicRegexTerm(keyword).replace(/\s+/g, '\\s+');
        const match = lowerText.match(new RegExp('\\b' + escaped + '\\b(?:\\s+|[-—:]\\s+)([0-9]+|x|any|all|\\{[^}]+\\})', 'i'));
        if (match) params.add(`${keyword}:${match[1] || ''}`);
    }
    return params;
}

function collectRegexTokens(text, regex) {
    const out = new Set();
    const input = String(text || '');
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(input))) {
        const token = normalizeMechanicToken(match[0]);
        if (token) out.add(token);
        if (regex.lastIndex === match.index) regex.lastIndex++;
    }
    return out;
}

function collectRegexGroupTokens(text, regex) {
    const out = new Set();
    const input = String(text || '');
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(input))) {
        const token = normalizeMechanicToken(match[1] || match[0]);
        if (token) out.add(token);
        if (regex.lastIndex === match.index) regex.lastIndex++;
    }
    return out;
}

function buildUniversalMechanicProfile(card = null, text = '', parsedEffects = null) {
    const oracle = String(text || card?.oracle_text || (card?.card_faces ? card.card_faces.map(f => f.oracle_text || '').join(' ') : '') || '');
    const keywords = extractMechanicKeywords(card, oracle);
    const keywordParameters = extractMechanicKeywordParameters(keywords, oracle);

    const actions = new Set();
    UNIVERSAL_RULE_ACTION_REGEX.lastIndex = 0;
    let actionMatch;
    while ((actionMatch = UNIVERSAL_RULE_ACTION_REGEX.exec(oracle))) {
        const action = normalizeMechanicToken(actionMatch[0]);
        if (action) actions.add(action);
        if (UNIVERSAL_RULE_ACTION_REGEX.lastIndex === actionMatch.index) UNIVERSAL_RULE_ACTION_REGEX.lastIndex++;
    }

    const canonicalFunctions = new Set();
    const canonicalOutcomes = new Set();
    const parsedActions = new Set();
    for (const effect of (parsedEffects || [])) {
        if (!effect) continue;
        if (effect.action && effect.action !== 'generic') parsedActions.add(normalizeMechanicToken(effect.action));
        if (effect.canonical?.function) canonicalFunctions.add(normalizeMechanicToken(effect.canonical.function));
        if (effect.canonical?.outcome) canonicalOutcomes.add(normalizeMechanicToken(effect.canonical.outcome));
    }

    const zoneRegex = new RegExp(
        '(?:' + UNIVERSAL_ZONE_TERMS.map(escapeMechanicRegexTerm).map(v => v.replace(/\s+/g, '\\s+')).join('|') + ')',
        'gi'
    );
    const zones = collectRegexTokens(oracle, zoneRegex);
    const context = {};
    for (const [name, regex] of Object.entries(UNIVERSAL_CONTEXT_PATTERNS)) context[name] = collectRegexTokens(oracle, regex);
    const resources = collectRegexTokens(oracle, UNIVERSAL_RESOURCE_REGEX);
    const stats = collectRegexTokens(oracle, UNIVERSAL_STAT_REGEX);
    const counters = collectRegexTokens(oracle, UNIVERSAL_COUNTER_REGEX);
    const tokens = collectRegexGroupTokens(oracle, UNIVERSAL_TOKEN_REGEX);
    const manaSymbols = collectRegexTokens(oracle, UNIVERSAL_MANA_SYMBOL_REGEX);
    const polarity = polarityProfile(oracle);

    const atoms = new Set();
    keywords.forEach(v => atoms.add(`keyword:${v}`));
    keywordParameters.forEach(v => atoms.add(`keyword_param:${v}`));
    actions.forEach(v => atoms.add(`action:${v}`));
    parsedActions.forEach(v => atoms.add(`parsed_action:${v}`));
    canonicalFunctions.forEach(v => atoms.add(`function:${v}`));
    canonicalOutcomes.forEach(v => atoms.add(`outcome:${v}`));
    zones.forEach(v => atoms.add(`zone:${v}`));
    resources.forEach(v => atoms.add(`resource:${v}`));
    counters.forEach(v => atoms.add(`counter:${v}`));
    tokens.forEach(v => atoms.add(`token:${v}`));
    stats.forEach(v => atoms.add(`stat:${v}`));
    manaSymbols.forEach(v => atoms.add(`mana:${v}`));
    Object.entries(polarity).forEach(([kind, value]) => { if (value) atoms.add(`polarity:${kind}`); });
    Object.entries(context).forEach(([kind, set]) => set.forEach(v => atoms.add(`${kind}:${v}`)));

    return {
        keywords,
        keywordParameters,
        actions,
        parsedActions,
        canonicalFunctions,
        canonicalOutcomes,
        zones,
        context,
        resources,
        stats,
        counters,
        tokens,
        manaSymbols,
        polarity,
        atoms,
        keywordCount: keywords.size,
        actionCount: actions.size,
        hasStructuredKeywordData: Array.isArray(card?.keywords) && card.keywords.length > 0
    };
}


// V22: universal evidence weighting. Generic Oracle grammar tokens are useful for parsing but are
// weak proof of a shared mechanic. Specific actions, outcomes, zones, counters, and keyword data
// therefore carry more weight while the generic signature remains a recall backstop for mechanics
// the finite parser does not recognize.
const UNIVERSAL_FEATURE_WEIGHTS = Object.freeze({
    actions: 0.78, parsedActions: 0.86, canonicalFunctions: 1.10, canonicalOutcomes: 1.12,
    zones: 0.90, resources: 0.62, target: 0.62, scope: 0.46, trigger: 0.68,
    cost: 0.34, choice: 0.30, counters: 0.80, tokens: 0.76, stats: 0.58, polarity: 0.90
});
const UNIVERSAL_GENERIC_TOKENS = new Set([
    'choose', 'chosen', 'target', 'a', 'an', 'the', 'you', 'your', 'card', 'cards', 'permanent',
    'permanents', 'player', 'players', 'opponent', 'opponents', 'may', 'one', 'two', 'three',
    'each', 'all', 'any', 'some', 'this', 'that', 'those', 'when', 'whenever', 'if', 'unless',
    'then', 'instead', 'for each', 'up to'
]);
function weightedSymmetricCoverage(sourceSet, candidateSet, factor = 0.9) {
    const source = sourceSet instanceof Set ? sourceSet : new Set(sourceSet || []);
    const candidate = candidateSet instanceof Set ? candidateSet : new Set(candidateSet || []);
    if (!source.size && !candidate.size) return 1;
    if (!source.size || !candidate.size) return 0;
    const useful = value => !UNIVERSAL_GENERIC_TOKENS.has(normalizeMechanicToken(value));
    const a = [...source].filter(useful);
    const b = [...candidate].filter(useful);
    const aa = a.length ? a : [...source];
    const bb = b.length ? b : [...candidate];
    const overlap = aa.filter(v => bb.includes(v)).length;
    const directionalA = overlap / Math.max(1, aa.length);
    const directionalB = overlap / Math.max(1, bb.length);
    return Math.max(0, Math.min(1, Math.sqrt(directionalA * directionalB) * factor + (1 - factor) * Math.min(directionalA, directionalB)));
}
function polarityProfile(text) {
    const value = String(text || '').toLowerCase();
    return {
        negative: /\b(?:can't|cannot|do not|doesn't|don't|isn't|aren't|never|no longer)\b/.test(value),
        replacement: /\b(?:instead|replace|rather than)\b/.test(value),
        prevention: /\b(?:prevent|prevents|prevented)\b/.test(value),
        prohibition: /\b(?:can't|cannot|may not|don't)\b/.test(value)
    };
}
function comparePolarity(a = {}, b = {}) {
    const keys = ['negative', 'replacement', 'prevention', 'prohibition'];
    let seen = 0, equal = 0;
    for (const key of keys) {
        if (a[key] !== undefined || b[key] !== undefined) {
            seen++;
            if (a[key] === b[key]) equal++;
        }
    }
    return seen ? equal / seen : 1;
}
function buildUniversalFunctionalText(card = null, text = '', parsedEffects = null) {
    const oracle = String(text || card?.oracle_text || (card?.card_faces ? card.card_faces.map(f => f.oracle_text || '').join(' ') : '') || '').trim();
    let parsed = parsedEffects;
    try { parsed = Array.isArray(parsed) ? parsed : parseMTGEffect(oracle); } catch (_) { parsed = []; }
    const profile = buildUniversalMechanicProfile(card, oracle, parsed);
    const parts = [];
    const canonical = canonicalFunctionToText(getCanonicalFunctions(parsed));
    if (canonical) parts.push(canonical);
    if (profile.keywords.size) parts.push(`keywords ${[...profile.keywords].join(' ')}`);
    const usefulActions = [...profile.actions].filter(x => !UNIVERSAL_GENERIC_TOKENS.has(x));
    if (usefulActions.length) parts.push(`actions ${usefulActions.join(' ')}`);
    if (profile.zones.size) parts.push(`zones ${[...profile.zones].join(' ')}`);
    if (profile.resources.size) parts.push(`resources ${[...profile.resources].join(' ')}`);
    if (profile.counters.size) parts.push(`counters ${[...profile.counters].join(' ')}`);
    if (profile.stats.size) parts.push(`stats ${[...profile.stats].join(' ')}`);
    if (profile.context?.target?.size) parts.push(`targets ${[...profile.context.target].join(' ')}`);
    if (profile.context?.scope?.size) parts.push(`scope ${[...profile.context.scope].join(' ')}`);
    if (profile.context?.trigger?.size) parts.push(`triggers ${[...profile.context.trigger].join(' ')}`);
    return parts.join('. ');
}

function calculateUniversalMechanicSimilarity(profileA, profileB) {
    if (!profileA || !profileB) return { score: 0, keywordCoverage: 0, keywordParameterCoverage: 0, actionCoverage: 0, parsedActionCoverage: 0, functionCoverage: 0, outcomeCoverage: 0, zoneCoverage: 0, targetCoverage: 0, scopeCoverage: 0, triggerCoverage: 0, costCoverage: 0, choiceCoverage: 0, resourceCoverage: 0, atomCoverage: 0, counterCoverage: 0, tokenCoverage: 0, statCoverage: 0, polaritySimilarity: 0, sharedKeywords: [] };
    const keywordCoverage = weightedSymmetricCoverage(profileA.keywords, profileB.keywords, 1.0);
    const keywordParameterCoverage = weightedSymmetricCoverage(profileA.keywordParameters, profileB.keywordParameters, 1.0);
    const actionCoverage = weightedSymmetricCoverage(profileA.actions, profileB.actions, 0.90);
    const parsedActionCoverage = weightedSymmetricCoverage(profileA.parsedActions, profileB.parsedActions, 0.92);
    const functionCoverage = weightedSymmetricCoverage(profileA.canonicalFunctions, profileB.canonicalFunctions, 1.0);
    const outcomeCoverage = weightedSymmetricCoverage(profileA.canonicalOutcomes, profileB.canonicalOutcomes, 1.0);
    const zoneCoverage = weightedSymmetricCoverage(profileA.zones, profileB.zones, 0.95);
    const targetCoverage = weightedSymmetricCoverage(profileA.context?.target, profileB.context?.target, 0.78);
    const scopeCoverage = weightedSymmetricCoverage(profileA.context?.scope, profileB.context?.scope, 0.68);
    const triggerCoverage = weightedSymmetricCoverage(profileA.context?.trigger, profileB.context?.trigger, 0.82);
    const costCoverage = weightedSymmetricCoverage(profileA.context?.cost, profileB.context?.cost, 0.52);
    const choiceCoverage = weightedSymmetricCoverage(profileA.context?.choice, profileB.context?.choice, 0.48);
    const resourceCoverage = weightedSymmetricCoverage(profileA.resources, profileB.resources, 0.72);
    const counterCoverage = weightedSymmetricCoverage(profileA.counters, profileB.counters, 0.88);
    const tokenCoverage = weightedSymmetricCoverage(profileA.tokens, profileB.tokens, 0.84);
    const statCoverage = weightedSymmetricCoverage(profileA.stats, profileB.stats, 0.65);
    const atomCoverage = weightedSymmetricCoverage(profileA.atoms, profileB.atoms, 0.82);
    const polaritySimilarity = comparePolarity(profileA.polarity || {}, profileB.polarity || {});
    const sharedKeywords = [...profileA.keywords].filter(k => profileB.keywords.has(k));
    const exactKeywordEvidence = keywordCoverage > 0
        ? Math.min(1, keywordCoverage * 0.78 + keywordParameterCoverage * 0.16)
        : 0;
    const weights = UNIVERSAL_FEATURE_WEIGHTS;
    const numerator = actionCoverage * weights.actions + parsedActionCoverage * weights.parsedActions +
        functionCoverage * weights.canonicalFunctions + outcomeCoverage * weights.canonicalOutcomes +
        zoneCoverage * weights.zones + targetCoverage * weights.target + scopeCoverage * weights.scope +
        triggerCoverage * weights.trigger + costCoverage * weights.cost + choiceCoverage * weights.choice +
        resourceCoverage * weights.resources + counterCoverage * weights.counters + tokenCoverage * weights.tokens +
        statCoverage * weights.stats + polaritySimilarity * weights.polarity;
    const denominator = Object.values(weights).reduce((a, b) => a + b, 0);
    const weightedTextEvidence = denominator ? numerator / denominator : 0;
    const signatureEvidence = Math.max(weightedTextEvidence, exactKeywordEvidence, atomCoverage * 0.72,
        keywordCoverage * 0.70 + counterCoverage * 0.15 + tokenCoverage * 0.15);
    return {
        score: Math.max(0, Math.min(1, signatureEvidence)), keywordCoverage, keywordParameterCoverage,
        actionCoverage, parsedActionCoverage, functionCoverage, outcomeCoverage, zoneCoverage,
        targetCoverage, scopeCoverage, triggerCoverage, costCoverage, choiceCoverage, resourceCoverage,
        atomCoverage, counterCoverage, tokenCoverage, statCoverage, polaritySimilarity, sharedKeywords
    };
}

// ---------------------------------------------------------------------------
// V21 MECHANICAL GRAPH + RULES-AWARE RANKING LAYER
// ---------------------------------------------------------------------------
// The parser/universal-keyword layer is now promoted into a graph representation. A Magic card is
// not merely a bag of words or isolated effects: effects have triggers, targets, costs, zones,
// restrictions, quantities, durations, replacement/static modes, and an order/dependency relation.
// This layer compares those relationships explicitly while remaining tolerant of wording changes.
//
// Important design rule: this is still evidence, not a rules oracle. The parser can miss things;
// raw Oracle semantics and Scryfall keyword metadata remain parallel evidence sources. The graph
// therefore never hard-vetoes a candidate solely because a heuristic field is absent.

const MECHANICAL_GRAPH_VERSION = 1;

const MECHANIC_OBJECT_PARENTS = {
    'artifact creature': ['creature', 'artifact', 'permanent'],
    'enchantment creature': ['creature', 'enchantment', 'permanent'],
    'battle': ['permanent'],
    'planeswalker': ['permanent'],
    'creature': ['permanent'],
    'artifact': ['permanent'],
    'enchantment': ['permanent'],
    'land': ['permanent'],
    'kindred': ['permanent'],
    'token': ['permanent'],
    'permanent': [],
    'spell': [],
    'ability': [],
    'card': [],
    'player': [],
    'opponent': ['player'],
    'creature card': ['card'],
    'artifact card': ['card'],
    'enchantment card': ['card'],
    'land card': ['card'],
    'instant card': ['card'],
    'sorcery card': ['card'],
    'planeswalker card': ['card'],
    'kindred card': ['card']
};

const MECHANIC_FAMILY_MAP = {
    destruction: 'removal', exile: 'removal', sacrifice: 'removal', bounce: 'tempo', tuck: 'tempo',
    reanimate: 'recursion', recursion: 'recursion', cheat_into_play: 'recursion',
    tutor: 'selection', ramp_tutor: 'acceleration', card_draw: 'card_advantage', discard: 'disruption',
    mill: 'disruption', counter: 'interaction', direct_damage: 'interaction', gain_control: 'control',
    cost_reduction: 'cost_modification', token_creation: 'tokens', token_multiplier: 'tokens',
    tribal_anthem: 'combat', anthem: 'combat', place_counter: 'stats', mana_ability: 'resources',
    gain_life: 'life', lose_life: 'life', tap: 'board_state', untap: 'board_state',
    copy: 'copy', clone: 'copy', phase: 'zone_or_state', transform: 'zone_or_state'
};

// Semantic anchor map for keyword mechanics. Unknown keywords are still retained literally, so
// this map is an additional bridge between named keyword mechanics and rules-text phrasing rather
// than a closed vocabulary. The broad map covers high-frequency mechanics whose rules meaning is
// often expressed differently in Oracle text.
const KEYWORD_MECHANIC_ANCHORS = {
    flying: ['evasion', 'block_by_flying_or_reach'],
    reach: ['block_flying'],
    trample: ['combat_damage', 'excess_damage_to_player_or_battle'],
    deathtouch: ['lethal_damage', 'creature_destruction'],
    lifelink: ['damage', 'life_gain'],
    vigilance: ['attack', 'does_not_tap'],
    haste: ['attack', 'tap_ability_immediately'],
    menace: ['evasion', 'multiple_blockers_required'],
    double_strike: ['combat_damage', 'two_damage_steps'],
    first_strike: ['combat_damage', 'first_strike_step'],
    indestructible: ['destruction_prevention'],
    hexproof: ['targeting_protection'],
    shroud: ['targeting_protection'],
    protection: ['targeting_protection', 'damage_prevention', 'blocking_restriction'],
    ward: ['targeting_tax', 'targeting_protection'],
    defender: ['cannot_attack'],
    flash: ['instant_speed'],
    morph: ['face_down', 'turn_face_up'],
    disguise: ['face_down', 'ward', 'turn_face_up'],
    cloak: ['face_down'],
    manifest: ['face_down', 'put_card_on_battlefield'],
    mutate: ['combine_permanents', 'cast_for_mutate'],
    transform: ['change_face', 'double_faced'],
    disturb: ['cast_from_graveyard', 'transform'],
    aftermath: ['split_card', 'cast_from_graveyard'],
    adventure: ['split_card', 'cast_from_exile'],
    flashback: ['cast_from_graveyard'],
    escape: ['cast_from_graveyard', 'additional_cost'],
    unearth: ['cast_from_graveyard', 'temporary', 'haste'],
    disturb: ['cast_from_graveyard', 'transform'],
    embalm: ['token_copy', 'cast_from_graveyard'],
    eternalize: ['token_copy', 'cast_from_graveyard'],
    encore: ['graveyard', 'token_copy', 'attack'],
    suspend: ['exile', 'time_counters', 'cast_later'],
    foretell: ['exile', 'cast_later', 'alternative_cost'],
    plot: ['exile', 'cast_later', 'alternative_cost'],
    rebound: ['cast_from_graveyard_after_cast', 'delayed_trigger'],
    cascade: ['reveal', 'cast_free', 'library'],
    discover: ['reveal', 'cast_free', 'library'],
    storm: ['copy_spell', 'cast_count'],
    prowess: ['spell_cast', 'stat_buff'],
    heroic: ['target_you_control', 'triggered_stat_or_effect'],
    constellation: ['enchantment_enters', 'triggered_effect'],
    landfall: ['land_enters', 'triggered_effect'],
    magecraft: ['spell_or_ability_cast', 'triggered_effect'],
    revolt: ['permanent_left_battlefield', 'triggered_effect'],
    enrage: ['damage_to_creature', 'triggered_effect'],
    raid: ['attacked_this_turn', 'triggered_effect'],
    morbid: ['creature_died_this_turn', 'condition'],
    ferocious: ['power_threshold', 'condition'],
    threshold: ['graveyard_count', 'condition'],
    delirium: ['card_type_count', 'condition'],
    descend: ['graveyard_count', 'condition'],
    exalted: ['solo_attacker', 'stat_buff'],
    mentor: ['attack', 'stat_buff', 'counter'],
    bolster: ['counter', 'lowest_toughness'],
    proliferate: ['counter', 'permanent_or_player'],
    evolve: ['creature_enters', 'counter'],
    adapt: ['counter', 'activated_ability'],
    graft: ['counter', 'creature_enters'],
    undying: ['dies', 'return_from_graveyard', 'counter'],
    persist: ['dies', 'return_from_graveyard', 'counter'],
    bloodthirst: ['life_loss_condition', 'counter'],
    wither: ['damage', 'minus_counters'],
    infect: ['damage', 'poison_counters', 'minus_counters'],
    toxic: ['combat_damage', 'poison_counters'],
    corrupted: ['poison_counters', 'condition'],
    discover: ['reveal', 'cast_free'],
    convoke: ['tap_creatures', 'mana_cost'],
    delve: ['exile_graveyard_cards', 'mana_cost'],
    affinity: ['cost_reduction', 'object_count'],
    improvise: ['tap_artifacts', 'mana_cost'],
    kicker: ['additional_cost', 'optional'],
    buyback: ['additional_cost', 'return_to_hand'],
    madness: ['discard', 'cast_from_graveyard_or_exile'],
    channel: ['discard', 'activated_ability'],
    cycling: ['discard', 'draw'],
    transmute: ['discard', 'tutor', 'activated_ability'],
    transfigure: ['sacrifice', 'tutor', 'activated_ability'],
    ninjutsu: ['return_to_hand', 'combat', 'put_on_battlefield'],
    jutsu: ['return_to_hand', 'combat', 'put_on_battlefield'],
    dash: ['alternative_cost', 'haste', 'return_to_hand'],
    blitz: ['alternative_cost', 'haste', 'dies', 'draw'],
    emerge: ['cost_reduction', 'sacrifice'],
    exploit: ['sacrifice', 'enters_battlefield'],
    connive: ['draw', 'discard', 'counter'],
    investigate: ['create_token', 'clue', 'draw'],
    incubate: ['create_token', 'transform'],
    create: ['token_creation'],
    populate: ['token_copy'],
    living_weapon: ['token_creation', 'equipment', 'attach'],
    reconfigure: ['equipment', 'attach'],
    equip: ['equipment', 'attach'],
    bestow: ['aura', 'alternative_cost', 'creature'],
    reanimation: ['graveyard', 'battlefield'],
    ward: ['targeting_tax'],
    cascade: ['library', 'cast_free'],
    storm: ['copy_spell'],
    replicate: ['copy_spell'],
    offspring: ['token_creation', 'enters_battlefield'],
    saddle: ['tap_creatures', 'attack'],
    mount: ['tap_creatures', 'attack'],
    craft: ['exile_from_graveyard', 'artifact', 'transformation'],
    bargain: ['additional_cost', 'sacrifice'],
    gift: ['give_opponent_resource', 'cast_or_effect'],
    goad: ['attack_requirement', 'combat'],
    myriad: ['token_creation', 'attack'],
    myriad: ['token_creation', 'attack'],
    populate: ['token_copy'],
    discover: ['library', 'cast_free']
};

function normalizeMechanicalObject(value) {
    const raw = normalizeMechanicToken(value);
    if (!raw) return null;
    const v = raw
        .replace(/^a\s+|^an\s+/g, '')
        .replace(/\s+cards?$/i, ' card')
        .replace(/\s+permanents?$/i, ' permanent')
        .replace(/\s+creatures?$/i, ' creature')
        .replace(/\s+players?$/i, ' player')
        .trim();
    const aliases = {
        'instant or sorcery': 'spell', 'instant or sorcery card': 'card',
        'any target': 'player_or_permanent', 'noncreature spell': 'spell',
        'nonland permanent': 'permanent', 'non-token creature': 'creature', 'non-token permanent': 'permanent'
    };
    return aliases[v] || v;
}

function mechanicalObjectAncestors(value) {
    const root = normalizeMechanicalObject(value);
    if (!root) return new Set();
    const out = new Set([root]);
    const queue = [root];
    while (queue.length) {
        const current = queue.shift();
        for (const parent of (MECHANIC_OBJECT_PARENTS[current] || [])) {
            if (!out.has(parent)) { out.add(parent); queue.push(parent); }
        }
    }
    return out;
}

function compareMechanicalObjects(a, b) {
    const aa = normalizeMechanicalObject(a), bb = normalizeMechanicalObject(b);
    if (!aa && !bb) return 1;
    if (!aa || !bb) return 0.58;
    if (aa === bb) return 1;
    if ((aa === 'player_or_permanent' && ['player','opponent','permanent'].includes(bb)) ||
        (bb === 'player_or_permanent' && ['player','opponent','permanent'].includes(aa))) return 0.82;
    const aAnc = mechanicalObjectAncestors(aa), bAnc = mechanicalObjectAncestors(bb);
    if (aAnc.has(bb) || bAnc.has(aa)) return 0.86;
    const overlap = [...aAnc].filter(v => bAnc.has(v));
    if (overlap.length) {
        if (overlap.includes('permanent')) return 0.78;
        if (overlap.includes('card')) return 0.74;
        if (overlap.includes('player')) return 0.70;
        return 0.64;
    }
    return 0.08;
}

function normalizeMechanicalSet(value) {
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value.filter(Boolean).map(normalizeMechanicToken));
    if (value == null) return new Set();
    return new Set([normalizeMechanicToken(value)].filter(Boolean));
}

function compareMechanicalSets(a, b, emptySimilarity = 1) {
    const aa = normalizeMechanicalSet(a), bb = normalizeMechanicalSet(b);
    if (!aa.size && !bb.size) return emptySimilarity;
    if (!aa.size || !bb.size) return 0.55;
    const union = new Set([...aa, ...bb]);
    let intersection = 0;
    aa.forEach(v => { if (bb.has(v)) intersection++; });
    return intersection / Math.max(1, union.size);
}

function extractKeywordAnchorSet(card, text = '') {
    const keywords = extractMechanicKeywords(card, text || card?.oracle_text || '');
    const anchors = new Set();
    for (const keyword of keywords) {
        const clean = normalizeMechanicToken(keyword);
        anchors.add(`keyword:${clean}`);
        const mapped = KEYWORD_MECHANIC_ANCHORS[clean];
        if (mapped) mapped.forEach(x => anchors.add(`anchor:${x}`));
    }
    return anchors;
}

function inferMechanicalEvent(effect) {
    const raw = String(effect?.raw || '').toLowerCase();
    if (effect?.activationCost) return 'activated';
    if (effect?.triggerProfile?.event) return effect.triggerProfile.event;
    if (/\bwhenever\b/.test(raw)) return 'triggered_event';
    if (/\bwhen\b/.test(raw)) return 'triggered_event';
    if (/\bat the beginning of\b|\bat the end of\b/.test(raw)) return 'turn_trigger';
    if (/\binstead\b/.test(raw)) return 'replacement';
    if (/\bprevent(?:s|ed)?\b/.test(raw)) return 'prevention';
    if (/\b(?:can't|cannot)\b/.test(raw)) return 'prohibition';
    if (/\bas long as\b|\bwhile\b/.test(raw)) return 'static_condition';
    if (effect?.isStatic) return 'static';
    return 'resolution';
}

function inferMechanicalObject(effect, universalAtoms = new Set()) {
    const candidates = [
        effect?.canonical?.params?.object,
        effect?.object,
        effect?.targetProfile?.object,
        effect?.tokenType === 'token' ? 'token' : null
    ];
    for (const c of candidates) {
        if (c) return normalizeMechanicalObject(c);
    }
    for (const atom of universalAtoms) {
        const m = /^target:(.+)$/.exec(atom);
        if (m) return normalizeMechanicalObject(m[1]);
    }
    return null;
}

function mechanicalNodeKeywordAnchors(effect) {
    const anchors = new Set();
    const raw = String(effect?.raw || '').toLowerCase();
    for (const [keyword, mapped] of Object.entries(KEYWORD_MECHANIC_ANCHORS)) {
        const re = new RegExp(`\\b${escapeMechanicRegexTerm(keyword)}\\b`, 'i');
        if (re.test(raw)) {
            anchors.add(`keyword:${keyword}`);
            mapped.forEach(x => anchors.add(`anchor:${x}`));
        }
    }
    for (const action of UNIVERSAL_RULE_ACTION_TERMS) {
        const re = new RegExp(`\\b${escapeMechanicRegexTerm(action).replace(/\\s+/g, '\\\\s+')}\\b`, 'i');
        if (re.test(raw)) anchors.add(`action_anchor:${normalizeMechanicToken(action)}`);
    }
    return anchors;
}

function buildMechanicalEffectNode(effect, index = 0, graphAnchors = new Set()) {
    const raw = String(effect?.raw || '');
    const canonical = effect?.canonical || null;
    const taxonomy = effect?.action ? ACTION_TAXONOMY[effect.action] : null;
    const p = canonical?.params || {};
    const universalAnchors = mechanicalNodeKeywordAnchors(effect);
    // Keep node anchors local to this effect. Card-wide keyword/function atoms live on the graph
    // itself; copying them onto every node would make every effect look like it contains every
    // mechanic on the card and would artificially inflate pairwise node matches.
    const quantityProfile = effect?.quantityProfile || p.quantityProfile || {};
    const triggerProfile = effect?.triggerProfile || p.triggerProfile || {};
    const targetProfile = effect?.targetProfile || p.targetProfile || {};
    const controllerScope = effect?.controllerScope || p.controllerScope || null;
    const restrictions = new Set([...(effect?.restriction || []), ...(p.restriction || [])].filter(Boolean).map(normalizeMechanicToken));
    const targetScope = targetProfile.scope || controllerScope ||
        (restrictions.has('controlledbyyou') ? 'you_control' : restrictions.has('controlledbyopponent') ? 'opponent_control' : null);

    const event = inferMechanicalEvent(effect);
    const mode = effect?.effectMode || p.effectMode || 'normal';
    const nodeFamily = canonical?.function
        ? (MECHANIC_FAMILY_MAP[canonical.function] || taxonomy?.family || canonical.function)
        : (taxonomy?.family || null);

    const node = {
        index,
        sequence: index,
        action: normalizeMechanicToken(effect?.action || ''),
        function: normalizeMechanicToken(canonical?.function || ''),
        outcome: normalizeMechanicToken(canonical?.outcome || ''),
        family: normalizeMechanicToken(nodeFamily || ''),
        object: inferMechanicalObject(effect),
        from: normalizeMechanicToken(effect?.from || p.from || ''),
        to: normalizeMechanicToken(effect?.to || p.to || ''),
        targetKind: normalizeMechanicToken(targetProfile.kind || p.target || effect?.target || ''),
        targetObject: normalizeMechanicalObject(targetProfile.object || p.object || effect?.object),
        targetScope: normalizeMechanicToken(targetScope || ''),
        scope: normalizeMechanicToken(p.scope || effect?.scope || ''),
        restriction: restrictions,
        quantityProfile: {
            kind: normalizeMechanicToken(quantityProfile.kind || ''),
            relation: normalizeMechanicToken(quantityProfile.relation || ''),
            bound: normalizeMechanicToken(quantityProfile.bound || ''),
            source: normalizeMechanicToken(quantityProfile.source || '')
        },
        quantity: Number.isFinite(Number(effect?.quantity ?? p.quantity)) ? Number(effect?.quantity ?? p.quantity) : null,
        magnitude: normalizeMechanicToken(p.magnitude || effect?.powerToughness || effect?.amount || ''),
        duration: normalizeMechanicToken(effect?.durationProfile || p.duration || ''),
        event,
        triggerType: normalizeMechanicToken(triggerProfile.type || ''),
        triggerWindow: normalizeMechanicToken(triggerProfile.window || ''),
        triggerEvent: normalizeMechanicToken(triggerProfile.event || ''),
        condition: normalizeMechanicToken(effect?.condition || p.condition || ''),
        conditionDetail: normalizeMechanicalSet(effect?.conditionDetail || p.conditionDetail),
        costType: normalizeMechanicToken(effect?.activationCost?.type || ''),
        costs: new Set([...(effect?.activationCost?.parts || []), effect?.payCost, p.payCost].filter(Boolean).map(normalizeMechanicToken)),
        effectMode: mode,
        static: effect?.isStatic === true || mode === 'prohibition' || mode === 'replacement' || mode === 'prevention' || event === 'static' || event === 'static_condition',
        replacement: mode === 'replacement',
        prevention: mode === 'prevention',
        isCost: Boolean(effect?.isCostEffect || p.isCostEffect),
        isMode: Boolean(effect?.isMode || p.isMode),
        modeGroupId: effect?.modeGroupId ?? p.modeGroupId ?? null,
        modeCount: effect?.modeCount || p.modeCount || null,
        role: normalizeMechanicToken(p.dependencyProfile?.role || effect?.dependencyProfile?.role || (effect?.isCostEffect ? 'cost' : 'primary')),
        dependencies: new Set(Object.entries(effect?.dependencyProfile || p.dependencyProfile || {}).filter(([,v]) => v === true).map(([k]) => normalizeMechanicToken(k))),
        keywordAnchors: universalAnchors,
        raw
    };
    if (effect?.stats) node.stats = normalizeMechanicToken(effect.stats);
    if (effect?.keywords) node.grantedKeywords = normalizeMechanicalSet(effect.keywords);
    if (effect?.tokenType) node.tokenType = normalizeMechanicToken(effect.tokenType);
    if (effect?.multiplier != null) node.multiplier = Number(effect.multiplier) || null;
    return node;
}

function getCachedParsedEffects(card = null, text = '') {
    const oracle = String(text || card?.oracle_text || (card?.card_faces ? card.card_faces.map(f => f.oracle_text || '').join('\n\n') : '') || '');
    const key = `${normalizeCardNameForIdentity(card?.name || '')}|${oracle}`;
    const cached = mechanicalProfileCache.get(`parsed|${key}`);
    if (cached) {
        mechanicalProfileCache.delete(`parsed|${key}`);
        mechanicalProfileCache.set(`parsed|${key}`, cached);
        return cached;
    }
    const parsed = parseMTGEffect(oracle);
    mechanicalProfileCache.set(`parsed|${key}`, parsed);
    while (mechanicalProfileCache.size > MECHANICAL_PROFILE_CACHE_MAX) {
        mechanicalProfileCache.delete(mechanicalProfileCache.keys().next().value);
    }
    return parsed;
}

function getCachedMechanicalProfile(card = null, text = '', parsedEffects = null) {
    const oracle = String(text || card?.oracle_text || (card?.card_faces ? card.card_faces.map(f => f.oracle_text || '').join('\n\n') : '') || '');
    const key = `${normalizeCardNameForIdentity(card?.name || '')}|${oracle}`;
    const cacheKey = `profile|${key}`;
    const cached = mechanicalProfileCache.get(cacheKey);
    if (cached) {
        mechanicalProfileCache.delete(cacheKey);
        mechanicalProfileCache.set(cacheKey, cached);
        return cached;
    }
    const profile = buildUniversalMechanicProfile(card, oracle, parsedEffects || getCachedParsedEffects(card, oracle));
    mechanicalProfileCache.set(cacheKey, profile);
    while (mechanicalProfileCache.size > MECHANICAL_PROFILE_CACHE_MAX) {
        mechanicalProfileCache.delete(mechanicalProfileCache.keys().next().value);
    }
    return profile;
}

function getCachedMechanicalEffectGraph(card = null, text = '', parsedEffects = null) {
    const oracle = String(text || card?.oracle_text || (card?.card_faces ? card.card_faces.map(f => f.oracle_text || '').join('\n\n') : '') || '');
    if (card && card._mechanicalGraphCacheText === oracle && card._mechanicalGraph) return card._mechanicalGraph;
    const graph = buildMechanicalEffectGraph(card, oracle, parsedEffects);
    if (card) {
        card._mechanicalGraphCacheText = oracle;
        card._mechanicalGraph = graph;
    }
    return graph;
}

function buildMechanicalEffectGraph(card = null, text = '', parsedEffects = null) {
    const oracle = String(text || card?.oracle_text || (card?.card_faces ? card.card_faces.map(f => f.oracle_text || '').join('\n\n') : '') || '');
    const effects = Array.isArray(parsedEffects) ? parsedEffects : parseMTGEffect(oracle);
    const keywordAnchors = extractKeywordAnchorSet(card, oracle);
    const universalProfile = (effects?._mechanicProfile) || buildUniversalMechanicProfile(card, oracle, effects);
    universalProfile?.atoms?.forEach?.(a => keywordAnchors.add(a));

    const nodes = effects
        .map((effect, index) => buildMechanicalEffectNode(effect, index))
        .filter(node => node.function || node.action || node.keywordAnchors.size || node.object || node.event !== 'resolution');

    const edges = [];
    for (let i = 1; i < nodes.length; i++) {
        const prev = nodes[i - 1], curr = nodes[i];
        const between = `${prev.raw || ''} ${curr.raw || ''}`.toLowerCase();
        edges.push({
            from: prev.index,
            to: curr.index,
            relation: curr.role === 'dependent_followup' ? 'dependent_followup'
                : curr.role === 'cost' ? 'cost_before_effect'
                : curr.isMode && prev.isMode && curr.modeGroupId === prev.modeGroupId ? 'same_mode_group'
                : /\bthen\b/i.test(between) ? 'then'
                : /\bif you do\b/i.test(between) ? 'if_you_do'
                : 'sequence'
        });
    }

    const typeCounts = {};
    nodes.forEach(n => { const key = n.function || n.family || n.action || 'unknown'; typeCounts[key] = (typeCounts[key] || 0) + 1; });
    return {
        version: MECHANICAL_GRAPH_VERSION,
        nodes,
        edges,
        keywordAnchors,
        universalProfile,
        typeCounts,
        nodeCount: nodes.length
    };
}

function mechanicalNumericSimilarity(a, b) {
    const aa = Number(a), bb = Number(b);
    if (!Number.isFinite(aa) && !Number.isFinite(bb)) return 1;
    if (!Number.isFinite(aa) || !Number.isFinite(bb)) return 0.55;
    return Math.max(0, 1 - Math.abs(aa - bb) / Math.max(Math.abs(aa), Math.abs(bb), 1));
}

function mechanicalQuantitySimilarity(a, b) {
    const qa = a?.quantityProfile || {}, qb = b?.quantityProfile || {};
    const av = a?.quantity, bv = b?.quantity;
    let score = mechanicalNumericSimilarity(av, bv);
    if (qa.kind && qb.kind && qa.kind !== qb.kind) score *= 0.82;
    if (qa.relation && qb.relation) score *= qa.relation === qb.relation ? 1 : 0.62;
    if (qa.bound && qb.bound) score *= qa.bound === qb.bound ? 1 : 0.70;
    if ((qa.source || qb.source) && qa.source !== qb.source) score *= 0.70;
    return Math.max(0, Math.min(1, score));
}

function mechanicalDurationSimilarity(a, b) {
    const aa = a?.duration || '', bb = b?.duration || '';
    if (!aa && !bb) return 1;
    if (!aa || !bb) return 0.62;
    if (aa === bb) return 1;
    const temporaryA = /until_end_of_turn|while_condition|temporary/.test(aa);
    const temporaryB = /until_end_of_turn|while_condition|temporary/.test(bb);
    if (temporaryA === temporaryB) return 0.60;
    return 0.20;
}

function mechanicalEventSimilarity(a, b) {
    const ea = a?.event || '', eb = b?.event || '';
    if (!ea && !eb) return 1;
    if (!ea || !eb) return 0.58;
    if (ea === eb) return 1;
    const triggerA = a?.triggerEvent || ea, triggerB = b?.triggerEvent || eb;
    if (triggerA && triggerB && triggerA === triggerB) return 0.95;
    if (a?.triggerType === b?.triggerType && a?.triggerType) return 0.62;
    if ((ea === 'triggered_event' || ea === 'turn_trigger') && (eb === 'triggered_event' || eb === 'turn_trigger')) return 0.42;
    return 0.15;
}

function mechanicalModeSimilarity(a, b) {
    const ma = a?.effectMode || 'normal', mb = b?.effectMode || 'normal';
    if (ma === mb) return 1;
    const compatible = new Set(['replacement|normal','normal|replacement','prevention|normal','normal|prevention','prohibition|static','static|prohibition']);
    return compatible.has(`${ma}|${mb}`) ? 0.45 : 0.12;
}

function mechanicalTriggerSimilarity(a, b) {
    if (!a?.triggerType && !b?.triggerType && !a?.triggerEvent && !b?.triggerEvent && !a?.triggerWindow && !b?.triggerWindow) return 1;
    const type = a?.triggerType === b?.triggerType ? 1 : 0.30;
    const ev = a?.triggerEvent && b?.triggerEvent ? (a.triggerEvent === b.triggerEvent ? 1 : 0.10) : 0.55;
    const win = a?.triggerWindow && b?.triggerWindow ? (a.triggerWindow === b.triggerWindow ? 1 : 0.30) : 0.65;
    return Math.max(0, Math.min(1, type * 0.30 + ev * 0.50 + win * 0.20));
}

function mechanicalRestrictionSimilarity(a, b) {
    const aa = normalizeMechanicalSet(a), bb = normalizeMechanicalSet(b);
    if (!aa.size && !bb.size) return 1;
    if (!aa.size || !bb.size) return 0.64;
    const exact = compareMechanicalSets(aa, bb, 0.64);
    const hasOppositeControl = (aa.has('controlledbyyou') && bb.has('controlledbyopponent')) || (bb.has('controlledbyyou') && aa.has('controlledbyopponent'));
    return hasOppositeControl ? 0.08 : exact;
}

function mechanicalCostSimilarity(a, b) {
    const aa = normalizeMechanicalSet(a?.costs), bb = normalizeMechanicalSet(b?.costs);
    const type = a?.costType && b?.costType ? (a.costType === b.costType ? 1 : 0.30) : (a?.costType || b?.costType ? 0.60 : 1);
    const parts = compareMechanicalSets(aa, bb, 1);
    return Math.max(0, Math.min(1, type * 0.45 + parts * 0.55));
}

function mechanicalRoleSimilarity(a, b) {
    if (a?.role === b?.role) return 1;
    const compatible = new Set([
        'primary|followup','followup|primary','primary|dependent_followup','dependent_followup|primary',
        'cost|primary','primary|cost'
    ]);
    return compatible.has(`${a?.role || ''}|${b?.role || ''}`) ? 0.58 : 0.28;
}

const OPPOSITE_MECHANICS = new Set([
    'gain_life|lose_life','lose_life|gain_life','tap|untap','untap|tap',
    'draw|discard','discard|draw','gain_control|self_sacrifice','self_sacrifice|gain_control',
    'reanimate|mill','mill|reanimate'
]);

function mechanicalNodeContradiction(a, b) {
    let penalty = 0;
    const key = `${a?.function || a?.action || ''}|${b?.function || b?.action || ''}`;
    if (OPPOSITE_MECHANICS.has(key)) penalty += 0.30;

    const zoneOpposite = a?.from && a?.to && b?.from && b?.to && a.from === b.to && a.to === b.from && a.from !== a.to;
    if (zoneOpposite) penalty += 0.22;

    if ((a?.targetScope === 'you_control' && b?.targetScope === 'opponent_control') ||
        (a?.targetScope === 'opponent_control' && b?.targetScope === 'you_control')) penalty += 0.26;

    const massA = ['all','each'].includes(a?.targetKind), massB = ['all','each'].includes(b?.targetKind);
    if (massA !== massB) penalty += 0.10;

    const destinationConflict = a?.to && b?.to && a.to !== b.to &&
        ['battlefield','hand','graveyard','library','exile'].includes(a.to) &&
        ['battlefield','hand','graveyard','library','exile'].includes(b.to);
    if (destinationConflict && a?.function && b?.function && a.function === b.function) penalty += 0.16;

    if (a?.replacement !== b?.replacement && (a?.replacement || b?.replacement)) penalty += 0.08;
    if (a?.prevention !== b?.prevention && (a?.prevention || b?.prevention)) penalty += 0.08;
    return Math.min(0.55, penalty);
}

function compareMechanicalEffectNodes(a, b) {
    if (!a || !b) return { score: 0, contradiction: 0, breakdown: {} };

    const functionExact = a.function && b.function && a.function === b.function;
    const outcomeExact = a.outcome && b.outcome && a.outcome === b.outcome;
    const sameFunction = functionExact ? (outcomeExact || !a.outcome || !b.outcome ? 1 : 0.90) : 0;
    const sameAction = a.action && b.action && a.action === b.action ? 0.96 : 0;
    const sameOutcome = outcomeExact ? 0.86 : 0;
    const sameFamily = a.family && b.family && a.family === b.family ? 0.64 : 0;
    const anchorAffinity = a.keywordAnchors?.size && b.keywordAnchors?.size
        ? compareMechanicalSets(a.keywordAnchors, b.keywordAnchors, 0)
        : 0;
    const core = Math.max(
        sameFunction,
        sameAction,
        sameOutcome,
        sameFamily,
        anchorAffinity * 0.93,
        getFunctionAffinity(a.function, b.function)
    );
    if (core <= 0.02) return { score: 0, contradiction: 0, breakdown: { core: 0 } };

    const breakdown = {
        core,
        object: compareMechanicalObjects(a.object || a.targetObject, b.object || b.targetObject),
        target: compareMechanicalTargetNodes(a, b),
        zone: compareMechanicalZoneNodes(a, b),
        restriction: mechanicalRestrictionSimilarity(a.restriction, b.restriction),
        quantity: mechanicalQuantitySimilarity(a, b),
        trigger: mechanicalTriggerSimilarity(a, b),
        event: mechanicalEventSimilarity(a, b),
        duration: mechanicalDurationSimilarity(a, b),
        mode: mechanicalModeSimilarity(a, b),
        cost: mechanicalCostSimilarity(a, b),
        role: mechanicalRoleSimilarity(a, b),
        condition: a.condition || b.condition ? (a.condition === b.condition ? 1 : 0.45) : 1,
        stats: a.stats || b.stats ? (a.stats === b.stats ? 1 : 0.45) : 1,
        keywords: compareMechanicalSets(a.keywordAnchors, b.keywordAnchors, 1)
    };
    const fieldParts = [
        [15, breakdown.object], [14, breakdown.target], [13, breakdown.zone], [10, breakdown.restriction],
        [9, breakdown.quantity], [10, breakdown.trigger], [8, breakdown.event], [7, breakdown.duration],
        [7, breakdown.mode], [5, breakdown.cost], [5, breakdown.role], [5, breakdown.condition], [4, breakdown.stats]
    ];
    const fieldScore = fieldParts.reduce((sum, [w, v]) => sum + w * v, 0) / fieldParts.reduce((sum, [w]) => sum + w, 0);
    const contradiction = mechanicalNodeContradiction(a, b);

    // Core mechanics dominate. Parameters refine rather than redefine the mechanic. This is what
    // makes "destroy target creature" close to "destroy all creatures" while still preferring the
    // exact target/scope match, and "deal 2 damage" close to "deal 3 damage" without treating the
    // amount as the entire identity of the effect.
    const parameterFactor = 0.48 + (0.52 * fieldScore);
    const score = Math.max(0, Math.min(1, core * parameterFactor * (1 - contradiction)));
    return { score, contradiction, breakdown };
}

function compareMechanicalTargetNodes(a, b) {
    const kindA = a?.targetKind || '', kindB = b?.targetKind || '';
    const scopeA = a?.targetScope || '', scopeB = b?.targetScope || '';
    const object = compareMechanicalObjects(a?.targetObject || a?.object, b?.targetObject || b?.object);
    let kind = 1;
    if (kindA || kindB) {
        if (kindA === kindB) kind = 1;
        else if ((['each','all'].includes(kindA) && ['each','all'].includes(kindB))) kind = 0.92;
        else if ((kindA === 'target' && ['each','all'].includes(kindB)) || (kindB === 'target' && ['each','all'].includes(kindA))) kind = 0.46;
        else if (kindA === 'any' || kindB === 'any') kind = 0.82;
        else kind = 0.58;
    }
    const scope = scopeA || scopeB ? (scopeA && scopeB ? (scopeA === scopeB ? 1 : 0.18) : 0.66) : 1;
    return Math.max(0, Math.min(1, kind * 0.42 + scope * 0.26 + object * 0.32));
}

function compareMechanicalZoneNodes(a, b) {
    const from = a?.from || '', fromB = b?.from || '', to = a?.to || '', toB = b?.to || '';
    const fromScore = from || fromB ? (from === fromB ? 1 : (!from || !fromB ? 0.62 : 0.18)) : 1;
    const toScore = to || toB ? (to === toB ? 1 : (!to || !toB ? 0.62 : 0.18)) : 1;
    return fromScore * 0.48 + toScore * 0.52;
}

function compareMechanicalNodeSetsUnordered(nodesA, nodesB) {
    const source = Array.isArray(nodesA) ? nodesA : [];
    const candidate = Array.isArray(nodesB) ? nodesB : [];
    if (!source.length || !candidate.length) return { sourceCoverage: 0, candidateCoverage: 0, score: 0, matches: [] };

    const sourceWeights = source.map(n => Math.max(0.05, n.isCost ? 0.20 : (n.role === 'followup' ? 0.45 : 0.85)));
    const candidateWeights = candidate.map(n => Math.max(0.05, n.isCost ? 0.20 : (n.role === 'followup' ? 0.45 : 0.85)));
    const pairs = [];
    source.forEach((a, i) => candidate.forEach((b, j) => {
        const detail = compareMechanicalEffectNodes(a, b);
        if (detail.score > 0.02) pairs.push({ i, j, ...detail });
    }));
    pairs.sort((x, y) => y.score - x.score);
    const usedA = new Set(), usedB = new Set(), matches = [];
    for (const pair of pairs) {
        if (usedA.has(pair.i) || usedB.has(pair.j)) continue;
        usedA.add(pair.i); usedB.add(pair.j);
        matches.push(pair);
    }
    let sourceMatched = 0, candidateMatched = 0;
    for (const m of matches) {
        sourceMatched += sourceWeights[m.i] * m.score;
        candidateMatched += candidateWeights[m.j] * m.score;
    }
    const sourceWeight = sourceWeights.reduce((a,b) => a+b, 0) || 1;
    const candidateWeight = candidateWeights.reduce((a,b) => a+b, 0) || 1;
    const sourceCoverage = Math.max(0, Math.min(1, sourceMatched / sourceWeight));
    const candidateCoverage = Math.max(0, Math.min(1, candidateMatched / candidateWeight));
    return { sourceCoverage, candidateCoverage, score: Math.sqrt(sourceCoverage * candidateCoverage), matches };
}

function compareMechanicalNodeSequences(nodesA, nodesB) {
    const a = Array.isArray(nodesA) ? nodesA : [], b = Array.isArray(nodesB) ? nodesB : [];
    if (!a.length || !b.length) return { sourceCoverage: 0, candidateCoverage: 0, orderScore: 0, matches: [] };
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
    const choice = Array.from({ length: n + 1 }, () => Array(m + 1).fill(null));
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const detail = compareMechanicalEffectNodes(a[i - 1], b[j - 1]);
            const match = dp[i - 1][j - 1] + (detail.score * Math.max(0.05, a[i - 1].isCost ? 0.20 : 0.85));
            const skipA = dp[i - 1][j];
            const skipB = dp[i][j - 1];
            if (match >= skipA && match >= skipB && detail.score > 0.02) {
                dp[i][j] = match;
                choice[i][j] = { type: 'match', detail };
            } else if (skipA >= skipB) {
                dp[i][j] = skipA;
                choice[i][j] = { type: 'skipA' };
            } else {
                dp[i][j] = skipB;
                choice[i][j] = { type: 'skipB' };
            }
        }
    }
    const matches = [];
    let i = n, j = m;
    while (i > 0 && j > 0) {
        const step = choice[i][j];
        if (step?.type === 'match') {
            matches.push({ i: i - 1, j: j - 1, ...step.detail });
            i--; j--;
        } else if (step?.type === 'skipA') i--;
        else j--;
    }
    matches.reverse();
    const sourceWeights = a.map(x => Math.max(0.05, x.isCost ? 0.20 : (x.role === 'followup' ? 0.45 : 0.85)));
    const candidateWeights = b.map(x => Math.max(0.05, x.isCost ? 0.20 : (x.role === 'followup' ? 0.45 : 0.85)));
    const sourceWeight = sourceWeights.reduce((x,y) => x+y, 0) || 1;
    const candidateWeight = candidateWeights.reduce((x,y) => x+y, 0) || 1;
    const matchedSource = matches.reduce((sum, x) => sum + sourceWeights[x.i] * x.score, 0);
    const matchedCandidate = matches.reduce((sum, x) => sum + candidateWeights[x.j] * x.score, 0);
    const sourceCoverage = Math.max(0, Math.min(1, matchedSource / sourceWeight));
    const candidateCoverage = Math.max(0, Math.min(1, matchedCandidate / candidateWeight));
    const orderScore = matches.length <= 1 ? 1 : matches.reduce((sum, x, idx) => {
        if (idx === 0) return sum + 1;
        const prev = matches[idx - 1];
        const sourceGap = x.i - prev.i, candidateGap = x.j - prev.j;
        return sum + (sourceGap === candidateGap ? 1 : Math.max(0.25, 1 - Math.abs(sourceGap - candidateGap) * 0.25));
    }, 0) / matches.length;
    return { sourceCoverage, candidateCoverage, orderScore, matches };
}

function mechanicalGraphContradictionScore(graphA, graphB, matches = []) {
    const a = graphA?.nodes || [], b = graphB?.nodes || [];
    let penalty = 0, checked = 0;
    for (const match of matches) {
        const detail = compareMechanicalEffectNodes(a[match.i], b[match.j]);
        penalty += detail.contradiction || 0;
        checked++;
    }
    // Look for strong candidate-wide opposite mechanics as a secondary contradiction signal.
    const functionPairs = [];
    a.forEach(x => b.forEach(y => {
        const k = `${x.function || x.action}|${y.function || y.action}`;
        if (OPPOSITE_MECHANICS.has(k)) functionPairs.push(k);
    }));
    if (functionPairs.length) penalty += Math.min(0.25, functionPairs.length * 0.06);
    return Math.min(0.60, checked ? penalty / checked : penalty);
}

function calculateMechanicalGraphSimilarity(graphA, graphB) {
    if (!graphA || !graphB) return { score: 0, sourceCoverage: 0, candidateCoverage: 0, orderScore: 0, contradiction: 0, matches: [], featureVector: null, evidence: [] };
    const unordered = compareMechanicalNodeSetsUnordered(graphA.nodes, graphB.nodes);
    const sequence = compareMechanicalNodeSequences(graphA.nodes, graphB.nodes);
    const keywordAnchorCoverage = (graphA.keywordAnchors?.size && graphB.keywordAnchors?.size)
        ? compareMechanicalSets(graphA.keywordAnchors, graphB.keywordAnchors, 0)
        : 0;
    const typeCoverage = compareMechanicalSets(Object.keys(graphA.typeCounts || {}), Object.keys(graphB.typeCounts || {}), 1);
    const contradiction = mechanicalGraphContradictionScore(graphA, graphB, sequence.matches);
    const coreCoverage = Math.max(unordered.sourceCoverage, sequence.sourceCoverage);
    const balanced = Math.max(unordered.score, Math.sqrt(sequence.sourceCoverage * sequence.candidateCoverage));
    const sequenceAgreement = Math.max(sequence.orderScore, 0.35);

    const featureVector = {
        sourceCoverage: coreCoverage,
        candidateCoverage: Math.max(unordered.candidateCoverage, sequence.candidateCoverage),
        balancedCoverage: balanced,
        orderScore: sequenceAgreement,
        keywordAnchorCoverage,
        typeCoverage,
        contradiction,
        nodeCountRatio: Math.min(1, Math.min(graphA.nodes.length, graphB.nodes.length) / Math.max(graphA.nodes.length, graphB.nodes.length)),
        exactFunctionCoverage: compareMechanicalSets(
            graphA.nodes.map(n => n.function).filter(Boolean),
            graphB.nodes.map(n => n.function).filter(Boolean), 1
        )
    };

    // Calibration-ready feature blend. The coefficients are conservative, human-auditable defaults
    // rather than a claim of a trained ML model. A future benchmark export can fit these same feature
    // columns offline without changing the browser-side graph representation.
    const hasMechanicalMatch = sequence.matches.length > 0 || unordered.matches.length > 0 ||
        featureVector.keywordAnchorCoverage > 0.05 || featureVector.exactFunctionCoverage > 0.05;

    // Never manufacture a nonzero mechanical score from generic shape properties alone. A pair
    // with no shared mechanic may have the same number of parsed nodes and both be one-shot effects,
    // but that is not evidence that they do the same thing.
    const rankerScore = hasMechanicalMatch ? Math.max(0, Math.min(1,
        featureVector.sourceCoverage * 0.24 +
        featureVector.balancedCoverage * 0.13 +
        featureVector.exactFunctionCoverage * 0.14 +
        featureVector.keywordAnchorCoverage * 0.13 +
        featureVector.typeCoverage * 0.05 +
        featureVector.orderScore * 0.08 +
        featureVector.nodeCountRatio * 0.04 +
        Math.max(0, 1 - featureVector.contradiction) * 0.19
    )) : 0;

    const score = Math.max(0, Math.min(1,
        rankerScore * (0.82 + 0.18 * Math.max(coreCoverage, featureVector.keywordAnchorCoverage)) * (1 - contradiction * 0.65)
    ));

    const evidence = [];
    if (featureVector.exactFunctionCoverage >= 0.75) evidence.push('shared canonical function');
    if (featureVector.sourceCoverage >= 0.75) evidence.push('high source-effect coverage');
    if (featureVector.orderScore >= 0.85 && sequence.matches.length > 1) evidence.push('effect sequence agrees');
    if (featureVector.keywordAnchorCoverage >= 0.55) evidence.push('shared mechanic anchors');
    if (featureVector.contradiction >= 0.12) evidence.push('rules-level contradiction detected');

    return {
        score,
        sourceCoverage: featureVector.sourceCoverage,
        candidateCoverage: featureVector.candidateCoverage,
        balancedCoverage: featureVector.balancedCoverage,
        orderScore: featureVector.orderScore,
        contradiction,
        matches: sequence.matches.length >= unordered.matches.length ? sequence.matches : unordered.matches,
        featureVector,
        evidence,
        unordered,
        sequence,
        keywordAnchorCoverage,
        typeCoverage
    };
}

function buildMechanicalConsensusGraph(graphs = []) {
    const valid = (graphs || []).filter(g => g?.nodes?.length);
    if (!valid.length) return null;
    if (valid.length === 1) return valid[0];

    const clusters = [];
    for (const graph of valid) {
        for (const node of graph.nodes) {
            let bestCluster = null, bestScore = 0;
            for (const cluster of clusters) {
                const rep = cluster.representative;
                const detail = compareMechanicalEffectNodes(node, rep);
                if (detail.score > bestScore) { bestScore = detail.score; bestCluster = cluster; }
            }
            if (!bestCluster || bestScore < 0.56) {
                clusters.push({ representative: node, members: [{ graph, node, score: 1 }], graphIds: new Set([graph]) });
            } else {
                bestCluster.members.push({ graph, node, score: bestScore });
                bestCluster.graphIds.add(graph);
                const total = bestCluster.members.reduce((s, x) => s + x.score * Math.max(0.05, x.node.isCost ? 0.20 : 0.85), 0);
                const sorted = bestCluster.members.slice().sort((a,b) => {
                    const aAvg = bestCluster.members.reduce((s,x) => s + compareMechanicalEffectNodes(a.node,x.node).score, 0);
                    const bAvg = bestCluster.members.reduce((s,x) => s + compareMechanicalEffectNodes(b.node,x.node).score, 0);
                    return bAvg - aAvg;
                });
                bestCluster.representative = sorted[0].node;
                bestCluster.weightedSupport = total;
            }
        }
    }

    const consensusNodes = clusters.map((cluster, idx) => {
        const rep = { ...cluster.representative };
        rep.index = idx;
        rep.sequence = idx;
        rep.consensusSupport = cluster.graphIds.size / valid.length;
        rep.importance = rep.consensusSupport * (rep.isCost ? 0.20 : 0.85);
        return rep;
    });
    const safeNodes = consensusNodes.filter(node => node.consensusSupport >= (valid.length >= 3 ? 0.50 : 0.34));
    const fallbackNodes = safeNodes.length ? safeNodes : consensusNodes;
    const keywordAnchors = new Set();
    const typeCounts = {};
    fallbackNodes.forEach(n => {
        n.keywordAnchors?.forEach?.(a => keywordAnchors.add(a));
        const key = n.function || n.family || n.action || 'unknown';
        typeCounts[key] = (typeCounts[key] || 0) + 1;
    });
    return { version: MECHANICAL_GRAPH_VERSION, nodes: fallbackNodes, edges: [], keywordAnchors, typeCounts, nodeCount: fallbackNodes.length, isConsensus: true, sourceGraphCount: valid.length };
}

function buildMechanicalFeatureVector(cardOrGraphA, graphB = null) {
    const graphA = cardOrGraphA?.nodes ? cardOrGraphA : buildMechanicalEffectGraph(cardOrGraphA);
    const graph = graphB?.nodes ? graphB : null;
    if (!graph) return null;
    return calculateMechanicalGraphSimilarity(graphA, graph).featureVector;
}

function calculateMechanicalSimilarityDetailed(parsedA, parsedB, profileA = null, profileB = null) {
    const safeA = Array.isArray(parsedA) ? parsedA : [];
    const safeB = Array.isArray(parsedB) ? parsedB : [];

    const structural = (() => {
        const sourceCoverage = directionalMechanicalSimilarity(safeA, safeB);
        if (sourceCoverage <= 0) return 0;
        const candidateExcess = calculateCandidateMechanicalExcess(safeA, safeB);
        const excessPenalty = 0.18 * Math.pow(candidateExcess, 1.25);
        return Math.max(0, Math.min(1, sourceCoverage * (1 - excessPenalty)));
    })();

    const graphA = safeA._mechanicalGraph || buildMechanicalEffectGraph(null, '', safeA);
    const graphB = safeB._mechanicalGraph || buildMechanicalEffectGraph(null, '', safeB);
    const graph = calculateMechanicalGraphSimilarity(graphA, graphB);

    const universal = calculateUniversalMechanicSimilarity(
        profileA || buildUniversalMechanicProfile(null, '', safeA),
        profileB || buildUniversalMechanicProfile(null, '', safeB)
    );

    // V21: the graph is the primary structured mechanical signal. The older directional matcher is
    // retained as a second, simpler structural witness; the universal keyword/action signature is
    // retained as a broad recall witness. This prevents a new graph heuristic from becoming a
    // single point of failure while still letting it reason about trigger/target/zone/sequence
    // relationships that the old pairwise field scorer could not represent together.
    const structuredBlend = Math.max(
        graph.score,
        (graph.score * 0.72) + (structural * 0.18) + (universal.score * 0.10),
        structural * 0.78 + graph.score * 0.22
    );

    // Exact shared keyword mechanics remain strong evidence, especially for mechanics whose Oracle
    // implementation is too novel for the regex parser. Conversely, graph contradictions actively
    // suppress otherwise tempting lexical/keyword coincidences.
    const keywordRescue = universal.keywordCoverage > 0
        ? Math.max(0, universal.score * (0.92 + Math.min(0.08, universal.keywordParameterCoverage * 0.08)))
        : 0;
    const contradictionPenalty = graph.contradiction || 0;
    const score = Math.max(0, Math.min(1,
        Math.max(structuredBlend, keywordRescue * 0.92, universal.score * 0.62)
        * (1 - Math.min(0.42, contradictionPenalty * 0.72))
    ));

    return {
        score,
        structuralScore: structural,
        graphScore: graph.score,
        graphSourceCoverage: graph.sourceCoverage,
        graphCandidateCoverage: graph.candidateCoverage,
        graphBalancedCoverage: graph.balancedCoverage,
        graphOrderScore: graph.orderScore,
        graphContradiction: graph.contradiction,
        graphFeatureVector: graph.featureVector,
        graphMatches: graph.matches,
        graphEvidence: graph.evidence,
        universalScore: universal.score,
        universal
    };
}

function calculateMechanicalSimilarity(parsedA, parsedB, profileA = null, profileB = null) {
    return calculateMechanicalSimilarityDetailed(parsedA, parsedB, profileA, profileB).score;
}

// Cache tag extraction to prevent running ~70 regex operations repeatedly per card
function calculateCategoryScore(targetCard, tags, sourceCard = null, sourceEffects = null) {
    if (!targetCard) return 0;
    const sourceTags = new Set((tags || []).map(t => normalizeMechanicToken(t)).filter(Boolean));
    if (!sourceTags.size && !sourceCard) return 0;
    if (!targetCard._cachedTags) targetCard._cachedTags = generateTags(targetCard, tags || []).map(normalizeMechanicToken);
    const targetTags = new Set(targetCard._cachedTags.filter(Boolean));
    const explicitOverlap = sourceTags.size ? weightedSymmetricCoverage(sourceTags, targetTags, 0.86) : 0;

    const sourceText = sourceCard ? strategicRoleCardText(sourceCard) : '';
    const targetText = strategicRoleCardText(targetCard);
    const sourceParsed = Array.isArray(sourceEffects) ? sourceEffects : (sourceCard?._parsedEffects || (sourceText ? parseMTGEffect(sourceText) : []));
    const targetParsed = targetCard._parsedEffects || parseMTGEffect(targetText);
    const sourceProfile = buildUniversalMechanicProfile(sourceCard, sourceText, sourceParsed);
    const targetProfile = buildUniversalMechanicProfile(targetCard, targetText, targetParsed);
    const universalScore = sourceCard ? calculateUniversalMechanicSimilarity(sourceProfile, targetProfile).score : 0;

    const sourceRole = sourceCard ? inferStrategicRoleProfile(sourceCard, sourceParsed, sourceText) : [];
    const targetRole = inferStrategicRoleProfile(targetCard, targetParsed, targetText);
    let roleScore = 0;
    for (const a of sourceRole) for (const b of targetRole) {
        if (a.role === b.role) roleScore = Math.max(roleScore, Math.sqrt(a.score * b.score));
        else if (a.group && a.group === b.group) roleScore = Math.max(roleScore, Math.sqrt(a.score * b.score) * 0.65);
    }

    // Explicit category tags remain the anchor; universal profile/role evidence prevents Category
    // from collapsing to zero for new or obscure mechanics simply because no bespoke tag exists.
    if (sourceCard) return Math.max(0, Math.min(1, explicitOverlap * 0.55 + universalScore * 0.30 + roleScore * 0.15));
    return explicitOverlap;
}


function runWhenIdle(task, { timeout = 2500 } = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            fn(value);
        };
        const invoke = () => {
            Promise.resolve()
                .then(task)
                .then(value => finish(resolve, value), error => finish(reject, error));
        };

        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(invoke, { timeout: Math.max(0, Number(timeout) || 0) });
        } else {
            setTimeout(invoke, Math.min(Math.max(0, Number(timeout) || 0), 50));
        }
    });
}

async function pauseForUserIdle(initialDelayMs = 0, maxDelayMs = 2500) {
    const initial = Math.max(0, Number(initialDelayMs) || 0);
    const maxWait = Math.max(initial, Number(maxDelayMs) || 0);
    if (initial > 0) await backgroundAwareDelay(initial);

    // Do not make background semantic work compete with an actively visible page. A hidden tab
    // is already deprioritized by the browser, so the small visibility check simply lets the work
    // proceed without spinning while the user is away.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        await new Promise(resolve => window.requestIdleCallback(() => resolve(), { timeout: maxWait }));
    } else if (maxWait > 0) {
        await backgroundAwareDelay(Math.min(50, maxWait));
    }
}

function backgroundAwareDelay(ms) {
    return new Promise(resolve => {
        const id = Math.random().toString();
        const handler = (e) => {
            if (e.data === id) {
                bgTimerWorker.removeEventListener('message', handler);
                resolve();
            }
        };
        bgTimerWorker.addEventListener('message', handler);
        bgTimerWorker.postMessage({ id, ms });
    });
}

function updateProgress(step, total, message) {
    const p = loadingIndicator.querySelector('p');
    if (step && total) {
        // Built via DOM APIs rather than innerHTML, matching the safe-rendering pattern used for
        // card results elsewhere in the file - these values are internal/developer-authored
        // strings today, but there's no reason this one sink should be the exception.
        p.innerHTML = '';
        const strong = document.createElement('strong');
        const phaseLabel = step === 1
            ? 'Searching for candidates'
            : step === 2
                ? 'Scoring candidates'
                : step === 3
                    ? 'Finalizing results'
                    : step === 4
                        ? 'Diversifying results'
                        : 'Finalizing search';
        strong.textContent = phaseLabel;
        const span = document.createElement('span');
        span.className = 'progress-text';
        span.style.cssText = 'font-size: 12px; color: var(--text-muted);';
        span.textContent = message;
        p.appendChild(strong);
        p.appendChild(document.createElement('br'));
        p.appendChild(span);
    } else {
        // If a step isn't passed, update only the inner message text
        const span = p.querySelector('.progress-text');
        if (span) {
            span.textContent = message;
        } else {
            p.textContent = message;
        }
    }
}

// --- 0 Card2Vec Fetch Similar Cards result ---
async function getCard2VecRecommendations(cardName) {
    if (!ENABLE_LOCAL_CARD2VEC) return [];
    const url = `http://localhost:5000/similar?card=${encodeURIComponent(cardName)}`;
    try {
        let response = await fetch(url);
        if (!response.ok) return [];   
        const data = await response.json();
        const seen = new Set();
        const uniqueRecs = [];
        for (const rec of data) {
            const name = rec.name;
            if (name) {
                const lowerName = name.toLowerCase();
                if (!seen.has(lowerName)) {
                    seen.add(lowerName);
                    uniqueRecs.push({
                        name: name,
                        score: rec.score || 0
                    });
                }
            }
        }
        return uniqueRecs;
    } catch (error) {
        console.warn("Card2Vec local server not reached. Skipping Card2Vec recommendations.");
        return [];
    }
}

/**
 * Explains WHY a card fails the active hard filters, field by field.
 *
 * `matchesActiveFilters` returns a bare boolean, so "excluded by constraints" was as much as the
 * benchmark could ever say. When an expected card is filtered out you need to know whether the
 * engine was wrong or the test case's own constraints were - and that means seeing "cmc: expected
 * 2, actual 4" (review Priority 6).
 *
 * @param {Object} card
 * @param {Object} filters
 * @param {Object|null} broadFallbackFilters
 * @returns {Array<{field: string, expected: string, actual: string}>} empty when the card passes
 */
/**
 * Parses a Scryfall-style numeric comparison filter string - "3", "=3", "<=2", ">4", "!=1", with
 * optional surrounding whitespace - the same operator syntax Scryfall's own search bar uses for
 * cmc/pow/tou, so anyone who already filters on Scryfall or EDHREC can type what they're used to.
 * A bare number with no operator behaves as exact match ("=" ), same as before this filter
 * accepted operators at all.
 * @param {string} raw
 * @returns {{operator: string, value: number}|null} null for an empty/unparseable value, which
 *   callers treat as "no filter applied" rather than a hard failure - matching how every other
 *   optional text filter in this app already behaves on an empty string.
 */
function parseComparisonFilter(raw) {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(<=|>=|!=|<|>|=)?\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const value = parseFloat(match[2]);
    if (Number.isNaN(value)) return null;
    return { operator: match[1] || '=', value };
}

/**
 * Applies a parsed comparison filter against a card's numeric field value.
 * @param {number|undefined|null} cardValue
 * @param {{operator: string, value: number}|null} filterSpec
 * @returns {boolean}
 */
function matchesComparisonFilter(cardValue, filterSpec) {
    if (!filterSpec) return true;
    // A card missing the field entirely (e.g. Power on a non-creature, or a variable "*" power
    // that doesn't parse to a number) never satisfies a numeric filter - comparing against
    // nothing is a non-match, not a free pass.
    if (cardValue === undefined || cardValue === null || Number.isNaN(cardValue)) return false;
    switch (filterSpec.operator) {
        case '<': return cardValue < filterSpec.value;
        case '<=': return cardValue <= filterSpec.value;
        case '>': return cardValue > filterSpec.value;
        case '>=': return cardValue >= filterSpec.value;
        case '!=': return cardValue !== filterSpec.value;
        default: return cardValue === filterSpec.value; // '='
    }
}

/**
 * Renders a parsed comparison filter as a Scryfall search-syntax fragment, e.g.
 * ('cmc', {operator:'<=', value:3}) -> "cmc<=3". Scryfall's query syntax already uses these exact
 * operator characters, so once a value has been through parseComparisonFilter this is a
 * straight pass-through, not a translation.
 * @param {string} field
 * @param {{operator: string, value: number}|null} filterSpec
 * @returns {string} empty string when there's nothing to add
 */
function comparisonFilterToScryfallQuery(field, filterSpec) {
    return filterSpec ? `${field}${filterSpec.operator}${filterSpec.value}` : '';
}

/**
 * Reads a numeric card field (power/toughness), falling back to the first card face for
 * double-faced/transform cards that carry it there instead of at top level, and treating
 * non-numeric values ("*", "X", "1+*") as absent rather than a parse error - those describe a
 * card whose value isn't a fixed number, which a numeric comparison filter can't meaningfully
 * evaluate either way.
 * @param {Object} card
 * @param {string} field - 'power' or 'toughness'
 * @returns {number|undefined}
 */
function getComparableCardField(card, field) {
    let raw = card[field];
    if (raw === undefined && card.card_faces && card.card_faces[0]) raw = card.card_faces[0][field];
    if (raw === undefined || raw === null) return undefined;
    const normalized = String(raw).trim();
    // Do not accept partial numeric parses such as parseFloat("1+*") === 1.  MTG values such
    // as *, X, 1+*, and similar expressions are dynamic and cannot satisfy a fixed numeric
    // comparison reliably.
    if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return undefined;
    const num = Number(normalized);
    return Number.isFinite(num) ? num : undefined;
}

function normalizeConstraintList(value) {
    if (Array.isArray(value)) {
        return [...new Set(value.map(v => String(v || '').trim().toLowerCase()).filter(Boolean))];
    }
    return [...new Set(String(value || '').split(/[|,]/).map(v => v.trim().toLowerCase()).filter(Boolean))];
}

function getTypeLineParts(card) {
    const typeLine = String((typeof card === 'string' ? card : card?.type_line) || '').trim().toLowerCase();
    const divider = typeLine.split(/\s*[—–-]\s*/);
    const left = divider[0] || '';
    const subtypes = divider.length > 1 ? divider.slice(1).join(' ') : '';

    // Backward-compatible result: older callers expect an array and use `.map()`,
    // while newer filter code reads the named `left` / `subtypes` properties.
    const parts = typeLine ? typeLine.split(/\s+/).filter(Boolean) : [];
    parts.left = left;
    parts.subtypes = subtypes;
    return parts;
}

function hasTypeLineToken(text, requirement) {
    const needle = String(requirement || '').trim().toLowerCase();
    if (!needle) return true;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'i').test(text);
}

function cardHasKeyword(card, keyword) {
    const needle = String(keyword || '').trim().toLowerCase();
    if (!needle) return true;
    const keywords = Array.isArray(card?.keywords) ? card.keywords.map(k => String(k).toLowerCase()) : [];
    if (keywords.includes(needle)) return true;
    const oracle = String(card?.oracle_text || (card?.card_faces || []).map(f => f?.oracle_text || '').join(' ')).toLowerCase();
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(oracle);
}

function readConstraintFilters() {
    const listValue = id => normalizeConstraintList(document.getElementById(id)?.value || '');
    const types = listValue('filter-type');
    return {
        types,
        supertypes: listValue('filter-supertype'),
        subtypes: listValue('filter-subtype'),
        keywords: listValue('filter-keyword'),
        // Backwards-compatible singular field used by older benchmark cases / diagnostics.
        type: types[0] || '',
        format: document.getElementById('filter-format')?.value || '',
        rarity: document.getElementById('filter-rarity')?.value || '',
        identity: (document.getElementById('filter-identity')?.value || '').trim(),
        colors: (document.getElementById('filter-colors')?.value || '').trim(),
        cmc: (document.getElementById('filter-cmc')?.value || '').trim(),
        power: (document.getElementById('filter-power')?.value || '').trim(),
        toughness: (document.getElementById('filter-toughness')?.value || '').trim(),
        set: (document.getElementById('filter-set')?.value || '').trim(),
        extraOracle: (document.getElementById('filter-extra-oracle')?.value || '').trim()
    };
}

function hasActiveConstraintFilters(filters) {
    if (!filters) return false;
    return Boolean(
        (filters.types || []).length || (filters.supertypes || []).length ||
        (filters.subtypes || []).length || (filters.keywords || []).length ||
        filters.format || filters.rarity || filters.identity || filters.colors ||
        filters.cmc || filters.power || filters.toughness || filters.set || filters.extraOracle
    );
}

function escapeScryfallValue(value) {
    return String(value || '').replace(/(["\\])/g, '\\$1');
}

function buildScryfallConstraintParts(filters) {
    const parts = [];
    (filters?.types || []).forEach(type => parts.push(`type:${escapeScryfallValue(type)}`));
    // Supertypes such as legendary are searchable through Scryfall's type: syntax.
    (filters?.supertypes || []).forEach(supertype => parts.push(`type:${escapeScryfallValue(supertype)}`));
    (filters?.subtypes || []).forEach(subtype => parts.push(`subtype:${escapeScryfallValue(subtype)}`));
    (filters?.keywords || []).forEach(keyword => parts.push(`keyword:"${escapeScryfallValue(keyword)}"`));
    if (filters?.format) parts.push(`f:${filters.format}`);
    if (filters?.rarity) parts.push(`r:${filters.rarity}`);
    if (filters?.identity) parts.push(`identity:${filters.identity}`);
    if (filters?.colors) parts.push(`c:${filters.colors}`);
    const cmcQuery = comparisonFilterToScryfallQuery('cmc', parseComparisonFilter(filters?.cmc));
    if (cmcQuery) parts.push(cmcQuery);
    const powerQuery = comparisonFilterToScryfallQuery('pow', parseComparisonFilter(filters?.power));
    if (powerQuery) parts.push(powerQuery);
    const toughnessQuery = comparisonFilterToScryfallQuery('tou', parseComparisonFilter(filters?.toughness));
    if (toughnessQuery) parts.push(toughnessQuery);
    if (filters?.set) parts.push(`e:${escapeScryfallValue(filters.set)}`);
    if (filters?.extraOracle) parts.push(`o:"${escapeScryfallValue(filters.extraOracle)}"`);
    return parts;
}

function syncConstraintChipField(sourceId, chipsId) {
    const source = document.getElementById(sourceId);
    const chips = document.getElementById(chipsId);
    if (!source || !chips) return;
    chips.replaceChildren();
    normalizeConstraintList(source.value).forEach(value => {
        const chip = document.createElement('span');
        chip.className = 'constraint-chip';
        const label = document.createElement('span');
        label.textContent = value;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'constraint-chip-remove';
        remove.setAttribute('aria-label', `Remove ${value} restriction`);
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            const next = normalizeConstraintList(source.value).filter(item => item !== value);
            source.value = next.join('|');
            source.dispatchEvent(new Event('input', { bubbles: true }));
            syncConstraintChipField(sourceId, chipsId);
        });
        chip.append(label, remove);
        chips.appendChild(chip);
    });
}

function initMultiConstraintFields(updateBadge) {
    const configs = [
        { sourceId: 'filter-type', entryId: 'filter-type-entry', chipsId: 'filter-type-chips' },
        { sourceId: 'filter-supertype', entryId: 'filter-supertype-entry', chipsId: 'filter-supertype-chips' },
        { sourceId: 'filter-subtype', entryId: 'filter-subtype-entry', chipsId: 'filter-subtype-chips' },
        { sourceId: 'filter-keyword', entryId: 'filter-keyword-entry', chipsId: 'filter-keyword-chips' }
    ];
    configs.forEach(({ sourceId, entryId, chipsId }) => {
        const source = document.getElementById(sourceId);
        const entry = document.getElementById(entryId);
        const addBtn = document.querySelector(`.constraint-add-btn[data-target="${sourceId}"]`);
        if (!source || !entry) return;

        const addValue = () => {
            const raw = String(entry.value || '').trim();
            if (!raw) return;
            const values = normalizeConstraintList(source.value);
            normalizeConstraintList(raw).forEach(value => {
                if (!values.includes(value)) values.push(value);
            });
            source.value = values.join('|');
            entry.value = '';
            if (entry.tagName === 'SELECT') entry.selectedIndex = 0;
            source.dispatchEvent(new Event('input', { bubbles: true }));
            syncConstraintChipField(sourceId, chipsId);
            updateBadge?.();
        };

        // Select-based constraints add on selection, so Card Types and Supertypes do not need
        // a separate Add button. Text-entry constraints keep their explicit Add controls.
        addBtn?.addEventListener('click', addValue);
        entry.addEventListener('change', () => { if (entry.tagName === 'SELECT') addValue(); });
        entry.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                addValue();
            }
        });
        source.addEventListener('input', () => syncConstraintChipField(sourceId, chipsId));
        syncConstraintChipField(sourceId, chipsId);
    });
}

function explainFilterFailures(card, filters, broadFallbackFilters) {
    const failures = [];
    if (!card) return [{ field: 'card', expected: 'a card object', actual: 'null' }];

    const cardOracle = (card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text).join(' ') : '')).toLowerCase();

    const typeLineParts = getTypeLineParts(card);
    for (const type of (filters.types || [])) {
        if (!hasTypeLineToken(typeLineParts.left, type)) failures.push({ field: 'type', expected: type, actual: card.type_line || '(none)' });
    }
    for (const supertype of (filters.supertypes || [])) {
        if (!hasTypeLineToken(typeLineParts.left, supertype)) failures.push({ field: 'supertype', expected: supertype, actual: card.type_line || '(none)' });
    }
    for (const subtype of (filters.subtypes || [])) {
        if (!hasTypeLineToken(typeLineParts.subtypes, subtype)) failures.push({ field: 'subtype', expected: subtype, actual: card.type_line || '(none)' });
    }
    for (const keyword of (filters.keywords || [])) {
        if (!cardHasKeyword(card, keyword)) failures.push({ field: 'keyword', expected: keyword, actual: (card.keywords || []).join(', ') || '(none)' });
    }
    if (filters.format && card.legalities && card.legalities[filters.format.toLowerCase()] !== 'legal') {
        failures.push({ field: 'format', expected: `legal in ${filters.format}`, actual: card.legalities[filters.format.toLowerCase()] || '(unknown)' });
    }
    if (filters.rarity && (card.rarity || '').toLowerCase() !== filters.rarity.toLowerCase()) {
        failures.push({ field: 'rarity', expected: filters.rarity, actual: card.rarity || '(none)' });
    }
    if (filters.identity) {
        const allowed = filters.identity.toLowerCase().replace(/[^wubrgc]/g, '').split('');
        const cardIdentity = (card.color_identity || []).map(c => c.toLowerCase());
        const offenders = cardIdentity.filter(c => !allowed.includes(c));
        if (offenders.length > 0) {
            failures.push({ field: 'identity', expected: `within {${allowed.join('')}}`, actual: `{${cardIdentity.join('')}}` });
        }
    }
    if (filters.colors) {
        const required = filters.colors.toLowerCase().replace(/[^wubrgc]/g, '').split('').sort().join('');
        const actual = (card.colors || []).map(c => c.toLowerCase()).sort().join('');
        if (actual !== required) failures.push({ field: 'colors', expected: `{${required}}`, actual: `{${actual}}` });
    }
    if (filters.cmc) {
        const cmcFilter = parseComparisonFilter(filters.cmc);
        if (!cmcFilter) {
            failures.push({ field: 'cmc', expected: `a valid comparison (e.g. "3", "<=2", ">4")`, actual: filters.cmc });
        } else if (!matchesComparisonFilter(card.cmc, cmcFilter)) {
            failures.push({ field: 'cmc', expected: String(filters.cmc), actual: String(card.cmc ?? '(none)') });
        }
    }
    if (filters.power) {
        const powerFilter = parseComparisonFilter(filters.power);
        if (powerFilter && !matchesComparisonFilter(getComparableCardField(card, 'power'), powerFilter)) {
            failures.push({ field: 'power', expected: String(filters.power), actual: card.power ?? '(none)' });
        }
    }
    if (filters.toughness) {
        const toughnessFilter = parseComparisonFilter(filters.toughness);
        if (toughnessFilter && !matchesComparisonFilter(getComparableCardField(card, 'toughness'), toughnessFilter)) {
            failures.push({ field: 'toughness', expected: String(filters.toughness), actual: card.toughness ?? '(none)' });
        }
    }
    if (filters.set && (card.set || '').toLowerCase() !== filters.set.toLowerCase()) {
        failures.push({ field: 'set', expected: filters.set, actual: card.set || '(none)' });
    }
    if (filters.extraOracle && !cardOracle.includes(filters.extraOracle.toLowerCase())) {
        failures.push({ field: 'extraOracle', expected: `oracle contains "${filters.extraOracle}"`, actual: '(not present)' });
    }

    if (broadFallbackFilters) {
        if (broadFallbackFilters.identity) {
            const allowed = broadFallbackFilters.identity.toLowerCase().replace(/[^wubrgc]/g, '').split('');
            const cardIdentity = (card.color_identity || []).map(c => c.toLowerCase());
            if (cardIdentity.some(c => !allowed.includes(c))) {
                failures.push({ field: 'broad.identity', expected: `within {${allowed.join('')}}`, actual: `{${cardIdentity.join('')}}` });
            }
        }
        if (broadFallbackFilters.detectedTypes) {
            const cardType = (card.type_line || '').toLowerCase();
            if (!broadFallbackFilters.detectedTypes.some(t => cardType.includes(t))) {
                failures.push({ field: 'broad.type', expected: broadFallbackFilters.detectedTypes.join('/'), actual: card.type_line || '(none)' });
            }
        }
    }

    return failures;
}

// Helper function to check if a card matches active UI filters
function matchesActiveFilters(card, filters, broadFallbackFilters) {
    if (!card) return false;

    const typeLineParts = getTypeLineParts(card);
    if ((filters.types || []).some(type => !hasTypeLineToken(typeLineParts.left, type))) return false;
    if ((filters.supertypes || []).some(supertype => !hasTypeLineToken(typeLineParts.left, supertype))) return false;
    if ((filters.subtypes || []).some(subtype => !hasTypeLineToken(typeLineParts.subtypes, subtype))) return false;
    if ((filters.keywords || []).some(keyword => !cardHasKeyword(card, keyword))) return false;

    if (filters.format) {
        const formatLower = filters.format.toLowerCase();
        if (card.legalities && card.legalities[formatLower] !== 'legal') return false;
    }

    if (filters.rarity) {
        if ((card.rarity || '').toLowerCase() !== filters.rarity.toLowerCase()) return false;
    }

    if (filters.identity) {
        const allowedColors = filters.identity.toLowerCase().replace(/[^wubrgc]/g, '').split('');
        const cardIdentity = (card.color_identity || []).map(c => c.toLowerCase());
        for (const color of cardIdentity) {
            if (!allowedColors.includes(color)) return false;
        }
    }

    if (filters.colors) {
        const requiredColors = filters.colors.toLowerCase().replace(/[^wubrgc]/g, '').split('').sort().join('');
        const cardColors = (card.colors || []).map(c => c.toLowerCase()).sort().join('');
        if (cardColors !== requiredColors) return false;
    }

    if (filters.cmc) {
        const cmcFilter = parseComparisonFilter(filters.cmc);
        if (!cmcFilter || !matchesComparisonFilter(card.cmc, cmcFilter)) return false;
    }

    if (filters.power) {
        const powerFilter = parseComparisonFilter(filters.power);
        // Invalid filter syntax should fail closed, matching CMC behavior. A dynamic/non-numeric
        // card value also cannot satisfy a numeric comparison.
        if (!powerFilter || !matchesComparisonFilter(getComparableCardField(card, 'power'), powerFilter)) return false;
    }

    if (filters.toughness) {
        const toughnessFilter = parseComparisonFilter(filters.toughness);
        if (!toughnessFilter || !matchesComparisonFilter(getComparableCardField(card, 'toughness'), toughnessFilter)) return false;
    }

    if (filters.set) {
        if ((card.set || '').toLowerCase() !== filters.set.toLowerCase()) return false;
    }

    if (filters.extraOracle) {
        const extraOracleLower = filters.extraOracle.toLowerCase();
        const cardOracle = (card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text).join(' ') : '')).toLowerCase();
        if (!cardOracle.includes(extraOracleLower)) return false;
    }

    if (broadFallbackFilters) {
        if (broadFallbackFilters.identity) {
            const allowedColors = broadFallbackFilters.identity.toLowerCase().replace(/[^wubrgc]/g, '').split('');
            const cardIdentity = (card.color_identity || []).map(c => c.toLowerCase());
            for (const color of cardIdentity) {
                if (!allowedColors.includes(color)) return false;
            }
        }
        if (broadFallbackFilters.detectedTypes) {
            const cardType = (card.type_line || '').toLowerCase();
            const matchesAnyType = broadFallbackFilters.detectedTypes.some(t => cardType.includes(t));
            if (!matchesAnyType) return false;
        }
    }

    return true;
}

// Simple bound on cache growth: an unbounded Map here would leak memory across a long
// session, since queries are unique per search (depth/pages included in the key).
const SEARCH_CACHE_MAX_ENTRIES = 200;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Search-depth policy: every live retrieval stream gets at least an 8-page budget when the
// query has that many pages, while Search Depth (%) controls how much of the complete Scryfall
// result set is actually traversed. 100% means exhaust every available page.
const DEFAULT_SEARCH_DEPTH_PERCENT = 50;
const MIN_SEARCH_PAGES = 8;
const MAX_SEARCH_DEPTH_PERCENT = 100;
const SEARCH_DEPTH_STORAGE_KEY = 'manamatch_search_depth_percent';

// --- Persistent search cache (localStorage-backed) ------------------------------------------
// The in-memory searchCache above is wiped on every page refresh, so a user testing a few
// related cards back-to-back, or simply reloading the page, redoes all the same network work for
// no reason - the data isn't actually stale, the page just restarted. This adds a second,
// persistent layer behind the exact same TTL: a miss in memory falls through to localStorage
// before the caller gives up and hits the network, and a fresh entry is also (best-effort)
// mirrored to localStorage for the next page load to find.
//
// Deliberately far more conservative than the in-memory cache: localStorage has a small (commonly
// 5-10MB per origin) quota shared with everything else on the origin, and a single broad
// retrieval stream can return 1000+ full card objects. Only entries at or below
// PERSISTENT_CACHE_MAX_CARDS are mirrored at all - this naturally excludes the huge Search B/E/F
// dumps, which also churn the most between different searches and benefit least from surviving a
// reload - and only PERSISTENT_CACHE_MAX_ENTRIES total entries are kept, oldest evicted first.
// Every write is wrapped in try/catch; if the quota is ever hit anyway, persistence just silently
// stops for the rest of the session rather than repeatedly failing on every subsequent search.
const PERSISTENT_CACHE_STORAGE_KEY = 'manasearch_search_cache_v1';
const PERSISTENT_CACHE_MAX_ENTRIES = 15;
const PERSISTENT_CACHE_MAX_CARDS = 80;
let persistentCacheDisabled = (typeof localStorage === 'undefined');

function readPersistentCache() {
    if (persistentCacheDisabled) return {};
    try {
        const raw = localStorage.getItem(PERSISTENT_CACHE_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (err) {
        return {};
    }
}

function writePersistentCache(store) {
    if (persistentCacheDisabled) return;
    try {
        localStorage.setItem(PERSISTENT_CACHE_STORAGE_KEY, JSON.stringify(store));
    } catch (err) {
        // Quota exceeded, storage disabled (private browsing), or some other write failure -
        // stop trying for the rest of this session rather than repeatedly failing on every
        // subsequent search that would otherwise try to mirror an entry.
        persistentCacheDisabled = true;
    }
}

function pruneAndWritePersistentStore(store) {
    const keys = Object.keys(store);
    if (keys.length <= PERSISTENT_CACHE_MAX_ENTRIES) {
        writePersistentCache(store);
        return;
    }
    // Oldest-timestamp-first eviction - mirrors the in-memory cache's LRU spirit without needing
    // a second, separate ordering structure just to track it.
    const keep = keys
        .sort((a, b) => (store[a].timestamp || 0) - (store[b].timestamp || 0))
        .slice(keys.length - PERSISTENT_CACHE_MAX_ENTRIES);
    const trimmed = {};
    keep.forEach(k => { trimmed[k] = store[k]; });
    writePersistentCache(trimmed);
}
// ----------------------------------------------------------------------------------------------

function getCachedSearch(cacheKey) {
    let entry = searchCache.get(cacheKey);
    if (!entry) {
        // Fall through to the persistent layer before giving up entirely.
        const persistedEntry = readPersistentCache()[cacheKey];
        if (persistedEntry && (Date.now() - persistedEntry.timestamp <= SEARCH_CACHE_TTL_MS)) {
            // .coverage lives as an extra own property on the results array, which
            // JSON.stringify silently drops for arrays (only indexed elements survive) - it was
            // pulled out into its own field on write (see setCachedSearch) specifically so it can
            // be reattached here instead of quietly vanishing on a cold-start cache hit.
            const rehydrated = persistedEntry.cards || [];
            if (persistedEntry.coverage) rehydrated.coverage = persistedEntry.coverage;
            entry = { value: rehydrated, timestamp: persistedEntry.timestamp };
            // Hydrate into the fast in-memory cache too, so any further hits this session (if
            // any) don't keep round-tripping through localStorage/JSON parsing.
            searchCache.set(cacheKey, entry);
        }
    }
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > SEARCH_CACHE_TTL_MS) {
        searchCache.delete(cacheKey);
        return undefined;
    }
    // Refresh recency for a basic LRU eviction policy.
    searchCache.delete(cacheKey);
    searchCache.set(cacheKey, entry);

    // CRITICAL: return fresh, shallow-cloned card objects rather than the cached references.
    // scoreCardBatch mutates cards in place (mechanicalScore, contextScore, functionScore,
    // categoryScore, _cachedTags, _parsedEffects, fieldConfidence, retrievalEvidence, ...). A
    // repeated or overlapping query - very plausible within the 10-minute cache window, e.g. two
    // different blue creatures both hitting Search E's `type:creature identity:U` - used to hand
    // back the SAME decorated objects from whichever earlier, unrelated source card scored them
    // last. Worse, `if (card.contextScore === undefined)` in scoreCardBatch then silently skipped
    // recomputing it, so the new search would keep the OLD source card's semantic similarity
    // score. This is independent of any ranking-quality work and was treated as the top
    // correctness priority (review Priority 7).
    //
    // A shallow clone is sufficient and cheap: every field scoring adds is a top-level property
    // (never a mutated nested object), so `{...card}` gives each search a clean slate while still
    // sharing the underlying nested data (image_uris, card_faces, etc.) instead of a full deep
    // clone.
    const cloned = entry.value.map(card => ({ ...card }));
    if (entry.value.coverage) cloned.coverage = entry.value.coverage;
    return cloned;
}

function setCachedSearch(cacheKey, value) {
    const entry = { value, timestamp: Date.now() };
    searchCache.set(cacheKey, entry);
    while (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
        const oldestKey = searchCache.keys().next().value;
        searchCache.delete(oldestKey);
    }

    // Mirror to the persistent layer only when small enough to be worth the localStorage cost -
    // see the persistent cache section above for the reasoning behind this cap.
    if (Array.isArray(value) && value.length > 0 && value.length <= PERSISTENT_CACHE_MAX_CARDS) {
        const store = readPersistentCache();
        store[cacheKey] = { timestamp: entry.timestamp, cards: value, coverage: value.coverage || null };
        pruneAndWritePersistentStore(store);
    }
}

// --- Global Scryfall request throttle ---------------------------------------------------
// findSimilarCards fires several independent search streams (A, B, C, E, and up to 5
// functional "F" formulations) concurrently via Promise.all, and each stream paginates
// itself with its own internal 100ms inter-page delay. That per-stream delay only spaces out
// a single stream's OWN pages - it does nothing to coordinate the streams with each other, so
// on the very first tick every stream can issue a page-1 request at once, and again for page 2,
// etc. That burst of simultaneously in-flight requests is what was tripping Scryfall's rate
// limiter (429s), independent of any single stream's own pacing. Routing every request from
// every stream through one shared queue - bounded concurrency plus a minimum gap between
// dispatches - fixes the bursting at its source instead of only retrying after the fact.
//
// Concurrency is 1, not 2: an earlier version of this queue allowed 2 requests in flight at
// once, which was enough to fix the light tests (few pages per stream) but NOT the heavy ones -
// a test whose streams each need many pages (Sol Ring, Phyrexian Arena, Mystic Confluence) kept
// both queue slots continuously occupied for most of retrieval, which is exactly the sustained
// overlap Scryfall's limiter flags. Every 429 then cost an exponential backoff (up to 15s, up to
// 5 retries per page) that stacked directly onto that test's wall-clock time - this, not the NLP
// model, is why later/heavier tests in a benchmark run appeared to get progressively slower.
// Scryfall's own guidance is to insert a delay BETWEEN serial requests, not to run several at
// once, so true serialization (one in flight at a time) is what actually keeps every stream under
// the limiter regardless of how many pages it needs.
const SCRYFALL_MAX_CONCURRENT_REQUESTS = 1;
// Keep the complete retrieval pipeline intact, but use a deliberately conservative steady-state
// cadence. This is still well below Scryfall's published <10 requests/second guidance and leaves
// headroom for browser retries, other tabs, and traffic sharing the same public IP.
const SCRYFALL_MIN_DISPATCH_GAP_MS = 400;

let scryfallActiveRequests = 0;
let scryfallLastDispatchAt = 0;
const scryfallRequestQueue = [];

// A 429 is a client-wide signal. The first one freezes all queued traffic for at least a minute;
// repeated 429s escalate the freeze instead of repeatedly probing the same endpoint. The cooldown
// is intentionally longer than the minimum steady-state gap because Scryfall explicitly asks
// clients not to retry through a rate limit.
const SCRYFALL_DEFAULT_COOLDOWN_MS = 60000;
const SCRYFALL_MAX_COOLDOWN_MS = 5 * 60 * 1000;
let scryfallGlobalBackoffUntil = 0;
let scryfallConsecutiveRateLimits = 0;
let scryfallLastHealthyResponseAt = 0;
let scryfallLastCooldownUiNoticeAt = 0;
let scryfallDispatchGeneration = 0;
let scryfallCircuitOpen = false;
const SCRYFALL_COOLDOWN_UI_NOTICE_DEDUP_MS = 8000;

function showScryfallCooldownNotice(message) {
    const now = Date.now();
    if (now - scryfallLastCooldownUiNoticeAt < SCRYFALL_COOLDOWN_UI_NOTICE_DEDUP_MS) return;
    scryfallLastCooldownUiNoticeAt = now;
    updateProgress(null, null, message);
}

// Exact in-flight request coalescing is a correctness/performance guard, not a search-quality
// change. If two parts of the app ask for the same Scryfall URL at the same time, they share the
// one physical HTTP request instead of creating redundant traffic. Completed requests can still
// be cached by the normal search/source-card caches below.
const scryfallInFlightRequests = new Map();
// Global backoff broadcast: a 429 (or a network error that looks like a disguised one - see the
// CORS note in fetchScryfallSearch) almost always reflects load on the WHOLE client's traffic to
// Scryfall, not just the one query that happened to receive it. Previously, only the offending
// stream's own retry loop slowed down; every other stream kept dispatching through the shared
// queue at the normal 100ms pace in the meantime and would frequently walk into the same limit
// moments later, each independently re-discovering it and burning its own retry budget instead of
// the client backing off as a whole. notifyScryfallRateLimited widens the gap between EVERY
// dispatch (not just the offending stream's) for a cooldown window, then it decays back to normal.
const SCRYFALL_BACKOFF_DISPATCH_GAP_MS = 1000;

function createScryfallRateLimitError(message = "Scryfall rate limit/network block") {
    const error = new Error(message);
    error.code = "SCRYFALL_RATE_LIMIT";
    error.isScryfallRateLimit = true;
    return error;
}

function isScryfallRateLimitError(error) {
    return Boolean(error?.isScryfallRateLimit || error?.code === "SCRYFALL_RATE_LIMIT");
}

function abortQueuedScryfallRequests(reason = 'Scryfall rate limit; queued API requests were cancelled locally.') {
    // Invalidate every outstanding queue wake-up. A rate limit is a circuit-breaker event, so
    // stale timeout callbacks must not be allowed to resurrect the queue during the cooldown.
    scryfallDispatchGeneration++;
    if (scryfallDispatchTimer) {
        clearTimeout(scryfallDispatchTimer);
        scryfallDispatchTimer = null;
    }
    scryfallDispatchTimerPending = false;

    const queuedError = createScryfallRateLimitError(reason);
    const dropped = scryfallRequestQueue.splice(0);
    dropped.forEach(task => {
        try {
            task.reject(queuedError);
        } catch (_) {}
    });
    return dropped.length;
}

function notifyScryfallRateLimited(cooldownMs = SCRYFALL_DEFAULT_COOLDOWN_MS, source = '429') {
    // A browser CORS failure can obscure an HTTP 429 as `TypeError: Failed to fetch`. Explicit 429s
    // use the normal escalation; generic network/CORS failures get one fixed cooldown so multiple
    // observers of the same browser failure cannot turn it into a multi-minute freeze.
    const wasAlreadyOpen = scryfallCircuitOpen;
    const isExplicit429 = source === '429';
    if (isExplicit429) scryfallConsecutiveRateLimits++;
    scryfallCircuitOpen = true;

    // Escalate repeated explicit 429s: 60s -> 120s -> 240s -> 300s max. The important part is that
    // a limit is a CIRCUIT BREAKER, not a retry instruction: queued traffic is failed locally
    // instead of sitting in a timer chain that probes Scryfall again.
    const escalation = isExplicit429
        ? 2 ** Math.max(0, scryfallConsecutiveRateLimits - 1)
        : 1;
    const requestedCooldown = Math.max(0, cooldownMs);
    const effectiveCooldown = Math.min(
        SCRYFALL_MAX_COOLDOWN_MS,
        Math.max(SCRYFALL_DEFAULT_COOLDOWN_MS, requestedCooldown) * escalation
    );
    const nextBackoffUntil = Date.now() + effectiveCooldown;

    // Extend the existing cooldown, never shorten it.
    scryfallGlobalBackoffUntil = Math.max(
        scryfallGlobalBackoffUntil,
        nextBackoffUntil
    );

    showScryfallCooldownNotice(
        `Scryfall rate limit detected. API traffic is cooling down for ${Math.ceil(effectiveCooldown / 1000)}s; unsent queued API work was cancelled and will not be retried.`
    );

    // Do not keep already-queued API work alive through the cooldown. Those requests would only
    // become a retry wave after the timer fires. Each search stream already knows how to preserve
    // its partial results, so canceling unsent work is the correct fail-closed behavior here.
    const dropped = abortQueuedScryfallRequests(
        `Scryfall rate limit (${source}); unsent API request(s) cancelled.`
    );
    if (dropped > 0 && !wasAlreadyOpen) {
        showScryfallCooldownNotice(`Scryfall rate limit: cancelled ${dropped} queued API request(s); keeping partial results and sending no retries.`);
    }
}

function noteScryfallHealthyResponse() {
    const now = Date.now();
    scryfallLastHealthyResponseAt = now;

    // A healthy response after the current freeze clears the escalation state so an old rate
    // limit doesn't permanently make this session slower. We intentionally require a healthy
    // response AFTER the cooldown window rather than resetting on a queued request that merely
    // started while the queue was still recovering.
    if (now >= scryfallGlobalBackoffUntil) {
        scryfallConsecutiveRateLimits = 0;
        scryfallLastCooldownUiNoticeAt = 0;
        scryfallCircuitOpen = false;
    }
}

function currentScryfallDispatchGapMs() {
    // The cooldown is handled separately by pumpScryfallQueue(). This helper only
    // defines the normal steady-state spacing between Scryfall dispatches.
    return SCRYFALL_MIN_DISPATCH_GAP_MS;
}

let scryfallDispatchTimerPending = false;
let scryfallDispatchTimer = null;

function pumpScryfallQueue() {
    // A client-wide 429 circuit is a hard stop. Never schedule a cooldown timer and never probe
    // the API again from the queue; callers are rejected at the front door until the cooldown ends.
    const now = Date.now();
    if (scryfallCircuitOpen) {
        if (now < scryfallGlobalBackoffUntil) {
            abortQueuedScryfallRequests('Scryfall client-wide rate-limit circuit is open; queued work cancelled.');
            return;
        }
        scryfallCircuitOpen = false;
    }

    if (
        scryfallActiveRequests >= SCRYFALL_MAX_CONCURRENT_REQUESTS ||
        scryfallRequestQueue.length === 0
    ) {
        return;
    }

    const gapRemaining = scryfallLastDispatchAt + SCRYFALL_MIN_DISPATCH_GAP_MS - now;
    if (gapRemaining > 0) {
        if (!scryfallDispatchTimerPending) {
            const generation = scryfallDispatchGeneration;
            scryfallDispatchTimerPending = true;
            scryfallDispatchTimer = setTimeout(() => {
                scryfallDispatchTimerPending = false;
                scryfallDispatchTimer = null;
                if (generation !== scryfallDispatchGeneration) return;
                pumpScryfallQueue();
            }, gapRemaining);
        }
        return;
    }

    scryfallActiveRequests++;
    scryfallLastDispatchAt = Date.now();
    const task = scryfallRequestQueue.shift();
    if (!task) {
        scryfallActiveRequests--;
        pumpScryfallQueue();
        return;
    }

    fetch(task.url, task.options)
        .then(response => {
            if (response.status === 429) {
                const retryAfterHeader = parseFloat(response.headers?.get?.('Retry-After'));
                const retryAfterMs = !isNaN(retryAfterHeader) && retryAfterHeader >= 0
                    ? retryAfterHeader * 1000
                    : SCRYFALL_DEFAULT_COOLDOWN_MS;
                notifyScryfallRateLimited(retryAfterMs);
            } else if (response.ok) {
                noteScryfallHealthyResponse();
            }
            task.resolve(response);
        }, error => {
            if (!isScryfallRateLimitError(error)) {
                notifyScryfallRateLimited(SCRYFALL_DEFAULT_COOLDOWN_MS, 'network');
            }
            task.reject(error);
        })
        .finally(() => {
            scryfallActiveRequests--;
            // Do not pump the queue after a rate-limit/network circuit opens. Any remaining queued
            // work was already rejected by notifyScryfallRateLimited().
            if (!scryfallCircuitOpen) pumpScryfallQueue();
        });
}

function scryfallRequestKey(url, options = {}) {
    return JSON.stringify({
        url,
        method: options.method || 'GET',
        body: options.body || null
    });
}

function scryfallThrottledFetch(url, options = {}) {
    // Never enqueue work while the client-wide circuit is open. This is intentionally global,
    // including interactive traffic: a queued request is still a retry and Scryfall asks clients
    // not to keep probing after a 429. Once the cooldown expires, the next caller may resume.
    const now = Date.now();
    if (scryfallCircuitOpen) {
        if (now < scryfallGlobalBackoffUntil) {
            const cooldownError = createScryfallRateLimitError(
                benchmarkColdMode
                    ? 'Scryfall is in a client-wide cooldown after a 429; benchmark stopped to avoid retry traffic.'
                    : 'Scryfall is in a client-wide cooldown after a 429; new API traffic is paused.'
            );
            cooldownError.isLocalCooldownRejection = true;
            return Promise.reject(cooldownError);
        }
        scryfallCircuitOpen = false;
    }

    const requestOptions = benchmarkColdMode
        ? { ...options, cache: 'no-store' }
        : options;
    const key = scryfallRequestKey(url, requestOptions);
    const inFlight = scryfallInFlightRequests.get(key);
    if (inFlight) return inFlight;

    // Always enqueue while a cooldown is active. pumpScryfallQueue() owns the cooldown gate and
    // will simply hold the request until the safe dispatch time. This avoids turning a temporary
    // server-side rate limit into a cascade of local promise rejections.

    const requestPromise = new Promise((resolve, reject) => {
        scryfallRequestQueue.push({
            url,
            options: requestOptions,
            resolve,
            reject
        });

        pumpScryfallQueue();
    });

    scryfallInFlightRequests.set(key, requestPromise);
    requestPromise.then(
        () => scryfallInFlightRequests.delete(key),
        () => scryfallInFlightRequests.delete(key)
    );

    return requestPromise;
}
// ------------------------------------------------------------------------------------------

async function fetchScryfallSearch(query, maxPagesOverride = MIN_SEARCH_PAGES, searchLabel = "Search") {
    const depthInput = parseFloat(document.getElementById('filter-depth-percent')?.value);
    const rawDepth = (!isNaN(depthInput) && depthInput > 0) ? depthInput : DEFAULT_SEARCH_DEPTH_PERCENT;
    const depthPercent = Math.max(1, Math.min(MAX_SEARCH_DEPTH_PERCENT, rawDepth));

    // Include every input that affects the result set in the cache key - a query at 25% depth
    // must not satisfy a later request for the same query at 100% depth.
    const cacheKey = JSON.stringify({ query, depthPercent, maxPagesOverride });
    const cached = getCachedSearch(cacheKey);
    if (cached) return cached;

    let allResults = [];
    let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&order=edhrec`;
    let hasMore = true;
    let pagesFetched = 0;
    // maxPagesOverride is now a MINIMUM page budget, not a hard ceiling. All streams request at
    // least 8 pages where available, and Search Depth (%) decides what fraction of the COMPLETE
    // Scryfall result set is traversed. This is what makes 100% genuinely exhaustive.
    const requestedBaseline = Math.max(MIN_SEARCH_PAGES, maxPagesOverride || MIN_SEARCH_PAGES);
    let maxPages = requestedBaseline;
    let totalCardsForQuery = 0;

    const MAX_RATE_LIMIT_RETRIES = 5;
    let rateLimitRetries = 0;
    let bailedAfterRetries = false;

    while (hasMore && url) {
        let response;
        try {
            // Goes through the shared, rate-limited queue (see above) instead of calling
            // fetch() directly, so this stream's requests are paced against every OTHER
            // concurrent search stream, not just against its own previous page.
            response = await scryfallThrottledFetch(url, {
                headers: {
                    'User-Agent': 'ManaMatch/1.0 (Semantic Magic Search)',
                    'Accept': 'application/json'
                }
            });
        } catch (networkErr) {
            // Browser-side CORS failures can hide an HTTP 429 as TypeError/ERR_FAILED. The shared
            // queue treats that as a client-wide circuit-breaker event, so this stream stops and
            // preserves its already-retrieved pages. Locally-generated circuit errors are handled
            // the same way, without issuing a retry.
            bailedAfterRetries = true;
            if (!networkErr?.isLocalCooldownRejection) {
                showScryfallCooldownNotice(`[${searchLabel}] Scryfall request blocked by the API/network. This stream kept its partial results and stopped without retrying the failed request.`);
            }
            break;
        }

        // 200 -> Valid Search
        if (response.status === 200) {
            rateLimitRetries = 0;
            const data = await response.json();
            
            if (pagesFetched === 0) {
                totalCardsForQuery = data.total_cards || 0;
                const scryfallTotalPages = Math.ceil(totalCardsForQuery / 175) || 1;

                // Search Depth (%) operates on the FULL available Scryfall page count.
                // A minimum of 8 pages is retained for sufficiently large queries, but it never
                // exceeds the query's actual page count. At 100%, every page is fetched. At 50%,
                // half of the complete result set is fetched, rounded up, with the 8-page floor.
                const depthBasedPages = Math.ceil(scryfallTotalPages * (depthPercent / 100));
                maxPages = depthPercent >= MAX_SEARCH_DEPTH_PERCENT
                    ? scryfallTotalPages
                    : Math.min(
                        scryfallTotalPages,
                        Math.max(requestedBaseline, MIN_SEARCH_PAGES, depthBasedPages)
                    );
            }

            if (data.data) allResults.push(...data.data);
            hasMore = data.has_more;
            url = data.next_page;
            pagesFetched++;
            
            const pageProgressMessage = `${pagesFetched}/${maxPages} pages searched`;
            if (typeof activeSearchStreamProgressReporter === 'function') {
                activeSearchStreamProgressReporter({ label: searchLabel, message: pageProgressMessage, kind: 'progress' });
            } else {
                updateProgress(null, null, `[${searchLabel}] ${pageProgressMessage}...`);
            }
            if (pagesFetched >= maxPages) break;
            
        // 429 -> Rate Limit. The shared queue has already opened a client-wide cooldown, so
        // this stream records the partial result set and never retries the limited request.
        } else if (response.status === 429) {
            // Scryfall returned an explicit rate-limit response. Honor Retry-After when
            // available, freeze the shared queue, and STOP this stream. Retrying the same page
            // is exactly the traffic pattern that turns one 429 into a cascade of 429s.
            // The shared queue has already read Retry-After and opened the global circuit breaker
            // before this response reached the search stream. Do not notify a second time here.
            bailedAfterRetries = true;
            showScryfallCooldownNotice(`[${searchLabel}] Scryfall rate limit (429). Stream stopped; no retry will be sent.`);
            break;

        // 404 -> No matches is a normal Scryfall search outcome.  The search endpoint uses
        // 404 for a query that produces no cards, so treating every 404 as a syntax error made
        // Related Search report "invalid Scryfall query" whenever a perfectly valid narrow
        // phrase simply had no matches.  Only a 400-class parser/request error should be surfaced
        // as invalid syntax.
        } else if (response.status === 404) {
            if (pagesFetched === 0) {
                hasMore = false;
                url = null;
                totalCardsForQuery = 0;
                break;
            }
            // A 404 after successful pagination is unusual. Preserve the valid pages already
            // retrieved rather than discarding them or mislabeling the search as invalid.
            hasMore = false;
            url = null;
            bailedAfterRetries = false;
            break;

        // 400 -> Malformed / invalid Scryfall query. Unlike a 404 no-match response, this is a
        // genuine query-construction problem and should be surfaced to the caller with the API's
        // own details when available.
        } else if (response.status === 400) {
            let details = '';
            try {
                const data = await response.json();
                details = typeof data?.details === 'string' ? data.details : '';
            } catch (_) {}
            const err = new Error(details || 'invalid Scryfall query');
            err.status = 400;
            err.scryfallDetails = details;
            throw err;

        // Other -> Network / API Error (5xx etc.) - retry with the same bounded backoff, then
        // fall back to whatever this stream already has rather than discarding it.
        } else {
            rateLimitRetries++;
            if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
                bailedAfterRetries = true;
                break;
            }
            const backoffMs = Math.min(1000 * 2 ** rateLimitRetries, 15000);
            const retryMessage = `API error (${response.status}) — retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}`;
            if (typeof activeSearchStreamProgressReporter === 'function') {
                activeSearchStreamProgressReporter({ label: searchLabel, message: retryMessage, kind: 'error' });
            } else {
                updateProgress(null, null, `[${searchLabel}] ${retryMessage}...`);
            }
            await backgroundAwareDelay(backoffMs);
            continue;
        }
        
        if (hasMore && pagesFetched < maxPages) {
            await backgroundAwareDelay(100);
        }
    }
    
    // Coverage metadata attached directly to the returned array (not just a count), so a caller
    // that wants to know WHY an expected card might be missing can see whether this stream even
    // finished covering its own match set (project spec Priority 7: retrieval diagnostics).
    allResults.coverage = {
        query,
        totalCards: totalCardsForQuery,
        pagesFetched,
        maxPages,
        retrievedCount: allResults.length,
        fullyCovered: pagesFetched >= Math.ceil(totalCardsForQuery / 175),
        // True when this stream had to give up mid-pagination after exhausting its retries
        // (persistent 429s, CORS-blocked rate-limit responses, or repeated 5xx errors) rather
        // than because it legitimately finished. Diagnostics can use this to distinguish "this
        // query only has 3 pages of matches" from "this query has more, we just couldn't get
        // to them" (review Priority 7).
        bailedAfterRetries
    };

    // A resumable cursor for "Search Deeper": present only when this stream was deliberately
    // capped by maxPages while Scryfall still had more pages (hasMore), and NOT when it gave up
    // after exhausting retries (bailedAfterRetries) - a stream that bailed needs a fresh attempt
    // from the same spot, not to be treated as "successfully paused here". `url` at this point
    // already holds next_page from the last successful response, since it's only reassigned
    // inside the 200-status branch above.
    allResults.continuation = (hasMore && !bailedAfterRetries && url)
        ? { url, searchLabel }
        : null;

    // Don't cache a result that's short because retries were exhausted - caching it would lock
    // in the gap for the full 10-minute TTL. A clean result (even an intentionally small one,
    // e.g. a narrow query that only had one page) is still safe to cache.
    if (!bailedAfterRetries) {
        setCachedSearch(cacheKey, allResults);
    }
    return allResults;
}

/**
 * Fetches more pages of an already-started Scryfall search, continuing from a previously-issued
 * continuation cursor (see fetchScryfallSearch's `.continuation`). This is the engine behind
 * "Search Deeper": rather than one search trying to exhaustively page through a haystack that
 * could be thousands of cards deep (slow, and mostly wasted on cards that were never going to
 * rank), the initial search stays bounded and fast, and the user can explicitly ask for more in
 * controlled, paced batches - each one still going through the exact same shared throttled queue
 * and retry/backoff behavior as every other Scryfall request, so this never bypasses the rate
 * limiting that keeps every OTHER request healthy.
 * @param {{url: string, searchLabel: string}} continuation
 * @param {number} pageBudget - how many more pages to fetch in this one call
 * @returns {Promise<{results: Array, continuation: {url,searchLabel}|null, bailedAfterRetries: boolean}>}
 */
async function fetchScryfallContinuationPages(continuation, pageBudget) {
    let { url, searchLabel } = continuation;
    const results = [];
    let hasMore = true;
    let pagesFetched = 0;
    const MAX_RATE_LIMIT_RETRIES = 5;
    let rateLimitRetries = 0;
    let bailedAfterRetries = false;

    while (hasMore && url && pagesFetched < pageBudget) {
        let response;
        try {
            response = await scryfallThrottledFetch(url, {
                headers: { 'User-Agent': 'ManaMatch/1.0 (Semantic Magic Search)', 'Accept': 'application/json' }
            });
        } catch (networkErr) {
            // The shared queue already opened the global circuit breaker for the rejected Scryfall
            // request. This stream simply stops without sending a duplicate retry.
            bailedAfterRetries = true;
            if (!networkErr?.isLocalCooldownRejection) {
                showScryfallCooldownNotice(`[${searchLabel}] Search Deeper: Scryfall rate limit/network response blocked. No retry sent.`);
            }
            break;
        }

        if (response.status === 200) {
            rateLimitRetries = 0;
            const data = await response.json();
            if (data.data) results.push(...data.data);
            hasMore = data.has_more;
            url = data.next_page;
            pagesFetched++;
            updateProgress(null, null, `[${searchLabel}] Search Deeper: ${pagesFetched}/${pageBudget} more pages...`);
        } else if (response.status === 429) {
            // Central queue handling already applied Retry-After and opened the global circuit
            // breaker. Keep this stream from issuing a duplicate retry.
            bailedAfterRetries = true;
            showScryfallCooldownNotice(`[${searchLabel}] Search Deeper: rate limit (429). No retry sent.`);
            break;
        } else if (response.status === 404) {
            // A continuation URL should never 404 (Scryfall generated it itself), but treat it as
            // exhausted rather than throwing and losing every page already fetched this batch.
            hasMore = false;
        } else {
            rateLimitRetries++;
            if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) { bailedAfterRetries = true; break; }
            const backoffMs = Math.min(1000 * 2 ** rateLimitRetries, 15000);
            updateProgress(null, null, `[${searchLabel}] Search Deeper: API error (${response.status}). Retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}...`);
            await backgroundAwareDelay(backoffMs);
            continue;
        }

        if (hasMore && pagesFetched < pageBudget) {
            await backgroundAwareDelay(100);
        }
    }

    return {
        results,
        continuation: (hasMore && !bailedAfterRetries && url) ? { url, searchLabel } : null,
        bailedAfterRetries
    };
}

async function fetchScryfallCollection(cardIdentifiers) {
    const batchSize = 75;
    let allCards = [];
    for (let i = 0; i < cardIdentifiers.length; i += batchSize) {
        const batch = cardIdentifiers.slice(i, i + batchSize);
        try {
            const response = await scryfallThrottledFetch('https://api.scryfall.com/cards/collection',{
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'ManaMatch/1.0 (Semantic Magic Search)',
                    'Accept': 'application/json'
            },
                body: JSON.stringify({ identifiers: batch })
            });
            if (response.ok) {
                const data = await response.json();
                if (data.data) {
                    allCards.push(...data.data);
                }
            } else if (response.status === 429) {
                // The shared queue has already opened the global circuit breaker. Keep this
                // collection call non-throwing so callers retain any successfully retrieved
                // cards instead of losing the entire batch. Later queued work will resume after
                // the same cooldown.
                console.warn('Scryfall collection request rate-limited; retaining partial results while the global cooldown runs.');
            }
        } catch (err) {
            if (!err?.isLocalCooldownRejection) {
                console.error("Collection batch fetch failed:", err);
            }
        }
    }
    return allCards;
}

// --- ENGINE 1: CONTEXT (Transformers / NLP) ---
async function loadTransformersLib() {
    try {
        let attempts = 0;
        while (!window.transformers && attempts < 50) {
            await new Promise(resolve => setTimeout(resolve, 200));
            attempts++;
        }
        if (!window.transformers) return null; 
        if (window.transformers.env) window.transformers.env.allowLocalModels = false;
        return window.transformers;
    } catch (error) {
        return null; 
    }
}

function calculateSimpleSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    const lexical = lexicalTokenCoverage(text1, text2);
    const normalizedA = String(text1).toLowerCase().replace(/[^a-z0-9+\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const normalizedB = String(text2).toLowerCase().replace(/[^a-z0-9+\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalizedA || !normalizedB) return 0;
    if (normalizedB.includes(normalizedA)) return 1;
    const sourceWords = normalizedA.split(/\s+/).map(normalizeLexicalStem).filter(Boolean);
    const targetWords = normalizedB.split(/\s+/).map(normalizeLexicalStem).filter(Boolean);
    const sourceBigrams = new Set();
    for (let i = 0; i + 1 < sourceWords.length; i++) sourceBigrams.add(`${sourceWords[i]} ${sourceWords[i + 1]}`);
    let sharedBigrams = 0;
    for (let i = 0; i + 1 < targetWords.length; i++) if (sourceBigrams.has(`${targetWords[i]} ${targetWords[i + 1]}`)) sharedBigrams++;
    const bigramScore = sourceBigrams.size ? sharedBigrams / sourceBigrams.size : lexical;
    return Math.max(0, Math.min(1, lexical * 0.72 + bigramScore * 0.28));
}

async function getNLPModel() {
    if (!nlpExtractor) {
        const loadingText = loadingIndicator.querySelector('p');
        loadingText.textContent = "Loading NLP ML Model (First time only, ~20MB)...";
        try {
            const transformers = await loadTransformersLib();
            if (transformers) {
                loadingText.textContent = "Initializing semantic analysis engine...";
                nlpExtractor = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
            } else {
                nlpExtractor = { type: 'fallback' };
            }
        } catch (error) {
            nlpExtractor = { type: 'fallback' };
        }
    }
    return nlpExtractor;
}

// V19 semantic normalization: remove card-specific wording noise before MiniLM sees Oracle text.
// This keeps the semantic channel focused on rules meaning rather than names, reminder text,
// mana-symbol typography, and incidental numeric formatting.
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
    // Reminder text is useful to humans but often duplicates/loosens the actual rules wording.
    value = value.replace(/\([^()]*\)/g, ' ');
    value = value.replace(/\{T\}/gi, ' tap ')
        .replace(/\{Q\}/gi, ' untap ')
        .replace(/\{[WUBRGC]\}/gi, ' colored mana ')
        .replace(/\{\d+\}/g, ' generic mana ')
        .replace(/\{X\}/gi, ' X mana ')
        .replace(/\{[^}]+\}/g, ' mana symbol ');
    const lower = value.toLowerCase();
    for (const [keyword, expansion] of Object.entries(SEMANTIC_KEYWORD_EXPANSIONS)) {
        value = value.replace(new RegExp(`\\b${keyword}\\b`, 'gi'), ` ${keyword} ${expansion} `);
    }
    // Numbers are preserved because quantity matters, but normalize comma/formatting noise.
    return value.replace(/[^a-z0-9+\-\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

let semanticCosineBaseline = 0.30;
let semanticCosineBaselineReady = false;

// V21/V22 semantic retrieval: full-corpus retrieval uses only the precomputed static
// `semantic-index.bin` generated during deployment. Visitor devices NEVER build a full corpus,
// fetch Scryfall bulk-data exports, or persist a locally generated semantic index.
const FULL_SEMANTIC_INDEX_SEARCH_LIMIT = 96;
const STATIC_SEMANTIC_INDEX_FILENAME = 'semantic-index.bin';
const STATIC_SEMANTIC_INDEX_VERSION = 1;
const STATIC_SEMANTIC_INDEX_MAGIC = 'MSIDX1';
const STATIC_SEMANTIC_INDEX_CACHE_VERSION = '20261007-1';
let staticSemanticIndexPromise = null;
let staticSemanticIndexAttempted = false;
let staticSemanticIndexLoadError = null;
let fullSemanticIndexMemory = null;
let fullSemanticIndexUnavailable = false;
let fullSemanticIndexUnavailableReason = null;

function getStaticSemanticIndexUrl() {
    try {
        const url = new URL(STATIC_SEMANTIC_INDEX_FILENAME, document.baseURI || window.location.href);
        url.searchParams.set('v', STATIC_SEMANTIC_INDEX_CACHE_VERSION);
        return url.href;
    } catch (_) {
        return STATIC_SEMANTIC_INDEX_FILENAME;
    }
}

function parseStaticSemanticIndexBinary(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 32) {
        throw new Error('Static semantic index is too small or empty.');
    }
    const bytes = new Uint8Array(buffer);
    const magic = String.fromCharCode(...bytes.subarray(0, 6));
    if (magic !== STATIC_SEMANTIC_INDEX_MAGIC) {
        throw new Error('Static semantic index has an unknown format.');
    }
    const view = new DataView(buffer);
    const version = view.getUint32(8, true);
    const dim = view.getUint32(12, true);
    const count = view.getUint32(16, true);
    const namesBytes = view.getUint32(20, true);
    const vectorsBytes = view.getUint32(24, true);
    if (version !== STATIC_SEMANTIC_INDEX_VERSION) {
        throw new Error(`Static semantic index version ${version} is not supported.`);
    }
    if (!dim || dim > 2048 || !count || !namesBytes || vectorsBytes !== count * dim) {
        throw new Error('Static semantic index metadata is invalid.');
    }
    const decoder = new TextDecoder();
    const names = [];
    let cursor = 32;
    const namesEnd = cursor + namesBytes;
    if (namesEnd > buffer.byteLength) throw new Error('Static semantic index name table is truncated.');
    while (cursor < namesEnd && names.length < count) {
        if (cursor + 2 > namesEnd) throw new Error('Static semantic index name length is truncated.');
        const byteLength = view.getUint16(cursor, true);
        cursor += 2;
        if (cursor + byteLength > namesEnd) throw new Error('Static semantic index contains a truncated card name.');
        names.push(decoder.decode(new Uint8Array(buffer, cursor, byteLength)));
        cursor += byteLength;
    }
    if (names.length !== count || cursor !== namesEnd) {
        throw new Error('Static semantic index name table count does not match its metadata.');
    }
    const vectorStart = namesEnd;
    if (vectorStart + vectorsBytes > buffer.byteLength) throw new Error('Static semantic index vectors are truncated.');
    const vectors = new Int8Array(buffer, vectorStart, vectorsBytes);
    const index = {
        dim,
        total: count,
        source: 'static',
        chunks: [{
            names,
            ids: [],
            cards: null,
            vectors,
            count
        }]
    };

    // Calibrate against a small sample from the same precomputed corpus. This keeps the static
    // path on the same cosine-to-similarity scale as the older IndexedDB fallback without doing
    // any client-side embedding work.
    const calibrationVectors = [];
    const sampleCount = Math.min(96, count);
    for (let i = 0; i < sampleCount; i++) {
        const view = vectors.subarray(i * dim, (i + 1) * dim);
        const f = new Float32Array(dim);
        for (let j = 0; j < dim; j++) f[j] = view[j] / 127;
        calibrationVectors.push(f);
    }
    if (calibrationVectors.length >= 12) calibrateSemanticCosineFromVectors(calibrationVectors);
    return index;
}

async function loadStaticSemanticIndex() {
    if (fullSemanticIndexMemory?.source === 'static') return fullSemanticIndexMemory;
    if (staticSemanticIndexPromise) return staticSemanticIndexPromise;
    staticSemanticIndexAttempted = true;
    staticSemanticIndexPromise = (async () => {
        const url = getStaticSemanticIndexUrl();
        const response = await fetch(url, {
            method: 'GET',
            cache: 'force-cache',
            headers: { 'Accept': 'application/octet-stream,*/*;q=0.8' }
        });
        if (!response.ok) {
            throw new Error(`Static semantic index download failed (${response.status}).`);
        }
        const buffer = await response.arrayBuffer();
        const index = await runWhenIdle(() => parseStaticSemanticIndexBinary(buffer), { timeout: 3500 });
        index.staticUrl = url;
        index.byteLength = buffer.byteLength;
        fullSemanticIndexMemory = index;
        console.info(`Precomputed semantic index loaded: ${index.total.toLocaleString()} cards, ${index.dim}-dimensional vectors.`);
        return index;
    })().catch(error => {
        staticSemanticIndexLoadError = error?.message || String(error);
        console.info('Precomputed semantic index unavailable; normal search remains fully functional:', staticSemanticIndexLoadError);
        return null;
    });
    return staticSemanticIndexPromise;
}

// Startup preloading only attempts the static asset. It never falls back to client-side building
// on its own, because a visitor who has not searched yet should not suddenly spend CPU embedding
// the whole card pool. The fallback is started only when a real search asks for semantic retrieval.
function preloadStaticSemanticIndex() {
    return loadStaticSemanticIndex();
}

// Compatibility helper: this used to read Scryfall bulk-card records directly.
// The browser no longer downloads/builds the bulk corpus; this simply extracts Oracle text
// from an ordinary Scryfall card object so retrieval/parsing code keeps one stable interface.
function extractBulkOracleCardText(card) {
    return getCardOracleText(card);
}

function buildSemanticRetrievalText(card, parsedEffects = null) {
    if (!card) return '';
    const oracle = normalizeOracleForEmbedding(extractBulkOracleCardText(card), card.name || '');
    let fnText = '';
    try {
        const parsed = parsedEffects || parseMTGEffect(extractBulkOracleCardText(card));
        fnText = canonicalFunctionToText(getCanonicalFunctions(parsed));
    } catch (_) {
        fnText = '';
    }
    // Raw meaning stays first because MiniLM should see the real rules wording. The compact
    // canonical-function suffix adds a second, parser-derived view only to the retrieval stream;
    // ranking still keeps raw-text and function/role semantics as separate channels.
    return [oracle, fnText ? `functional meaning ${fnText}` : ''].filter(Boolean).join('. ');
}

function quantizeEmbeddingVector(vector) {
    const q = new Int8Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
        const v = Math.max(-1, Math.min(1, Number(vector[i]) || 0));
        q[i] = Math.max(-127, Math.min(127, Math.round(v * 127)));
    }
    return q;
}

function approximateQuantizedCosine(queryVector, quantizedVector, dim) {
    if (!queryVector || !quantizedVector || !dim) return 0;
    let dot = 0, normQ = 0, normV = 0;
    for (let i = 0; i < dim; i++) {
        const q = Number(queryVector[i]) || 0;
        const v = quantizedVector[i] || 0;
        dot += q * v;
        normQ += q * q;
        normV += v * v;
    }
    if (normQ <= 0 || normV <= 0) return 0;
    return dot / (Math.sqrt(normQ) * Math.sqrt(normV));
}

function calibrateSemanticCosineFromVectors(vectors) {
    if (semanticCosineBaselineReady || !vectors || vectors.length < 12) return semanticCosineBaseline;
    let sum = 0, count = 0;
    const sampleCount = Math.min(96, Math.floor(vectors.length / 2));
    for (let i = 0; i < sampleCount; i++) {
        const a = vectors[(i * 17) % vectors.length];
        const b = vectors[(i * 43 + 11) % vectors.length];
        if (!a || !b || a === b) continue;
        const c = cosineSimilarity(a, b);
        if (Number.isFinite(c)) { sum += c; count++; }
    }
    if (count >= 12) {
        semanticCosineBaseline = Math.max(0.18, Math.min(0.52, sum / count));
        semanticCosineBaselineReady = true;
    }
    return semanticCosineBaseline;
}

async function ensureFullSemanticIndex() {
    // The only supported full-corpus index is the precomputed deployment asset.
    if (fullSemanticIndexMemory?.source === 'static') return fullSemanticIndexMemory;
    if (fullSemanticIndexUnavailable) return null;

    const staticIndex = await loadStaticSemanticIndex();
    if (staticIndex?.source === 'static') return staticIndex;

    fullSemanticIndexUnavailable = true;
    fullSemanticIndexUnavailableReason = staticSemanticIndexLoadError || 'Precomputed semantic index unavailable.';
    return null;
}

// V21 performance: full-corpus cosine search runs in a Web Worker so scanning the prebuilt
// ~30k-card vector set never monopolizes the page's main thread. The static index's vector buffer is
// transferred to the worker (not copied), keeping memory overhead low. The fallback index can use
// the same worker once it exists.
let semanticSearchWorker = null;
let semanticSearchWorkerIndex = null;
let semanticSearchWorkerInitPromise = null;
let semanticSearchWorkerRequestId = 0;
const semanticSearchWorkerPending = new Map();

function createSemanticSearchWorker() {
    const code = `
        let indexChunks = [];
        let indexDim = 384;
        let ready = false;
        let latestGeneration = -1;
        function cosineAgainstQuantized(queryVector, vector, dim, queryNorm) {
            let dot = 0, normV = 0;
            for (let i = 0; i < dim; i++) {
                const q = Number(queryVector[i]) || 0;
                const v = vector[i] || 0;
                dot += q * v;
                normV += v * v;
            }
            if (queryNorm <= 0 || normV <= 0) return 0;
            return dot / (Math.sqrt(queryNorm) * Math.sqrt(normV));
        }
        function heapSwap(heap, a, b) { const t = heap[a]; heap[a] = heap[b]; heap[b] = t; }
        function heapUp(heap, index) {
            while (index > 0) {
                const parent = Math.floor((index - 1) / 2);
                if (heap[parent].similarity <= heap[index].similarity) break;
                heapSwap(heap, parent, index); index = parent;
            }
        }
        function heapDown(heap, index) {
            while (true) {
                const left = index * 2 + 1, right = left + 1;
                let smallest = index;
                if (left < heap.length && heap[left].similarity < heap[smallest].similarity) smallest = left;
                if (right < heap.length && heap[right].similarity < heap[smallest].similarity) smallest = right;
                if (smallest === index) break;
                heapSwap(heap, smallest, index); index = smallest;
            }
        }
        function heapPushTop(heap, item, cap) {
            if (heap.length < cap) { heap.push(item); heapUp(heap, heap.length - 1); return; }
            if (item.similarity <= heap[0].similarity) return;
            heap[0] = item; heapDown(heap, 0);
        }
        self.onmessage = function(event) {
            const data = event.data || {};
            if (Number.isFinite(data.generation)) latestGeneration = Math.max(latestGeneration, Number(data.generation));
            if (data.type === 'init') {
                try {
                    indexDim = Number(data.dim) || 384;
                    indexChunks = (data.chunks || []).map(chunk => ({
                        names: chunk.names || [],
                        ids: chunk.ids || [],
                        vectors: new Int8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength),
                        count: Number(chunk.count) || (chunk.names || []).length
                    }));
                    ready = true;
                    self.postMessage({ type: 'ready', requestId: data.requestId });
                } catch (error) {
                    self.postMessage({ type: 'init-error', requestId: data.requestId, error: error?.message || String(error) });
                }
                return;
            }
            if (data.type !== 'query' || !ready) return;
            try {
                const query = new Float32Array(data.queryBuffer);
                const dim = indexDim;
                let queryNorm = 0;
                for (let i = 0; i < dim; i++) {
                    const q = Number(query[i]) || 0;
                    queryNorm += q * q;
                }
                const excludeKey = String(data.excludeKey || '');
                const limit = Math.max(1, Number(data.limit) || 72);
                const minSimilarity = Number.isFinite(data.minSimilarity) ? data.minSimilarity : 0.42;
                const baseline = Number.isFinite(data.baseline) ? data.baseline : 0.30;
                const cap = Math.max(limit * 2, 32);
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
                        if (name.toLowerCase().replace(/\\s+/g, ' ').trim() === excludeKey) continue;
                        const vector = chunk.vectors.subarray(i * dim, (i + 1) * dim);
                        const rawCos = cosineAgainstQuantized(query, vector, dim, queryNorm);
                        const calibrated = Math.max(0, Math.min(1, (rawCos - baseline) / Math.max(0.05, 1 - baseline)));
                        if (calibrated >= minSimilarity) heapPushTop(heap, { name, id: chunk.ids?.[i] || null, similarity: calibrated }, cap);
                    }
                }
                heap.sort((a, b) => b.similarity - a.similarity);
                const seen = new Set();
                const results = [];
                for (const item of heap) {
                    const key = String(item.name || '').toLowerCase().replace(/\\s+/g, ' ').trim();
                    if (!key || seen.has(key)) continue;
                    seen.add(key); results.push(item);
                    if (results.length >= limit) break;
                }
                self.postMessage({ type: 'result', requestId: data.requestId, results });
            } catch (error) {
                self.postMessage({ type: 'query-error', requestId: data.requestId, error: error?.message || String(error) });
            }
        };
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = event => {
        const data = event.data || {};
        const pending = semanticSearchWorkerPending.get(data.requestId);
        if (!pending) return;
        if (data.type === 'ready' || data.type === 'init-error' || data.type === 'query-error' || data.type === 'result') {
            semanticSearchWorkerPending.delete(data.requestId);
            if (data.type === 'ready') pending.resolve(true);
            else if (data.type === 'result') pending.resolve(data.results || []);
            else pending.reject(new Error(data.error || 'Semantic worker failed.'));
        }
    };
    worker.onerror = error => {
        const message = error?.message || 'Semantic search worker failed.';
        for (const pending of semanticSearchWorkerPending.values()) pending.reject(new Error(message));
        semanticSearchWorkerPending.clear();
        semanticSearchWorkerInitPromise = null;
        semanticSearchWorkerIndex = null;
        try { worker.terminate(); } catch (_) {}
        semanticSearchWorker = null;
    };
    return worker;
}

function semanticWorkerRequest(type, payload, transfer = []) {
    if (!semanticSearchWorker) return Promise.reject(new Error('Semantic search worker is unavailable.'));
    const requestId = ++semanticSearchWorkerRequestId;
    return new Promise((resolve, reject) => {
        semanticSearchWorkerPending.set(requestId, { resolve, reject });
        try { semanticSearchWorker.postMessage({ type, requestId, ...payload }, transfer); }
        catch (error) { semanticSearchWorkerPending.delete(requestId); reject(error); }
    });
}

async function ensureSemanticWorkerIndex(index) {
    if (!index || !index.chunks?.length) throw new Error('Semantic index is empty.');
    if (semanticSearchWorker && semanticSearchWorkerIndex === index) {
        if (semanticSearchWorkerInitPromise) await semanticSearchWorkerInitPromise;
        return;
    }
    if (semanticSearchWorker) {
        try { semanticSearchWorker.terminate(); } catch (_) {}
        semanticSearchWorker = null;
        semanticSearchWorkerIndex = null;
        semanticSearchWorkerInitPromise = null;
    }
    semanticSearchWorker = createSemanticSearchWorker();
    semanticSearchWorkerIndex = index;
    const chunks = [];
    const transfers = [];
    const seenBuffers = new Set();
    for (const chunk of index.chunks) {
        if (!chunk?.vectors?.buffer) continue;
        const sourceBuffer = chunk.vectors.buffer;
        if (seenBuffers.has(sourceBuffer)) continue;
        seenBuffers.add(sourceBuffer);

        // A transferred ArrayBuffer becomes detached on the main thread. Keep an independent
        // Int8Array copy so findFullSemanticMatches() can genuinely fall back to a yielding
        // main-thread scan if the worker later fails. This costs one additional vector-buffer copy
        // (~13.6 MB for the current static index) but makes the fallback reliable.
        const start = chunk.vectors.byteOffset || 0;
        const end = start + chunk.vectors.byteLength;
        const workerBuffer = sourceBuffer.slice(start, end);
        const fallbackVectors = new Int8Array(sourceBuffer.slice(start, end));
        chunk.vectors = fallbackVectors;
        chunks.push({
            names: chunk.names || [],
            ids: chunk.ids || [],
            count: chunk.count || (chunk.names || []).length,
            byteOffset: 0,
            byteLength: workerBuffer.byteLength,
            buffer: workerBuffer
        });
        transfers.push(workerBuffer);
    }
    if (!chunks.length || !transfers.length) throw new Error('Semantic index has no transferable vectors.');
    semanticSearchWorkerInitPromise = semanticWorkerRequest('init', { dim: index.dim || 384, chunks }, transfers);
    await semanticSearchWorkerInitPromise;
    // Keep the independent fallback vectors retained above; the worker received separate buffers.
    semanticSearchWorkerInitPromise = null;
}

function getSemanticWorkerExcludeKey(excludeName) {
    return String(excludeName || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function findFullSemanticMatches(index, sourceVector, excludeName, limit = FULL_SEMANTIC_INDEX_SEARCH_LIMIT, minSimilarity = 0.42) {
    if (!index || !sourceVector) return [];

    // Benchmark-local corpora contain the full card payload in each chunk; the worker intentionally
    // transfers only names/ids/vectors, so keep benchmark queries on the main-thread fallback to
    // preserve the card payloads used by the benchmark harness. Live static/IndexedDB indexes use the
    // worker-first path below.
    const benchmarkLocal = index === benchmarkLocalOracleCorpus;
    try {
        if (benchmarkLocal) throw new Error('Benchmark-local corpus uses payload-preserving scan.');
        await runWhenIdle(() => ensureSemanticWorkerIndex(index), { timeout: 2500 });
        const queryVector = sourceVector instanceof Float32Array ? new Float32Array(sourceVector) : Float32Array.from(sourceVector);
        const results = await semanticWorkerRequest('query', {
            queryBuffer: queryVector.buffer,
            excludeKey: getSemanticWorkerExcludeKey(excludeName),
            limit,
            minSimilarity,
            baseline: semanticCosineBaseline,
            generation: searchRequestId
        }, [queryVector.buffer]);
        return results || [];
    } catch (workerError) {
        if (!benchmarkLocal) console.info('Semantic worker unavailable; using yielding main-thread semantic scan where possible:', workerError?.message || workerError);
        const excludeKey = normalizeCardNameForIdentity(excludeName || '');
        const best = [];
        const keepCap = Math.max(limit * 2, 32);
        const pushBest = item => {
            best.push(item);
            best.sort((a, b) => b.similarity - a.similarity);
            if (best.length > keepCap) best.length = keepCap;
        };
        for (const chunk of index.chunks || []) {
            if (!chunk?.vectors) continue;
            for (let i = 0; i < chunk.count; i++) {
                const name = chunk.names?.[i] || '';
                if (!name || normalizeCardNameForIdentity(name) === excludeKey) continue;
                const vector = chunk.vectors.subarray(i * index.dim, (i + 1) * index.dim);
                const rawCos = approximateQuantizedCosine(sourceVector, vector, index.dim);
                const calibrated = Math.max(0, Math.min(1, (rawCos - semanticCosineBaseline) / Math.max(0.05, 1 - semanticCosineBaseline)));
                if (calibrated >= minSimilarity) pushBest({ name, id: chunk.ids?.[i] || null, card: chunk.cards?.[i] || null, similarity: calibrated });
            }
            await backgroundAwareDelay(0);
        }
        const seen = new Set();
        return best
            .sort((a, b) => b.similarity - a.similarity)
            .filter(x => {
                const k = normalizeCardNameForIdentity(x.name);
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            })
            .slice(0, limit);
    }
}

function findFullSemanticExactMatches(index, highlights, excludeName, limit = 1024) {
    if (!index || !Array.isArray(highlights) || !highlights.length) return [];
    const out = [];
    const excludeKey = normalizeCardNameForIdentity(excludeName || '');
    for (const chunk of index.chunks || []) {
        for (let i = 0; i < chunk.count; i++) {
            const card = chunk.cards?.[i];
            if (!card?.name || normalizeCardNameForIdentity(card.name) === excludeKey) continue;
            if (!matchesExactHighlightConstraints(card, highlights)) continue;
            out.push({ card, name: card.name, id: chunk.ids?.[i] || card.id || null, similarity: 1 });
            if (out.length >= limit) return out;
        }
    }
    return out;
}

function recordInSessionSemanticCorpus(card, functionVector, oracleVector) {
    if (!card || !card.name || (!functionVector && !oracleVector)) return;
    const key = normalizeCardNameForIdentity(card.name);
    sessionSemanticCorpus.delete(key); // re-insert at the end so updates count as "recently used"
    sessionSemanticCorpus.set(key, { card, functionVector, oracleVector });
    while (sessionSemanticCorpus.size > SESSION_SEMANTIC_CORPUS_LIMIT) {
        const oldestKey = sessionSemanticCorpus.keys().next().value;
        sessionSemanticCorpus.delete(oldestKey);
    }
}

/**
 * Searches the session semantic corpus for cards whose function meaning (preferred) or raw
 * oracle wording resembles the given source vectors, purely by embedding distance - this is real
 * nearest-neighbor retrieval over whatever the session has accumulated, not a re-rank of
 * lexically-retrieved candidates (see the corpus's own comment for what this can and can't cover).
 * @param {Float32Array|null} sourceFunctionVector
 * @param {Float32Array|null} sourceOracleVector
 * @param {string} excludeName - the current source card's own name, never returned as a match
 * @param {number} limit
 * @param {number} minSimilarity - cosine-similarity floor below which a "match" isn't worth surfacing
 * @returns {Array<Object>} card objects, best match first
 */
function findSessionSemanticMatches(sourceFunctionVector, sourceOracleVector, excludeName, limit = 15, minSimilarity = 0.55) {
    if (!sourceFunctionVector && !sourceOracleVector) return [];
    const scored = [];
    for (const [key, entry] of sessionSemanticCorpus) {
        // isSameCardName rather than a bare key comparison - see its own doc comment for why a
        // plain string match isn't always reliable here (whitespace formatting, double-faced
        // card name shape).
        if (isSameCardName(key, excludeName)) continue;
        // Function-vector similarity leads (it's what makes this useful for "same effect,
        // different words"); raw oracle similarity is kept as a fallback signal for cards whose
        // effect never parsed into a canonical function at all.
        let similarity = -1;
        if (sourceFunctionVector && entry.functionVector) {
            similarity = calibratedCosineSimilarity(sourceFunctionVector, entry.functionVector);
        } else if (sourceOracleVector && entry.oracleVector) {
            similarity = calibratedCosineSimilarity(sourceOracleVector, entry.oracleVector);
        }
        if (similarity >= minSimilarity) scored.push({ card: entry.card, similarity });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit).map(s => ({ ...s.card, _semanticRetrievalSimilarity: s.similarity }));
}

function calibrateSemanticCosineFromCache() {
    // Fallback only when the durable corpus is not ready. The full Oracle index takes precedence.
    if (semanticCosineBaselineReady || embeddingCache.size < 8) return semanticCosineBaseline;
    const vectors = Array.from(embeddingCache.values()).filter(v => v && v.length > 0);
    return calibrateSemanticCosineFromVectors(vectors);
}

function calibratedCosineSimilarity(vecA, vecB) {
    const raw = cosineSimilarity(vecA, vecB);
    if (!Number.isFinite(raw)) return 0;
    const baseline = semanticCosineBaselineReady ? semanticCosineBaseline : 0.30;
    return Math.max(0, Math.min(1, (raw - baseline) / Math.max(0.05, 1 - baseline)));
}

function calibrateBatchSemanticScores(cards) {
    const finiteRaw = (cards || []).map(c => Number(c?._rawOracleSemanticSimilarity)).filter(Number.isFinite).sort((a,b)=>a-b);
    if (finiteRaw.length < 8) return null;
    const qIndex = Math.max(0, Math.min(finiteRaw.length - 1, Math.floor(finiteRaw.length * 0.18)));
    const localQuantile = finiteRaw[qIndex];
    const durableBaseline = semanticCosineBaselineReady ? semanticCosineBaseline : 0.30;
    const localBaseline = Math.max(0.20, Math.min(0.50, durableBaseline * 0.75 + localQuantile * 0.25));
    const denom = Math.max(0.05, 1 - localBaseline);
    const fnBase = semanticCosineBaselineReady ? semanticCosineBaseline : 0.30;
    for (const card of cards || []) {
        const raw = Number(card?._rawOracleSemanticSimilarity);
        if (Number.isFinite(raw)) card.oracleSemanticScore = Math.max(0, Math.min(1, (raw - localBaseline) / denom));
        const fnRaw = Number(card?._rawFunctionSemanticSimilarity);
        if (Number.isFinite(fnRaw)) card.functionScore = Math.max(0, Math.min(1, (fnRaw - fnBase) / Math.max(0.05, 1 - fnBase)));
    }
    return { localBaseline, localQuantile, sampleSize: finiteRaw.length };
}

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Fetches (or computes and caches) the embedding vector for a single text string. Embeddings are
 * deterministic per string, so once a given semantic text is embedded it never needs to be
 * recomputed during the session.
 */
async function getCachedEmbedding(text, extractor, diagnostics) {
    if (!text) return null;
    if (embeddingCache.has(text)) {
        if (diagnostics) diagnostics.cacheHits++;
        return embeddingCache.get(text);
    }
    try {
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        embeddingCache.set(text, output.data);
        if (diagnostics) diagnostics.computed++;
        return output.data;
    } catch (err) {
        if (diagnostics) diagnostics.failed++;
        return null;
    }
}

async function embedTextBatch(texts, extractor) {
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    const dims = output?.dims;
    if (!Array.isArray(dims) || dims.length < 2 || dims[0] !== texts.length) {
        throw new Error(`unexpected batched embedding shape: ${JSON.stringify(dims)} for ${texts.length} input(s)`);
    }
    const hiddenSize = dims[dims.length - 1];
    const vectors = [];
    for (let i = 0; i < texts.length; i++) {
        vectors.push(output.data.slice(i * hiddenSize, (i + 1) * hiddenSize));
    }
    return vectors;
}

async function warmEmbeddingCache(texts, extractor, diagnostics, batchSize = 16) {
    const unique = [...new Set(texts.filter(Boolean))].filter(t => !embeddingCache.has(t));
    for (let i = 0; i < unique.length; i += batchSize) {
        const chunk = unique.slice(i, i + batchSize);
        try {
            const vectors = await embedTextBatch(chunk, extractor);
            chunk.forEach((t, idx) => {
                embeddingCache.set(t, vectors[idx]);
                if (diagnostics) diagnostics.computed++;
            });
        } catch (batchErr) {
            await Promise.all(chunk.map(t => getCachedEmbedding(t, extractor, diagnostics)));
        }
        await backgroundAwareDelay(0);
    }
}

// --- ENGINE 2: EXACTNESS ---
// Fast memory-efficient Levenshtein distance using 1D Int32Arrays
function calculateLevenshteinDistance(a, b) {
    if (a === b) return 0;
    const la = a.length;
    const lb = b.length;
    if (la === 0) return lb;
    if (lb === 0) return la;

    let prev = Array.from({ length: la + 1 }, (_, i) => i);
    let curr = new Array(la + 1);

    for (let i = 1; i <= lb; i++) {
        curr[0] = i;
        const cb = b.charCodeAt(i - 1);
        for (let j = 1; j <= la; j++) {
            const cost = a.charCodeAt(j - 1) === cb ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[la];
}

function calculateFuzzySimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    const t1 = text1.toLowerCase().trim();
    const t2 = text2.toLowerCase().trim();
    
    if (t2.includes(t1)) return 1.0;

    const distance = calculateLevenshteinDistance(t1, t2);
    const maxLength = Math.max(t1.length, t2.length);
    if (maxLength === 0) return 1.0;
    return Math.max(0, 1.0 - (distance / maxLength));
}

/**
 * Normalizes user-marked exact-highlight text for a true lexical constraint.
 * Exact means the highlighted wording/value must occur in the candidate Oracle text,
 * modulo punctuation, Unicode typography, and whitespace formatting.
 */
function normalizeExactHighlightText(text) {
    return String(text || '')
        .normalize('NFKD')
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .toLowerCase()
        .replace(/[{}()[\],.:;!?/\\+*|_=<>~`$%^&#@-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Parses the extra semantic carried by punctuation in an Exact highlight.
 *
 * A trailing period is NOT formatting-only: for MTG rules text it means the highlighted
 * words form a complete sentence/clause. In particular, "Counter target spell." must not
 * match "Counter target spell unless..." or "Counter target spell with...".
 */
function parseExactHighlightRequirement(text) {
    const raw = String(text || '')
        .normalize('NFKD')
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .trim();

    return {
        text: normalizeExactHighlightText(raw),
        requiresSentenceTerminalPeriod: /\.\s*$/.test(raw)
    };
}

/**
 * Normalizes Oracle text for an exact-highlight requirement while preserving sentence periods.
 * Other punctuation is treated as token separation, so harmless comma/semicolon/quote variants
 * remain compatible with an Exact text match, but a required trailing period remains observable.
 */
function normalizeOracleForExactMatching(text) {
    return String(text || '')
        .normalize('NFKD')
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .toLowerCase()
        .replace(/[{}()[\],:;!?/\\+*|_=<>~`$%^&#@-]+/g, ' ')
        .replace(/\.+/g, '.')
        .replace(/\s*\.\s*/g, '. ')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeRegexText(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactHighlightOccursInOracle(oracleText, requirement) {
    if (!requirement?.text) return false;

    // Ordinary Exact highlight: whole-word-ish occurrence, preserving the existing permissive
    // punctuation normalization.
    const normalizedOracle = normalizeExactHighlightText(oracleText);
    if (!normalizedOracle) return false;

    if (!requirement.requiresSentenceTerminalPeriod) {
        return ` ${normalizedOracle} `.includes(` ${requirement.text} `);
    }

    // Punctuation-aware Exact highlight: require the phrase to be immediately followed by an
    // actual sentence-ending period in the candidate Oracle text. This is the critical distinction
    // for unconditional effects versus caveated effects such as:
    //   "Counter target spell unless its controller pays {2}."
    // The former contains the same words, but it does NOT contain the exact sentence requested by
    // the user because there is no period after "spell".
    const sentenceOracle = normalizeOracleForExactMatching(oracleText);
    const tokens = requirement.text.split(/\s+/).filter(Boolean).map(escapeRegexText);
    if (!tokens.length || !sentenceOracle) return false;

    const phrasePattern = new RegExp(`(?:^|\\s)${tokens.join('\\s+')}\\.(?=\\s|$)`);
    return phrasePattern.test(sentenceOracle);
}

function getCardOracleText(card) {
    return card?.oracle_text || (card?.card_faces ? card.card_faces.map(f => f.oracle_text || '').join(' ') : '');
}

/**
 * Exact-highlight constraint: every Exact highlight must literally occur in the candidate's
 * Oracle text. Flexible highlights are deliberately ignored and remain semantic/ranking intent.
 * A trailing period on an Exact highlight is a semantic hard boundary, not formatting.
 */
function matchesExactHighlightConstraints(card, highlights = []) {
    const exactHighlights = (highlights || [])
        .filter(h => h && h.mode !== 'variable' && !h.benchmarkIntentOnly && typeof h.text === 'string' && h.text.trim())
        .map(h => parseExactHighlightRequirement(h.text))
        .filter(req => req.text);
    if (!exactHighlights.length) return true;

    const oracle = getCardOracleText(card);
    if (!oracle) return false;
    return exactHighlights.every(requirement => exactHighlightOccursInOracle(oracle, requirement));
}

function explainExactHighlightFailures(card, highlights = []) {
    const oracle = getCardOracleText(card);
    return (highlights || [])
        .filter(h => h && h.mode !== 'variable' && !h.benchmarkIntentOnly && typeof h.text === 'string' && h.text.trim())
        .map(h => ({ raw: h.text.trim(), requirement: parseExactHighlightRequirement(h.text) }))
        .filter(item => item.requirement.text && !exactHighlightOccursInOracle(oracle, item.requirement))
        .map(item => item.requirement.requiresSentenceTerminalPeriod
            ? `exact highlight sentence boundary missing: "${item.raw}"`
            : `exact highlight not present: "${item.raw}"`
        );
}

function calculateFuzzyTextMatch(sourceText, targetText) {
    if (!sourceText || !targetText) return 0;

    const cleanSource = sourceText
        .toLowerCase()
        .replace(/^o:"|"$|-name:.*$/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleanSource) return 0;

    const cleanTarget = targetText
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleanTarget) return 0;

    // A literal source phrase inside the candidate remains definitive textual evidence.
    if (cleanTarget.includes(cleanSource)) return 1.0;

    const sourceWords = cleanSource.split(/\s+/).filter(Boolean);
    const targetSentences = targetText.split(/(?<=[.!?])\s+/);
    let bestScore = 0;

    for (const sentence of targetSentences) {
        const words = sentence
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        if (!words.length) continue;

        // Compare the source against local candidate windows instead of the entire candidate
        // sentence. This prevents an otherwise exact rule clause from being punished simply
        // because the card contains extra clauses after it. A few extra words are allowed so
        // small wording differences can still be matched.
        const minWindow = Math.max(1, sourceWords.length - 1);
        const maxWindow = Math.min(words.length, sourceWords.length + 5);

        for (let windowSize = minWindow; windowSize <= maxWindow; windowSize++) {
            for (let start = 0; start + windowSize <= words.length; start++) {
                const windowText = words.slice(start, start + windowSize).join(' ');
                const distance = calculateLevenshteinDistance(cleanSource, windowText);
                const maxLength = Math.max(cleanSource.length, windowText.length);
                const editScore = maxLength > 0 ? Math.max(0, 1 - (distance / maxLength)) : 0;
                const sourceTokenSet = new Set(sourceWords);
                const windowTokenSet = new Set(words.slice(start, start + windowSize));
                let shared = 0;
                sourceTokenSet.forEach(w => { if (windowTokenSet.has(w)) shared++; });
                const tokenCoverage = shared / Math.max(1, sourceTokenSet.size);
                const windowExcess = Math.max(0, windowTokenSet.size - shared) / Math.max(1, windowTokenSet.size);

                const score = ((editScore * 0.45) + (tokenCoverage * 0.55)) * (1 - 0.08 * Math.pow(windowExcess, 1.15));
                if (score > bestScore) bestScore = score;
            }
        }
    }

    return Math.max(0, Math.min(1, bestScore));
}

function getScoreKeyByCriteria(criteria) {
    switch (criteria) {
        case 'mechanical': return 'mechanicalScore';
        case 'functional': return 'functionScore';
        case 'semantic':
        case 'context': return 'contextScore';
        case 'role': return 'roleScore';
        case 'synergy': return 'synergyScore';
        case 'exactness': return 'exactnessScore';
        case 'category': return 'categoryScore';
        // Composite / presentation-only order modes do not represent a single stored score.
        // Callers that need those modes should use applyResultOrdering(), not this scalar key.
        case 'balanced':
        case 'matrix':
        case 'diverse':
        case 'overall':
        default: return 'similarityScore';
    }
}

function normalizeLexicalStem(token) {
    let t = normalizeMechanicToken(token).replace(/[^a-z0-9+\-]/g, '');
    if (!t) return '';
    if (t.length > 5 && /ies$/.test(t)) t = t.slice(0, -3) + 'y';
    else if (t.length > 5 && /(ches|shes|xes|zes|ses)$/.test(t)) t = t.slice(0, -2);
    else if (t.length > 4 && /s$/.test(t) && !/ss$/.test(t)) t = t.slice(0, -1);
    if (t.length > 6 && /ing$/.test(t)) t = t.slice(0, -3);
    else if (t.length > 6 && /ed$/.test(t)) t = t.slice(0, -2);
    return t;
}
function lexicalTokenCoverage(sourceText, candidateText) {
    const sourceTokens = String(sourceText || '').toLowerCase().match(/[a-z0-9+\-]+/g) || [];
    const candidateTokens = String(candidateText || '').toLowerCase().match(/[a-z0-9+\-]+/g) || [];
    if (!sourceTokens.length || !candidateTokens.length) return 0;
    const sourceSet = new Set(sourceTokens.map(normalizeLexicalStem).filter(Boolean));
    const candidateSet = new Set(candidateTokens.map(normalizeLexicalStem).filter(Boolean));
    const meaningful = [...sourceSet].filter(t => !UNIVERSAL_GENERIC_TOKENS.has(t));
    const pool = meaningful.length ? meaningful : [...sourceSet];
    return pool.filter(t => candidateSet.has(t)).length / Math.max(1, pool.length);
}
function calculateCombinedFuzzyScore(sourceCard, targetCard, targetTextForScoring) {
    const targetOracle = targetCard.oracle_text || (targetCard.card_faces ? targetCard.card_faces.map(f => f.oracle_text).join(' ') : '');
    const textScore = calculateFuzzyTextMatch(targetTextForScoring, targetOracle);
    const lexicalCoverage = lexicalTokenCoverage(targetTextForScoring, targetOracle);
    const hasUsableSourceText = String(targetTextForScoring || '').trim().length >= 4;
    const nameScore = hasUsableSourceText ? 0 : calculateFuzzySimilarity(sourceCard.name, targetCard.name);
    let score = nameScore * 0.02 + textScore * 0.73 + lexicalCoverage * 0.25;
    if (targetTextForScoring && targetTextForScoring.length > 3) {
        const cleanQuery = targetTextForScoring.toLowerCase().replace(/^o:"|"$|-name:.*$/g, '').replace(/[^\w\s]/g, '').trim();
        const cleanOracle = targetOracle.toLowerCase().replace(/[^\w\s]/g, '').trim();
        if (cleanQuery && cleanOracle.includes(cleanQuery)) score = Math.max(score, 0.90);
    }
    return Math.max(0, Math.min(1, score));
}


// --- RANKING EVIDENCE MODEL (V17) ------------------------------------------
// Keep the ranking compact: core evidence answers "does this actually do the
// same thing?"; supporting evidence answers "do several secondary clues agree?".
// Supporting evidence is intentionally unable to rescue a weak core match.
function getCanonicalEffectList(card) {
    return Array.isArray(card?._parsedEffects) ? card._parsedEffects : [];
}

function getEffectFunctionSet(card) {
    const effects = getCanonicalEffectList(card);
    const out = new Set();
    effects.forEach(e => {
        const fn = e?.canonical?.function || e?.function;
        const outcome = e?.canonical?.outcome || e?.outcome;
        if (fn) out.add(String(fn));
        if (outcome) out.add(`outcome:${outcome}`);
    });
    return out;
}

function effectIsRecurring(effect) {
    const t = effect?.triggerProfile || effect?.canonical?.params?.triggerProfile;
    if (t?.event || t?.turn_window || t?.threshold !== undefined) return true;
    const raw = String(effect?.raw || effect?.text || '').toLowerCase();
    return /\b(?:whenever|at the beginning of|at the end of|each upkeep|each turn|every turn|as long as|while)\b/.test(raw);
}

function cardHasRecurringEffects(card) {
    return getCanonicalEffectList(card).some(effectIsRecurring);
}

function calculateRecurrenceSimilarity(sourceCard, candidateCard) {
    const sourceRecurring = cardHasRecurringEffects(sourceCard);
    const candidateRecurring = cardHasRecurringEffects(candidateCard);
    if (sourceRecurring === candidateRecurring) return 1;
    // A recurring engine versus a one-shot spell is a real strategic distinction,
    // but not a hard contradiction: the same core action can still be useful.
    return 0.58;
}

function calculateSourceDifficulty(sourceCard, parsedSource, sourceParseConfidence) {
    const effects = parsedSource || [];
    const effectCount = effects.length;
    const confidence = Math.max(0, Math.min(1, sourceParseConfidence || 0));
    const raw = String(sourceCard?.oracle_text || '').trim();
    const clauseCount = raw ? raw.split(/(?<=[.!?])\s+/).filter(Boolean).length : 0;
    const complexity = Math.min(1, Math.max(0, (Math.max(effectCount, clauseCount) - 1) / 5));
    // Difficulty is used only to soften trust in a brittle mechanical comparison.
    return Math.max(0, Math.min(1, (1 - confidence) * 0.70 + complexity * 0.30));
}

function calculateCanonicalContradictionPenalty(sourceCard, candidateCard) {
    const sourceEffects = getCanonicalEffectList(sourceCard);
    const candidateEffects = getCanonicalEffectList(candidateCard);
    if (!sourceEffects.length || !candidateEffects.length) return 1;

    const sourceFns = getEffectFunctionSet(sourceCard);
    const candidateFns = getEffectFunctionSet(candidateCard);
    const sourceFunctions = [...sourceFns].filter(x => !x.startsWith('outcome:'));
    const candidateFunctions = [...candidateFns].filter(x => !x.startsWith('outcome:'));

    // Only penalize strong, strategic contradictions. Extra effects are deliberately
    // tolerated; this is not another bidirectional "all text must match" score.
    let penalty = 1;
    const has = (set, value) => set.has(value);
    const pairs = [
        ['reanimate', 'removal'], ['recursion', 'removal'],
        ['counter', 'direct_damage'], ['counter', 'token_creation'],
        ['token_creation', 'exile_removal'], ['mana_ability', 'direct_damage'],
        ['card_draw', 'removal'], ['tutor', 'direct_damage']
    ];
    for (const [a, b] of pairs) {
        if (has(new Set(sourceFunctions), a) && has(new Set(candidateFunctions), b) && !candidateFunctions.includes(a)) penalty *= 0.93;
        if (has(new Set(sourceFunctions), b) && has(new Set(candidateFunctions), a) && !candidateFunctions.includes(b)) penalty *= 0.93;
    }

    const sourceRecurring = cardHasRecurringEffects(sourceCard);
    const candidateRecurring = cardHasRecurringEffects(candidateCard);
    if (sourceRecurring !== candidateRecurring) penalty *= 0.96;

    return Math.max(0.82, Math.min(1, penalty));
}

function calculateEvidenceAgreement(card, rankingIntent = { kind: 'effect_match' }) {
    // Only independent channels participate: structural parse, functional semantic text,
    // raw-oracle semantic text, and an explicit highlight. Retrieval provenance and the old
    // blended context score are intentionally excluded.
    const signals = [
        Number(card.mechanicalScore) || 0,
        Number(card.functionScore) || 0,
        Number(card.oracleSemanticScore) || 0,
        rankingIntent.kind === 'highlighted_effect' ? (Number(card.highlightIntentScore) || 0) : 0
    ].filter(v => v > 0.05).sort((a,b) => b-a);
    if (signals.length < 2) return 0;
    const pair = Math.sqrt(signals[0] * signals[1]);
    const tri = signals.length >= 3 ? Math.pow(signals[0] * signals[1] * signals[2], 1/3) : pair;
    return Math.max(0, Math.min(1, pair * 0.72 + tri * 0.28));
}

function calculateCoreEvidence(card, difficulty, rankingIntent = { kind: 'effect_match' }) {
    const mech = Number(card.mechanicalScore) || 0;
    const fn = Number(card.functionScore) || 0;
    const sem = Number(card.oracleSemanticScore) || 0;
    const highlight = Number(card.highlightIntentScore) || 0;
    const role = Number(card.roleScore) || 0;
    const mechanicalTrust = 0.62 + 0.38 * (1 - Math.max(0, Math.min(1, difficulty || 0)));
    let weighted;
    if (rankingIntent.kind === 'highlighted_effect') {
        weighted = mech * 0.30 * mechanicalTrust + fn * 0.29 + sem * 0.13 + highlight * 0.28;
        if (highlight >= 0.72) weighted = Math.max(weighted, highlight * 0.82 + Math.max(mech, fn) * 0.18);
    } else if (rankingIntent.kind === 'strategic_role') {
        weighted = role * 0.40 + fn * 0.30 + sem * 0.20 + mech * 0.10 * mechanicalTrust;
    } else if (rankingIntent.kind === 'hybrid_effect') {
        weighted = mech * 0.38 * mechanicalTrust + fn * 0.34 + sem * 0.20 + highlight * 0.08;
    } else {
        weighted = mech * 0.40 * mechanicalTrust + fn * 0.34 + sem * 0.22 + highlight * 0.04;
    }
    const strongest = Math.max(mech, fn, sem, highlight, rankingIntent.kind === 'strategic_role' ? role : 0);
    return Math.max(0, Math.min(1, weighted * 0.80 + strongest * 0.20));
}

function calculateSupportingEvidence(card, rankingIntent = { kind: 'effect_match' }) {
    // Supporting evidence cannot use retrieval provenance or color identity. Both are useful
    // diagnostics/filters, but neither establishes functional similarity.
    const role = Number(card.roleScore) || 0;
    const lexical = Number(card.exactnessScore) || 0;
    const category = Number(card.categoryScore) || 0;
    const roleWeight = rankingIntent.kind === 'strategic_role' ? 0.68 : 0.52;
    return Math.max(0, Math.min(1, role * roleWeight + lexical * 0.24 + category * 0.08));
}

function calculateLexicalSupport(exactness) {
    const x = Math.max(0, Math.min(1, Number(exactness) || 0));
    // Strong wording similarity still helps, but the curve flattens near the top so 0.97 vs
    // 1.00 is not treated as materially different evidence.
    return (x * 0.72) + (Math.pow(x, 2.8) * 0.28);
}

function calculateRankingStability(card, coreEvidence, supportingEvidence) {
    const signals = [
        Number(card.mechanicalScore) || 0,
        Number(card.functionScore) || 0,
        Number(card.oracleSemanticScore) || 0,
        Number(card.highlightIntentScore) || 0,
        Number(card.roleScore) || 0,
        Number(card.exactnessScore) || 0
    ].filter(v => v > 0);
    if (signals.length < 2) return 0.95;
    const max = Math.max(...signals);
    const total = signals.reduce((a, b) => a + b, 0);
    const concentration = total > 0 ? max / total : 1;
    return Math.max(0.955, Math.min(1, 1 - Math.max(0, concentration - 0.70) * 0.08));
}

// --- ENGINE 3: SYNERGY (Filter-Aware) ---
function calculateSynergyScore(sourceCard, targetCard, activeFilters = {}) {
    if (!sourceCard || !targetCard) return 0;
    let score = 0, max = 0;
    const identityConstrained = Boolean(activeFilters.identity || activeFilters.colors);
    if (!identityConstrained) {
        max += 2;
        const a = new Set(sourceCard.color_identity || []);
        const b = new Set(targetCard.color_identity || []);
        if (a.size === 0 && b.size === 0) score += 2;
        else if (a.size === 0 || b.size === 0) score += 0.55;
        else {
            const inter = [...a].filter(x => b.has(x)).length;
            const union = new Set([...a, ...b]).size;
            const containment = inter / Math.max(1, a.size);
            score += Math.max(inter / Math.max(1, union), containment * 0.72) * 2;
        }
    }

    const cmcConstrained = activeFilters.cmc !== undefined && activeFilters.cmc !== '';
    if (!cmcConstrained) {
        max += 1;
        if (Number.isFinite(sourceCard.cmc) && Number.isFinite(targetCard.cmc)) {
            const diff = Math.abs(sourceCard.cmc - targetCard.cmc);
            score += Math.exp(-(diff * diff) / 12);
        }
    }

    max += 2;
    const sourceKeywords = new Set((sourceCard.keywords || []).map(normalizeMechanicToken).filter(Boolean));
    const targetKeywords = new Set((targetCard.keywords || []).map(normalizeMechanicToken).filter(Boolean));
    if (!sourceKeywords.size && !targetKeywords.size) {
        max -= 2;
    } else {
        score += weightedSymmetricCoverage(sourceKeywords, targetKeywords, 0.95) * 2;
    }

    const typeConstrained = Boolean(activeFilters.type);
    if (!typeConstrained) {
        max += 1.5;
        const typeTokens = card => new Set((getTypeLineParts(card.type_line || '') || []).map(normalizeMechanicToken).filter(Boolean));
        const a = typeTokens(sourceCard), b = typeTokens(targetCard);
        if (a.size && b.size) score += weightedSymmetricCoverage(a, b, 0.90) * 1.5;
        else if (!a.size && !b.size) score += 0.6;
    }

    // Synergy also reflects shared deckbuilding role, but this is intentionally a small term. It
    // supports cards with different implementations without turning role similarity into a second
    // mechanical score.
    max += 0.75;
    const sourceEffects = Array.isArray(sourceCard._parsedEffects) ? sourceCard._parsedEffects : parseMTGEffect(strategicRoleCardText(sourceCard));
    const targetEffects = Array.isArray(targetCard._parsedEffects) ? targetCard._parsedEffects : parseMTGEffect(strategicRoleCardText(targetCard));
    const sourceRoles = inferStrategicRoleProfile(sourceCard, sourceEffects, strategicRoleCardText(sourceCard));
    const targetRoles = inferStrategicRoleProfile(targetCard, targetEffects, strategicRoleCardText(targetCard));
    let roleSim = 0;
    for (const a of sourceRoles) for (const b of targetRoles) {
        if (a.role === b.role) roleSim = Math.max(roleSim, Math.sqrt(a.score * b.score));
        else if (a.group && a.group === b.group) roleSim = Math.max(roleSim, Math.sqrt(a.score * b.score) * 0.65);
    }
    score += roleSim * 0.75;

    return max > 0 ? Math.max(0, Math.min(1, score / max)) : 0;
}

// --- PATTERN EXTRACTION FOR RELATED CARDS ---
function escapeScryfallQuotedValue(value) {
    // Scryfall quoted search terms use backslash escaping.  Related Search previously only
    // escaped double quotes in card names, so a name/text containing a backslash could produce
    // an invalid query.  Keep this helper deliberately narrow: it is for values inside "...".
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\t]/g, ' ').trim();
}

function sanitizeRelatedOraclePattern(pattern) {
    // extractRepeatingPatterns already removes punctuation, but keep the query boundary defensive
    // because patterns may later come from another source (or future editor functionality).
    const cleaned = String(pattern ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/[\"\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned || cleaned.length < 2) return '';
    return cleaned.slice(0, 80);
}

function buildRelatedSearchQueries(sourceCard, selectedCards, repeatingPatterns, filterParts) {
    // Related Search is driven first by the cards the user explicitly selected. The original
    // implementation let the source card and a few lossy repeating-text queries consume the
    // retrieval budget, which meant a selected pair such as Thran Dynamo + Basalt Monolith could
    // produce no useful Scryfall candidates even though both have a clear mana-production role.
    const allCards = [sourceCard, ...selectedCards];
    const priorityCards = [...selectedCards, sourceCard].filter(Boolean);
    const excludedNames = allCards
        .map(c => escapeScryfallQuotedValue(c?.name || ''))
        .filter(Boolean)
        .map(name => `-name:"${name}"`)
        .join(' ');
    const filters = Array.isArray(filterParts) ? filterParts.filter(Boolean).join(' ') : '';
    const patterns = [...new Set((repeatingPatterns || []).map(sanitizeRelatedOraclePattern).filter(Boolean))].slice(0, 5);
    const queries = [];
    const seen = new Set();
    const add = (query, kind = 'generic', priority = 50) => {
        const q = String(query || '').replace(/\s+/g, ' ').trim();
        if (!q || seen.has(q)) return;
        seen.add(q);
        queries.push({ query: q, kind, priority });
    };

    // Reserve the earliest retrieval slots for robust Scryfall oracle-tags and broad strategic
    // role phrases. These are much less brittle than quoting normalized text and ensure each
    // explicitly selected card can seed a useful related-card family.
    const seenTags = new Set();
    const seenRolePhrases = new Set();
    for (const referenceCard of priorityCards) {
        const referenceText = getCurrentSourceOracleText(referenceCard);
        const parsed = getCachedParsedEffects(referenceCard, referenceText);
        for (const cf of getCanonicalFunctions(parsed).slice(0, 4)) {
            const tag = FUNCTION_RETRIEVAL_VOCAB[cf?.function]?.otag;
            if (tag && !seenTags.has(tag)) {
                seenTags.add(tag);
                add(`otag:${tag} ${excludedNames} ${filters}`, 'oracle-tag', 5 + seenTags.size);
            }
        }
        const roles = inferStrategicRoleProfile(referenceCard, parsed, referenceText) || [];
        for (const roleRecord of roles.slice(0, 2)) {
            for (const phrase of (ROLE_RETRIEVAL_PHRASES[roleRecord.role] || []).slice(0, 2)) {
                const clean = String(phrase).replace(/["\\]/g, '').replace(/\s+/g, ' ').trim();
                const roleKey = clean.toLowerCase();
                if (clean.length >= 5 && !seenRolePhrases.has(roleKey)) {
                    seenRolePhrases.add(roleKey);
                    add(`o:"${escapeScryfallQuotedValue(clean)}" ${excludedNames} ${filters}`, 'role', 15 + seenRolePhrases.size);
                }
            }
        }
    }

    // Shared text remains a supporting lane. Its normalized text can lose mana symbols, dynamic
    // values, reminder punctuation, and other MTG-specific structure, so it must never be the only
    // way a mechanically related pair can be retrieved.
    if (patterns.length) {
        const oracleGroup = `(${patterns.map(p => `o:"${escapeScryfallQuotedValue(p)}"`).join(' or ')})`;
        add(`${oracleGroup} ${excludedNames} ${filters}`, 'shared-text', 70);
        patterns.slice(0, 2).forEach(pattern => {
            add(`o:"${escapeScryfallQuotedValue(pattern)}" ${excludedNames} ${filters}`, 'shared-text-fallback', 75);
        });
    }

    // Build a small, explicitly ordered retrieval pool from every selected reference. Prefer
    // Scryfall oracle-tags (when available), then canonical phrases/parameterized queries, then
    // broader role/alternate forms. This preserves the engine's query budget while ensuring each
    // selected card contributes at least one real mechanical retrieval opportunity.
    const referencePlans = [];
    for (let cardIndex = 0; cardIndex < priorityCards.length; cardIndex++) {
        const referenceCard = priorityCards[cardIndex];
        const referenceText = getCurrentSourceOracleText(referenceCard);
        const parsed = getCachedParsedEffects(referenceCard, referenceText);
        const functional = buildFunctionalRetrievalQueries(referenceCard, parsed, excludedNames, 2);
        const orderedFunctional = functional.slice().sort((a, b) => {
            const score = item => {
                const q = String(item?.query || '');
                if (/\botag:/i.test(q)) return 0;
                if (/search your library|add |destroy |exile |counter |return |create |draw |damage|gain life|lose life|tap |untap /i.test(q)) return 1;
                return 2;
            };
            return score(a) - score(b);
        });

        orderedFunctional.forEach(item => {
            if (item?.query) referencePlans.push({ query: `${item.query} ${filters}`, kind: 'functional', priority: 30 + cardIndex });
        });

        const roleQuery = buildRoleFocusedRetrievalQuery(referenceCard, parsed, excludedNames);
        if (roleQuery) referencePlans.push({ query: `${roleQuery} ${filters}`, kind: 'role', priority: 45 + cardIndex });

        const alternateQuery = buildAlternateMechanicRetrievalQuery(referenceCard, parsed, excludedNames);
        if (alternateQuery) referencePlans.push({ query: `${alternateQuery} ${filters}`, kind: 'alternate', priority: 55 + cardIndex });
    }

    // Sort explicitly so the selected-card functional lanes occupy the first retrieval slots,
    // followed by role/alternate context.
    referencePlans.sort((a, b) => a.priority - b.priority);
    referencePlans.forEach(plan => add(plan.query, plan.kind, plan.priority));

    // A very common case is a pair of cards sharing a function but not wording. Make sure each
    // selected reference can contribute its first functional query before the source card's lower
    // priority lanes consume the eight-query network budget.
    const orderedQueries = queries.slice().sort((a, b) => a.priority - b.priority);
    return orderedQueries.slice(0, 8);
}

function extractRepeatingPatterns(cards) {
    const stopWords = new Set([
        'the','of','and','a','to','in','is','that','it','for','on','are','as','with','they','at','be','this','have','from','or','by','but','not','what','all','were','we','when','your','can','there','an','which','do','their','if','will','up','about','out','then','them','these','so','some','would','make','like','into','has','more','no','could','my','than','first','been','who','its','now','down','may','you','control','put','target','onto','battlefield'
    ]);

    const cardTexts = cards.map(c => {
        return (c.oracle_text || (c.card_faces ? c.card_faces.map(f => f.oracle_text).join(' ') : '')).toLowerCase();
    });

    const phraseCounts = new Map();

    cardTexts.forEach(text => {
        const seenInThisCard = new Set();
        const cleanText = text.replace(/[^a-z0-9\s]/g, ' ');
        const words = cleanText.split(/\s+/).filter(w => w.length > 0);

        // Generate 2 to 6 word phrases
        for (let len = 2; len <= 6; len++) {
            for (let i = 0; i <= words.length - len; i++) {
                const ngram = words.slice(i, i + len).join(' ');
                const nonStop = words.slice(i, i + len).filter(w => !stopWords.has(w) && w.length > 2);
                if (nonStop.length > 0) {
                    seenInThisCard.add(ngram);
                }
            }
        }

        // Add single significant words
        words.forEach(w => {
            if (w.length > 2 && !stopWords.has(w)) {
                seenInThisCard.add(w);
            }
        });

        seenInThisCard.forEach(pattern => {
            phraseCounts.set(pattern, (phraseCounts.get(pattern) || 0) + 1);
        });
    });

    // Patterns appearing in AT LEAST 2 cards
    const repeating = [];
    phraseCounts.forEach((count, pattern) => {
        if (count >= 2) {
            repeating.push({ pattern, count, wordCount: pattern.split(' ').length });
        }
    });

    repeating.sort((a, b) => b.wordCount - a.wordCount || b.count - a.count);

    const finalPatterns = [];
    for (const item of repeating) {
        if (!finalPatterns.some(p => p.includes(item.pattern))) {
            finalPatterns.push(item.pattern);
        }
        if (finalPatterns.length >= 5) break;
    }

    return finalPatterns;
}

// --- INITIALIZATION ---
function initApp() {
    cardSearchInput = document.getElementById('card-search-input');
    searchBtn = document.getElementById('search-btn');
    sourceCardSection = document.getElementById('source-card-section');
    sourceCardOracle = document.getElementById('source-card-oracle');
    findSimilarBtn = document.getElementById('find-similar-btn');
    loadingIndicator = document.getElementById('loading-indicator');
    resultsSection = document.getElementById('results-section');
    resultsGrid = document.getElementById('results-grid');
    themeToggle = null;
    loadDisplayPreferences();
    applyPresentationPreferences();

    // --- PREFERENCES PANEL ---
    const preferencesBtn = document.getElementById('preferences-btn');
    const preferencesModal = document.getElementById('preferences-modal');
    const closePreferencesBtn = document.getElementById('close-preferences-modal');
    const savePreferencesBtn = document.getElementById('save-preferences-btn');
    const resetPreferencesBtn = document.getElementById('reset-preferences-btn');
    const preferenceResultLimit = document.getElementById('preference-result-limit');
    const preferenceScoreBreakdown = document.getElementById('preference-score-breakdown');
    const preferenceTheme = document.getElementById('preference-theme');
    const preferenceDensity = document.getElementById('preference-result-density');
    const preferenceReduceMotion = document.getElementById('preference-reduce-motion');
    const preferenceShowStreamProgress = document.getElementById('preference-show-stream-progress');

    function syncPreferencesControls() {
        if (preferenceResultLimit) preferenceResultLimit.value = String(getDisplayedResultLimit());
        if (preferenceScoreBreakdown) preferenceScoreBreakdown.checked = Boolean(displayPreferences.showScoreBreakdown);
        if (preferenceTheme) preferenceTheme.value = displayPreferences.theme || 'system';
        if (preferenceDensity) preferenceDensity.value = displayPreferences.resultDensity || 'comfortable';
        if (preferenceReduceMotion) preferenceReduceMotion.checked = Boolean(displayPreferences.reduceMotion);
        if (preferenceShowStreamProgress) preferenceShowStreamProgress.checked = displayPreferences.showStreamProgress !== false;
    }

    function commitPreferences() {
        displayPreferences.maxResults = clampDisplayResultLimit(preferenceResultLimit?.value);
        displayPreferences.showScoreBreakdown = preferenceScoreBreakdown?.checked !== false;
        displayPreferences.theme = ['dark', 'light', 'system'].includes(preferenceTheme?.value) ? preferenceTheme.value : DEFAULT_DISPLAY_PREFERENCES.theme;
        displayPreferences.resultDensity = ['comfortable', 'compact'].includes(preferenceDensity?.value) ? preferenceDensity.value : DEFAULT_DISPLAY_PREFERENCES.resultDensity;
        displayPreferences.reduceMotion = Boolean(preferenceReduceMotion?.checked);
        displayPreferences.showStreamProgress = preferenceShowStreamProgress?.checked !== false;
        saveDisplayPreferences();
        try {
            localStorage.setItem(THEME_KEY, displayPreferences.theme === 'system' ? resolveTheme('system') : displayPreferences.theme);
        } catch (_) {}
        applyPresentationPreferences();
        if (resultsSection && !resultsSection.classList.contains('hidden') && Array.isArray(lastSearchResults)) {
            renderResults(lastSearchResults);
        }
    }

    if (preferencesBtn) preferencesBtn.addEventListener('click', () => {
        syncPreferencesControls();
        preferencesModal?.classList.remove('hidden');
        preferenceResultLimit?.focus();
    });
    if (closePreferencesBtn) closePreferencesBtn.addEventListener('click', () => {
        syncPreferencesControls();
        preferencesModal?.classList.add('hidden');
    });
    if (savePreferencesBtn) savePreferencesBtn.addEventListener('click', () => {
        commitPreferences();
        preferencesModal?.classList.add('hidden');
    });
    if (resetPreferencesBtn) resetPreferencesBtn.addEventListener('click', () => {
        displayPreferences = { ...DEFAULT_DISPLAY_PREFERENCES };
        syncPreferencesControls();
        commitPreferences();
    });
    preferenceResultLimit?.addEventListener('change', () => {
        preferenceResultLimit.value = String(clampDisplayResultLimit(preferenceResultLimit.value));
    });

    historyList = document.getElementById('history-list');
    favoritesList = document.getElementById('favorites-list');
    favoriteBtn = document.getElementById('favorite-btn');
    exportBtn = document.getElementById('export-btn');
    compareModal = document.getElementById('compare-modal');
    compareContainer = document.getElementById('compare-container');
    compareStatus = document.getElementById('compare-status');
    sortSelect = document.getElementById('sort-results');
    setupSourceCardPicker();

    // Search Depth defaults to 50% for a new browser profile. Once the user deliberately changes
    // it, remember that choice so the control remains genuinely user-configurable across reloads.
    const depthControl = document.getElementById('filter-depth-percent');
    if (depthControl) {
        let storedDepth = null;
        try {
            storedDepth = parseFloat(localStorage.getItem(SEARCH_DEPTH_STORAGE_KEY));
        } catch (err) {
            storedDepth = null;
        }
        if (!isNaN(storedDepth) && storedDepth > 0) {
            depthControl.value = String(Math.max(1, Math.min(MAX_SEARCH_DEPTH_PERCENT, storedDepth)));
        } else {
            depthControl.value = String(DEFAULT_SEARCH_DEPTH_PERCENT);
        }
        depthControl.dispatchEvent(new Event('input', { bubbles: true }));
        depthControl.addEventListener('input', () => {
            let value = parseFloat(depthControl.value);
            if (Number.isNaN(value)) return;
            value = Math.max(1, Math.min(MAX_SEARCH_DEPTH_PERCENT, Math.round(value)));
            depthControl.value = String(value);
            try {
                localStorage.setItem(SEARCH_DEPTH_STORAGE_KEY, String(value));
            } catch (err) {
                // Persistence is optional; the live control still works without it.
            }
        });
    }

    relatedCardsBar = document.getElementById('related-cards-bar');
    selectedCardsChips = document.getElementById('selected-cards-chips');
    selectedRelatedMoreBtn = document.getElementById('selected-cards-more-btn');
    selectedRelatedModal = document.getElementById('selected-related-modal');
    selectedRelatedModalGrid = document.getElementById('selected-related-modal-grid');
    selectedRelatedModalClose = document.getElementById('selected-related-modal-close');
    relatedSearchBtn = document.getElementById('related-search-btn');
    clearSelectedBtn = document.getElementById('clear-selected-btn');
    
    // --- SEARCH METHODS MODAL LOGIC ---
    const toggleMethodsBtn = document.getElementById('toggle-search-methods-btn');
    const searchMethodsModal = document.getElementById('search-methods-modal');
    const closeMethodsBtn = document.getElementById('close-methods-modal');
    const saveMethodsBtn = document.getElementById('save-methods-btn');
    const methodsBadge = document.getElementById('selected-methods-badge');

    function updateMethodsBadge() {
        const selected = [];
        const labels = [
            ['broad-search', 'Broad Search'],
            ['divergent-search', 'Divergent Search'],
            ['wording-search', 'Wording Search'],
            ['functional-search', 'Functional Search'],
            ['target-search', 'Target Search'],
            ['role-search', 'Role Search'],
            ['alternate-search', 'Alternative Search'],
            ['synergy-search', 'Synergy Search']
        ];
        labels.forEach(([id, label]) => {
            if (document.getElementById(id)?.checked) selected.push(label);
        });

        if (selected.length === 0) {
            methodsBadge.textContent = 'Standard';
            methodsBadge.style.backgroundColor = 'var(--bg-primary)';
        } else {
            methodsBadge.textContent = selected.length <= 3 ? selected.join(', ') : `${selected.length} selected`;
            methodsBadge.style.backgroundColor = 'var(--accent-color)';
        }
    }

    if (toggleMethodsBtn) toggleMethodsBtn.addEventListener('click', () => searchMethodsModal.classList.remove('hidden'));
    if (closeMethodsBtn) closeMethodsBtn.addEventListener('click', () => searchMethodsModal.classList.add('hidden'));
    if (saveMethodsBtn) saveMethodsBtn.addEventListener('click', () => {
        updateMethodsBadge();
        searchMethodsModal.classList.add('hidden');
    });

    // --- ORDER MODAL LOGIC ---
    const toggleOrderBtn = document.getElementById('toggle-order-btn');
    const orderModal = document.getElementById('order-modal');
    const closeOrderBtn = document.getElementById('close-order-modal');
    const saveOrderBtn = document.getElementById('save-order-btn');
    const orderBadge = document.getElementById('selected-order-badge');
    const orderRadios = Array.from(document.querySelectorAll('input[name="order-choice"]'));
    const orderMatrixFeature = document.getElementById('order-feature-matrix');
    const orderDiverseFeature = document.getElementById('order-feature-diverse');

    const orderLabels = {
        overall: 'Overall Match',
        mechanical: 'Mechanical',
        functional: 'Functional',
        semantic: 'Semantic',
        role: 'Strategic Role',
        balanced: 'Mechanical + Functional',
        synergy: 'Synergy',
        exactness: 'Exactness',
        category: 'Category'
    };
    const validOrderRankings = new Set(Object.keys(orderLabels));

    function getActiveOrderCriteria() {
        const current = sortSelect?.value || 'overall';
        return validOrderRankings.has(current) ? current : 'overall';
    }

    function syncOrderModalSelection() {
        const current = getActiveOrderCriteria();
        orderRadios.forEach(radio => { radio.checked = radio.value === current; });
        if (orderMatrixFeature) orderMatrixFeature.checked = Boolean(activeOrderFeatureFlags.matrix);
        if (orderDiverseFeature) orderDiverseFeature.checked = Boolean(activeOrderFeatureFlags.diverse);
    }

    function updateOrderBadge() {
        const current = getActiveOrderCriteria();
        const baseLabel = orderLabels[current] || 'Overall Match';
        const features = [];
        if (activeOrderFeatureFlags.matrix) features.push('Matrix');
        if (activeOrderFeatureFlags.diverse) features.push('Diverse');
        if (orderBadge) {
            orderBadge.textContent = features.length ? `${baseLabel} + ${features.join(' + ')}` : baseLabel;
            orderBadge.title = features.length
                ? `Ranking: ${baseLabel}. Features: ${features.join(', ')}`
                : `Ranking: ${baseLabel}`;
        }
    }

    if (toggleOrderBtn) toggleOrderBtn.addEventListener('click', () => {
        syncOrderModalSelection();
        orderModal?.classList.remove('hidden');
    });
    if (closeOrderBtn) closeOrderBtn.addEventListener('click', () => {
        syncOrderModalSelection();
        orderModal?.classList.add('hidden');
    });
    if (saveOrderBtn) saveOrderBtn.addEventListener('click', () => {
        const selected = orderRadios.find(radio => radio.checked)?.value || 'overall';
        activeOrderFeatureFlags.matrix = Boolean(orderMatrixFeature?.checked);
        activeOrderFeatureFlags.diverse = Boolean(orderDiverseFeature?.checked);

        if (sortSelect && sortSelect.value !== selected) {
            sortSelect.value = selected;
            sortSelect.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (lastSearchResults && lastSearchResults.length > 0) {
            reorderResults();
            renderResults(lastSearchResults);
        }
        updateOrderBadge();
        orderModal?.classList.add('hidden');
    });
    orderRadios.forEach(radio => radio.addEventListener('change', () => {
        // The actual ranking/features are committed with Done, matching the Search Methods panel.
    }));
    updateOrderBadge();

    ['broad-search', 'divergent-search', 'wording-search', 'functional-search', 'target-search', 'role-search', 'alternate-search', 'synergy-search'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', updateMethodsBadge);
    });

    if (preferencesModal) preferencesModal.addEventListener('click', (event) => {
        if (event.target === preferencesModal) preferencesModal.classList.add('hidden');
    });

    renderSidebarLists();
    systemThemeMediaQuery = window.matchMedia?.('(prefers-color-scheme: light)') || null;
    if (systemThemeMediaQuery?.addEventListener) {
        systemThemeMediaQuery.addEventListener('change', () => {
            if (displayPreferences.theme === 'system') applyPresentationPreferences();
        });
    } else if (systemThemeMediaQuery?.addListener) {
        systemThemeMediaQuery.addListener(() => {
            if (displayPreferences.theme === 'system') applyPresentationPreferences();
        });
    }
    
    if (searchBtn) searchBtn.addEventListener('click', () => loadSourceCard(cardSearchInput.value.trim()));
    if (cardSearchInput) cardSearchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') loadSourceCard(cardSearchInput.value.trim()); });
    if (findSimilarBtn) findSimilarBtn.addEventListener('click', findSimilarCards);
    const searchDeeperBtnInit = document.getElementById('search-deeper-btn');
    if (searchDeeperBtnInit) searchDeeperBtnInit.addEventListener('click', searchDeeper);
    if (favoriteBtn) favoriteBtn.addEventListener('click', toggleFavorite);
    const discardSourceCardBtn = document.getElementById('discard-source-card-btn');
    if (discardSourceCardBtn) {
        discardSourceCardBtn.addEventListener('click', () => currentSourceCard ? removeSourceCardFromSet(currentSourceCard) : clearSourceCard());
        discardSourceCardBtn.disabled = !currentSourceCard;
    }
    updateSourceCardMultiSearchState();
    if (exportBtn) exportBtn.addEventListener('click', exportToCSV);
    
    if (clearSelectedBtn) clearSelectedBtn.addEventListener('click', clearSelectedRelatedCards);
    if (relatedSearchBtn) relatedSearchBtn.addEventListener('click', executeRelatedCardSearch);
    if (selectedRelatedMoreBtn) selectedRelatedMoreBtn.addEventListener('click', openSelectedRelatedCardsModal);
    if (selectedRelatedModalClose) selectedRelatedModalClose.addEventListener('click', closeSelectedRelatedCardsModal);
    if (selectedRelatedModal) {
        selectedRelatedModal.addEventListener('click', (event) => {
            if (event.target === selectedRelatedModal) closeSelectedRelatedCardsModal();
        });
    }

    if ('requestIdleCallback' in window) {
        requestIdleCallback(() => {
            void getNLPModel();
        }, { timeout: 2500 });
    } else {
        setTimeout(() => {
            void getNLPModel();
        }, 2000);
    }

    ensureComparePresentationStyles();

    const closeModalBtn = document.getElementById('close-modal');
    if (closeModalBtn) {
        closeModalBtn.setAttribute('role', 'button');
        closeModalBtn.setAttribute('tabindex', '0');
        closeModalBtn.setAttribute('aria-label', 'Close card comparison');
        const closeCompare = () => { compareModal.classList.add('hidden'); compareQueue = []; };
        closeModalBtn.addEventListener('click', closeCompare);
        closeModalBtn.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); closeCompare(); }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && compareModal && !compareModal.classList.contains('hidden')) closeCompare();
        });
    }

    const addTagInput = document.getElementById('add-tag-input');
    if (addTagInput) {
        addTagInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const newTag = e.target.value.trim();
                if (newTag && !activeTags.map(t => t.toLowerCase()).includes(newTag.toLowerCase())) {
                    activeTags.push(newTag);
                    renderTags();
                }
                e.target.value = '';
            }
        });
    }

    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            if (validOrderCriteriaForOrdering(sortSelect.value) !== sortSelect.value) {
                sortSelect.value = 'overall';
            }
            updateOrderBadge();
            if (lastSearchResults && lastSearchResults.length > 0) {
                reorderResults();
                renderResults(lastSearchResults);
            }
        });
    }

    if (sourceCardOracle) {
        // Mouse, touch, and keyboard selection all end up in the same handler.  The mouse handler
        // MUST only react to the primary (left) mouse button.  A generic `mouseup` listener also
        // receives the middle-button release used by browser auto-scroll; re-rendering the Oracle
        // from that event can interfere with the browser's native middle-click scroll state,
        // especially while a search is replacing/rerendering the page.  Leaving button===1 alone
        // lets the browser start/stop auto-scroll normally.
        sourceCardOracle.addEventListener('mouseup', (event) => {
            if (event.button !== 0) return;
            handleOracleTextSelection();
        });
        sourceCardOracle.addEventListener('touchend', () => setTimeout(handleOracleTextSelection, 0));
        sourceCardOracle.addEventListener('keyup', (event) => {
            if (event.shiftKey || event.key.startsWith('Arrow')) handleOracleTextSelection();
        });
    }

    sourceCardSection?.classList.remove('hidden');
    sourceCardLoaded?.classList.toggle('hidden', !currentSourceCard);
    sourceCardEmpty?.classList.toggle('hidden', !!currentSourceCard);
    renderHighlightChips();

    // --- SORTING & WEIGHT MODIFIERS MODAL LOGIC ---
    const toggleSortingWeightsBtn = document.getElementById('toggle-sorting-weights-btn');
    const sortingWeightsModal = document.getElementById('sorting-weights-modal');
    const closeSortingWeightsBtn = document.getElementById('close-sorting-weights-modal');
    const saveSortingWeightsBtn = document.getElementById('save-sorting-weights-btn');
    const sortingWeightsBadge = document.getElementById('sorting-weights-badge');

    if (saveSortingWeightsBtn) {
        saveSortingWeightsBtn.addEventListener('click', () => {
            updateSortingWeightsBadge();
            sortingWeightsModal.classList.add('hidden');
            if (lastSearchResults && lastSearchResults.length > 0) {
                reorderResults();
                renderResults(lastSearchResults);
            }
        });
    }

    function updateSortingWeightsBadge() {
    const synergy = parseInt(document.getElementById('weight-synergy')?.value) || 0;
    const context = parseInt(document.getElementById('weight-context')?.value) || 0;
    const exactness = parseInt(document.getElementById('weight-exactness')?.value) || 0;
    const category = parseInt(document.getElementById('weight-category')?.value) || 0;
    const sortVal = document.getElementById('sort-results')?.value || 'overall';

    if (synergy === 0 && context === 0 && exactness === 0 && category === 0 && sortVal === 'overall') {
        sortingWeightsBadge.textContent = 'Default';
        sortingWeightsBadge.style.backgroundColor = 'var(--bg-primary)';
    } else {
        sortingWeightsBadge.textContent = 'Customized';
        sortingWeightsBadge.style.backgroundColor = 'var(--accent-color)';
    }
    }

    if (toggleSortingWeightsBtn) toggleSortingWeightsBtn.addEventListener('click', () => sortingWeightsModal.classList.remove('hidden'));
    if (closeSortingWeightsBtn) closeSortingWeightsBtn.addEventListener('click', () => sortingWeightsModal.classList.add('hidden'));

    ['sort-results', 'weight-synergy', 'weight-context', 'weight-exactness', 'weight-category'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', updateSortingWeightsBadge);
            if (id === 'sort-results') el.addEventListener('change', updateOrderBadge);
        }
    });

    // --- CARD CONSTRAINTS MODAL LOGIC ---
    const toggleCardConstraintsBtn = document.getElementById('toggle-card-constraints-btn');
    const cardConstraintsModal = document.getElementById('card-constraints-modal');
    const closeCardConstraintsBtn = document.getElementById('close-card-constraints-modal');
    const saveCardConstraintsBtn = document.getElementById('save-card-constraints-btn');
    const cardConstraintsBadge = document.getElementById('card-constraints-badge');

    function updateCardConstraintsBadge() {
        const filters = readConstraintFilters();
        let activeCount = 0;
        activeCount += (filters.types || []).length;
        activeCount += (filters.supertypes || []).length;
        activeCount += (filters.subtypes || []).length;
        activeCount += (filters.keywords || []).length;
        if (filters.format) activeCount++;
        if (filters.rarity) activeCount++;
        if (filters.identity) activeCount++;
        if (filters.colors) activeCount++;
        if (filters.cmc !== '') activeCount++;
        if (filters.power !== '') activeCount++;
        if (filters.toughness !== '') activeCount++;
        if (filters.set) activeCount++;
        if (filters.extraOracle) activeCount++;
        if (activeCount === 0) {
            cardConstraintsBadge.textContent = 'Any';
            cardConstraintsBadge.style.backgroundColor = 'var(--bg-primary)';
        } else {
            cardConstraintsBadge.textContent = `${activeCount} Active`;
            cardConstraintsBadge.style.backgroundColor = 'var(--accent-color)';
        }
    }
    if (toggleCardConstraintsBtn) toggleCardConstraintsBtn.addEventListener('click', () => cardConstraintsModal.classList.remove('hidden'));
    if (closeCardConstraintsBtn) closeCardConstraintsBtn.addEventListener('click', () => cardConstraintsModal.classList.add('hidden'));
    if (saveCardConstraintsBtn) {
        saveCardConstraintsBtn.addEventListener('click', () => {
            updateCardConstraintsBadge();
            cardConstraintsModal.classList.add('hidden');
        });
    }

    ['filter-type', 'filter-supertype', 'filter-subtype', 'filter-keyword', 'filter-format', 'filter-rarity', 'filter-identity', 'filter-colors', 'filter-cmc', 'filter-power', 'filter-toughness', 'filter-set', 'filter-extra-oracle'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', updateCardConstraintsBadge);
            if (el.tagName === 'SELECT') el.addEventListener('change', updateCardConstraintsBadge);
        }
    });

    initMultiConstraintFields(updateCardConstraintsBadge);
    ['filter-type', 'filter-supertype', 'filter-subtype', 'filter-keyword'].forEach(id => {
        const source = document.getElementById(id);
        if (source) {
            source.value = normalizeConstraintList(source.value).join('|');
            syncConstraintChipField(id, `${id}-chips`);
        }
    });

    initColorPips();

    // Fire-and-forget preload of both semantic resources. The static semantic index is a
    // deployment artifact, not something visitors should build locally. Starting it here means
    // its ~13.6 MB download can overlap the first Scryfall search instead of beginning only after
    // the first results have rendered.
    getNLPModel().catch(() => {});
    preloadStaticSemanticIndex().catch(() => {});
}

/**
 * Wires up the clickable WUBRG "pip" buttons (a classic Scryfall/EDHREC color picker pattern) as
 * a friendlier input method for the existing Color Identity / Exact Colors filters. Each pip
 * group targets a hidden text input (via data-target) that already holds the real filter value -
 * clicking a pip toggles it and writes the same letter-string the input always expected (e.g.
 * "wg"), then dispatches a genuine 'input' event so every listener already watching that field
 * (the constraints badge, etc.) picks up the change with no separate wiring needed. The hidden
 * input stays the single source of truth; the pips are just a nicer way to fill it.
 */
function initColorPips() {
    document.querySelectorAll('.color-pip-group').forEach(group => {
        const targetInput = document.getElementById(group.dataset.target);
        if (!targetInput) return;

        function syncPipsFromInput() {
            const active = (targetInput.value || '').toLowerCase().replace(/[^wubrgc]/g, '').split('');
            group.querySelectorAll('.color-pip').forEach(pip => {
                pip.classList.toggle('active', active.includes(pip.dataset.color));
            });
        }

        group.querySelectorAll('.color-pip').forEach(pip => {
            pip.addEventListener('click', () => {
                pip.classList.toggle('active');
                const selected = Array.from(group.querySelectorAll('.color-pip.active')).map(p => p.dataset.color);
                targetInput.value = selected.join('');
                targetInput.dispatchEvent(new Event('input', { bubbles: true }));
            });
        });

        // Keeps the pips visually in sync if the hidden input's value is ever set
        // programmatically instead of by clicking a pip (e.g. the benchmark runner loading a
        // test case's constraints directly into the field).
        syncPipsFromInput();
        targetInput.addEventListener('input', syncPipsFromInput);
    });
}

// Fallback execution check for ES Module environments
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// --- THEME & STORAGE MANAGEMENT ---
// Theme is controlled from Preferences. These compatibility helpers remain available for
// older integrations/benchmarks that may call them directly.
function toggleTheme() {
    const current = resolveTheme(displayPreferences?.theme);
    displayPreferences.theme = current === 'light' ? 'dark' : 'light';
    saveDisplayPreferences();
    applyPresentationPreferences();
    try { localStorage.setItem(THEME_KEY, displayPreferences.theme); } catch (_) {}
}

function loadTheme() {
    applyPresentationPreferences();
}

function getStoredArray(key) { 
    try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : [];
    } catch (err) {
        console.error(`Error reading ${key} from localStorage:`, err);
        return [];
    }
}

function getCardImageUrl(card) {
    return card?.image_uris?.normal || card?.card_faces?.[0]?.image_uris?.normal || '';
}

function buildHistoryCardPreview(card) {
    if (!card) return null;
    const hasOracle = typeof card.oracle_text === 'string' && card.oracle_text.trim().length > 0;
    const hasFaces = Array.isArray(card.card_faces) && card.card_faces.some(face => String(face?.oracle_text || '').trim());
    return {
        id: card.id || '',
        name: card.name || '',
        mana_cost: card.mana_cost || '',
        type_line: card.type_line || '',
        oracle_text: hasOracle ? card.oracle_text : '',
        image_uris: card.image_uris ? { normal: card.image_uris.normal || '' } : undefined,
        card_faces: Array.isArray(card.card_faces) ? card.card_faces.slice(0, 2).map(face => ({
            name: face.name || '',
            mana_cost: face.mana_cost || '',
            type_line: face.type_line || '',
            oracle_text: face.oracle_text || '',
            image_uris: face.image_uris ? { normal: face.image_uris.normal || '' } : undefined
        })) : undefined,
        _hasOracleText: Boolean(hasOracle || hasFaces),
        _savedAt: Date.now()
    };
}

function hasUsableOracleText(card) {
    if (!card) return false;
    if (typeof card.oracle_text === 'string' && card.oracle_text.trim()) return true;
    return Array.isArray(card.card_faces) && card.card_faces.some(face => String(face?.oracle_text || '').trim());
}

function mergeCardRecords(primary, secondary) {
    if (!primary && !secondary) return null;
    if (!primary) return secondary;
    if (!secondary) return primary;
    const merged = { ...secondary, ...primary };
    const primaryOracle = hasUsableOracleText(primary);
    const secondaryOracle = hasUsableOracleText(secondary);
    if (!primaryOracle && secondaryOracle) {
        merged.oracle_text = secondary.oracle_text || '';
        if (secondary.card_faces) merged.card_faces = secondary.card_faces;
    }
    if (!merged.image_uris?.normal && secondary.image_uris?.normal) merged.image_uris = secondary.image_uris;
    if ((!Array.isArray(merged.card_faces) || !merged.card_faces.length) && Array.isArray(secondary.card_faces)) merged.card_faces = secondary.card_faces;
    return merged;
}

function storeHistoryCardPreview(card) {
    const preview = buildHistoryCardPreview(card);
    if (!preview?.name) return;
    let previews = getStoredArray(HISTORY_CARD_PREVIEWS_KEY);
    const key = preview.name.toLowerCase();
    const existing = previews.find(item => String(item?.name || '').toLowerCase() === key);
    const richerPreview = existing ? mergeCardRecords(existing, preview) : preview;
    // Prefer a newly retrieved record when it contains rules text; never overwrite good Oracle
    // data with an older, partial history preview.
    if (hasUsableOracleText(preview)) {
        richerPreview.oracle_text = preview.oracle_text || '';
        if (preview.card_faces) richerPreview.card_faces = preview.card_faces;
        richerPreview._hasOracleText = true;
    }
    richerPreview._savedAt = Date.now();
    previews = previews.filter(item => String(item?.name || '').toLowerCase() !== key);
    previews.unshift(richerPreview);
    if (previews.length > 10) previews = previews.slice(0, 10);
    try { localStorage.setItem(HISTORY_CARD_PREVIEWS_KEY, JSON.stringify(previews)); } catch (_) {}
}

function getHistoryCardPreviews() {
    return getStoredArray(HISTORY_CARD_PREVIEWS_KEY).filter(card => card && card.name);
}

function addToHistory(cardName, card = currentSourceCard) {
    if (card) storeHistoryCardPreview(card);
    let history = getStoredArray(HISTORY_KEY);
    history = history.filter(name => name.toLowerCase() !== cardName.toLowerCase());
    history.unshift(cardName);
    if (history.length > 10) history.pop();
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (err) {
        console.warn("Search history could not be saved:", err.message);
    }
    renderSidebarLists();
}

function setFavoriteState(cardName, shouldFavorite) {
    const normalizedName = String(cardName || '').trim();
    if (!normalizedName) return false;

    let favorites = getStoredArray(FAVORITES_KEY);
    const existingIndex = favorites.findIndex(name => String(name).toLowerCase() === normalizedName.toLowerCase());

    if (shouldFavorite) {
        if (existingIndex === -1) favorites.push(normalizedName);
    } else if (existingIndex !== -1) {
        favorites.splice(existingIndex, 1);
    }

    try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    } catch (err) {
        console.warn("Favorites could not be saved:", err.message);
        return false;
    }

    renderSidebarLists();
    updateFavoriteButtons(normalizedName);
    return true;
}

function updateFavoriteButtons(cardName) {
    const normalizedName = String(cardName || '').trim().toLowerCase();
    if (!normalizedName) return;
    const favorites = getStoredArray(FAVORITES_KEY);
    const isFavorite = favorites.some(name => String(name).toLowerCase() === normalizedName);

    if (favoriteBtn && currentSourceCard && String(currentSourceCard.name || '').toLowerCase() === normalizedName) {
        favoriteBtn.textContent = isFavorite ? '★ Favorited' : '☆ Favorite';
    }

    document.querySelectorAll('[data-favorite-card-name]').forEach(button => {
        if (String(button.dataset.favoriteCardName || '').toLowerCase() !== normalizedName) return;
        button.textContent = isFavorite ? '★' : '☆';
        button.title = isFavorite ? `Remove ${button.dataset.favoriteCardName} from favorites` : `Add ${button.dataset.favoriteCardName} to favorites`;
        button.setAttribute('aria-label', button.title);
        button.classList.toggle('is-favorited', isFavorite);
    });
}

function toggleFavoriteCard(card) {
    if (!card?.name) return;
    const favorites = getStoredArray(FAVORITES_KEY);
    const isFavorite = favorites.some(name => String(name).toLowerCase() === String(card.name).toLowerCase());
    setFavoriteState(card.name, !isFavorite);
}

function toggleFavorite() {
    if (!currentSourceCard) return;
    const favorites = getStoredArray(FAVORITES_KEY);
    const isFavorite = favorites.some(name => String(name).toLowerCase() === String(currentSourceCard.name).toLowerCase());
    setFavoriteState(currentSourceCard.name, !isFavorite);
}

function renderSidebarLists() {
    const history = getStoredArray(HISTORY_KEY);
    const favorites = getStoredArray(FAVORITES_KEY);

    const previewByName = new Map(getHistoryCardPreviews().map(card => [String(card.name || '').toLowerCase(), card]));

    historyList.innerHTML = '';
    history.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        const preview = mergeCardRecords(
            previewByName.get(String(name).toLowerCase()) || null,
            sourceCardCache.get(String(name).toLowerCase()) || null
        );
        li.addEventListener('click', () => loadSourceCard(name, preview));
        historyList.appendChild(li);
    });

    favoritesList.innerHTML = '';
    favorites.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        const preview = mergeCardRecords(
            previewByName.get(String(name).toLowerCase()) || null,
            sourceCardCache.get(String(name).toLowerCase()) || null
        );
        li.addEventListener('click', () => loadSourceCard(name, preview));
        favoritesList.appendChild(li);
    });
}

function checkFavoriteStatus(cardName) {
    const favorites = getStoredArray(FAVORITES_KEY);
    favoriteBtn.textContent = favorites.includes(cardName) ? '★ Favorited' : '☆ Favorite';
}

// --- MULTI-SOURCE CARD CONTEXT ------------------------------------------------------------
function getSourceCardIdentity(card) {
    return String(card?.id || card?.oracle_id || card?.name || '').trim().toLowerCase();
}
function getActiveSourceCards() {
    const cards = [];
    if (primarySourceCardKey && sourceCards.has(primarySourceCardKey)) cards.push(sourceCards.get(primarySourceCardKey));
    sourceCards.forEach((card, key) => { if (key !== primarySourceCardKey) cards.push(card); });
    return cards.filter(Boolean);
}
function addSourceCardToSet(card, { makePrimary = false } = {}) {
    if (!card?.name) return false;
    const key = getSourceCardIdentity(card);
    if (!key) return false;
    if (!sourceCards.has(key) && sourceCards.size >= MAX_SOURCE_CARDS) { alert(`ManaSearch supports up to ${MAX_SOURCE_CARDS} source cards at once.`); return false; }
    sourceCards.set(key, card);
    if (!primarySourceCardKey || makePrimary) primarySourceCardKey = key;
    renderAdditionalSourceCards(); updateSourceCardMultiSearchState(); return true;
}
function removeSourceCardFromSet(cardOrKey) {
    const key = typeof cardOrKey === 'string' ? cardOrKey : getSourceCardIdentity(cardOrKey);
    if (!key || !sourceCards.has(key)) return;
    const wasPrimary = key === primarySourceCardKey; sourceCards.delete(key);
    if (wasPrimary) {
        const next = sourceCards.values().next().value || null;
        primarySourceCardKey = next ? getSourceCardIdentity(next) : null; currentSourceCard = next;
        if (next) { displaySourceCard(next); activeTags = generateTags(next); renderTags(); checkFavoriteStatus(next.name); }
        else { clearSourceCard(); return; }
    }
    renderAdditionalSourceCards(); updateSourceCardMultiSearchState();
}
function renderAdditionalSourceCards() {
    const container = document.getElementById('additional-source-cards'); if (!container) return;
    container.replaceChildren();
    const cards = getActiveSourceCards().filter(c => getSourceCardIdentity(c) !== primarySourceCardKey);
    if (!cards.length) { container.classList.add('hidden'); return; }
    container.classList.remove('hidden');
    const heading = document.createElement('div'); heading.className='additional-source-cards-heading';
    const title=document.createElement('strong'); title.textContent=`Additional source cards (${cards.length})`;
    const hint=document.createElement('span'); hint.textContent='Shared-text search uses all source cards'; heading.append(title,hint);
    const grid=document.createElement('div'); grid.className='additional-source-cards-grid';
    cards.forEach(card => {
        const tile=document.createElement('article'); tile.className='additional-source-card';
        const img=document.createElement('img'); img.src=getCardImageUrl(card)||''; img.alt=card.name; img.loading='lazy';
        const meta=document.createElement('div'); meta.className='additional-source-card-meta';
        const name=document.createElement('strong'); name.textContent=card.name; const type=document.createElement('span'); type.textContent=card.type_line||''; meta.append(name,type);
        const remove=document.createElement('button'); remove.type='button'; remove.className='additional-source-card-remove'; remove.textContent='\u00D7'; remove.title=`Remove ${card.name}`; remove.setAttribute('aria-label',`Remove ${card.name} from source cards`);
        remove.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();removeSourceCardFromSet(card);});
        tile.append(img,meta,remove); grid.appendChild(tile);
    });
    container.append(heading,grid);
}
async function addAdditionalSourceCard(card) {
    if (!card?.name) return; const key=getSourceCardIdentity(card); if (sourceCards.has(key)) {closeSourceCardPicker();return;}
    if (sourceCards.size>=MAX_SOURCE_CARDS) {closeSourceCardPicker();alert(`ManaSearch supports up to ${MAX_SOURCE_CARDS} source cards at once.`);return;}
    try {
        let fullCard=card;
        if (!hasUsableOracleText(fullCard)) {
            const response=await scryfallThrottledFetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(card.name)}`,{headers:{'User-Agent':'ManaMatch/1.0 (Semantic Magic Search)','Accept':'application/json'}});
            if(!response.ok) throw new Error('Unable to load the additional source card.'); fullCard=await response.json();
        }
        sourceCardCache.set(fullCard.name.toLowerCase(),fullCard); addSourceCardToSet(fullCard); closeSourceCardPicker();
    } catch(error) { alert(error.message||'Unable to add source card.'); }
}
function updateSourceCardMultiSearchState() {
    const count=sourceCards.size, badge=document.getElementById('source-card-count-badge'); if(badge) badge.textContent=String(Math.max(1,count));
    const button=document.getElementById('add-source-card-btn'); if(button){button.disabled=count>=MAX_SOURCE_CARDS;button.textContent=count>=MAX_SOURCE_CARDS?'Source Card Limit':'Add Source Card';}
}
function buildSharedSourceTextSearchQuery(cards, excludeNames='') {
    if(!Array.isArray(cards)||cards.length<2)return null;
    const stop=new Set(['the','of','and','a','to','in','is','that','it','for','on','are','as','with','they','at','be','this','have','from','or','by','but','not','what','all','were','we','when','your','can','there','an','which','do','their','if','will','up','about','out','then','them','these','so','some','would','make','like','into','has','more','no','could','my','than','first','been','who','its','now','down','may','you']);
    const mtg=new Set(['target','targets','targeting','creature','creatures','card','cards','damage','battlefield','control','controls','controlled','controller','player','players','permanent','permanents','ability','abilities','spell','spells','choose','mana','opponent','opponents','turn','until','each','another','deals','deal','put','onto','enters','becomes','gets','gain','gains','equal','instead','additional','whenever','number','other','any','exile','exiled','hand','graveyard','library','tap','tapped','untap','sacrifice','nontoken','nonland','cost','costs','pay','resolves','owner','you','yours']);
    const texts=cards.map(c=>extractBulkOracleCardText(c).toLowerCase().replace(/[^a-z0-9+\-\s]/g,' ').split(/\s+/).filter(Boolean));
    const sets=texts.map(ws=>new Set(ws.filter(w=>w.length>2&&!stop.has(w)&&!mtg.has(w)&&!/^\d+$/.test(w))));
    const common=[...sets[0]].filter(w=>sets.every(s=>s.has(w)));
    const phraseSets=texts.map(ws=>{const out=new Set();for(let len=2;len<=4;len++)for(let i=0;i<=ws.length-len;i++){const part=ws.slice(i,i+len);if(part.filter(w=>w.length>2&&!stop.has(w)&&!mtg.has(w)).length>=2)out.add(part.join(' '));}return out;});
    const phrases=[...phraseSets[0]].filter(p=>phraseSets.every(s=>s.has(p))).sort((a,b)=>b.split(/\s+/).length-a.split(/\s+/).length||b.length-a.length).slice(0,4);
    const clauses=phrases.map(p=>`o:"${p.replace(/"/g,'\\"')}"`);
    if(!clauses.length)for(let i=0;i+1<common.length&&clauses.length<4;i+=2)clauses.push(`(o:"${common[i]}" o:"${common[i+1]}")`);
    if(!clauses.length&&common.length)clauses.push(`o:"${common[0]}"`);
    return clauses.length?`(${clauses.join(' OR ')}) ${excludeNames}`.trim():null;
}

// --- RELATED CARDS SELECTION & FLOATING BAR ---
function invalidateInFlightRelatedSearch() {
    // Selection changes alter only the related-card query context. They MUST NOT invalidate the
    // ordinary Similar Cards search, because users are allowed to select a progressively-scored
    // result before every retrieval stream has finished. The previous implementation incremented
    // searchRequestId here, which made the in-flight main search think it had become stale and it
    // subsequently cleared/withdrew its remaining candidates.
    ++relatedSearchRequestId;
    pendingDeeperSearch = null;
    const deeperBtn = document.getElementById('search-deeper-btn');
    if (deeperBtn) deeperBtn.classList.add('hidden');
}

function toggleSelectRelatedCard(card) {
    invalidateInFlightRelatedSearch();
    if (selectedRelatedCards.has(card.id)) {
        selectedRelatedCards.delete(card.id);
    } else {
        selectedRelatedCards.set(card.id, card);
    }
    updateRelatedBar();
    renderResults(lastSearchResults); // Re-render to highlight selected state
}

function clearSelectedRelatedCards() {
    if (selectedRelatedCards.size === 0) return;
    invalidateInFlightRelatedSearch();
    selectedRelatedCards.clear();
    updateRelatedBar();
    if (lastSearchResults) renderResults(lastSearchResults);
}

function updateRelatedBar() {
    if (selectedRelatedCards.size === 0) {
        relatedCardsBar.classList.add('hidden');
        selectedRelatedMoreBtn?.classList.add('hidden');
        closeSelectedRelatedCardsModal();
        return;
    }

    relatedCardsBar.classList.remove('hidden');
    selectedCardsChips.innerHTML = '';

    selectedRelatedCards.forEach(card => {
        const chip = document.createElement('div');
        chip.className = 'card-chip';

        const label = document.createElement('span');
        label.textContent = card.name;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'card-chip-remove';
        removeBtn.textContent = '\u00D7';
        removeBtn.title = `Remove ${card.name}`;
        removeBtn.setAttribute('aria-label', `Remove ${card.name} from selected related cards`);
        removeBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            invalidateInFlightRelatedSearch();
            selectedRelatedCards.delete(card.id);
            updateRelatedBar();
            renderResults(lastSearchResults);
            if (selectedRelatedModal && !selectedRelatedModal.classList.contains('hidden')) {
                renderSelectedRelatedCardsModal();
            }
        });

        chip.appendChild(label);
        chip.appendChild(removeBtn);
        selectedCardsChips.appendChild(chip);
    });

    requestAnimationFrame(syncSelectedRelatedCardsOverflow);
}

function syncSelectedRelatedCardsOverflow() {
    if (!selectedCardsChips || !selectedRelatedMoreBtn) return;
    if (selectedRelatedCards.size === 0) {
        selectedRelatedMoreBtn.classList.add('hidden');
        return;
    }

    selectedRelatedMoreBtn.classList.add('hidden');
    const overflowing = selectedCardsChips.scrollWidth > selectedCardsChips.clientWidth + 1;
    if (overflowing) selectedRelatedMoreBtn.classList.remove('hidden');
}

function renderSelectedRelatedCardsModal() {
    if (!selectedRelatedModalGrid) return;
    selectedRelatedModalGrid.innerHTML = '';

    selectedRelatedCards.forEach(card => {
        const tile = document.createElement('article');
        tile.className = 'selected-related-card-tile';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'selected-related-card-remove';
        removeBtn.textContent = '\u00D7';
        removeBtn.title = `Remove ${card.name}`;
        removeBtn.setAttribute('aria-label', `Remove ${card.name} from selected related cards`);
        removeBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            invalidateInFlightRelatedSearch();
            selectedRelatedCards.delete(card.id);
            updateRelatedBar();
            renderResults(lastSearchResults);
            if (selectedRelatedCards.size === 0) {
                closeSelectedRelatedCardsModal();
            } else {
                renderSelectedRelatedCardsModal();
            }
        });

        const artWrap = document.createElement('div');
        artWrap.className = 'selected-related-card-art-wrap';
        const img = document.createElement('img');
        img.src = card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || 'https://placeholder.pics/svg/220x310/EAEAEA/999999/No%20Image';
        img.alt = card.name;
        img.loading = 'lazy';
        artWrap.appendChild(img);

        const name = document.createElement('div');
        name.className = 'selected-related-card-name';
        name.textContent = card.name;

        tile.append(removeBtn, artWrap, name);
        selectedRelatedModalGrid.appendChild(tile);
    });
}

function openSelectedRelatedCardsModal() {
    if (!selectedRelatedModal || selectedRelatedCards.size === 0) return;
    renderSelectedRelatedCardsModal();
    selectedRelatedModal.classList.remove('hidden');
}

function closeSelectedRelatedCardsModal() {
    selectedRelatedModal?.classList.add('hidden');
}

// --- SOURCE CARD PICKER ---
function closeSourceCardPicker() {
    if (!sourceCardPickerModal) return;
    sourceCardPickerModal.classList.add('hidden');
    if (sourceCardPickerDebounce) {
        clearTimeout(sourceCardPickerDebounce);
        sourceCardPickerDebounce = null;
    }
}

function getSourceCardPickerMatches() {
    const previews = getHistoryCardPreviews();
    const cached = Array.from(sourceCardCache.values()).filter(card => card && card.name);
    const merged = [];
    const seen = new Set();
    [...previews, ...cached].forEach(card => {
        const key = String(card.name || '').toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        merged.push(card);
    });
    return merged;
}

function renderSourceCardPickerCards(cards, emptyMessage = 'No cards found.') {
    if (!sourceCardPickerResults) return;
    sourceCardPickerResults.innerHTML = '';
    if (!cards.length) {
        const empty = document.createElement('div');
        empty.className = 'source-card-picker-empty';
        empty.textContent = emptyMessage;
        sourceCardPickerResults.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    cards.slice(0, 12).forEach(card => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'source-picker-card';
        const imageUrl = getCardImageUrl(card);
        if (imageUrl) {
            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = card.name;
            img.loading = 'lazy';
            img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });
            button.appendChild(img);
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'source-picker-card-placeholder';
            placeholder.textContent = 'MTG';
            button.appendChild(placeholder);
        }
        const body = document.createElement('span');
        body.className = 'source-picker-card-body';
        const name = document.createElement('strong');
        name.textContent = card.name;
        const type = document.createElement('span');
        type.textContent = [card.mana_cost, card.type_line].filter(Boolean).join(' • ');
        body.append(name, type);
        button.appendChild(body);
        button.addEventListener('click', () => {
            cardSearchInput.value = card.name;
            if (currentSourceCard) addAdditionalSourceCard(card);
            else { closeSourceCardPicker(); loadSourceCard(card.name, card); }
        });
        fragment.appendChild(button);
    });
    sourceCardPickerResults.appendChild(fragment);
}

function openSourceCardPicker() {
    if (!sourceCardPickerModal) return;
    sourceCardPickerModal.classList.remove('hidden');
    if (sourceCardPickerInput) {
        sourceCardPickerInput.value = '';
        sourceCardPickerInput.focus();
    }
    const history = getSourceCardPickerMatches();
    if (sourceCardPickerStatus) sourceCardPickerStatus.textContent = history.length ? 'Recent cards' : 'Start typing to search Scryfall.';
    renderSourceCardPickerCards(history, 'No recent cards yet. Start typing to search.');
}

async function searchSourceCardPicker(query) {
    const requestId = ++sourceCardPickerRequestId;
    const q = String(query || '').trim();
    if (!q) {
        const history = getSourceCardPickerMatches();
        if (sourceCardPickerStatus) sourceCardPickerStatus.textContent = history.length ? 'Recent cards' : 'Start typing to search Scryfall.';
        renderSourceCardPickerCards(history, 'No recent cards yet. Start typing to search.');
        return;
    }
    if (q.length < 2) {
        if (sourceCardPickerStatus) sourceCardPickerStatus.textContent = 'Type at least 2 characters…';
        renderSourceCardPickerCards([], 'Keep typing to search cards.');
        return;
    }

    if (sourceCardPickerStatus) sourceCardPickerStatus.textContent = `Searching for “${q}”…`;
    renderSourceCardPickerCards([], 'Searching…');
    try {
        const response = await scryfallThrottledFetch(
            `https://api.scryfall.com/cards/search?unique=cards&order=name&q=${encodeURIComponent(q)}`,
            { headers: { 'User-Agent': 'ManaMatch/1.0 (Semantic Magic Search)', 'Accept': 'application/json' } }
        );
        if (requestId !== sourceCardPickerRequestId) return;
        if (response.status === 404) {
            if (sourceCardPickerStatus) sourceCardPickerStatus.textContent = 'No matching cards';
            renderSourceCardPickerCards([], 'No matching cards.');
            return;
        }
        if (!response.ok) throw new Error('Card search is temporarily unavailable.');
        const payload = await response.json();
        const cards = Array.isArray(payload.data) ? payload.data : [];
        cards.forEach(card => { if (card?.name) sourceCardCache.set(card.name.toLowerCase(), card); });
        if (sourceCardPickerStatus) sourceCardPickerStatus.textContent = `${cards.length} result${cards.length === 1 ? '' : 's'}`;
        renderSourceCardPickerCards(cards, 'No matching cards.');
    } catch (error) {
        if (requestId !== sourceCardPickerRequestId) return;
        if (sourceCardPickerStatus) sourceCardPickerStatus.textContent = 'Search unavailable';
        renderSourceCardPickerCards([], error.message || 'Unable to search cards right now.');
    }
}

function setupSourceCardPicker() {
    sourceCardAddBtn = document.getElementById('source-card-add-btn');
    sourceCardEmpty = document.getElementById('source-card-empty');
    sourceCardLoaded = document.getElementById('source-card-loaded');
    sourceCardPickerModal = document.getElementById('source-card-picker-modal');
    sourceCardPickerInput = document.getElementById('source-card-picker-input');
    sourceCardPickerResults = document.getElementById('source-card-picker-results');
    sourceCardPickerStatus = document.getElementById('source-card-picker-status');
    closeSourceCardPickerBtn = document.getElementById('close-source-card-picker');

    sourceCardAddBtn?.addEventListener('click', openSourceCardPicker);
    document.getElementById('add-source-card-btn')?.addEventListener('click', openSourceCardPicker);
    closeSourceCardPickerBtn?.addEventListener('click', closeSourceCardPicker);
    sourceCardPickerModal?.addEventListener('click', event => {
        if (event.target === sourceCardPickerModal) closeSourceCardPicker();
    });
    sourceCardPickerInput?.addEventListener('input', () => {
        if (sourceCardPickerDebounce) clearTimeout(sourceCardPickerDebounce);
        const query = sourceCardPickerInput.value;
        sourceCardPickerDebounce = setTimeout(() => searchSourceCardPicker(query), 280);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && sourceCardPickerModal && !sourceCardPickerModal.classList.contains('hidden')) closeSourceCardPicker();
    });
}

function clearSourceCard() {
    ++searchRequestId;
    ++sourceCardPickerRequestId;
    currentSourceCard = null;
    sourceCards.clear();
    primarySourceCardKey = null;
    renderAdditionalSourceCards();
    updateSourceCardMultiSearchState();
    lastSearchResults = [];
    lastSearchCandidateCount = null;
    manualHighlights = [];
    highlightComposerOpen = false;
    selectedRelatedCards.clear();
    lastSearchDiagnostics = null;
    pendingDeeperSearch = null;
    activeTags = [];
    sourceCardOracle?.replaceChildren();
    if (sourceCardOracle) {
        sourceCardOracle.removeAttribute('data-original-text');
        sourceCardOracle.removeAttribute('data-original-html');
    }
    sourceCardEmpty?.classList.remove('hidden');
    sourceCardLoaded?.classList.add('hidden');
    sourceCardSection?.classList.remove('hidden');
    if (findSimilarBtn) findSimilarBtn.disabled = true;
    if (resultsSection) resultsSection.classList.add('hidden');
    if (resultsGrid) resultsGrid.innerHTML = '';
    if (cardSearchInput) cardSearchInput.value = '';
    updateRelatedBar();
    renderHighlightChips();
    renderTags();
    checkFavoriteStatus('');
    const removeBtn = document.getElementById('discard-source-card-btn');
    if (removeBtn) removeBtn.disabled = true;
}

// --- CORE SEARCH LOGIC ---
async function loadSourceCard(query, providedCard = null) {
    if (!query) return;

    ++relatedSearchRequestId;
    const requestId = ++searchRequestId;

    showLoading(true);
    resultsSection.classList.add('hidden');
    
    // Reset state to avoid leaking previous search results, highlights, or selected related cards.
    // These belong to the previous source-card context and must never participate in the new one.
    lastSearchResults = [];
    selectedRelatedCards.clear();
    manualHighlights = [];
    // Diagnostics belong to a specific search - clear them alongside the results so a later
    // benchmark or debug read can't pick up instrumentation from a previous, unrelated search.
    lastSearchDiagnostics = null;
    pendingDeeperSearch = null;
    updateRelatedBar();
    resultsGrid.innerHTML = '';
    cardSearchInput.value = query;

    try {
        const cacheKey = query.trim().toLowerCase();
        let cardData = providedCard || null;
        if (cardData) {
            // Picker/history entries can be lightweight or stale local previews. Merge them with
            // the session cache first so a preview can never hide a complete Oracle-text record.
            cardData = mergeCardRecords(cardData, sourceCardCache.get(cacheKey) || null);
        }
        if (!cardData) cardData = benchmarkColdMode ? (benchmarkSourceCardCatalog.get(cacheKey) || null) : null;
        if (!cardData) cardData = sourceCardCache.get(cacheKey) || null;

        // Old history/picker entries may have been saved before full Oracle text was retained.
        // Hydrate those records through Scryfall before displaying the source card. This is also
        // what repairs any existing broken history entries rather than requiring the user to
        // delete and recreate their history.
        if (cardData && !hasUsableOracleText(cardData) && !benchmarkColdMode) {
            try {
                const response = await scryfallThrottledFetch(
                    `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(cardData.name || query)}`,
                    {
                        headers: {
                            'User-Agent': 'ManaMatch/1.0 (Semantic Magic Search)',
                            'Accept': 'application/json'
                        }
                    }
                );
                if (requestId !== searchRequestId) return;
                if (response.ok) {
                    const fullCard = await response.json();
                    cardData = mergeCardRecords(cardData, fullCard);
                    sourceCardCache.set(cacheKey, cardData);
                }
            } catch (hydrateError) {
                // Fall through to the existing record; a transient hydration failure should not
                // prevent an otherwise usable cached card from loading.
                console.warn('Could not hydrate Oracle text for source card:', hydrateError.message);
            }
        }

        if (!cardData) {
            const response = await scryfallThrottledFetch(
                `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(query)}`,
                {
                    headers: {
                        'User-Agent': 'ManaMatch/1.0 (Semantic Magic Search)',
                        'Accept': 'application/json'
                    }
                }
            );

            if (requestId !== searchRequestId) return;
            if (response.status === 429) {
                const rateLimitError = new Error('Scryfall is temporarily rate-limiting requests. The app has paused API traffic and will resume queued work automatically.');
                rateLimitError.status = 429;
                throw rateLimitError;
            }
            if (!response.ok) throw new Error('Card not found.');

            cardData = await response.json();
            sourceCardCache.set(cacheKey, cardData);
            if (benchmarkColdMode) benchmarkSourceCardCatalog.set(cacheKey, cardData);
        }

        // A newer search started while this fetch was in flight - drop these results
        // so a slow lookup for an earlier query can't overwrite the current card.
        if (requestId !== searchRequestId) return;

        currentSourceCard = cardData;
        sourceCards.clear();
        primarySourceCardKey = getSourceCardIdentity(cardData);
        if (primarySourceCardKey) sourceCards.set(primarySourceCardKey, cardData);
        sourceCardCache.set(cacheKey, cardData);
        
        displaySourceCard(cardData);
        renderAdditionalSourceCards();
        updateSourceCardMultiSearchState();
        activeTags = generateTags(cardData);
        renderTags();
        addToHistory(cardData.name, cardData);
        checkFavoriteStatus(cardData.name);
        const removeBtn = document.getElementById('discard-source-card-btn');
        if (removeBtn) removeBtn.disabled = false;
    } catch (error) {
        activeSearchStreamProgressReporter = null;
        if (requestId !== searchRequestId) return;
        if (benchmarkColdMode && isScryfallRateLimitError(error)) {
            // A benchmark-wide Scryfall circuit is a suite stop condition, not a browser alert.
            throw error;
        }
        currentSourceCard = null;
        activeTags = [];
        manualHighlights = [];
        highlightComposerOpen = false;
        selectedRelatedCards.clear();
        alert(error.message);
        sourceCardSection.classList.remove('hidden');
        sourceCardLoaded?.classList.add('hidden');
        sourceCardEmpty?.classList.remove('hidden');
        findSimilarBtn.disabled = true;
    } finally {
        if (requestId === searchRequestId) showLoading(false);
    }
}

function displaySourceCard(card) {
    document.getElementById('source-card-name').textContent = card.name;
    document.getElementById('source-card-mana').textContent = card.mana_cost || 'None';
    document.getElementById('source-card-type').textContent = card.type_line;
    
    // Keep the displayed Oracle text in exactly the same coordinate space used by the scoring
    // layer. Face names are metadata, not Oracle text; including them here shifted highlight
    // offsets for transform/double-faced cards.
    const oracleText = getCurrentSourceOracleText(card) || 'No rules text.';
    sourceCardOracle.textContent = oracleText;
    sourceCardOracle.dataset.originalText = oracleText;
    // Retain the legacy field for compatibility with any external code, but do not use it for
    // highlight offsets because HTML entity lengths differ from text-node lengths.
    sourceCardOracle.dataset.originalHtml = sourceCardOracle.innerHTML;
    manualHighlights = [];
    renderHighlightChips();
    
    const imageUrl = getCardImageUrl(card);
    const sourceImage = document.getElementById('source-card-image');
    if (sourceImage) { sourceImage.src = imageUrl; sourceImage.style.display = imageUrl ? 'block' : 'none'; }

    sourceCardEmpty?.classList.add('hidden');
    sourceCardLoaded?.classList.remove('hidden');
    sourceCardSection.classList.remove('hidden');
    findSimilarBtn.disabled = false;
}

// 1. Batch NLP embedding calculations and chunk thread yields
// NOTE: takes a single options object (not positional args) specifically to prevent
// the class of argument-order bug that previously broke related-card search scoring.
async function scoreCardBatch({
    cards,
    sourceCard,
    targetText,
    // Optional parsed-effect override/reference set used by multi-card related search. The
    // normal similarity search leaves these empty and therefore keeps its existing source-card
    // parsing path unchanged. Related search, however, is asking "what matches these selected
    // cards?" rather than only "what matches the original source card?"; giving the scorer the
    // selected cards' parsed effects prevents a shared-pattern search from producing a false
    // 0% mechanical score simply because the original source has additional unrelated effects.
    sourceParsedEffectsOverride = null,
    sourceReferenceParsedEffects = [],
    // Text to check for literal presence on a candidate (the exactness/fuzzy channel), as
    // opposed to targetText which also drives mechanical/semantic parsing. Defaults to targetText
    // for callers that don't distinguish (related-card search, searchDeeper) - only the main
    // findSimilarCards path, which knows about per-highlight exact/variable modes, passes a
    // narrower value here (see the multi-highlight feature: 'variable' highlights should inform
    // parsing but never force a literal-text requirement).
    exactnessText = targetText,
    targetVector,
    targetVectors = null,
    sourceFunctionVector: suppliedSourceFunctionVector = null,
    isCancelled = null,
    extractor,
    weights = {},
    tags = [],
    topNNames = new Set(),
    sniperIds = new Set(),
    activeFilters = {}
}) {
    const rawWM = weights.mechanical ?? 45;
    const rawWS = weights.synergy ?? 10;
    const rawWC = weights.context ?? 20;
    const rawWE = weights.exactness ?? 15;
    const rawWCa = weights.category ?? 10;
    const hasHighlight = Boolean(manualHighlights && manualHighlights.length > 0);

    // Strategic role is a NEW ranking dimension, but it is deliberately carved out of the existing
    // 100-point budget instead of being added on top. That keeps a role match from making every
    // candidate look better merely because another score was added. Existing user-controlled
    // weights are proportionally scaled to leave a fixed 14-point role budget (12 with highlights).
    const roleWeight = hasHighlight ? 12 : 14;
    const rawExistingWeightTotal = Math.max(1, rawWM + rawWS + rawWC + rawWE + rawWCa);
    const existingWeightScale = (100 - roleWeight) / rawExistingWeightTotal;
    const wM = rawWM * existingWeightScale;
    const wS = rawWS * existingWeightScale;
    const wC = rawWC * existingWeightScale;
    const wE = rawWE * existingWeightScale;
    const wCa = rawWCa * existingWeightScale;
    const wH = hasHighlight ? Math.min(roleWeight, Math.max(0, wM * 0.20)) : 0;
    const totalWeight = 100;

    // Highlight intent is an explicit user constraint, so its weight is carved out of the
    // mechanical budget rather than silently inflating the total score.
    const effectiveHighlightWeight = Math.min(wH, wM);
    const effectiveMechanicalBase = wM - effectiveHighlightWeight;
    const highlightProfiles = hasHighlight ? buildHighlightIntentProfiles(manualHighlights) : [];

    const sourceText = sourceCard.oracle_text || (sourceCard.card_faces ? sourceCard.card_faces.map(f => f.oracle_text).join(' ') : '');
    const sourceTextToParse = (hasHighlight && targetText) ? targetText : sourceText;
    const parsedSourceCard = Array.isArray(sourceParsedEffectsOverride) && sourceParsedEffectsOverride.length > 0
        ? sourceParsedEffectsOverride
        : (sourceTextToParse === (sourceCard.oracle_text || (sourceCard.card_faces ? sourceCard.card_faces.map(f => f.oracle_text).join(' ') : ''))
            ? getCachedParsedEffects(sourceCard, sourceTextToParse)
            : parseMTGEffect(sourceTextToParse));
    const sourceMechanicProfile = getCachedMechanicalProfile(sourceCard, sourceTextToParse, parsedSourceCard);
    const sourceMechanicalGraph = getCachedMechanicalEffectGraph(sourceCard, sourceTextToParse, parsedSourceCard);
    parsedSourceCard._mechanicProfile = sourceMechanicProfile;
    parsedSourceCard._mechanicalGraph = sourceMechanicalGraph;
    const referenceEffectSets = [parsedSourceCard, ...(Array.isArray(sourceReferenceParsedEffects) ? sourceReferenceParsedEffects : [])]
        .filter(effects => Array.isArray(effects) && effects.length > 0);
    const referenceMechanicProfiles = referenceEffectSets.map((effects, idx) =>
        effects?._mechanicProfile || (idx === 0 ? sourceMechanicProfile : buildUniversalMechanicProfile(null, '', effects))
    );
    // How much of the source card's text did the rule-based parser actually turn into a
    // recognized action (vs. falling back to "generic")? A card whose text mostly comes back
    // generic gives an unreliable mechanicalScore, so that score shouldn't get full authority
    // in the final ranking (project spec ranking A: confidence-aware mechanical weighting).
    const sourceParseConfidence = calculateParseConfidence(parsedSourceCard);
    const sourceRoleProfile = inferStrategicRoleProfile(sourceCard, parsedSourceCard, targetText);
    const sourceRoleText = strategicRoleToText(sourceRoleProfile);
    const sourceRoleFingerprint = buildStrategicRoleFingerprint(sourceCard, parsedSourceCard, sourceRoleProfile);
    const rankingIntent = inferRankingIntent(sourceCard, parsedSourceCard, targetText, sourceRoleProfile, manualHighlights);
    sourceCard._strategicRoleFingerprint = sourceRoleFingerprint;
    sourceCard._rankingIntent = rankingIntent;
    // Field-level confidence gives a far better read on whether the structural parse is actually
    // trustworthy than "what fraction of clauses had some action" (review Priority 9).
    const sourceFieldConfidence = calculateCardFieldConfidence(parsedSourceCard);
    const sourceDifficulty = calculateSourceDifficulty(sourceCard, parsedSourceCard, sourceParseConfidence);

    // Tallies how the embedding cache performed for this batch: how many lookups were already
    // cached, how many required an actual model call, and how many of those calls failed and
    // silently fell back to lexical-only scoring for that card. Everywhere else in this file is
    // careful to surface why a result looks the way it does; a per-card embedding failure used to
    // vanish into a `null` with nothing recording that it happened (review: embedding diagnostics).
    const embeddingDiagnostics = { cacheHits: 0, computed: 0, failed: 0, skippedForBudget: 0 };

    // Functional embedding target: the source card's canonical function rendered as normalized
    // text. Embedding THIS instead of only raw Oracle wording means the model compares MTG
    // meaning rather than being asked to infer mechanics from arbitrary phrasing - which is the
    // whole point when the alternative card is worded completely differently (review Priority 8).
    const sourceFunctionText = canonicalFunctionToText(getCanonicalFunctions(parsedSourceCard)) ||
        buildUniversalFunctionalText(sourceCard, sourceTextToParse, parsedSourceCard);
    let sourceFunctionVector = suppliedSourceFunctionVector;
    if (!sourceFunctionVector && extractor && extractor.type !== 'fallback' && sourceFunctionText) {
        sourceFunctionVector = await getCachedEmbedding(sourceFunctionText, extractor, embeddingDiagnostics);
    }
    throwIfSearchCancelled(isCancelled);

    // Build all reference graphs once per scoring batch. Related-card search can supply multiple
    // references; computing the consensus inside the per-candidate loop would repeat the same
    // clustering work hundreds of times and make the search slower without adding evidence.
    const referenceMechanicalGraphs = referenceEffectSets.map((effects, idx) =>
        effects?._mechanicalGraph || (idx === 0 ? sourceMechanicalGraph : buildMechanicalEffectGraph(null, '', effects))
    );
    const consensusMechanicalGraph = referenceMechanicalGraphs.length > 1
        ? buildMechanicalConsensusGraph(referenceMechanicalGraphs)
        : null;

    for (let i = 0; i < cards.length; i++) {
        throwIfSearchCancelled(isCancelled);
        const card = cards[i];
        const cardText = card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text).join(' ') : '');

        // Pass activeFilters to prevent duplicate scoring of hard-filtered fields
        card.synergyScore = calculateSynergyScore(sourceCard, card, activeFilters);

        // Exactness Score & Mechanical Similarity calculations remain independent
        card.exactnessScore = calculateCombinedFuzzyScore(sourceCard, card, exactnessText);
        const parsedCandidateCard = getCachedParsedEffects(card, cardText);
        const candidateMechanicProfile = getCachedMechanicalProfile(card, cardText, parsedCandidateCard);
        parsedCandidateCard._mechanicProfile = candidateMechanicProfile;
        const candidateMechanicalGraph = getCachedMechanicalEffectGraph(card, cardText, parsedCandidateCard);
        parsedCandidateCard._mechanicalGraph = candidateMechanicalGraph;

        // Related-card search can have several legitimate mechanical reference cards. Score the
        // candidate against each reference and keep the strongest coherent mechanical match. This
        // is intentionally a MAX across references, not an average: a related-card result only
        // needs to share a meaningful mechanic with one of the selected cards, and averaging in
        // unrelated abilities from the other selections would recreate the false-low/0% problem
        // this path is meant to avoid. The ordinary one-card search has a single reference and is
        // therefore numerically unchanged.
        let bestMechanical = null;
        for (let referenceIndex = 0; referenceIndex < referenceEffectSets.length; referenceIndex++) {
            const referenceEffects = referenceEffectSets[referenceIndex];
            const mechanicalDetail = calculateMechanicalSimilarityDetailed(
                referenceEffects,
                parsedCandidateCard,
                referenceMechanicProfiles[referenceIndex],
                candidateMechanicProfile
            );
            const mechanical = mechanicalDetail.score;
            const referenceGraph = referenceMechanicalGraphs[referenceIndex] || buildMechanicalEffectGraph(null, '', referenceEffects);
            const graphDetail = calculateMechanicalGraphSimilarity(referenceGraph, candidateMechanicalGraph);
            const graphAwareMechanical = Math.max(mechanical, graphDetail.score);
            const coverage = calculateEffectCoverageProfile(referenceEffects, parsedCandidateCard);
            const functional = calculateFunctionalSimilarity(referenceEffects, parsedCandidateCard);
            const quantity = calculateAggregateQuantitySimilarity(referenceEffects, parsedCandidateCard, coverage);
            if (!bestMechanical || graphAwareMechanical > bestMechanical.mechanical ||
                (graphAwareMechanical === bestMechanical.mechanical && functional > bestMechanical.functional)) {
                bestMechanical = { mechanical: graphAwareMechanical, coverage, functional, quantity, referenceEffects, mechanicalDetail, graphDetail };
            }
        }

        if (consensusMechanicalGraph) {
            const consensusDetail = calculateMechanicalGraphSimilarity(consensusMechanicalGraph, candidateMechanicalGraph);
            if (!bestMechanical || consensusDetail.score > bestMechanical.mechanical) {
                const consensusCoverage = calculateEffectCoverageProfile(
                    referenceEffectSets[0] || parsedSourceCard,
                    parsedCandidateCard
                );
                bestMechanical = {
                    mechanical: consensusDetail.score,
                    coverage: consensusCoverage,
                    functional: calculateFunctionalSimilarity(referenceEffectSets[0] || parsedSourceCard, parsedCandidateCard),
                    quantity: calculateAggregateQuantitySimilarity(referenceEffectSets[0] || parsedSourceCard, parsedCandidateCard, consensusCoverage),
                    referenceEffects: referenceEffectSets[0] || parsedSourceCard,
                    mechanicalDetail: {
                        score: consensusDetail.score,
                        structuralScore: bestMechanical?.mechanicalDetail?.structuralScore || 0,
                        graphScore: consensusDetail.score,
                        graphFeatureVector: consensusDetail.featureVector,
                        graphEvidence: [...(consensusDetail.evidence || []), 'consensus across related cards'],
                        universalScore: candidateMechanicProfile ? calculateUniversalMechanicSimilarity((consensusMechanicalGraph.universalProfile || sourceMechanicProfile), candidateMechanicProfile).score : 0,
                        universal: candidateMechanicProfile ? calculateUniversalMechanicSimilarity((consensusMechanicalGraph.universalProfile || sourceMechanicProfile), candidateMechanicProfile) : null
                    },
                    graphDetail: consensusDetail,
                    consensus: true
                };
            }
        }

        bestMechanical = bestMechanical || {
            mechanical: 0,
            coverage: { sourceCoverage: 0, balancedCoverage: 0, primaryMatch: 0, matches: [] },
            functional: 0,
            quantity: 0,
            referenceEffects: parsedSourceCard,
            mechanicalDetail: calculateMechanicalSimilarityDetailed(parsedSourceCard, parsedCandidateCard, sourceMechanicProfile, candidateMechanicProfile),
            graphDetail: calculateMechanicalGraphSimilarity(sourceMechanicalGraph, candidateMechanicalGraph)
        };

        card.mechanicalScore = bestMechanical.mechanical;
        card.mechanicalEvidence = {
            universal: bestMechanical.mechanicalDetail?.universal || null,
            graph: bestMechanical.mechanicalDetail?.graphFeatureVector || bestMechanical.graphDetail?.featureVector || null,
            evidence: bestMechanical.mechanicalDetail?.graphEvidence || bestMechanical.graphDetail?.evidence || [],
            consensus: Boolean(bestMechanical.consensus),
            referenceName: bestMechanical.referenceEffects === parsedSourceCard ? sourceCard?.name || '' : ''
        };
        card.mechanicalBreakdown = bestMechanical.mechanicalDetail || null;
        card.effectCoverageProfile = bestMechanical.coverage;
        card.effectCoverageScore = card.effectCoverageProfile.sourceCoverage;
        card.balancedEffectCoverage = card.effectCoverageProfile.balancedCoverage;
        card.primaryEffectMatchScore = card.effectCoverageProfile.primaryMatch;
        card.functionalSimilarityScore = bestMechanical.functional;
        card.quantitySimilarityScore = bestMechanical.quantity;
        card._mechanicalReferenceEffects = bestMechanical.referenceEffects;
        card.roleProfile = inferStrategicRoleProfile(card, parsedCandidateCard, targetText);
        card._strategicRoleFingerprint = buildStrategicRoleFingerprint(card, parsedCandidateCard, card.roleProfile);
        card.roleScore = calculateStrategicRoleScore(sourceRoleProfile, card.roleProfile, sourceRoleFingerprint, card._strategicRoleFingerprint);
        card.highlightIntentScore = hasHighlight
            ? calculateHighlightIntentMatch(highlightProfiles, parsedCandidateCard, card)
            : 0;
        card._parsedEffects = parsedCandidateCard;
        card.fieldConfidence = calculateCardFieldConfidence(parsedCandidateCard);
        card.parseConfidence = calculateParseConfidence(parsedCandidateCard);
        const candidateStructuralConfidence = Math.max(0, Math.min(1,
            ((card.fieldConfidence?.overall || 0) * 0.70) + ((card.parseConfidence || 0) * 0.30)
        ));
        const sourceStructuralConfidence = Math.max(0, Math.min(1,
            ((sourceFieldConfidence?.overall || 0) * 0.70) + ((sourceParseConfidence || 0) * 0.30)
        ));
        card.mechanicalConfidence = Math.max(0, Math.min(1,
            Math.sqrt(Math.max(0.001, sourceStructuralConfidence) * Math.max(0.001, candidateStructuralConfidence))
        ));

        if (sniperIds?.has(card.id) && exactnessText) {
            const nameScore = calculateFuzzySimilarity(sourceCard.name, card.name);
            const textScore = calculateFuzzyTextMatch(exactnessText, cardText);
            card.exactnessScore = Math.min(1.0, Math.max(card.exactnessScore, ((nameScore * 0.05) + (textScore * 0.95)) + 0.40));
        }

        card.categoryScore = calculateCategoryScore(card, tags, sourceCard, parsedSourceCard);

        if (i % 50 === 0) {
            await backgroundAwareDelay(0);
        }
    }

    if (embeddingCache.size >= 8) calibrateSemanticCosineFromCache();
    const oracleTargetVector = targetVectors?.oracle || targetVector || null;
    const semanticRetrievalTargetVector = targetVectors?.semanticRetrieval || oracleTargetVector;
    const hasSemanticEngine = Boolean(extractor && extractor.type !== 'fallback' && oracleTargetVector);

    // The loop above gives every candidate a mechanical/exactness/category/synergy score using
    // pure JS - cheap regardless of how many candidates there are. The embedding step below is
    // NOT cheap: it's 1-2 real ML inference calls per candidate. Retrieval is deliberately allowed
    // to bring back thousands of candidates for a broad/generic source card (coverage-guaranteed
    // retrieval depth, project spec E) - that's the right call for not missing the right answer.
    // But spending full embedding cost on every one of those thousands isn't: measured at 60-90+
    // seconds of scoring time alone on cards like Sol Ring or Phyrexian Arena, dwarfing every
    // other phase, for a benefit that's almost entirely wasted at the bottom of the pool - a
    // candidate with a near-zero mechanical AND exactness score is vanishingly unlikely to become
    // a top result no matter what its embedding says. Only the most promising candidates by cheap
    // signals get the expensive treatment; everyone else still gets a real contextScore, just a
    // lexical one instead of an ML one - the exact same graceful fallback this code already uses
    // when the model fails to load at all, not a new code path.
    // Confidence-aware budget and proxy (review: rank system item 1). sourceFieldConfidence and
    // sourceParseConfidence are already computed above for the per-card weight-shifting further
    // down - reused here so the eligibility cut and the final blend agree on how much to trust
    // this source card's structural parse, instead of the cut using mechanicalScore at full
    // authority while the blend right after it treats that same score as unreliable.
    const sourceConfidence = (sourceFieldConfidence.overall * 0.7) + (sourceParseConfidence * 0.3);
    // Scales from 250 (confident parse) up to 450 (source parsed as fully generic): a shakier
    // mechanical signal means more candidates deserve a real semantic look rather than being cut
    // on a proxy that leans on that same shaky signal. Capped at 450 to keep the worst case
    // bounded - this is a deliberate trade of some extra scoring time on hard-to-parse source
    // cards specifically, not a general increase.
    const MAX_SEMANTIC_SCORING_CANDIDATES = Math.round(320 + (1 - sourceConfidence) * 280);
    const MIN_SEMANTIC_SCORING_CANDIDATES = Math.min(128, cards.length);

    // Cheap pre-embedding relevance triage. This is intentionally stricter than the final display
    // floor because its job is computational budgeting: only candidates with concrete evidence
    // get the expensive semantic/function embedding pass. It is NOT allowed to eliminate every
    // weakly-worded semantic candidate, so retrieval agreement and Search F evidence provide a
    // controlled secondary path into the expensive pass.
    const cheapTriageScore = (c) => {
        const retrievalCount = Math.min(4, c.retrievalEvidence?.length || 0);
        const retrievalAgreement = retrievalCount / 4;
        const searchFAgreement = c.retrievalEvidence?.includes('Search F') ? 1 : 0;
        return (c.mechanicalScore || 0) * 0.52
            + (c.exactnessScore || 0) * 0.20
            + (c.categoryScore || 0) * 0.08
            + retrievalAgreement * 0.10
            + searchFAgreement * 0.10;
    };

    const scoredByCheapEvidence = cards
        .map(card => ({ card, triage: cheapTriageScore(card) }))
        .sort((a, b) => b.triage - a.triage);

    let semanticEligible = cards;
    const triageDetails = cards.map(card => {
        const retrievalCount = Math.min(4, card.retrievalEvidence?.length || 0);
        const retrievalAgreement = retrievalCount / 4;
        const searchFAgreement = card.retrievalEvidence?.includes('Search F') ? 1 : 0;
        const mechanical = card.mechanicalScore || 0;
        const role = card.roleScore || 0;
        const exactness = card.exactnessScore || 0;
        const lexical = calculateSimpleSimilarity(targetText, strategicRoleCardText(card));
        const semanticRetrieval = card._semanticRetrievalSimilarity || (card.retrievalEvidence?.includes('Search G') ? 0.58 : 0);
        const triage = mechanical * 0.35 + role * 0.15 + exactness * 0.12 + lexical * 0.10 + retrievalAgreement * 0.04 + searchFAgreement * 0.04 + semanticRetrieval * 0.20;
        return { card, triage, mechanical, role, exactness, lexical, retrievalCount, searchFAgreement, semanticRetrieval };
    });

    if (cards.length > MIN_SEMANTIC_SCORING_CANDIDATES) {
        const budget = Math.min(MAX_SEMANTIC_SCORING_CANDIDATES, cards.length);
        // Multi-lane selection prevents a single cheap signal from monopolizing semantic budget.
        // Each lane is deliberately capped; empty/weak role lanes simply contribute nothing.
        const laneSizes = {
            mechanical: Math.max(28, Math.floor(budget * 0.30)),
            role: Math.max(18, Math.floor(budget * 0.15)),
            lexical: Math.max(14, Math.floor(budget * 0.10)),
            retrieval: Math.max(10, Math.floor(budget * 0.08)),
            semantic: Math.max(72, Math.floor(budget * 0.34)),
            exploratory: Math.max(22, Math.floor(budget * 0.10))
        };
        const by = (fn) => triageDetails.slice().sort((a, b) => fn(b) - fn(a));
        const lanes = [
            by(x => x.mechanical).slice(0, laneSizes.mechanical),
            by(x => x.role).filter(x => x.role >= 0.55).slice(0, laneSizes.role),
            by(x => x.lexical).slice(0, laneSizes.lexical),
            by(x => (x.retrievalCount * 0.12) + (x.searchFAgreement * 0.16) + (x.mechanical * 0.22) + (x.role * 0.20) + (x.lexical * 0.30)).slice(0, laneSizes.retrieval),
            // Semantic lane: cards already surfaced by meaning-only Search G are protected even
            // when mechanical/lexical evidence is weak. This is the in-session equivalent of a
            // semantic nearest-neighbor retrieval stream and prevents the cheap triage lanes from
            // completely starving differently-worded candidates.
            by(x => (x.card._semanticRetrievalSimilarity || 0) + (x.role * 0.03) + (x.mechanical * 0.02)).slice(0, laneSizes.semantic),
            // Exploration lane: favor cards that are structurally plausible but not already owned
            // by the strongest lanes. This is the safety valve for semantic-analogy discoveries.
            by(x => Math.max(x.role * 0.8, x.lexical * 0.6, x.retrievalCount / 4) + (x.mechanical < 0.35 ? 0.12 : 0)).slice(0, laneSizes.exploratory)
        ];

        const merged = [];
        const seen = new Set();
        for (const lane of lanes) {
            for (const item of lane) {
                if (seen.has(item.card)) continue;
                seen.add(item.card);
                merged.push(item.card);
                if (merged.length >= budget) break;
            }
            if (merged.length >= budget) break;
        }

        // Full-pool semantic retrieval is a first-class retrieval lane, not a weak rerank hint.
        // Protect every semantic-index hit with a real similarity value before the fallback fill.
        const protectedSemanticHits = triageDetails
            .filter(x => Number.isFinite(x.card._semanticRetrievalSimilarity))
            .sort((a,b) => (b.card._semanticRetrievalSimilarity || 0) - (a.card._semanticRetrievalSimilarity || 0));
        for (const item of protectedSemanticHits) {
            if (merged.length >= budget) break;
            if (seen.has(item.card)) continue;
            seen.add(item.card);
            merged.push(item.card);
        }

        // Strong evidence still gets protected if the lane union under-fills the budget.
        const fallback = triageDetails.slice().sort((a, b) => b.triage - a.triage);
        for (const item of fallback) {
            if (merged.length >= budget) break;
            if (seen.has(item.card)) continue;
            if (item.triage < 0.22 && item.role < 0.55 && item.mechanical < 0.30 && item.exactness < 0.40 && item.retrievalCount < 2) continue;
            seen.add(item.card);
            merged.push(item.card);
        }

        semanticEligible = merged.slice(0, budget);
        embeddingDiagnostics.skippedForBudget = cards.length - semanticEligible.length;
    }
    const semanticEligibleSet = new Set(semanticEligible);

    // Pre-resolve every embedding this batch will need, in small concurrent chunks, before
    // scoring a single card. Previously each candidate's oracle-text embedding and function-text
    // embedding were awaited one at a time inside this very loop - up to two full model calls per
    // card, strictly serialized, with no reuse even when two candidates in the same batch (or the
    // same candidate across an earlier search) needed the identical text embedded again. Warming
    // the cache up front lets independent candidates' embedding calls overlap instead of queuing,
    // and means the scoring pass below never re-embeds text it has already seen this session
    // (review: parallel embedding batch / embedding cache).
    if (hasSemanticEngine || sourceFunctionVector) {
        const textsToEmbed = [];
        for (const card of semanticEligible) {
            if (card.contextScore !== undefined) continue;
            const cardText = card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text).join(' ') : '');
            if (hasSemanticEngine && cardText) textsToEmbed.push(normalizeOracleForEmbedding(cardText, card.name));
            if (sourceFunctionVector && card._parsedEffects) {
                const candidateFunctionText = canonicalFunctionToText(getCanonicalFunctions(card._parsedEffects));
                if (candidateFunctionText) textsToEmbed.push(candidateFunctionText);
            }
        }
        await warmEmbeddingCache(textsToEmbed, extractor, embeddingDiagnostics);
    }

    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const cardText = card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text || '').join(' ') : '');

        if (card.contextScore === undefined) {
            const lexicalScore = calculateSimpleSimilarity(targetText, cardText);

            // Use the loaded MiniLM embedding (when available) as the primary "does this card
            // mean something similar" signal, blended with cheap word-overlap. This is what lets
            // ManaSearch discover genuinely differently-worded alternatives (project spec 1.2 /
            // 2.7) instead of the transformer model being loaded but never actually consulted.
            // The cache was already warmed above, so this is a cache read, not a fresh model call.
            let semanticScore = null;
            if (hasSemanticEngine && cardText && semanticEligibleSet.has(card)) {
                const cardVector = await getCachedEmbedding(normalizeOracleForEmbedding(cardText, card.name), extractor, embeddingDiagnostics);
                if (cardVector) {
                    const semanticQueryVector = Number.isFinite(card._semanticRetrievalSimilarity)
                        ? semanticRetrievalTargetVector
                        : oracleTargetVector;
                    semanticScore = semanticQueryVector ? calibratedCosineSimilarity(semanticQueryVector, cardVector) : null;
                    if (semanticQueryVector && cardVector) card._rawOracleSemanticSimilarity = cosineSimilarity(semanticQueryVector, cardVector);
                }
            }

            // Second, FUNCTIONAL embedding: compare the two cards' canonical functions as
            // normalized text. Raw-Oracle similarity and functional similarity answer different
            // questions - two reanimation spells can read nothing alike, and two cards can share
            // lots of wording while doing different things - so both are kept and the functional
            // one is weighted higher (review Priority 8).
            let functionScore = null;
            if (sourceFunctionVector && card._parsedEffects && semanticEligibleSet.has(card)) {
                const candidateFunctionText = canonicalFunctionToText(getCanonicalFunctions(card._parsedEffects)) ||
                    buildUniversalFunctionalText(card, cardText, card._parsedEffects);
                if (candidateFunctionText) {
                    const fnVector = await getCachedEmbedding(candidateFunctionText, extractor, embeddingDiagnostics);
                    if (fnVector) {
                        functionScore = calibratedCosineSimilarity(sourceFunctionVector, fnVector);
                        card._rawFunctionSemanticSimilarity = cosineSimilarity(sourceFunctionVector, fnVector);
                    }
                }
            }

            card.oracleSemanticScore = semanticScore ?? 0;
            // Context is now the raw-text semantic channel only. Function semantics remain a
            // separate channel, and lexical similarity remains a supporting signal, preventing
            // the old context blend from being counted as independent evidence twice.
            card.contextScore = semanticScore !== null ? semanticScore : lexicalScore;
            card.functionScore = functionScore;
            if (card.oracleSemanticScore === undefined) card.oracleSemanticScore = 0;
        }

        // Embedding calls are async network/CPU work per-card now, so yield more often to keep
        // the UI responsive during a large candidate batch.
        if (i % 25 === 0) {
            throwIfSearchCancelled(isCancelled);
            await backgroundAwareDelay(0);
        }
    }

    const semanticCalibration = calibrateBatchSemanticScores(cards);

    // V20 ranking: collapse the model to three intentionally different channels.
    //   1) structural parse: explicit rules mechanics + earned fields only
    //   2) raw semantic: normalized Oracle text embedding
    //   3) function/role semantic: canonical-function embedding plus strategic role fingerprint
    // A small agreement bonus is allowed, but correlated retrieval provenance / color / legacy
    // blends no longer add extra score. This prevents the old ranker from paying multiple times for
    // the same parse and from turning retrieval or deck colors into hidden ranking priors.
    const channelWeights = {
        effect_match: { structural: 0.48, rawSemantic: 0.25, functionRole: 0.27 },
        hybrid_effect: { structural: 0.43, rawSemantic: 0.25, functionRole: 0.32 },
        strategic_role: { structural: 0.12, rawSemantic: 0.23, functionRole: 0.65 },
        highlighted_effect: { structural: 0.52, rawSemantic: 0.23, functionRole: 0.25 }
    };
    const profile = channelWeights[rankingIntent.kind] || channelWeights.effect_match;

    const hasMeaningful = v => Number.isFinite(v) && v > 0;
    const methodStructuralBias = activeSearchMethodFlags.alternate ? 0.92 : 1;
    const methodSemanticBias = activeSearchMethodFlags.role ? 0.92 : (activeSearchMethodFlags.synergy ? 0.96 : 1);
    const methodFunctionBias = activeSearchMethodFlags.functional ? 1.22 : 1;
    const userStructuralBias = Math.max(0.75, Math.min(1.35, (rawWM / 45) * methodStructuralBias));
    const userSemanticBias = Math.max(0.75, Math.min(1.35, (rawWC / 20) * methodSemanticBias));
    const userFunctionBias = Math.max(0.75, Math.min(1.35, ((rawWE + rawWCa) / 25) * methodFunctionBias));
    const rawChannels = [
        profile.structural * userStructuralBias,
        profile.rawSemantic * userSemanticBias,
        profile.functionRole * userFunctionBias
    ];
    const channelDenom = rawChannels.reduce((a,b) => a+b, 0) || 1;
    const structuralW = rawChannels[0] / channelDenom;
    const semanticW = rawChannels[1] / channelDenom;
    const functionRoleW = rawChannels[2] / channelDenom;

    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const cardText = card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text || '').join(' ') : '');
        // Reuse the parsed candidate profile created during the structural scoring pass. The old
        // locals were scoped to that earlier loop, which caused the final ranking pass to throw
        // before similarityScore was assigned.
        const candidateParsedEffects = Array.isArray(card._parsedEffects) ? card._parsedEffects : [];
        const candidateMechanicProfile = candidateParsedEffects?._mechanicProfile
            || buildUniversalMechanicProfile(card, cardText, candidateParsedEffects);
        if (candidateParsedEffects.length && !candidateParsedEffects._mechanicProfile) {
            candidateParsedEffects._mechanicProfile = candidateMechanicProfile;
        }
        const structural = Math.max(0, Math.min(1, card.mechanicalScore || 0));
        const mechanicalConfidence = Math.max(0, Math.min(1, card.mechanicalConfidence ?? 0.5));
        const structuralTrusted = structural * (0.70 + 0.30 * mechanicalConfidence);
        const rawSemantic = hasMeaningful(card.oracleSemanticScore) ? Math.max(0, Math.min(1, card.oracleSemanticScore)) : 0;
        const functionSemantic = hasMeaningful(card.functionScore) ? Math.max(0, Math.min(1, card.functionScore)) : 0;
        const universalMechanical = Number(card.mechanicalBreakdown?.universalScore) || Number(card.mechanicalEvidence?.universal?.score) || 0;
        const functionSemanticAugmented = Math.max(functionSemantic, universalMechanical * 0.72);
        const roleSemantic = Math.max(0, Math.min(1, card.roleScore || 0));

        // Role intent gets role dominance; ordinary effect search keeps function semantic dominant.
        const functionRole = rankingIntent.kind === 'strategic_role'
            ? Math.max(roleSemantic, functionSemanticAugmented)
            : Math.max(functionSemanticAugmented * 0.72 + roleSemantic * 0.28, roleSemantic * 0.70);

        const channelScore = (structuralTrusted * structuralW) + (rawSemantic * semanticW) + (functionRole * functionRoleW);

        // Agreement is only the convergence of the same three channels. It is capped hard so it
        // can never turn three weakly-related signals into a strong match by itself.
        const independent = [structural, rawSemantic, functionRole].filter(v => v > 0.01).sort((a,b) => b-a);
        const agreement = independent.length >= 2
            ? Math.sqrt(independent[0] * independent[1])
            : 0;
        const agreementBonus = Math.min(0.045, Math.max(0, agreement - 0.48) * 0.11);

        const effectCoverage = Math.max(0, Math.min(1, card.effectCoverageScore || 0));
        const balancedCoverage = Math.max(0, Math.min(1, card.balancedEffectCoverage || 0));
        const primaryEffectMatch = Math.max(0, Math.min(1, card.primaryEffectMatchScore || 0));
        const functionalSimilarity = Math.max(0, Math.min(1, card.functionalSimilarityScore || 0));
        const quantitySimilarity = Math.max(0, Math.min(1, card.quantitySimilarityScore || 0));

        // Ranking refinement: preserve the existing channel blend, then reward candidates that
        // cover the source's important effects and behave like genuine functional substitutes.
        // These are deliberately bounded so a candidate cannot leapfrog a much stronger mechanical
        // match merely because it has a similar number or role.
        const compoundCoverageBonus = Math.min(0.075, Math.max(0, effectCoverage - 0.55) * 0.17);
        const balancedCoverageBonus = Math.min(0.045, Math.max(0, balancedCoverage - 0.45) * 0.10);
        const primaryMatchBonus = Math.min(0.035, Math.max(0, primaryEffectMatch - 0.70) * 0.12);
        const functionalSubstituteBonus = Math.min(0.055, Math.max(0, functionalSimilarity - 0.55) * 0.12);
        const quantityBonus = Math.min(0.025, Math.max(0, quantitySimilarity - 0.55) * 0.06);

        const contradictionPenalty = calculateCanonicalContradictionPenalty(sourceCard, card);
        const directBest = rankingIntent.kind === 'strategic_role'
            ? Math.max(functionRole, rawSemantic)
            : Math.max(structuralTrusted, functionSemanticAugmented, rawSemantic, card.highlightIntentScore || 0);
        const evidenceThreshold = 0.24;
        const evidenceRatio = Math.min(1, directBest / evidenceThreshold);
        const evidenceGate = directBest >= evidenceThreshold
            ? 1
            : 0.14 + (0.86 * Math.pow(evidenceRatio, 1.05));

        card.evidenceAgreement = agreement;
        card.contradictionPenalty = contradictionPenalty;
        card.coreEvidenceScore = channelScore;
        card.supportingEvidenceScore = Math.max(roleSemantic, card.exactnessScore || 0, card.categoryScore || 0);
        card.relevanceEvidenceScore = Math.min(1,
            structuralTrusted * 0.44 + rawSemantic * 0.28 + functionRole * 0.28
        );
        card.rankingIntent = rankingIntent.kind;
        card.rankingIntentConfidence = rankingIntent.confidence;
        const universalMethodDetail = (activeSearchMethodFlags.target || activeSearchMethodFlags.alternate)
            ? calculateUniversalMechanicSimilarity(sourceMechanicProfile, candidateMechanicProfile)
            : null;
        const targetFocusSignal = universalMethodDetail
            ? Math.max(0, Math.min(1, universalMethodDetail.targetCoverage * 0.62 + universalMethodDetail.zoneCoverage * 0.18 + universalMethodDetail.scopeCoverage * 0.20))
            : 0;
        const roleFocusSignal = roleSemantic;
        const alternateSignal = universalMethodDetail
            ? Math.max(0, Math.min(1, universalMethodDetail.outcomeCoverage * 0.55 + universalMethodDetail.targetCoverage * 0.22 + universalMethodDetail.zoneCoverage * 0.13 + (1 - universalMethodDetail.functionCoverage) * 0.10))
            : 0;
        const synergySignal = Math.max(0, Math.min(1, (card.synergyScore || 0) * 0.65 + (card.categoryScore || 0) * 0.20 + roleSemantic * 0.15));
        const wordingSignal = Math.max(0, Math.min(1, (card.exactnessScore || 0) * 0.72 + calculateSimpleSimilarity(targetText, cardText) * 0.28));
        const methodBoost =
            (activeSearchMethodFlags.functional ? Math.min(0.055, Math.max(0, functionalSimilarity - 0.45) * 0.10) : 0) +
            (activeSearchMethodFlags.target ? Math.min(0.055, Math.max(0, targetFocusSignal - 0.45) * 0.11) : 0) +
            (activeSearchMethodFlags.role ? Math.min(0.060, Math.max(0, roleFocusSignal - 0.45) * 0.11) : 0) +
            (activeSearchMethodFlags.alternate ? Math.min(0.060, Math.max(0, alternateSignal - 0.45) * 0.12) : 0) +
            (activeSearchMethodFlags.synergy ? Math.min(0.050, Math.max(0, synergySignal - 0.42) * 0.10) : 0) +
            (activeSearchMethodFlags.wording ? Math.min(0.050, Math.max(0, wordingSignal - 0.50) * 0.10) : 0);
        card.methodSignals = { target: targetFocusSignal, role: roleFocusSignal, alternate: alternateSignal, synergy: synergySignal, wording: wordingSignal };

        const rankingRefinement = compoundCoverageBonus + balancedCoverageBonus + primaryMatchBonus
            + functionalSubstituteBonus + quantityBonus + methodBoost;

        card.rankingRefinementScore = rankingRefinement;
        card.rankingEvidence = { mechanical: structural, mechanicalTrusted: structuralTrusted, mechanicalConfidence, rawSemantic, functionSemantic: functionSemanticAugmented, roleSemantic, effectCoverage, balancedCoverage, primaryEffectMatch, evidenceAgreement: agreement, retrievalSimilarity: Number(card._semanticRetrievalSimilarity) || 0, rankingIntent: rankingIntent.kind, rankingIntentConfidence: rankingIntent.confidence };
        card.similarityScore = Math.max(0, Math.min(1,
            (channelScore + agreementBonus + rankingRefinement) * evidenceGate * contradictionPenalty
        ));

        if (i % 100 === 0) {
            throwIfSearchCancelled(isCancelled);
            await backgroundAwareDelay(0);
        }
    }

    return { embeddingDiagnostics, semanticCalibration };
}
async function executeRelatedCardSearch() {
    if (!currentSourceCard || selectedRelatedCards.size === 0) return;

    const requestId = ++relatedSearchRequestId;
    activeResultView = { mode: 'related', requestId };
    const sourceSearchRequestId = searchRequestId;
    const sourceCardAtStart = currentSourceCard;
    const selectedCardsAtStart = new Map(selectedRelatedCards);
    const isCurrentRelatedSearch = () =>
        requestId === relatedSearchRequestId &&
        sourceSearchRequestId === searchRequestId &&
        currentSourceCard === sourceCardAtStart;

    showLoading(true);
    // Keep the Results section visible while Related Search runs. Hiding the section made a
    // successful related search look like it had returned nothing during the retrieval/scoring
    // window. Replace only the grid contents with the same lightweight in-search state used by the
    // normal search; the final related results replace it when scoring finishes.
    if (resultsSection) resultsSection.classList.remove('hidden');
    if (resultsGrid) {
        resultsGrid.innerHTML = '';
        const relatedInitialState = document.createElement('div');
        relatedInitialState.className = 'search-initial-state';
        relatedInitialState.setAttribute('aria-live', 'polite');
        const relatedTitle = document.createElement('strong');
        relatedTitle.textContent = 'Finding related cards…';
        const relatedDetail = document.createElement('span');
        relatedDetail.textContent = 'Using the selected cards as shared and individual references.';
        relatedInitialState.append(relatedTitle, relatedDetail);
        resultsGrid.appendChild(relatedInitialState);
    }

    const allCardsInSet = [sourceCardAtStart, ...Array.from(selectedCardsAtStart.values())];
    const repeatingPatterns = extractRepeatingPatterns(allCardsInSet);

    updateProgress(1, 3, `Discovered ${repeatingPatterns.length} shared patterns across selected cards...`);

    const filters = readConstraintFilters();

    const filterParts = buildScryfallConstraintParts(filters);

    const relatedSearchQueries = buildRelatedSearchQueries(
        sourceCardAtStart,
        Array.from(selectedCardsAtStart.values()),
        repeatingPatterns,
        filterParts
    );

    try {
        // 1. RETRIEVAL
        // Try the efficient grouped query first.  If Scryfall rejects that syntax (or a future
        // pattern introduces a parser edge case), fall back to individually valid o:"phrase"
        // queries rather than surfacing "invalid Scryfall query" to the user.
        let results = [];
        let lastRelatedQueryError = null;
        // 404/no-match is handled as an ordinary empty result by fetchScryfallSearch.  We only
        // retry genuine 400 parser errors here; no-match queries should simply allow the next
        // related retrieval formulation to try.
        const queryAttempts = relatedSearchQueries;
        for (let qi = 0; qi < queryAttempts.length; qi++) {
            const attempt = queryAttempts[qi];
            const candidateQuery = typeof attempt === 'string' ? attempt : attempt?.query;
            const kind = typeof attempt === 'string' ? 'related' : (attempt?.kind || 'related');
            try {
                const attemptResults = await fetchScryfallSearch(
                    candidateQuery,
                    2,
                    `Related ${kind}`
                );
                if (attemptResults.length > 0) {
                    results.push(...attemptResults);
                }
                lastRelatedQueryError = null;
            } catch (error) {
                lastRelatedQueryError = error;
                // Only malformed-query errors are safe to retry with another formulation.
                // Network, rate-limit, and cancellation errors must propagate instead of being
                // hidden behind a misleading "invalid query" message.
                if (error?.status !== 400) throw error;
            }
            if (!isCurrentRelatedSearch()) return;
        }

        // The semantic index is a second, first-class Related Search retrieval lane. It is essential
        // when the selected cards have differently worded mechanics, and it also rescues cases where
        // Scryfall's phrase retrieval is too brittle. Each selected/reference card gets its own query
        // vector; a centroid vector then adds the "common concept" view required by multi-card Related
        // Search.
        const semanticIndex = await ensureFullSemanticIndex();
        const relatedExtractor = await getNLPModel();
        let semanticMatches = [];
        let relatedTargetVectors = [];
        if (semanticIndex && relatedExtractor?.type !== 'fallback' && isCurrentRelatedSearch()) {
            const referenceVectors = [];
            const vectorJobs = allCardsInSet.map(async referenceCard => {
                const oracleText = getCurrentSourceOracleText(referenceCard);
                if (!oracleText) return;
                const oracleVector = await getCachedEmbedding(normalizeOracleForEmbedding(oracleText, referenceCard.name), relatedExtractor);
                if (oracleVector) referenceVectors.push(oracleVector);
            });
            await Promise.all(vectorJobs);
            if (!isCurrentRelatedSearch()) return;

            if (referenceVectors.length) {
                relatedTargetVectors = referenceVectors;
                const dim = referenceVectors[0].length;
                const centroid = new Float32Array(dim);
                for (const vector of referenceVectors) {
                    for (let i = 0; i < dim; i++) centroid[i] += Number(vector[i]) || 0;
                }
                for (let i = 0; i < dim; i++) centroid[i] /= referenceVectors.length;
                relatedTargetVectors.push(centroid);

                const semanticQuerySets = await Promise.all(relatedTargetVectors.map((vector, index) =>
                    findFullSemanticMatches(
                        semanticIndex,
                        vector,
                        sourceCardAtStart.name,
                        index === relatedTargetVectors.length - 1 ? 72 : 48,
                        index === relatedTargetVectors.length - 1 ? 0.40 : 0.42
                    )
                ));

                const semanticByName = new Map();
                semanticQuerySets.forEach(set => (set || []).forEach(item => {
                    const key = normalizeCardNameForIdentity(item.name);
                    if (!key) return;
                    const prev = semanticByName.get(key);
                    semanticByName.set(key, prev
                        ? { ...prev, similarity: Math.max(prev.similarity || 0, item.similarity || 0) }
                        : item);
                }));

                if (semanticByName.size) {
                    const hydrated = await fetchScryfallCollection(
                        Array.from(semanticByName.values()).map(x => ({ name: x.name }))
                    );
                    const scoreByName = new Map(
                        Array.from(semanticByName.values()).map(x => [normalizeCardNameForIdentity(x.name), x.similarity || 0])
                    );
                    semanticMatches = (hydrated || []).map(card => ({
                        ...card,
                        _semanticRetrievalSimilarity: scoreByName.get(normalizeCardNameForIdentity(card.name)) || 0,
                        _semanticRetrievalSource: 'related-semantic-index'
                    }));
                    results.push(...semanticMatches);
                }
            }
        }

        // Existing search results are a safe local fallback/recall lane. They were already
        // hydrated by Scryfall and scored by ManaSearch, so Related Search can re-evaluate them
        // against the selected-card reference set without another network dependency. This is
        // especially important when a narrow Scryfall formulation happens to return zero matches.
        // Keep the pool bounded so a huge previous Search Deeper session cannot turn Related Search
        // into an accidental full-history rescore.
        const existingRelatedCandidates = Array.isArray(lastSearchResults)
            ? lastSearchResults.slice(0, 200).filter(card =>
                card && card.name &&
                !allCardsInSet.some(ref => isSameCardName(card.name, ref.name))
            )
            : [];
        if (existingRelatedCandidates.length) {
            const seenExisting = new Set(results.map(c => normalizeCardNameForIdentity(c?.name)));
            for (const card of existingRelatedCandidates) {
                const key = normalizeCardNameForIdentity(card.name);
                if (!key || seenExisting.has(key)) continue;
                seenExisting.add(key);
                results.push({ ...card, _relatedRetrievalSource: 'existing-search-pool' });
            }
        }

        if (lastRelatedQueryError && !results.length && !semanticMatches.length) throw lastRelatedQueryError;

        // Multiple related retrieval formulations can legitimately return overlapping cards.
        // Deduplicate them before the normal related-card filtering/scoring stage.
        if (results.length > 1) {
            const unique = new Map();
            for (const card of results) {
                if (!card?.id) continue;
                unique.set(card.id, card);
            }
            results = [...unique.values()];
        }
        if (!isCurrentRelatedSearch()) return;
        
        // 2. REMOVE SOURCE/SELECTED CARDS & 3. APPLY USER FILTERS
        // Excludes by NAME (not just id) so a different printing of the source card or an
        // already-selected card doesn't slip back in as an apparent "new" result.
        const excludedNamesLower = new Set(allCardsInSet.map(c => (c.name || '').toLowerCase()));
        const filteredResults = results.filter(card => 
            card && 
            card.id && 
            card.name &&
            !excludedNamesLower.has(card.name.toLowerCase()) && 
            matchesActiveFilters(card, filters, null)
        );

        // 4. DEDUPLICATE - by card NAME rather than Scryfall's print id, so two different
        // printings of the same card don't show up as two visually-duplicate result cards.
        const preferBetterPrinting = (existing, incoming) => {
            const hasImage = (c) => Boolean(c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal);
            if (!hasImage(existing) && hasImage(incoming)) return incoming;
            return existing;
        };
        const candidateMap = new Map();
        for (const card of filteredResults) {
            const dedupeKey = card.name.toLowerCase();
            const existing = candidateMap.get(dedupeKey);
            candidateMap.set(dedupeKey, existing ? preferBetterPrinting(existing, card) : card);
        }

        const finalCardPool = [...Array.from(selectedCardsAtStart.values()), ...Array.from(candidateMap.values())];

        updateProgress(2, 3, "Scoring candidates against target patterns...");
        const extractor = relatedExtractor || await getNLPModel();
        if (!isCurrentRelatedSearch()) return;

        // Build a semantic/common target from the selected set. Shared literal patterns are useful
        // retrieval evidence, but they can be too lossy (mana symbols, punctuation, dynamic values).
        // The canonical-function view therefore leads when available, with shared wording retained as
        // supporting context.
        const referenceCanonicalFunctions = allCardsInSet.flatMap(card => {
            const text = getCurrentSourceOracleText(card);
            const parsed = getCachedParsedEffects(card, text);
            return getCanonicalFunctions(parsed);
        });
        const uniqueCanonicalKeys = new Set();
        const uniqueCanonicalFunctions = [];
        for (const fn of referenceCanonicalFunctions) {
            const key = JSON.stringify({ function: fn?.function || '', params: fn?.params || {} });
            if (uniqueCanonicalKeys.has(key)) continue;
            uniqueCanonicalKeys.add(key);
            uniqueCanonicalFunctions.push(fn);
        }
        const canonicalTargetText = canonicalFunctionToText(uniqueCanonicalFunctions.slice(0, 6));
        const combinedTargetText = canonicalTargetText
            ? [canonicalTargetText, repeatingPatterns.length ? repeatingPatterns.slice(0, 3).join('. ') : ''].filter(Boolean).join('. ')
            : (repeatingPatterns.length > 0 ? repeatingPatterns.join('. ') : getCurrentSourceOracleText(sourceCardAtStart));

        // Related search is an ensemble query: a candidate is mechanically related when it
        // matches a meaningful effect from ANY selected card, not only the original source card.
        // Keep both the shared-pattern parse (preferred primary reference) and the full parsed
        // effects of every selected/source card as reference lanes. If the shared phrases are too
        // fragmentary for the parser, the full-card references still provide reliable mechanical
        // structure without requiring literal wording to match.
        const relatedKeywordSeedCard = {
            keywords: [...new Set(allCardsInSet.flatMap(card => Array.isArray(card?.keywords) ? card.keywords : []))]
        };
        const parsedPatternEffects = parseMTGEffect(combinedTargetText);
        parsedPatternEffects._mechanicProfile = buildUniversalMechanicProfile(relatedKeywordSeedCard, combinedTargetText, parsedPatternEffects);
        parsedPatternEffects._mechanicalGraph = buildMechanicalEffectGraph(relatedKeywordSeedCard, combinedTargetText, parsedPatternEffects);
        const relatedReferenceParsedEffects = allCardsInSet
            .map(card => {
                const effects = parseMTGEffect(getCurrentSourceOracleText(card));
                effects._mechanicProfile = buildUniversalMechanicProfile(card, getCurrentSourceOracleText(card), effects);
                effects._mechanicalGraph = buildMechanicalEffectGraph(card, getCurrentSourceOracleText(card), effects);
                return effects;
            })
            .filter(effects => Array.isArray(effects) && effects.length > 0);
        const relatedPrimaryParsedEffects = parsedPatternEffects.length > 0
            ? parsedPatternEffects
            : (relatedReferenceParsedEffects[0] || []);
        
        let targetVector = null;
        let sourceFunctionVector = null;
        if (extractor.type !== 'fallback') {
            targetVector = relatedTargetVectors.length
                ? relatedTargetVectors[relatedTargetVectors.length - 1]
                : await getCachedEmbedding(normalizeOracleForEmbedding(combinedTargetText, sourceCardAtStart.name), extractor);
            const combinedFunctionText = canonicalFunctionToText(uniqueCanonicalFunctions.slice(0, 6));
            if (combinedFunctionText) {
                sourceFunctionVector = await getCachedEmbedding(combinedFunctionText, extractor);
            }
        }

        // Related-card search now keeps a genuine, nonzero mechanical weight (project spec
        // 2.12) instead of disabling mechanical scoring entirely - it still uses semantic +
        // category + text evidence too, mechanical similarity is just one more voice, not muted.
        const wM = Math.max(0, 40 + (parseInt(document.getElementById('weight-mechanical')?.value) || 0));
        const wS = Math.max(0, 33 + (parseInt(document.getElementById('weight-synergy')?.value) || 0));
        const wC = Math.max(0, 34 + (parseInt(document.getElementById('weight-context')?.value) || 0));
        const wE = Math.max(0, 33 + (parseInt(document.getElementById('weight-exactness')?.value) || 0));
        const wCa = Math.max(0, 25 + (parseInt(document.getElementById('weight-category')?.value) || 0));

        // 5. MECHANICAL & 6. SEMANTIC SCORING
        await scoreCardBatch({
            cards: finalCardPool,
            sourceCard: sourceCardAtStart,
            targetText: combinedTargetText,
            sourceParsedEffectsOverride: relatedPrimaryParsedEffects,
            sourceReferenceParsedEffects: relatedReferenceParsedEffects,
            targetVector,
            targetVectors: { oracle: targetVector, semanticRetrieval: targetVector },
            sourceFunctionVector,
            isCancelled: () => !isCurrentRelatedSearch(),
            extractor,
            weights: { mechanical: wM, synergy: wS, context: wC, exactness: wE, category: wCa },
            tags: activeTags,
            topNNames: new Set(),
            sniperIds: new Set(),
            activeFilters: filters
        });
        if (!isCurrentRelatedSearch()) return;

        // 7. FINAL RANKING
        const priorityValue = document.getElementById('sort-results')?.value || 'overall';
        const nonSelected = applyResultOrdering(
            finalCardPool.filter(c => !selectedCardsAtStart.has(c.id)),
            priorityValue
        );
        
        lastSearchResults = [...Array.from(selectedCardsAtStart.values()), ...nonSelected];
        // Related-card search runs its own pipeline and produces no stage diagnostics; clear
        // them rather than leaving the previous search's instrumentation in place.
        lastSearchDiagnostics = null;
        pendingDeeperSearch = null;
        renderResults(lastSearchResults);

    } catch (error) {
        if (isCurrentRelatedSearch()) alert("Related card search failed: " + error.message);
    } finally {
        if (isCurrentRelatedSearch()) {
            updateProgress(null, null, "Related card search complete!");
            showLoading(false);
        }
    }
}

// The actual MTG card types a `type:` Scryfall search should target - supertypes like
// "Legendary", "Snow", "Basic", "World", and "Token" are NOT card types and must not be used as
// one (project spec: Search E primaryType bug).
const MTG_CARD_TYPES = ['creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'planeswalker', 'land', 'battle', 'kindred', 'tribal'];

/**
 * Extracts the real primary MTG card type from a type line, e.g. "creature" from
 * "Legendary Creature — Merfolk Wizard" - NOT simply the first word, which is very often a
 * supertype instead (Legendary, Snow, Basic, World...). The previous implementation
 * (`type_line.split(' ')[0]`) turned every legendary creature's "broader mechanical" search
 * into an effectively unrelated `type:legendary` search, silently starving that retrieval
 * stream for exactly the kind of card (Lord of Atlantis, Knight of the White Orchid) it was
 * meant to help find.
 * @param {string} typeLine
 * @returns {string|null}
 */
function extractPrimaryCardType(typeLine) {
    if (!typeLine) return null;
    const beforeDash = typeLine.split('—')[0].toLowerCase();
    const words = beforeDash.split(/\s+/).filter(Boolean);
    const matchedType = words.find(w => MTG_CARD_TYPES.includes(w));
    return matchedType || words[words.length - 1] || null;
}

// Retrieval vocabulary per canonical function. This is the ONLY place that needs a new entry to
// teach the engine how to retrieve a new mechanic - the query-building control flow below is
// generic (review Priority 3: vocabulary/function mappings, not special-case branches).
//   phrases       - canonical Oracle wordings other cards use for this function
//   otag          - Scryfall oracle-tag, where one exists for the mechanic
//   paramTemplate - builds a query from the canonical params (subtype, magnitude, object, ...)
const FUNCTION_RETRIEVAL_VOCAB = {
    reanimate: {
        phrases: ["from your graveyard to the battlefield", "from a graveyard to the battlefield", "onto the battlefield from your graveyard"],
        otag: "reanimate",
        paramTemplate: (p) => p.object ? `o:"${p.object}" o:"graveyard" o:"battlefield"` : null
    },
    recursion: {
        phrases: ["from your graveyard to your hand", "return target card from your graveyard"],
        paramTemplate: (p) => p.object ? `o:"${p.object} card from your graveyard"` : null
    },
    bounce: {
        phrases: ["return target creature to its owner's hand", "to its owner's hand"],
        otag: "bounce"
    },
    cheat_into_play: {
        phrases: ["put it onto the battlefield", "onto the battlefield without paying"]
    },
    tuck: { phrases: ["on top of its owner's library", "into its owner's library"] },
    removal: {
        phrases: ["destroy target creature", "destroy target permanent", "destroy all creatures"],
        otag: "removal",
        paramTemplate: (p) => {
            const obj = p.object === 'creature' || (p.restriction || []).includes('creature') ? 'creature' : 'permanent';
            return p.target === 'all' || p.target === 'each'
                ? `(o:"destroy all ${obj}s" or o:"exile all ${obj}s")`
                : `(o:"destroy target ${obj}" or o:"exile target ${obj}")`;
        }
    },
    exile_removal: {
        phrases: ["exile target creature", "exile target permanent"],
        otag: "removal"
    },
    cost_reduction: {
        // Keep the retrieval phrasing broad enough to find equivalent continuous cost modifiers
        // while still anchoring on the distinctive rules language that denotes a cost reduction.
        phrases: ["less to cast", "cost less", "costs less to cast"],
        paramTemplate: (p) => {
            const parts = ['o:"less to cast"'];
            const restriction = (p.restriction || []).find(r => r && r.length > 2 &&
                !['controlledbyyou', 'controlledbyopponent'].includes(r));
            if (restriction) parts.push(`o:"${restriction}"`);
            return parts.join(' ');
        }
    },
    counter: {
        phrases: ["counter target spell", "counter target creature spell", "counter target noncreature spell", "counter target ability"],
        otag: "counterspell"
    },
    tutor: {
        phrases: ["search your library for a card", "search your library for a creature card"],
        otag: "tutor",
        paramTemplate: (p) => {
            const kind = (p.restriction || []).find(r => ['creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'planeswalker'].includes(r));
            return kind ? `o:"search your library for a ${kind} card"` : null;
        }
    },
    ramp_tutor: {
        phrases: ["search your library for a basic land", "search your library for a land card", "put it onto the battlefield tapped"],
        otag: "ramp"
    },
    token_creation: {
        phrases: ["create a token", "creature token"],
        paramTemplate: (p) => typeof p.quantity === 'number' && p.quantity > 1 ? `o:"create ${p.quantity}"` : null
    },
    token_multiplier: {
        phrases: ["twice that many", "twice as many", "one or more tokens would be created"]
    },
    tribal_anthem: {
        phrases: ["creatures you control get +1/+1"],
        paramTemplate: (p) => {
            if (!p.subtype) return null;
            const subtype = String(p.subtype).replace(/["\\]/g, '').trim();
            if (!subtype) return null;
            const magnitude = p.magnitude ? `o:"${p.magnitude}"` : `o:"get +"`;
            return `o:"${subtype}" ${magnitude}`;
        }
    },
    anthem: {
        phrases: ["creatures you control get +1/+1", "other creatures you control get"],
        paramTemplate: (p) => p.magnitude ? `o:"creatures you control get ${p.magnitude}"` : null
    },
    card_draw: {
        phrases: ["draw a card", "draw two cards"],
        otag: "draw"
    },
    mill: { phrases: ["mill", "into their graveyard"] },
    discard: { phrases: ["discards a card", "discard a card"] },
    self_sacrifice: { phrases: ["sacrifice a creature", "sacrifice another creature", "sacrifice a permanent"] },
    zone_change: { phrases: [] },
    direct_damage: {
        phrases: ["damage to any target", "damage to target creature", "damage to target player"],
        otag: "burn",
        paramTemplate: (p) => {
            const targetPhrase = p.object === 'any target' ? 'any target'
                : p.object === 'creature' ? 'target creature'
                : p.object === 'player' ? 'target player'
                : p.object === 'planeswalker' ? 'target planeswalker'
                : null;
            if (!targetPhrase) return null;
            // Only anchor on the exact amount when it's a real number - "x"/"that much" damage
            // spells are their own (smaller, more relevant) family and searching for the literal
            // word "x damage" is still meaningful there, so no special-case is needed either way.
            const amountPhrase = typeof p.quantity === 'number' ? `${p.quantity} damage to ${targetPhrase}` : `damage to ${targetPhrase}`;
            return `o:"${amountPhrase}"`;
        }
    },
    mana_ability: {
        phrases: ["add one mana of any color", "add mana of any one color"],
        otag: "manaproduction",
        paramTemplate: (p) => typeof p.quantity === 'number' ? `o:"add ${p.quantity}"` : null
    },
    gain_life: {
        phrases: ["you gain life", "gains life equal to"],
        otag: "lifegain",
        paramTemplate: (p) => typeof p.quantity === 'number' ? `o:"gain ${p.quantity} life"` : null
    },
    lose_life: {
        phrases: ["loses life", "loses life equal to"],
        paramTemplate: (p) => typeof p.quantity === 'number' ? `o:"lose ${p.quantity} life"` : null
    },
    place_counter: {
        phrases: ["+1/+1 counter on target creature", "-1/-1 counter on target creature"],
        otag: "counters",
        paramTemplate: (p) => p.magnitude ? `o:"${p.magnitude} counter"` : null
    },
    tap: {
        phrases: ["tap target creature", "tap target permanent"]
    },
    untap: {
        phrases: ["untap target creature", "untap all lands you control", "untap all creatures you control"]
    }
};

/**
 * Builds a query from whatever structural params a canonical function actually has, ANDing them
 * together, WITHOUT any per-function vocabulary entry. This is the piece that makes retrieval
 * genuinely ontology-driven rather than "vocabulary-driven with a generic fallback": every
 * FUNCTION_RETRIEVAL_VOCAB entry above still has to be hand-written per mechanic, but this runs
 * for every canonical function unconditionally, purely off `deriveCanonicalFunction`'s params
 * (subtype, scope, zones, object, magnitude, quantity). A function nobody has written vocabulary
 * for yet - `self_sacrifice`, `zone_change`, or a future one - still gets a real multi-feature
 * query instead of relying entirely on the flat action+object fallback (review Priority 3:
 * "adding a new mechanic should require adding vocabulary/function mappings, not another pile of
 * special-case if statements" - taken one step further so some mechanics need neither).
 *
 * Only returned when at least two features combine - a single feature alone is indistinguishable
 * from what the flat fallback or Formulation 1 already produces, so it isn't worth a 5th query.
 * @param {Object} canonicalFn - one entry from getCanonicalFunctions()
 * @returns {string|null}
 */
function buildGenericFeatureCombinationQuery(canonicalFn) {
    const p = canonicalFn?.params || {};
    const parts = [];

    if (p.subtype) parts.push(`o:"${String(p.subtype).replace(/["\\]/g, '')}"`);
    if (p.scope === 'other') parts.push(`o:"other"`);
    if (p.from) parts.push(`o:"${p.from}"`);
    if (p.to) parts.push(`o:"${p.to}"`);
    if (p.object && p.object !== 'generic' && p.object !== 'card') parts.push(`o:"${p.object}"`);
    if (p.magnitude) parts.push(`o:"${p.magnitude}"`);
    if (typeof p.quantity === 'number' && p.quantity > 1) parts.push(`o:"${p.quantity}"`);

    // Restriction tokens include structural markers ("controlledbyyou") that aren't literal
    // Oracle wording and would 404 the query if quoted as text - only a genuine descriptive word
    // is usable here.
    const literalRestriction = (p.restriction || [])
        .find(r => r.length > 2 && !['controlledbyyou', 'controlledbyopponent'].includes(r) && !r.startsWith('non'));
    if (literalRestriction && !parts.some(part => part.includes(literalRestriction))) {
        parts.push(`o:"${literalRestriction}"`);
    }

    return parts.length >= 2 ? parts.join(' ') : null;
}

/**
 * Generates diversified Scryfall retrieval queries from the source card's CANONICAL functions.
 *
 * Three layers, in order of how much hand-authoring each needs:
 *   1. FUNCTION_RETRIEVAL_VOCAB (phrases / otag / paramTemplate) - hand-written per mechanic,
 *      used when present because canonical Oracle wording is the strongest single signal.
 *   2. Zone-based formulation - generic (from+to+object), needs no per-function entry.
 *   3. Generic feature-combination (buildGenericFeatureCombinationQuery) - fully generic, ANDs
 *      together whatever structural params a canonical function has (subtype, scope, zones,
 *      magnitude, quantity, a restriction word). Runs for EVERY canonical function, including
 *      ones with no vocabulary entry at all.
 * Only the flat "action + object" fallback at the bottom requires no canonical function to have
 * been derived in the first place - everything above works directly off the ontology
 * (deriveCanonicalFunction), so most new mechanics need vocabulary/param support, not new control
 * flow, and some need nothing at all (review Priority 3).
 *
 * It also DIVERSIFIES: rather than emitting one or two near-identical phrasings, each function can
 * produce several independent formulations and the candidate pools are unioned, giving the engine
 * multiple independent chances to retrieve a differently-worded card (review Priority 13).
 *
 * @param {Object} sourceCard
 * @param {Array<Object>} parsedEffects - output of parseMTGEffect (already importance-ranked)
 * @param {string} excludeSelf
 * @returns {Array<{query: string, narrow: boolean}>} query descriptors with a coverage policy flag
 */
function buildWordingRetrievalQuery(sourceCard, excludeSelf, stopWords = new Set(), mtgStopWords = new Set()) {
    const text = String(sourceCard?.oracle_text || (sourceCard?.card_faces ? sourceCard.card_faces.map(f => f.oracle_text || '').join(' ') : '') || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const sentences = text.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
    const phrases = sentences.slice(0, 2).map(sentence => {
        const words = sentence.split(/\s+/).filter(Boolean);
        return words.length > 9 ? words.slice(0, 9).join(' ') : sentence;
    }).filter(x => x.length >= 12);
    const usefulWords = [...new Set(text.toLowerCase().replace(/[^a-z0-9+\/-\s]/g, ' ').split(/\s+/))]
        .filter(w => w.length >= 4 && !stopWords.has(w) && !mtgStopWords.has(w))
        .slice(0, 5);
    const clauses = [];
    phrases.forEach(p => clauses.push(`o:"${p.replace(/"/g, '\\"')}"`));
    usefulWords.slice(0, 3).forEach(w => clauses.push(`o:"${w}"`));
    return clauses.length ? `(${clauses.join(' or ')}) ${excludeSelf}`.trim() : null;
}

function buildTargetFocusedRetrievalQuery(sourceCard, parsedEffects, excludeSelf) {
    const canonicals = getCanonicalFunctions(parsedEffects).slice(0, 3);
    const clauses = [];
    const seen = new Set();
    const push = value => {
        const clean = String(value || '').replace(/^[._]+|[._]+$/g, '').trim().toLowerCase();
        if (!clean || clean.length < 3 || seen.has(clean)) return;
        seen.add(clean);
        clauses.push(`o:"${clean.replace(/"/g, '')}"`);
    };
    canonicals.forEach(cf => {
        const p = cf?.params || {};
        if (p.object && !['generic', 'card'].includes(String(p.object).toLowerCase())) push(p.object);
        if (p.subtype) push(p.subtype);
        if (p.from) push(p.from);
        if (p.to) push(p.to);
        if (p.scope && p.scope !== 'any') push(p.scope);
        const restriction = Array.isArray(p.restriction) ? p.restriction.find(r => r && !/controlledbyyou|controlledbyopponent/i.test(r)) : null;
        if (restriction) push(restriction);
    });
    if (clauses.length < 2) return null;
    return `(${clauses.slice(0, 5).join(' ')}) ${excludeSelf}`.trim();
}

const ROLE_RETRIEVAL_PHRASES = {
    fast_mana: ['add mana', 'add two mana', 'mana ability'],
    catch_up_ramp: ['more lands', 'search your library for a basic land'],
    land_ramp: ['search your library for a basic land', 'put it onto the battlefield'],
    card_advantage_engine: ['draw a card', 'draw cards', 'put it into your hand'],
    token_multiplier: ['twice that many', 'tokens would be created'],
    token_engine: ['create a token', 'create a creature token'],
    tribal_anthem: ['other creatures you control get', 'get +1/+1'],
    anthem: ['creatures you control get', 'creatures get +1/+1'],
    counterspell: ['counter target spell', 'counter target ability'],
    board_wipe: ['destroy all', 'exile all'],
    single_target_removal: ['destroy target', 'exile target'],
    bounce: ['return target creature to its owner', 'return target permanent to its owner'],
    burn: ['damage to any target', 'damage to target creature'],
    graveyard_recursion: ['return target card from your graveyard', 'from your graveyard to the battlefield'],
    tutor: ['search your library for a card'],
    discard_engine: ['discard a card', 'discards a card'],
    mill_engine: ['mill cards', 'puts the top cards of'],
    life_gain_engine: ['gain life', 'you gain life'],
    life_loss_engine: ['lose life', 'loses life']
};

function buildRoleFocusedRetrievalQuery(sourceCard, parsedEffects, excludeSelf) {
    const roles = inferStrategicRoleProfile(sourceCard, parsedEffects, '') || [];
    const phrases = [];
    roles.slice(0, 3).forEach(roleRecord => {
        (ROLE_RETRIEVAL_PHRASES[roleRecord.role] || []).slice(0, 2).forEach(phrase => phrases.push(`o:"${phrase}"`));
        (roleRecord.anchors || []).slice(0, 1).forEach(anchor => {
            const clean = String(anchor).replace(/\s+/g, ' ').trim();
            if (clean.length >= 5) phrases.push(`o:"${clean.replace(/"/g, '')}"`);
        });
    });
    const unique = [...new Set(phrases)];
    return unique.length ? `(${unique.slice(0, 8).join(' or ')}) ${excludeSelf}`.trim() : null;
}

function buildAlternateMechanicRetrievalQuery(sourceCard, parsedEffects, excludeSelf) {
    const canonicals = getCanonicalFunctions(parsedEffects).slice(0, 3);
    const clauses = [];
    const seen = new Set();
    const add = (value) => {
        const clean = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!clean || clean.length < 3 || seen.has(clean)) return;
        seen.add(clean);
        clauses.push(`o:"${clean.replace(/"/g, '')}"`);
    };
    canonicals.forEach(cf => {
        const p = cf?.params || {};
        if (p.object && !['generic', 'card'].includes(String(p.object).toLowerCase())) add(p.object);
        if (p.subtype) add(p.subtype);
        if (p.to) add(p.to);
    });
    return clauses.length >= 2 ? `(${clauses.slice(0, 6).join(' ')}) ${excludeSelf}`.trim() : null;
}

function buildSynergyRetrievalQuery(sourceCard, parsedEffects, excludeSelf) {
    const typeLine = String(sourceCard?.type_line || '').replace(/—/g, ' ').split(/\s+/).map(x => x.trim()).filter(Boolean);
    const subtypeText = String(sourceCard?.type_line || '').split('—')[1] || '';
    const subtypes = subtypeText.split(/\s+/).map(x => x.trim()).filter(Boolean).filter(x => /^[A-Za-z]+$/.test(x));
    const parts = [];
    subtypes.slice(0, 2).forEach(s => parts.push(`o:"${s.replace(/"/g, '')}"`));
    const keywords = Array.isArray(sourceCard?.keywords) ? sourceCard.keywords.slice(0, 3) : [];
    keywords.forEach(k => parts.push(`o:"${String(k).replace(/"/g, '')}"`));
    const permanentType = ['creature','artifact','enchantment','planeswalker','battle','land'].find(t => typeLine.map(x => x.toLowerCase()).includes(t));
    if (permanentType) parts.push(`type:${permanentType}`);
    return parts.length ? `(${[...new Set(parts)].join(' or ')}) ${excludeSelf}`.trim() : null;
}

function buildFunctionalRetrievalQueries(sourceCard, parsedEffects, excludeSelf, maxFunctions = 2) {
    const sourceText = (sourceCard.oracle_text || (sourceCard.card_faces ? sourceCard.card_faces.map(f => f.oracle_text).join(' ') : '')).toLowerCase();

    // Take the top functions by importance, not merely the first parsed effect - a card whose
    // opening clause is a rider shouldn't have its whole retrieval strategy built from that rider
    // (review Priority 1).
    const canonicals = getCanonicalFunctions(parsedEffects).slice(0, Math.max(1, Number(maxFunctions) || 2));

    const descriptors = [];
    const seenQueries = new Set();
    const addQuery = (parts, narrow) => {
        const body = parts.filter(Boolean).join(' ').trim();
        if (!body) return;
        const query = `${body} ${excludeSelf}`.trim();
        // Order-independent dedup key: Formulation 2 (zone-based) and Formulation 5 (generic
        // combination) can both land on the same AND-of-terms in a different order (e.g.
        // "o:graveyard o:battlefield o:creature" vs "o:creature o:graveyard o:battlefield") -
        // functionally identical to Scryfall, so without sorting the tokens first, one of them
        // would silently waste a query slot on a request that returns the exact same cards.
        const dedupeKey = body.toLowerCase().split(/\s+/).sort().join(' ');
        if (seenQueries.has(dedupeKey)) return;
        seenQueries.add(dedupeKey);
        descriptors.push({ query, narrow });
    };

    for (const cf of canonicals) {
        const vocab = FUNCTION_RETRIEVAL_VOCAB[cf.function];
        const p = cf.params || {};

        // Formulation 1 - canonical Oracle wording for this function (requires vocab).
        if (vocab?.phrases?.length) {
            addQuery([`(${vocab.phrases.map(ph => `o:"${ph}"`).join(' or ')})`], true);
        }

        // Formulation 2 - zone-based: describe the movement rather than the verb, so a card using
        // completely different wording for the same zone transition is still reachable.
        if (p.from && p.to) {
            addQuery([`o:"${p.from}"`, `o:"${p.to}"`, p.object ? `o:"${p.object}"` : null], true);
        }

        // Formulation 3 - parameterized: subtype/magnitude/object specifics (requires vocab).
        if (vocab?.paramTemplate) {
            const templated = vocab.paramTemplate(p);
            if (templated) addQuery([templated], true);
        }

        // Formulation 4 - tag-based, using Scryfall's own oracle-tag index where one exists.
        if (vocab?.otag) {
            addQuery([`otag:${vocab.otag}`], true);
        }

        // Formulation 5 - generic feature combination, requiring NO vocabulary entry at all. This
        // is what keeps retrieval ontology-driven rather than vocabulary-driven-with-a-fallback:
        // a canonical function nobody has written phrases/otag/paramTemplate for yet still gets a
        // real multi-feature AND query straight from its structural params (review Priority 3;
        // review Priority 14, "feature combinations").
        const combo = buildGenericFeatureCombinationQuery(cf);
        if (combo) addQuery([combo], true);
    }

    // Generic structural fallback for any function with no vocabulary entry yet: build a query
    // straight out of whatever structure the parser DID recognize, so an unanticipated mechanic
    // still gets some functional retrieval instead of none.
    if (descriptors.length === 0) {
        const primary = (parsedEffects || []).find(e => e.isPrimary && e.action && e.action !== "generic")
            || (parsedEffects || []).find(e => e.action && e.action !== "generic");

        if (primary) {
            const objectPhrase = primary.object && primary.object !== "generic" ? primary.object : null;
            const restrictionWord = (primary.restriction || [])
                .find(r => r.length > 2 && !['controlledbyyou', 'controlledbyopponent'].includes(r));
            addQuery([
                `o:"${primary.action}${objectPhrase ? ' ' + objectPhrase : ''}"`,
                restrictionWord ? `o:"${restrictionWord}"` : null
            ], true);
        }

        // parseDamageEffect covers the common "deals N damage to <target type>" phrasing (feeding
        // FUNCTION_RETRIEVAL_VOCAB.direct_damage above via the main loop); this is a last-resort
        // net for damage phrasing that doesn't match that regex exactly, since this whole block
        // only runs when the canonical-function loop above found nothing at all.
        if (/\bdeals?\s+\d+\s+damage\b/i.test(sourceText)) {
            addQuery([`(o:"damage to any target" or o:"damage to target")`], true);
        }
    }

    return descriptors.slice(0, 5);
}

function buildNoHighlightSemanticIntentText(sourceCard, sourceText, parsedEffects) {
    const full = normalizeOracleForEmbedding(sourceText, sourceCard?.name || '');
    if (!full) return '';
    const effects = (parsedEffects || []).filter(e => e?.canonical).slice().sort((a,b)=>(Number(b.importance)||0)-(Number(a.importance)||0));
    const canonical = getCanonicalFunctions(effects).slice(0, 4);
    const primary = canonical[0] ? canonicalFunctionToText([canonical[0]]) : '';
    const secondary = canonical.length > 1 ? canonicalFunctionToText(canonical.slice(1)) : '';
    return [full, primary ? `primary gameplay focus ${primary}` : '', secondary ? `secondary gameplay effects ${secondary}` : ''].filter(Boolean).join('. ');
}


function getSearchIntent(sourceCard, highlights = []) {
    const sourceText = getCurrentSourceOracleText(sourceCard) || '';
    const signature = JSON.stringify((highlights || []).map(h => ({
        text: String(h?.text || ''),
        mode: h?.mode === 'variable' ? 'variable' : 'exact',
        origin: h?.origin || 'user',
        attachedTo: Number.isInteger(h?.attachedTo) ? h.attachedTo : null,
        intent: String(h?.intent || ''),
        benchmarkIntentOnly: Boolean(h?.benchmarkIntentOnly)
    })));
    const key = `${normalizeCardNameForIdentity(sourceCard?.name || '')}|${sourceText}|${signature}`;
    const searchIntentCache = getSearchIntentRuntimeCache();
    const cached = searchIntentCache.get(key);
    if (cached) {
        searchIntentCache.delete(key);
        searchIntentCache.set(key, cached);
        return cached;
    }

    const hasHighlight = Array.isArray(highlights) && highlights.length > 0;
    const targetText = hasHighlight
        ? buildHighlightScoringText(highlights, sourceText)
        : sourceText;

    let parsedEffects;
    if (hasHighlight) {
        // Parse only the source-card Oracle excerpts, never the attached search-only wording.
        // The latter is semantic/retrieval intent and may not be valid MTG grammar.
        const profiles = buildHighlightIntentProfiles(highlights);
        parsedEffects = profiles.flatMap(p => p.recognizedEffects?.length ? p.recognizedEffects : (p.parsedEffects || []));
        if (!parsedEffects.length) {
            const sourceOnlyText = (profiles.map(p => p.contextText).filter(Boolean).join('. ') || targetText);
            parsedEffects = parseMTGEffect(sourceOnlyText);
        }
    } else {
        parsedEffects = getCachedParsedEffects(sourceCard, sourceText);
    }

    const semanticText = hasHighlight
        ? normalizeOracleForEmbedding(targetText, sourceCard?.name || '')
        : buildNoHighlightSemanticIntentText(sourceCard, sourceText, parsedEffects);
    const intent = { sourceText, targetText, parsedEffects, semanticText, hasHighlight };
    searchIntentCache.set(key, intent);
    while (searchIntentCache.size > SEARCH_INTENT_CACHE_MAX) {
        searchIntentCache.delete(searchIntentCache.keys().next().value);
    }
    return intent;
}

function createSearchCancellationError() {
    const error = new Error('Search superseded by a newer search.');
    error.code = 'SEARCH_CANCELLED';
    return error;
}

function throwIfSearchCancelled(isCancelled) {
    if (typeof isCancelled === 'function' && isCancelled()) throw createSearchCancellationError();
}

async function findSimilarCards() {
    if (!currentSourceCard) return;

    const requestId = ++searchRequestId;
    activeResultView = { mode: 'main', requestId };

    // Phase timing, surfaced through diagnostics so the benchmark can report where a search
    // actually spends its time (retrieval vs. scoring vs. ranking vs. render) instead of only a
    // single opaque total (review Priority 10, "Per-Test Timing Breakdown").
    const searchStartedAt = Date.now();
    const timings = {};

    showLoading(true);
    // Keep the Results area visible during the search. The user should be able to see the
    // first-pass candidates as soon as they arrive instead of waiting for the entire pipeline.
    if (resultsSection) resultsSection.classList.remove('hidden');
    const resultsSummaryEl = document.getElementById('results-summary');
    if (resultsSummaryEl) {
        resultsSummaryEl.textContent = 'Searching… initial matches will appear as soon as they are found.';
        resultsSummaryEl.classList.remove('hidden');
    }
    if (resultsGrid) {
        resultsGrid.innerHTML = '';
        const initialState = document.createElement('div');
        initialState.className = 'search-initial-state';
        initialState.setAttribute('aria-live', 'polite');
        const title = document.createElement('strong');
        title.textContent = 'Searching for similar cards…';
        const detail = document.createElement('span');
        detail.textContent = 'Initial matches will appear here as soon as a retrieval stream returns them.';
        initialState.append(title, detail);
        resultsGrid.appendChild(initialState);
    }
    const provisionalBannerEl = document.getElementById('provisional-results-banner');
    if (provisionalBannerEl) {
        provisionalBannerEl.textContent = 'Initial results will appear while the remaining search streams continue.';
        provisionalBannerEl.classList.remove('hidden');
    }
    const streamChecklistEl = document.getElementById('stream-checklist');
    if (streamChecklistEl) streamChecklistEl.innerHTML = '';
    // A fresh search makes any earlier search's "more pages available" cursors meaningless (the
    // source card and/or filters may have changed, and even if not, those results are about to
    // be replaced), so the Search Deeper button and its state must not survive into this search.
    pendingDeeperSearch = null;
    const searchDeeperBtnEl = document.getElementById('search-deeper-btn');
    if (searchDeeperBtnEl) searchDeeperBtnEl.classList.add('hidden');

    const isBroadSearch = Boolean(document.getElementById('broad-search')?.checked);
    const isDivergent = Boolean(document.getElementById('divergent-search')?.checked);
    activeSearchMethodFlags = {
        broad: isBroadSearch,
        divergent: isDivergent,
        wording: Boolean(document.getElementById('wording-search')?.checked),
        functional: Boolean(document.getElementById('functional-search')?.checked),
        target: Boolean(document.getElementById('target-search')?.checked),
        role: Boolean(document.getElementById('role-search')?.checked),
        alternate: Boolean(document.getElementById('alternate-search')?.checked),
        synergy: Boolean(document.getElementById('synergy-search')?.checked)
    };
    const priorityValue = document.getElementById('sort-results')?.value || 'overall';
    // The large checklist below is the detailed process view. The headline progress is kept as
    // a high-level pipeline stage indicator so it does not pretend that "1/2" means half of the
    // actual retrieval work has finished.
    const totalSteps = 3;

    updateProgress(1, totalSteps, getActiveSourceCards().length > 1
        ? "Retrieval in progress — searching multiple source cards and gathering initial candidates..."
        : "Retrieval in progress — gathering initial candidates from the search streams...");

    const hasHighlight = Boolean(manualHighlights && manualHighlights.length > 0);

    // Initialize before any retrieval/checklist code can touch the binding. `functionalRetrievalPlans`
    // is populated later, but keeping the binding initialized from the start prevents a Temporal
    // Dead Zone error when a progress/render callback runs while the search function is awaiting.
    let functionalRetrievalPlans = [];

    // Joined with ". " rather than a bare space: multiple highlights are very often disjoint
    // spans pulled from separate sentences/clauses on the card (e.g. one highlight from an ETB
    // ability, another from a separate activated ability further down). A bare-space join
    // collapses that into one run-on string with no sentence boundary at all, which the parser's
    // clause-splitting (which looks for sentence-ending punctuation) then reads as a single
    // malformed clause instead of two separate effects - corrupting mechanical/semantic parsing
    // for any multi-highlight search. A period restores the boundary the parser relies on.
    const searchIntent = getSearchIntent(currentSourceCard, manualHighlights);
    const sourceOracleTextForScoring = searchIntent.sourceText ||
        (sourceCardOracle?.textContent ? sourceCardOracle.textContent : '');
    const targetTextForScoring = searchIntent.targetText || sourceOracleTextForScoring;
    const sourceOracleTextForParsing = sourceOracleTextForScoring;
    const semanticIntentTextForScoring = searchIntent.semanticText || normalizeOracleForEmbedding(targetTextForScoring, currentSourceCard.name);

    // A mixed benchmark highlight on one grammatical effect uses its Exact fragments as structural
    // anchors and its Variable fragments as flexible parameters. Do not turn those anchors into a
    // literal hard query, or semantically equivalent cards are filtered out before scoring.
    const highlightProfilesForSearch = hasHighlight ? buildHighlightIntentProfiles(manualHighlights) : [];
    const hasBenchmarkMixedHighlightIntent = benchmarkColdMode && highlightProfilesForSearch.some(p => p.benchmarkIntentOnly);
    const exactnessTextForScoring = hasHighlight
        ? (hasBenchmarkMixedHighlightIntent
            ? ''
            : manualHighlights.filter(h => h.mode === 'exact' && !h.benchmarkIntentOnly).map(h => h.text).join('. '))
        : targetTextForScoring;

    const filters = readConstraintFilters();

    const hasActiveFilters = hasActiveConstraintFilters(filters);
    // Broad Search widens retrieval without inventing new hard filters. All explicit UI constraints
    // remain mandatory in the local filtering stage.
    const broadFallbackFilters = null;

    const filterParts = buildScryfallConstraintParts(filters);

    const stopWords = new Set(['the','of','and','a','to','in','is','that','it','for','on','are','as','with','they','at','be','this','have','from','or','by','but','not','what','all','were','we','when','your','can','there','an','which','do','their','if','will','up','about','out','then','them','these','so','some','would','make','like','into','has','more','no','could','my','than','first','been','who','its','now','down','may']);
    // Ultra-common Magic oracle-text vocabulary, kept separate from the general English list
    // above because it's specific to card-text phrasing rather than English grammar. These words
    // appear on huge swaths of unrelated cards ("target", "creature", "damage", "battlefield"...),
    // so picking one as one of only 4 keywords for this search wastes that slot on a term with
    // almost no discriminating power - Search F's functional queries and Search A/G already carry
    // the more precise signal, so trimming these here sharpens Search B without losing coverage
    // those other streams don't already provide.
    const mtgStopWords = new Set(['target','targets','targeting','creature','creatures','card','cards','damage','battlefield','control','controls','controlled','controller','player','players','permanent','permanents','ability','abilities','spell','spells','choose','mana','opponent','opponents','turn','until','each','another','deals','deal','put','onto','enters','becomes','gets','gain','gains','equal','instead','additional','whenever','number','other','any','exile','exiled','hand','graveyard','library','tap','tapped','untap','sacrifice','nontoken','nonland','cost','costs','pay','resolves','owner','you','yours']);
    const allWords = targetTextForScoring.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
    const getUnique = (arr, max) => [...new Set(arr)].slice(0, max);
    const cleanKeywords = getUnique(allWords.filter(w => w.length > 2 && !stopWords.has(w) && !mtgStopWords.has(w)), 4);
    const baseOracleQuery = cleanKeywords.length > 0 ? `(${cleanKeywords.map(w => `oracle:${w}`).join(' OR ')})` : '';

    const escapedTargetText = exactnessTextForScoring ? exactnessTextForScoring.replace(/"/g, '\\"') : '';
    const activeSourceCardsForSearch = getActiveSourceCards();
    const allSourceExclusions = activeSourceCardsForSearch.map(card => `-name:"${String(card.name || '').replace(/"/g, '\"')}"`).join(' ');
    const excludeSelf = allSourceExclusions || `-name:"${currentSourceCard.name.replace(/"/g, '\"')}"`;

    // Broad Search uses more source-text terms than Search B and deliberately omits narrow
    // Scryfall constraint clauses here. The local hard-filter stage still enforces every explicit
    // constraint chosen by the user.
    const broadSourceText = hasHighlight ? targetTextForScoring : sourceOracleTextForParsing;
    const broadKeywords = isBroadSearch
        ? [...new Set(
            broadSourceText.toLowerCase()
                .replace(/[^\w+\/-\s]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length > 2 && !stopWords.has(w))
        )].slice(0, 8)
        : [];
    const broadOracleQuery = broadKeywords.length > 0
        ? `(${broadKeywords.map(w => `oracle:${w}`).join(' OR ')}) ${excludeSelf}`.trim()
        : null;

    const sharedSourceTextQuery = activeSourceCardsForSearch.length > 1
        ? buildSharedSourceTextSearchQuery(activeSourceCardsForSearch, allSourceExclusions)
        : null;

    let searchA_Query = null;
    if (escapedTargetText) {
        if (escapedTargetText.includes('o:') || escapedTargetText.includes('oracle:')) {
            searchA_Query = escapedTargetText.includes('-name:') 
                ? `${escapedTargetText} ${filterParts.join(' ')}`.trim() 
                : `${escapedTargetText} ${filterParts.join(' ')} ${excludeSelf}`.trim();
        } else {
            searchA_Query = `o:"${escapedTargetText}" ${filterParts.join(' ')} ${excludeSelf}`.trim();
        }
    }

    const searchB_Query = baseOracleQuery ? `${baseOracleQuery} ${filterParts.join(' ')} ${excludeSelf}`.trim() : null;
    const searchC_Query = activeTags && activeTags.length > 0 
        ? `${activeTags.map(tag => `(otag:"${tag}" OR oracle:"${tag}")`).join(' OR ')} ${filterParts.join(' ')} ${excludeSelf}`.trim()
        : null;

    const card2vecRecs = typeof getCard2VecRecommendations === 'function' 
        ? await getCard2VecRecommendations(currentSourceCard.name) 
        : [];
    const c2vLimit = isBroadSearch ? 20 : 10;
    const topNCard2Vec = card2vecRecs.slice(0, c2vLimit);
    const topNNames = new Set(topNCard2Vec.map(r => r.name.toLowerCase()));

    const primaryType = extractPrimaryCardType(currentSourceCard.type_line);
    const colorId = (currentSourceCard.color_identity || []).join('');
    const searchE_Query = primaryType ? `(type:${primaryType}${colorId ? ` identity:${colorId}` : ''} ${filterParts.join(' ')})`.trim() : null;

    // Search F: functional/mechanic-family retrieval, built from the parsed source effect
    // rather than its literal wording (project spec: functional expansion stage).
    const sourceParsedEffects = searchIntent.parsedEffects || (hasHighlight
        ? parseMTGEffect(targetTextForScoring)
        : getCachedParsedEffects(currentSourceCard, sourceOracleTextForParsing));

    // Source-side confidence is needed later by the ranking/relevance stage. Keep it local to
    // findSimilarCards: scoreCardBatch has its own function-scoped confidence values, so relying
    // on those here would produce a ReferenceError for the relevance floor.
    const sourceParseConfidence = calculateParseConfidence(sourceParsedEffects);
    const sourceFieldConfidence = calculateCardFieldConfidence(sourceParsedEffects);
    const sourceRoleProfileForFloor = inferStrategicRoleProfile(currentSourceCard, sourceParsedEffects, targetTextForScoring);
    const sourceRankingIntentForFloor = inferRankingIntent(currentSourceCard, sourceParsedEffects, targetTextForScoring, sourceRoleProfileForFloor, manualHighlights);

    const highlightRetrievalText = hasHighlight
        ? calculateHighlightIntentRetrievalText(highlightProfilesForSearch)
        : '';

    // Exact highlights are hard lexical constraints. Add a dedicated Oracle-phrase retrieval lane
    // so a valid exact match is not dependent on semantic/function streams surfacing it first.
    const exactHighlightQueries = [];
    if (hasHighlight) {
        const seenExactQueries = new Set();
        for (const highlight of manualHighlights.filter(h => h?.mode !== 'variable' && !h.benchmarkIntentOnly && typeof h.text === 'string' && h.text.trim())) {
            const literal = highlight.text.trim().replaceAll('\\', '\\\\').replaceAll('"', '\\"');
            const key = literal.toLowerCase();
            if (!literal || seenExactQueries.has(key)) continue;
            seenExactQueries.add(key);
            exactHighlightQueries.push({
                query: `oracle:"${literal}" ${excludeSelf}`.trim(),
                narrow: true,
                source: 'highlight-exact'
            });
        }
    }

    functionalRetrievalPlans = buildFunctionalRetrievalQueries(
        currentSourceCard, sourceParsedEffects, excludeSelf,
        activeSearchMethodFlags.functional ? 3 : 2
    );
    const methodQueries = {
        wording: activeSearchMethodFlags.wording ? buildWordingRetrievalQuery(currentSourceCard, excludeSelf, stopWords, mtgStopWords) : null,
        target: activeSearchMethodFlags.target ? buildTargetFocusedRetrievalQuery(currentSourceCard, sourceParsedEffects, excludeSelf) : null,
        role: activeSearchMethodFlags.role ? buildRoleFocusedRetrievalQuery(currentSourceCard, sourceParsedEffects, excludeSelf) : null,
        alternate: activeSearchMethodFlags.alternate ? buildAlternateMechanicRetrievalQuery(currentSourceCard, sourceParsedEffects, excludeSelf) : null,
        synergy: activeSearchMethodFlags.synergy ? buildSynergyRetrievalQuery(currentSourceCard, sourceParsedEffects, excludeSelf) : null
    };
    if (highlightRetrievalText) {
        const highlightWords = [...new Set(highlightRetrievalText.toLowerCase().match(/[a-z][a-z0-9+\/-]{2,}/g) || [])]
            .filter(w => !mtgStopWords.has(w) && !stopWords.has(w))
            .slice(0, 6);
        if (highlightWords.length > 0) {
            functionalRetrievalPlans.push({
                query: `(${highlightWords.map(w => `oracle:${w}`).join(' OR ')}) ${excludeSelf}`.trim(),
                narrow: false,
                source: 'highlight-intent'
            });
        }
    }

    // The loading checklist is intentionally a USER-FACING summary of retrieval lanes, not a
    // one-for-one dump of every internal query. Search F can use several independent functional
    // formulations, but visually it is one "Functional Match" lane. The individual formulations
    // still remain separate in diagnostics and in the progressive result merge below.
    const uniqueFunctionalQueries = [];
    const seenFunctionalQueries = new Set();
    functionalRetrievalPlans.forEach(q => {
        if (!q?.query || seenFunctionalQueries.has(q.query)) return;
        seenFunctionalQueries.add(q.query);
        uniqueFunctionalQueries.push(q);
    });
    const hasFunctionalVisualStream = !benchmarkUseLocalOracleCorpus && uniqueFunctionalQueries.length > 0;
    const exactHighlightStreamLabels = exactHighlightQueries.map((_, idx) => `Search H #${idx + 1} (Exact Highlight)`);
    const plannedStreamLabels = [
        'Exact Phrase', 'Oracle Terms', 'Mechanics/Tags', 'Card2Vec', 'Broader Mechanical',
        'Semantic Index',
        ...(hasFunctionalVisualStream ? ['Functional Match'] : []),
        ...exactHighlightStreamLabels
    ];
    if (isBroadSearch) plannedStreamLabels.push('Broad Retrieval');
    if (sharedSourceTextQuery) plannedStreamLabels.push('Shared Source Text');
    if (activeSearchMethodFlags.wording && methodQueries.wording) plannedStreamLabels.push('Wording Search');
    if (activeSearchMethodFlags.functional && methodQueries.functional) plannedStreamLabels.push('Functional Search');
    if (activeSearchMethodFlags.target && methodQueries.target) plannedStreamLabels.push('Target Search');
    if (activeSearchMethodFlags.role && methodQueries.role) plannedStreamLabels.push('Role Search');
    if (activeSearchMethodFlags.alternate && methodQueries.alternate) plannedStreamLabels.push('Alternative Search');
    if (activeSearchMethodFlags.synergy && methodQueries.synergy) plannedStreamLabels.push('Synergy Search');

    // Confidence-aware retrieval depth for Search B specifically: known synchronously, before any
    // network call, from how cleanly the source card's own text parsed - no need to wait on
    // another stream's live results (which would serialize what's currently launched in
    // parallel). A confident parse (few/no "generic" clauses) means the precise streams (A/F) are
    // likely doing the real work well this search, so Search B's broad, expensive net - which
    // routinely hits its page cap on the biggest, least-targeted hauls of the whole pipeline -
    // matters comparatively less and gets one fewer page; a weak/generic parse means the broad
    // net is carrying more of the load, so it keeps its full depth.
    const sourceParseConfidenceForDepth = sourceParseConfidence;
    const benchmarkPageCap = benchmarkColdMode && benchmarkApiConservativeMode ? 1 : 8;
    const searchBMaxPages = benchmarkPageCap;

    const retrievalStartedAt = Date.now();

    // Stage awareness: tick off each retrieval stream as it resolves, so the loading text (and
    // the visible per-stream checklist) reflects which stage the search is actually in instead of
    // one static message for however long the slowest stream takes (user request: "make sure the
    // user is aware of the current search and display stages"). trackStream wraps a promise
    // without changing what it resolves to.
    const totalTrackedStreams = plannedStreamLabels.length;
    let streamsSettled = 0;
    const streamChecklistState = new Map(); // label -> done (boolean)
    const streamChecklistDetail = new Map(); // label -> current page/status detail
    plannedStreamLabels.forEach(label => {
        streamChecklistState.set(label, false);
        streamChecklistDetail.set(label, 'Waiting to start');
    });
    function renderStreamChecklist() {
        if (!streamChecklistEl) return;
        streamChecklistEl.innerHTML = '';
        streamChecklistState.forEach((done, label) => {
            const chip = document.createElement('span');
            chip.className = `stream-chip${done ? ' stream-done' : ''}`;
            const labelSpan = document.createElement('span');
            labelSpan.className = 'stream-chip-label';
            labelSpan.textContent = label;
            const detailSpan = document.createElement('span');
            detailSpan.className = 'stream-chip-detail';
            detailSpan.textContent = streamChecklistDetail.get(label) || (done ? 'Done' : 'Waiting');
            chip.title = `${label}: ${detailSpan.textContent}`;
            chip.append(labelSpan, detailSpan);
            streamChecklistEl.appendChild(chip);
        });
    }

    // Route retrieval progress into the USER-FACING lane represented by the checklist. Search F
    // has multiple internal queries, so their live page updates are collapsed into one Functional
    // Match chip. Any unexpected label is still shown so a genuinely new stream can never remain
    // invisible; the normal A/B/C/E labels below use the same names here, avoiding the duplicate
    // gray chips that used to appear as "Search A (Exact Phrase)" alongside the completed chip.
    activeSearchStreamProgressReporter = ({ label, message, kind = 'progress' } = {}) => {
        if (requestId !== searchRequestId || !label) return;
        const displayLabel = /^Search F #\d+ \(Functional Match\)$/.test(label)
            ? 'Functional Match'
            : label;
        if (!streamChecklistState.has(displayLabel)) streamChecklistState.set(displayLabel, false);
        streamChecklistDetail.set(displayLabel, message || (kind === 'done' ? 'Done' : 'Working'));
        renderStreamChecklist();
    };

    const trackStream = (promise, label) => {
        streamChecklistState.set(label, false);
        streamChecklistDetail.set(label, 'Starting');
        renderStreamChecklist();
        return promise.then(r => {
            // A slow stream from an older search must never mutate the checklist belonging to a
            // newer search. Without this guard, a late A/B/C/F completion could repaint the new
            // search's chips or make its aggregate progress counter inaccurate.
            if (requestId !== searchRequestId) return r;
            streamsSettled++;
            streamChecklistState.set(label, true);
            const coverage = r?.coverage;
            const detail = coverage
                ? `Done • ${coverage.pagesFetched}/${coverage.maxPages} pages • ${coverage.retrievedCount} cards`
                : 'Done';
            streamChecklistDetail.set(label, detail);
            renderStreamChecklist();
            updateProgress(1, totalSteps, `Retrieval in progress — ${streamsSettled}/${totalTrackedStreams} search streams finished; ${label} finished.`);
            return r;
        });
    };

    // Wall-clock safety net state - declared here (not inside the try block below) specifically
    // so the catch/finally blocks can also see and clear searchTimeoutId; a timer armed and only
    // referenced from inside try would be out of scope for cleanup in catch/finally.
    let pipelineCompleted = false;
    let searchTimeoutId = null;

    try {
        const streamAPromise = trackStream(
            benchmarkUseLocalOracleCorpus ? Promise.resolve([]) :
            (searchA_Query ? fetchScryfallSearch(searchA_Query, benchmarkPageCap, "Exact Phrase").catch(() => []) : Promise.resolve([])),
            "Exact Phrase"
        );

        // Progressive merge (user request: continuously improve the shown cards rather than one
        // big swap at the end). previewPool accumulates every preview-eligible stream's results,
        // keyed by name so the same card arriving from two different streams doesn't duplicate;
        // each new arrival triggers a re-sort and re-render of the WHOLE pool built up so far,
        // rather than either replacing everything or only ever showing whichever single stream
        // happened to finish first. previouslyRenderedNames tracks what was already on screen as
        // of the last progressive render, so a card that's new since then can be flagged and
        // briefly highlighted (newly-added-flash, see style.css) instead of silently reshuffling
        // the whole grid with no indication of what changed or why.
        //
        // This deliberately does NOT run the full scoreCardBatch pass: the NLP model may still be
        // loading at this point, so a real semantic/context score isn't reliably available yet.
        // It DOES use every other scoring dimension that doesn't need the model - mechanical
        // similarity, category match, and synergy - all cheap, synchronous, and already far more
        // informative than sorting by raw text similarity alone. The authoritative, fully-scored
        // render further down unconditionally replaces whatever this produced once the whole
        // pipeline completes.
        const previewPool = new Map();
        const previouslyRenderedNames = new Set();
        const MIN_PREVIEW_RESULTS = 1;
        const PREVIEW_RENDER_CAP = 20;
        const PREVIEW_RENDER_MIN_INTERVAL_MS = 300;
        let previewRenderTimer = null;
        let previewRenderDirty = false;
        let previewRenderLabel = '';
        let previewLastRenderedAt = 0;

        const previewSourceMechanicProfile = buildUniversalMechanicProfile(currentSourceCard, targetTextForScoring, sourceParsedEffects);

        function computePreviewScore(card) {
            const cText = card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text).join(' ') : '');
            const cParsed = parseMTGEffect(cText);
            const cProfile = buildUniversalMechanicProfile(card, cText, cParsed);
            const mech = calculateMechanicalSimilarity(sourceParsedEffects, cParsed, previewSourceMechanicProfile, cProfile);
            const cat = calculateCategoryScore(card, activeTags);
            const syn = calculateSynergyScore(currentSourceCard, card, filters);
            // Weighted toward mechanical since it's the most direct "does this do the same
            // thing" signal available without the embedding model.
            return (mech * 0.55) + (cat * 0.25) + (syn * 0.20);
        }

        function flushPreviewRender() {
            if (requestId !== searchRequestId || !previewRenderDirty || previewPool.size < MIN_PREVIEW_RESULTS) return;
            previewRenderDirty = false;
            previewLastRenderedAt = Date.now();
            const sorted = Array.from(previewPool.values())
                .sort((a, b) => (b._previewScore || 0) - (a._previewScore || 0))
                .slice(0, PREVIEW_RENDER_CAP);
            // Progressive rendering must not flash/recolor cards as they re-enter the visible
            // top-N pool. The old newly-added animation caused cards to appear to flicker between
            // the normal gray border and a purple outline whenever a score update reran this pass.
            sorted.forEach(c => { c._isNewlyAdded = false; });
            if (requestId !== searchRequestId || activeResultView.mode !== 'main' || activeResultView.requestId !== requestId) return;
            updateProgress(1, totalSteps, `First look: ${sorted.length} match${sorted.length === 1 ? '' : 'es'} found so far (just updated by ${previewRenderLabel || 'another search stage'}) - still searching further sources...`);
            document.getElementById('provisional-results-banner')?.classList.remove('hidden');
            renderResults(sorted);
            if (typeof requestProgressiveRanking === 'function') requestProgressiveRanking();
        }

        function schedulePreviewRender(label) {
            previewRenderLabel = label;
            previewRenderDirty = true;
            if (previewRenderTimer || requestId !== searchRequestId) return;
            const elapsed = Date.now() - previewLastRenderedAt;
            const delay = Math.max(0, PREVIEW_RENDER_MIN_INTERVAL_MS - elapsed);
            previewRenderTimer = setTimeout(() => {
                previewRenderTimer = null;
                flushPreviewRender();
            }, delay);
        }

        function mergeIntoPreview(newResults, label) {
            if (requestId !== searchRequestId || !newResults || newResults.length === 0) return;
            const filtered = newResults.filter(c =>
                c && c.name &&
                !isSameCardName(c.name, currentSourceCard.name) &&
                matchesExactHighlightConstraints(c, manualHighlights) &&
                matchesActiveFilters(c, filters, broadFallbackFilters)
            );
            let addedAny = false;
            filtered.forEach(c => {
                const key = c.name.toLowerCase();
                if (previewPool.has(key)) return;
                c._previewScore = computePreviewScore(c);
                c.similarityScore = c._previewScore;
                c._isProvisionalScore = true;
                previewPool.set(key, c);
                addedAny = true;
            });
            if (!addedAny || previewPool.size < MIN_PREVIEW_RESULTS) return;
            schedulePreviewRender(label);
        }
        streamAPromise.then(r => mergeIntoPreview(r, "exact phrase")).catch(() => {});

        // Wall-clock safety net (user request): even with the retrieval/rate-limit fixes, a
        // genuinely hard source card (a huge, legitimately relevant broad candidate pool) can
        // still take a long time. Rather than only improving the AVERAGE case, this bounds the
        // WORST case predictably: if the full pipeline hasn't finished within SEARCH_TIMEOUT_MS,
        // whatever's in the progressive preview pool is shown as an explicit "still searching"
        // state instead of an indefinite spinner with no sense of how much longer it'll take. The
        // underlying retrieval/scoring work is NOT cancelled or altered by this firing - it keeps
        // running in the background, and the normal unconditional final render still replaces
        // this once it completes, exactly as if the timeout had never fired.
        const SEARCH_TIMEOUT_MS = 20000;
        searchTimeoutId = setTimeout(() => {
            if (pipelineCompleted || requestId !== searchRequestId || activeResultView.mode !== 'main' || activeResultView.requestId !== requestId) return;
            const partial = Array.from(previewPool.values()).sort((a, b) => (b._previewScore || 0) - (a._previewScore || 0));
            if (partial.length > 0) {
                updateProgress(1, totalSteps, `Still searching - this one's taking a while. Showing ${partial.length} match${partial.length === 1 ? '' : 'es'} found so far while the rest of the search keeps running...`);
                document.getElementById('provisional-results-banner')?.classList.remove('hidden');
                renderResults(partial);
            } else {
                updateProgress(1, totalSteps, `Still searching - this one's taking a while, no matches found yet. Hang tight...`);
            }
        }, SEARCH_TIMEOUT_MS);

        const streamBPromise = trackStream(
            benchmarkUseLocalOracleCorpus ? Promise.resolve([]) :
            (searchB_Query ? fetchScryfallSearch(searchB_Query, searchBMaxPages, "Oracle Terms").catch(() => []) : Promise.resolve([])),
            "Oracle Terms"
        );
        streamBPromise.then(r => mergeIntoPreview(r, "oracle terms")).catch(() => {});
        const streamCPromise = trackStream(
            benchmarkUseLocalOracleCorpus ? Promise.resolve([]) :
            (searchC_Query ? fetchScryfallSearch(searchC_Query, benchmarkPageCap, "Mechanics/Tags").catch(() => []) : Promise.resolve([])),
            "Mechanics/Tags"
        );
        streamCPromise.then(r => mergeIntoPreview(r, "tags")).catch(() => {});
        const streamDPromise = trackStream(
            benchmarkUseLocalOracleCorpus ? Promise.resolve([]) :
            (topNCard2Vec.length > 0 ? fetchScryfallCollection(topNCard2Vec.map(r => ({ name: r.name }))).catch(() => []) : Promise.resolve([])),
            "Card2Vec"
        );
        streamDPromise.then(r => mergeIntoPreview(r, "card2vec")).catch(() => {});
        const streamEPromise = trackStream(
            benchmarkUseLocalOracleCorpus ? Promise.resolve([]) :
            (searchE_Query ? fetchScryfallSearch(searchE_Query, benchmarkPageCap, "Broader Mechanical").catch(() => []) : Promise.resolve([])),
            "Broader Mechanical"
        );
        streamEPromise.then(r => mergeIntoPreview(r, "broader mechanical match")).catch(() => {});

        // Search I: Broad Retrieval. A separate retrieval lane makes Broad Search an actual
        // candidate-recall method rather than a dormant toggle.
        const broadSearchMaxPages = benchmarkColdMode && benchmarkApiConservativeMode ? 1 : 8;
        const streamBroadPromise = isBroadSearch
            ? trackStream(
                benchmarkUseLocalOracleCorpus ? Promise.resolve([]) :
                (broadOracleQuery
                    ? fetchScryfallSearch(broadOracleQuery, broadSearchMaxPages, "Broad Retrieval").catch(() => [])
                    : Promise.resolve([])),
                "Broad Retrieval"
            )
            : Promise.resolve([]);
        streamBroadPromise.then(r => mergeIntoPreview(r, "broad retrieval")).catch(() => {});
        const streamSharedPromise = sharedSourceTextQuery
            ? trackStream(
                benchmarkUseLocalOracleCorpus ? Promise.resolve([]) :
                fetchScryfallSearch(sharedSourceTextQuery, benchmarkPageCap, "Shared Source Text").catch(() => []),
                "Shared Source Text"
            )
            : Promise.resolve([]);
        streamSharedPromise.then(r => mergeIntoPreview(r, "shared source text")).catch(() => {});
        // Coverage policy is per-query, not one global page cap. A narrow functional query
        // ("reanimate + creature + graveyard + battlefield") matches few cards and we want near
        // complete coverage of it - missing page 3 there means missing the answer. A broad
        // formulation matches thousands and only needs shallow exploration. Query size alone
        // couldn't express that distinction (review Priority 12).
        //
        // Each functional query is kept as its OWN promise/result rather than flattened into one
        // array immediately - Search F can carry several independent formulations of the same
        // function (zone-based, Oracle-wording, parameterized...), and collapsing them together
        // made it impossible to tell which formulation actually worked. Diagnostics need the
        // per-query breakdown (review Priority 8). Each is also merged into the progressive
        // preview individually as it resolves, rather than waiting for every formulation to
        // finish - the fastest functional match contributes to what's on screen as soon as it
        // lands, not only once the whole Search F batch is done.
        // Search F is one visible stream with several internal formulations. Keep every query
        // running independently (and keep its individual diagnostic coverage), but only mark the
        // visible Functional Match chip complete once the whole F group has settled.
        const functionalQueryPromises = benchmarkUseLocalOracleCorpus ? [] : uniqueFunctionalQueries.map((q, idx) => {
            const streamLabel = `Search F #${idx + 1} (Functional Match)`;
            const p = fetchScryfallSearch(q.query, benchmarkPageCap, streamLabel).catch(() => []);
            p.then(r => mergeIntoPreview(r, `functional match ${idx + 1}`)).catch(() => {});
            return p;
        });
        const functionalResultsPromise = (async () => {
            const sets = await Promise.all(functionalQueryPromises);
            if (hasFunctionalVisualStream) {
                streamsSettled++;
                const totalQueries = functionalQueryPromises.length;
                const totalPages = sets.reduce((sum, r) => sum + (r?.coverage?.pagesFetched || 0), 0);
                const maxPages = sets.reduce((sum, r) => sum + (r?.coverage?.maxPages || 0), 0);
                const totalCards = sets.reduce((sum, r) => sum + (r?.length || 0), 0);
                streamChecklistState.set('Functional Match', true);
                streamChecklistDetail.set(
                    'Functional Match',
                    `Done • ${totalQueries} queries • ${totalPages}/${maxPages || totalPages} pages • ${totalCards} cards`
                );
                renderStreamChecklist();
                updateProgress(1, totalSteps, `Retrieval in progress — ${streamsSettled}/${totalTrackedStreams} search streams finished; Functional Match finished.`);
            }
            return sets;
        })();
        const exactHighlightPromises = benchmarkUseLocalOracleCorpus ? [] : exactHighlightQueries.map((q, idx) => {
            const streamLabel = `Search H #${idx + 1} (Exact Highlight)`;
            const p = trackStream(
                fetchScryfallSearch(q.query, benchmarkPageCap, streamLabel).catch(() => []),
                streamLabel
            );
            p.then(r => mergeIntoPreview(r, `exact highlight ${idx + 1}`)).catch(() => {});
            return p;
        });
        const methodStreamPromises = [];
        const registerMethodStream = (key, query, label) => {
            if (!query) return;
            const promise = trackStream(
                benchmarkUseLocalOracleCorpus ? Promise.resolve([]) :
                fetchScryfallSearch(query, benchmarkPageCap, label).catch(() => []),
                label
            );
            promise.then(r => mergeIntoPreview(r, key)).catch(() => {});
            methodStreamPromises.push({ key, promise });
        };
        if (activeSearchMethodFlags.wording) registerMethodStream('wording search', methodQueries.wording, 'Wording Search');
        if (activeSearchMethodFlags.target) registerMethodStream('target search', methodQueries.target, 'Target Search');
        if (activeSearchMethodFlags.role) registerMethodStream('role search', methodQueries.role, 'Role Search');
        if (activeSearchMethodFlags.alternate) registerMethodStream('alternative search', methodQueries.alternate, 'Alternative Search');
        if (activeSearchMethodFlags.synergy) registerMethodStream('synergy search', methodQueries.synergy, 'Synergy Search');

        // The NLP model and the precomputed semantic index are independent startup resources.
        // Start both now so their download/initialization overlaps the Scryfall retrieval streams.
        // The static index is the ONLY full-corpus semantic source for live users; it must be a
        // real Search G retrieval lane in the main search, not merely a post-search background job.
        const extractorPromise = getNLPModel();
        const semanticIndexPromise = (!benchmarkUseLocalOracleCorpus && !benchmarkApiConservativeMode)
            ? ensureFullSemanticIndex()
            : Promise.resolve(null);

        // Start Search G immediately, in parallel with the ordinary Scryfall retrieval streams.
        // The same normalized target embedding is returned for the scoring pass, so we do not
        // embed the source text twice. For the deployed static index, the vector representation
        // is the normalized Oracle text used by semantic-index.bin.
        const semanticRetrievalPromise = trackStream((async () => {
            try {
                const ex = await extractorPromise;
                if (!ex || ex.type === 'fallback') return { index: null, queryVector: null, semanticRetrievalVector: null, matches: [], hydrated: [] };
                const index = benchmarkUseLocalOracleCorpus
                    ? benchmarkLocalOracleCorpus
                    : await semanticIndexPromise;
                if (!index) return { index: null, queryVector: null, semanticRetrievalVector: null, matches: [], hydrated: [] };

                const queryText = semanticIntentTextForScoring;
                if (!queryText) return { index, queryVector: null, matches: [], hydrated: [] };
                const semanticRetrievalVector = await getCachedEmbedding(queryText, ex);
                const oracleVector = await getCachedEmbedding(normalizeOracleForEmbedding(targetTextForScoring, currentSourceCard.name), ex);
                if (!semanticRetrievalVector && !oracleVector) return { index, queryVector: null, semanticRetrievalVector: null, matches: [], hydrated: [] };

                const limit = benchmarkUseLocalOracleCorpus
                    ? (isBroadSearch ? 512 : 384)
                    : (isBroadSearch ? 96 : 72);
                const queryJobs = [];
                if (semanticRetrievalVector) queryJobs.push({ vector: semanticRetrievalVector, view: 'intent', limit, threshold: 0.42 });
                if (oracleVector && !hasHighlight) queryJobs.push({ vector: oracleVector, view: 'oracle', limit: Math.max(24, Math.floor(limit * 0.55)), threshold: 0.40 });
                const querySets = await Promise.all(queryJobs.map(q => findFullSemanticMatches(index, q.vector, currentSourceCard.name, q.limit, q.threshold)));
                const mergedMatches = new Map();
                querySets.forEach((set, qi) => (set || []).forEach(item => {
                    const key = normalizeCardNameForIdentity(item.name);
                    const prev = mergedMatches.get(key);
                    const view = queryJobs[qi].view;
                    mergedMatches.set(key, prev ? { ...prev, similarity: Math.max(prev.similarity || 0, item.similarity || 0), _semanticViews: [...new Set([...(prev._semanticViews || []), view])] } : { ...item, _semanticViews: [view] });
                }));
                const matches = Array.from(mergedMatches.values()).sort((a,b)=>(b.similarity||0)-(a.similarity||0)).slice(0, limit);
                const exactMatches = benchmarkUseLocalOracleCorpus && hasHighlight
                    ? findFullSemanticExactMatches(index, manualHighlights, currentSourceCard.name, 1024)
                    : [];

                const byName = new Map();
                for (const item of matches) byName.set(normalizeCardNameForIdentity(item.name), item);
                for (const item of exactMatches) {
                    const key = normalizeCardNameForIdentity(item.name);
                    const previous = byName.get(key);
                    byName.set(key, previous
                        ? { ...previous, similarity: Math.max(previous.similarity || 0, 1), card: item.card || previous.card }
                        : item);
                }

                let hydrated = [];
                if (byName.size > 0) {
                    if (benchmarkUseLocalOracleCorpus) {
                        const exactKeys = new Set(exactMatches.map(x => normalizeCardNameForIdentity(x.name)));
                        hydrated = Array.from(byName.values())
                            .filter(x => x.card)
                            .map(x => ({
                                ...x.card,
                                _semanticRetrievalSimilarity: x.similarity || 0,
                                _semanticRetrievalSource: exactKeys.has(normalizeCardNameForIdentity(x.name))
                                    ? 'benchmark-full-index-exact'
                                    : 'benchmark-full-index'
                            }));
                    } else {
                        const fetched = await fetchScryfallCollection(Array.from(byName.values()).map(x => ({ name: x.name })));
                        const scoreByName = new Map(Array.from(byName.values()).map(x => [normalizeCardNameForIdentity(x.name), x.similarity]));
                        hydrated = (fetched || []).map(card => ({
                            ...card,
                            _semanticRetrievalSimilarity: scoreByName.get(normalizeCardNameForIdentity(card.name)) || 0,
                            _semanticRetrievalSource: 'full-index'
                        }));
                    }
                }
                return { index, queryVector: oracleVector || semanticRetrievalVector, semanticRetrievalVector, matches, hydrated };
            } catch (error) {
                console.info('Search G semantic retrieval unavailable; continuing with non-semantic retrieval:', error?.message || error);
                return { index: null, queryVector: null, semanticRetrievalVector: null, matches: [], hydrated: [] };
            }
        })(), 'Semantic Index');

        // Continuous ranking: retrieve and score concurrently. As soon as a retrieval stream adds
        // candidates to previewPool, a serialized queue scores the strongest 18-card batches and
        // re-renders the provisional result order. The final full-pool pass remains authoritative
        // and reuses the embedding cache, so this improves time-to-ranked-results without changing
        // the final ranking model.
        let requestProgressiveRanking = null;
        let progressiveRankingRunning = false;
        const progressiveRankingPending = new Map();
        const progressiveRankingBatchSize = 18;
        let progressiveTargetVectorPromise = null;
        const getProgressiveTargetVector = async () => {
            if (progressiveTargetVectorPromise) return progressiveTargetVectorPromise;
            progressiveTargetVectorPromise = (async () => {
                const ex = await extractorPromise;
                if (!ex || ex.type === 'fallback') return null;
                try { return await getCachedEmbedding(normalizeOracleForEmbedding(targetTextForScoring, currentSourceCard.name), ex); }
                catch (_) { return null; }
            })();
            return progressiveTargetVectorPromise;
        };
        const runProgressiveRanking = async () => {
            if (progressiveRankingRunning || requestId !== searchRequestId) return;
            progressiveRankingRunning = true;
            try {
                const ex = await extractorPromise;
                if (!ex || requestId !== searchRequestId) return;
                const targetVector = await getProgressiveTargetVector();
                while (progressiveRankingPending.size && requestId === searchRequestId) {
                    const batch = Array.from(progressiveRankingPending.values())
                        .sort((a,b)=>(b._previewScore||0)-(a._previewScore||0))
                        .slice(0, progressiveRankingBatchSize);
                    if (!batch.length) break;
                    batch.forEach(card => progressiveRankingPending.delete((card.name||'').toLowerCase()));
                    await scoreCardBatch({
                        cards: batch, sourceCard: currentSourceCard, targetText: targetTextForScoring,
                        exactnessText: exactnessTextForScoring, targetVector, extractor: ex,
                        targetVectors: { oracle: targetVector, semanticRetrieval: targetVector },
                        isCancelled: () => requestId !== searchRequestId,
                        weights:{mechanical:45,synergy:10,context:20,exactness:15,category:10},
                        tags:activeTags, topNNames:new Set(), sniperIds:new Set(), activeFilters:filters
                    });
                    if (requestId !== searchRequestId) break;
                    batch.forEach(card=>{card._progressivelyRanked=true;});
                    // Related Search may intentionally own the Results grid while this main
                    // search continues in the background. Do not repaint the user's active view.
                    if (activeResultView.mode !== 'main' || activeResultView.requestId !== requestId) break;
                    const ranked=Array.from(previewPool.values()).sort((a,b)=>{
                        const as=Number.isFinite(a.similarityScore)?a.similarityScore:(a._previewScore||0);
                        const bs=Number.isFinite(b.similarityScore)?b.similarityScore:(b._previewScore||0); return bs-as;
                    });
                    renderResults(ranked);
                    await backgroundAwareDelay(0);
                }
            } catch(error) { console.info('Progressive ranking paused; final ranking continues:', error?.message||error); }
            finally { progressiveRankingRunning=false; }
        };
        requestProgressiveRanking = () => {
            if (requestId !== searchRequestId) return;
            previewPool.forEach((card,key)=>{ if(card && key && !card._progressivelyRanked) progressiveRankingPending.set(key,card); });
            runProgressiveRanking();
        };

        const [resultsA, resultsB, resultsC, resultsD, resultsE, resultsBroad, resultsShared, resultsFSets, resultsExactSets, extractor, semanticRetrieval, resolvedMethodStreams] = await Promise.all([
            streamAPromise, streamBPromise, streamCPromise, streamDPromise, streamEPromise, streamBroadPromise, streamSharedPromise,
            functionalResultsPromise,
            Promise.all(exactHighlightPromises),
            extractorPromise,
            semanticRetrievalPromise,
            Promise.all(methodStreamPromises.map(entry => entry.promise))
        ]);
        const methodResults = Object.fromEntries(methodStreamPromises.map((entry, index) => [entry.key, resolvedMethodStreams[index] || []]));
        updateProgress(2, totalSteps, 'Scoring in progress — combining retrieved candidates and calculating similarity signals...');
        const resultsF = resultsFSets.flat();
        const resultsExact = resultsExactSets.flat();
        const resultsSharedFlat = resultsShared || [];

        // Search G results were retrieved in parallel with the other search streams above.
        // Reuse its query vector as the scoring target so the semantic index and candidate scorer
        // are guaranteed to operate on the same normalized source representation.
        let sourceFunctionVector = null;
        const sourceOracleVector = semanticRetrieval?.queryVector || null;
        const sourceSemanticRetrievalVector = semanticRetrieval?.semanticRetrievalVector || sourceOracleVector;
        if (extractor && extractor.type !== 'fallback') {
            const sourceFunctionText = canonicalFunctionToText(getCanonicalFunctions(sourceParsedEffects));
            if (sourceFunctionText) sourceFunctionVector = await getCachedEmbedding(sourceFunctionText, extractor);
        }
        let resultsG = semanticRetrieval?.hydrated || [];
        const targetVectors = { oracle: sourceOracleVector, semanticRetrieval: sourceSemanticRetrievalVector };
        const targetVector = targetVectors.oracle;

        // Keep the old session corpus as a secondary recovery lane. It is still useful for cards
        // already hydrated elsewhere in the session, but no longer serves as the primary semantic
        // retrieval mechanism and therefore cannot bias first-search recall.
        const sessionSemanticMatches = findSessionSemanticMatches(
            sourceFunctionVector || sourceOracleVector,
            sourceOracleVector,
            currentSourceCard.name,
            isBroadSearch ? 24 : 16,
            0.48
        );
        const semanticMap = new Map();
        for (const card of resultsG) semanticMap.set(normalizeCardNameForIdentity(card.name), card);
        for (const card of sessionSemanticMatches) {
            const key = normalizeCardNameForIdentity(card.name);
            if (!semanticMap.has(key)) semanticMap.set(key, card);
        }
        resultsG = Array.from(semanticMap.values());


        timings.retrievalMs = Date.now() - retrievalStartedAt;

        // Per-query Search F breakdown: which formulation (zone-based, Oracle-wording,
        // parameterized, tag-based) actually retrieved anything, and how thoroughly, rather than
        // one merged "Search F: 163 cards" number that hides which query did the work
        // (review Priority 8).
        const searchFQueryDetail = functionalRetrievalPlans.map((q, i) => ({
            query: q.query,
            narrow: q.narrow,
            retrieved: (resultsFSets[i] || []).length,
            coverage: resultsFSets[i]?.coverage || null
        }));
        const exactHighlightQueryDetail = exactHighlightQueries.map((q, i) => ({
            query: q.query,
            narrow: q.narrow,
            retrieved: (resultsExactSets[i] || []).length,
            coverage: resultsExactSets[i]?.coverage || null
        }));

        // Stream capture
const streamDiagnostics = {
    "Search A": new Set((resultsA || []).map(c => c.name.toLowerCase())),
    "Search B": new Set((resultsB || []).map(c => c.name.toLowerCase())),
    "Search C": new Set((resultsC || []).map(c => c.name.toLowerCase())),
    "Search D": new Set((resultsD || []).map(c => c.name.toLowerCase())),
    "Search E": new Set((resultsE || []).map(c => c.name.toLowerCase())),
    "Broad Retrieval": new Set((resultsBroad || []).map(c => c.name.toLowerCase())),
    "Shared Source Text": new Set((resultsSharedFlat || []).map(c => c.name.toLowerCase())),
    "Search F": new Set((resultsF || []).map(c => c.name.toLowerCase())),
    "Search G": new Set((resultsG || []).map(c => c.name.toLowerCase())),
    "Search H": new Set((resultsExact || []).map(c => c.name.toLowerCase())),
    ...Object.fromEntries(Object.entries(methodResults).map(([key, value]) => [key, new Set((value || []).map(c => c.name.toLowerCase()))]))
};

// Per-stream coverage (total_cards vs. what was actually fetched) - lets a caller tell "this
// expected card was never retrieved" apart from "this expected card was never retrievABLE
// within the page budget", which a name-presence Set alone can't distinguish
// (project spec Priority 7: retrieval diagnostics; project spec E: coverage guarantees).
// Search F has no single coverage figure of its own since it can run several independent
// queries at once - see searchFQueryDetail below for the per-query breakdown instead.
const streamCoverage = {
    "Search A": resultsA?.coverage || null,
    "Search B": resultsB?.coverage || null,
    "Search C": resultsC?.coverage || null,
    "Search E": resultsE?.coverage || null,
    "Broad Retrieval": resultsBroad?.coverage || null,
    "Shared Source Text": resultsSharedFlat?.coverage || null
};

const sniperCardIds = new Set((resultsA || []).map(card => card.id));
const methodRawCandidates = Object.values(methodResults).flatMap(value => Array.isArray(value) ? value : []);
const rawCandidates = [...resultsA, ...resultsB, ...resultsC, ...resultsD, ...resultsE, ...resultsBroad, ...resultsSharedFlat, ...resultsF, ...resultsG, ...resultsExact, ...methodRawCandidates];
const countRetrieved = rawCandidates.length;

// Stage 1: Raw candidate pool set
const rawCandidateNames = new Set(rawCandidates.map(c => (c.name || '').toLowerCase()));

// Stage 2: Hard Filters Application
const sourceNameLower = normalizeCardNameForIdentity(currentSourceCard.name);
// Records, per rejected card name, exactly which constraint(s) it failed and by how much. This
// is what turns "excluded by constraints" into "cmc: expected 2, actual 4" in the benchmark, so a
// filtered-out expected card immediately shows whether the engine or the test case is wrong
// (review Priority 6).
const filterFailureReasons = new Map();
const filteredCandidates = rawCandidates.filter(card => {
    if (!card || !card.id || !card.name) return false;
    // isSameCardName (not a bare .toLowerCase() comparison) so the source card is excluded even
    // when whitespace formatting differs between how it was loaded and how a search result came
    // back, or when a double-faced/split card's combined "Front // Back" name is compared against
    // just its front face - a bug report showed the source card itself appearing as its own top
    // "similar" result, which a plain string comparison mismatch like this would explain.
    if (card.id === currentSourceCard.id || isSameCardName(card.name, currentSourceCard.name)) return false;

    // Exact highlight = mandatory text constraint. Semantic retrieval is allowed to find candidates
    // that read differently, but it is never allowed to override an explicit Exact highlight.
    if (!matchesExactHighlightConstraints(card, manualHighlights)) {
        const nameKey = card.name.toLowerCase();
        if (!filterFailureReasons.has(nameKey)) {
            filterFailureReasons.set(nameKey, explainExactHighlightFailures(card, manualHighlights));
        }
        return false;
    }

    if (matchesActiveFilters(card, filters, broadFallbackFilters)) return true;

    const nameKey = card.name.toLowerCase();
    if (!filterFailureReasons.has(nameKey)) {
        filterFailureReasons.set(nameKey, explainFilterFailures(card, filters, broadFallbackFilters));
    }
    return false;
});

// Stage 2: Passed hard filters set
const passedFilterNames = new Set(filteredCandidates.map(c => (c.name || '').toLowerCase()));
const countPassedFiltersRaw = filteredCandidates.length;
const exactHighlightConstraintCount = manualHighlights.filter(h => h?.mode !== 'variable' && !h.benchmarkIntentOnly && typeof h.text === 'string' && h.text.trim()).length;

// Dedupe by card NAME rather than Scryfall's print id - different printings (different set,
// frame, or art) of the same card have different ids but are the same card for search purposes,
// and previously showed up as separate, visually duplicate result entries.
const preferBetterPrinting = (existing, incoming) => {
    const hasImage = (c) => Boolean(c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal);
    if (!hasImage(existing) && hasImage(incoming)) return incoming;
    return existing;
};
const candidateMap = new Map();
for (const card of filteredCandidates) {
    const dedupeKey = card.name.toLowerCase();
    const existing = candidateMap.get(dedupeKey);
    candidateMap.set(dedupeKey, existing ? preferBetterPrinting(existing, card) : card);
}
let candidates = Array.from(candidateMap.values());
const countAfterHardFilters = candidates.length;

// ---- RETRIEVAL EVIDENCE (kept separate from the similarity score) ----
// Which streams surfaced a card is provenance, not quality: a card isn't more similar because
// Search F happened to find it. Recording it as its own field keeps it available for diagnostics
// and debugging without letting retrieval origin leak into ranking as a hidden bias
// (review Priority 14). Nothing in scoreCardBatch reads this.
candidates.forEach(card => {
    const nameLower = (card.name || '').toLowerCase();
    card.retrievalEvidence = Object.entries(streamDiagnostics)
        .filter(([, nameSet]) => nameSet.has(nameLower))
        .map(([streamName]) => streamName);
});
// Stage 3: post-dedup set (same names as passedFilterNames, but this is the explicit "one
// entry per unique card" stage the funnel is supposed to show, rather than leaving dedup as an
// invisible side effect of the filter step (project spec Priority 7).
const dedupedNames = new Set(candidates.map(c => (c.name || '').toLowerCase()));

// Keep the scoring weights alive for the entire search request. targetVector was already
// computed by Search G in parallel with retrieval, so the index query and candidate scorer share
// exactly the same normalized source embedding.
const baseWM = hasHighlight ? 60 : 45;
const baseWC = hasHighlight ? 15 : 20;
const baseWS = hasHighlight ? 5 : 10;
const baseWE = hasHighlight ? 10 : 15;
const baseWCa = hasHighlight ? 10 : 10;
const wM = Math.max(0, baseWM + (parseInt(document.getElementById('weight-mechanical')?.value) || 0));
const wC = Math.max(0, baseWC + (parseInt(document.getElementById('weight-context')?.value) || 0));
const wS = Math.max(0, baseWS + (parseInt(document.getElementById('weight-synergy')?.value) || 0));
const wE = Math.max(0, baseWE + (parseInt(document.getElementById('weight-exactness')?.value) || 0));
const wCa = Math.max(0, baseWCa + (parseInt(document.getElementById('weight-category')?.value) || 0));

// Search G owns the target embedding. If the semantic engine is unavailable, targetVector is
// null and scoreCardBatch uses its normal lexical/mechanical fallback channels.


if (candidates.length > 0) {
    updateProgress(2, totalSteps, "Scoring candidate pool via ManaSearch...");
    await backgroundAwareDelay(50); 
    
    const scoringStartedAt = Date.now();

    const { embeddingDiagnostics, semanticCalibration } = await scoreCardBatch({
        cards: candidates,
        sourceCard: currentSourceCard,
        targetText: targetTextForScoring,
        exactnessText: exactnessTextForScoring,
        targetVector,
        targetVectors,
        sourceFunctionVector,
        isCancelled: () => requestId !== searchRequestId,
        extractor,
        weights: { mechanical: wM, synergy: wS, context: wC, exactness: wE, category: wCa },
        tags: activeTags,
        topNNames,
        sniperIds: sniperCardIds,
        activeFilters: filters
    });
    timings.scoringMs = Date.now() - scoringStartedAt;

    // Feed this search's results (and its source card) into the session semantic corpus so a
    // LATER search - on this or any other source card, this session - can find them via Search G
    // purely by meaning, even if that later search's own lexical streams would have missed them.
    // Every candidate here already has its embeddings sitting in embeddingCache from scoring
    // above (keyed by the exact text that was embedded), so this is a cache read, not new work.
    if (extractor && extractor.type !== 'fallback') {
        recordInSessionSemanticCorpus(currentSourceCard, sourceFunctionVector, sourceOracleVector);
        for (const card of candidates) {
            const cardText = card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text).join(' ') : '');
            const candidateFunctionText = card._parsedEffects ? canonicalFunctionToText(getCanonicalFunctions(card._parsedEffects)) : null;
            const functionVector = candidateFunctionText ? (embeddingCache.get(candidateFunctionText) || null) : null;
            const oracleVector = cardText ? (embeddingCache.get(normalizeOracleForEmbedding(cardText, card.name)) || null) : null;
            if (functionVector || oracleVector) recordInSessionSemanticCorpus(card, functionVector, oracleVector);
        }
    }

    const rankingStartedAt = Date.now();

    // Stage 4 (benchmark): every candidate above was actually run through the scorer, so this is
    // the true "scored" population - captured *before* the relevance floor prunes anything, so it
    // doesn't just duplicate the final-rank stage (project spec 2.11).
    const scoredNames = new Set(candidates.map(c => (c.name || '').toLowerCase()));

    // Stage 3.5: which of those scored candidates actually got a meaningful (non-generic) rule
    // parse - a card that was retrieved, filtered, and scored, but whose text mostly fell back
    // to "generic", explains a low mechanicalScore very differently than a card that parsed
    // cleanly and simply isn't very similar (project spec Priority 7: retrieved -> filtered ->
    // scored -> pruned breakdown; also feeds the confidence-aware weighting above).
    const meaningfulParseNames = new Set(candidates.filter(c => (c.parseConfidence || 0) > 0).map(c => (c.name || '').toLowerCase()));

    // Order is a presentation/ranking choice. Relevance pruning stays anchored to the canonical
    // Overall Match score so selecting e.g. Category or Strategic Role does not accidentally turn
    // those secondary channels into hard eligibility tests.
    const scoreKey = 'similarityScore';
    candidates.sort((a, b) => (b[scoreKey] || 0) - (a[scoreKey] || 0));

    // Stage 5: Relevance Floor.
    //
    // The floor has two jobs: (1) keep the final result set focused, and (2) avoid treating a
    // strong match on one dimension as permission for every vaguely-related card to survive. The
    // default path therefore uses absolute + relative thresholds, while a small set of candidates
    // with *strong, direct* evidence can bypass the relative cutoff. Those protected candidates are
    // still subject to the absolute floor unless their direct signal itself is strong enough.
    const ABSOLUTE_RELEVANCE_FLOOR = isBroadSearch ? 0.145 : (isDivergent ? 0.17 : 0.18);
    // Strongly parsed source cards get a tighter relative floor; uncertain sources receive a little
    // more distance so wording/parse gaps do not erase legitimate semantic matches.
    // This is the same source-confidence definition used inside scoreCardBatch, made local here so
    // the relevance-floor stage never depends on a function-scoped variable that is out of scope.
    const floorSourceConfidence = Math.max(0, Math.min(1,
        ((sourceFieldConfidence.overall || 0) * 0.7) + ((sourceParseConfidence || 0) * 0.3)
    ));
    const RELATIVE_RELEVANCE_OFFSET = isDivergent
        ? 0.52
        : (isBroadSearch
            ? 0.30 + (1 - floorSourceConfidence) * 0.12
            : 0.24 + (1 - floorSourceConfidence) * 0.10);

    const bestKeyScore = candidates.reduce((max, c) => Math.max(max, c[scoreKey] || 0), 0);
    const relativeFloor = Math.max(0, bestKeyScore - RELATIVE_RELEVANCE_OFFSET);

    const retrievalAgreementCount = (c) => Math.min(4, c.retrievalEvidence?.length || 0);

    // Strong-evidence protection is based on direct signals, not simply on the blended ranking
    // score. Role protection is only available when the role itself is specific and strong.
    const hasStrongDirectEvidence = (c) => {
        const mech = c.mechanicalScore || 0;
        const fn = c.functionScore || 0;
        const role = c.roleScore || 0;
        const highlight = c.highlightIntentScore || 0;
        const context = c.contextScore || 0;
        const rel = c.relevanceEvidenceScore || 0;
        const semanticHit = Number.isFinite(c._semanticRetrievalSimilarity) ? c._semanticRetrievalSimilarity : 0;
        if (sourceRankingIntentForFloor.kind === 'strategic_role' && role >= 0.72) return true;
        if (sourceRankingIntentForFloor.kind === 'highlighted_effect' && highlight >= 0.68) return true;
        if (mech >= 0.76) return true;
        if (highlight >= 0.76) return true;
        if (fn >= 0.84) return true;
        if (role >= 0.84) return true;
        if (rel >= 0.72 && ((mech >= 0.48 && fn >= 0.58) || (role >= 0.70 && (mech >= 0.40 || fn >= 0.58)))) return true;
        if (context >= 0.80 && (mech >= 0.50 || role >= 0.72)) return true;
        if (semanticHit >= 0.64 && (fn >= 0.30 || context >= 0.26 || role >= 0.40 || mech >= 0.22)) return true;
        return false;
    };

    const passesAbsoluteFloor = c => (c[scoreKey] || 0) >= ABSOLUTE_RELEVANCE_FLOOR || (Number.isFinite(c._semanticRetrievalSimilarity) && c._semanticRetrievalSimilarity >= 0.70);
    const passesRelativeFloor = c => (c[scoreKey] || 0) >= relativeFloor || (Number.isFinite(c._semanticRetrievalSimilarity) && c._semanticRetrievalSimilarity >= 0.64);

    const strictQualified = candidates
        .filter(c => passesAbsoluteFloor(c) && (passesRelativeFloor(c) || hasStrongDirectEvidence(c)))
        .sort((a, b) => (b[scoreKey] || 0) - (a[scoreKey] || 0));

    // Catastrophic-empty guard. A relevance floor must control noisy results, not make a valid
    // search disappear completely. This can happen when semantic calibration lowers the absolute
    // score range, when the parser is uncertain, or when the source is a deliberately divergent
    // / differently-worded effect. In that case preserve the strongest *evidence-bearing* cards
    // and let the ranker order them. This is intentionally not normal weak-result backfill: it only
    // activates when the strict floor would return zero cards.
    let qualified = strictQualified;
    if (qualified.length === 0 && candidates.length > 0) {
        const evidenceBearing = candidates
            .filter(c => {
                const structural = Number(c.mechanicalScore) || 0;
                const semantic = Number(c.oracleSemanticScore) || 0;
                const fn = Number(c.functionScore) || 0;
                const role = Number(c.roleScore) || 0;
                const exact = Number(c.exactnessScore) || 0;
                const rel = Number(c.relevanceEvidenceScore) || 0;
                const retrieval = Number(c._semanticRetrievalSimilarity) || 0;
                return Math.max(structural, semantic, fn, role, exact, rel, retrieval) > 0.02;
            })
            .sort((a, b) => {
                const signal = c => Math.max(
                    Number(c[scoreKey]) || 0,
                    (Number(c.relevanceEvidenceScore) || 0) * 0.92,
                    (Number(c._semanticRetrievalSimilarity) || 0) * 0.78
                );
                return signal(b) - signal(a);
            });

        // Keep enough of the scored pool for meaningful top-k ranking, while still bounding the
        // rescue pool so a broad search cannot flood the UI. Eight is the normal display target;
        // twenty preserves enough headroom for ranking/tie-breaking and benchmark Recall@20.
        const CATASTROPHIC_EMPTY_RESCUE_CAP = 20;
        qualified = (evidenceBearing.length > 0 ? evidenceBearing : candidates.slice().sort((a,b) => (b[scoreKey] || 0) - (a[scoreKey] || 0)))
            .slice(0, Math.min(CATASTROPHIC_EMPTY_RESCUE_CAP, candidates.length));

        qualified.forEach(c => { c._catastrophicEmptyRescue = true; });
        embeddingDiagnostics.relevanceFloorRescue = qualified.length;
    }

    candidates = qualified;
    candidates.forEach(c => {
        if (!c._catastrophicEmptyRescue) c._weakBackfillMatch = false;
        c._isProvisionalScore = false;
    });

    candidates = applyResultOrdering(candidates, priorityValue);

    const countAfterRelevanceFloor = candidates.length;
    const relevanceFloorRescued = candidates.filter(c => c._catastrophicEmptyRescue).length;
    // Stage 6: what survived pruning. Matrix Sweep is an Order mode, so it never trims the
    // scored candidate pool.
    const passedRelevanceFloorNames = new Set(candidates.map(c => (c.name || '').toLowerCase()));

    if (isDivergent) {
        // "Divergent Search" was previously a dead checkbox (found while auditing the pipeline):
        // it set totalSteps to 5, but nothing anywhere else ever branched on isDivergent, so
        // checking it changed the progress bar's denominator and NOTHING about the actual
        // results. This gives it real teeth: a Maximal Marginal Relevance (MMR) pass that
        // actively pushes the shown results apart from each other by genuine semantic distance,
        // not just a coarse "same top function label or not" bucket - two cards can share a
        // primary canonical function label while reading nothing alike in every OTHER respect, or
        // vice versa, and a discrete bucket can't tell the difference the way an embedding
        // distance can (user request: results should be more different from each other).
        updateProgress(3, totalSteps, "Measuring similarity between candidates...");

        // Every candidate here was already embedded during this search's own scoring pass (either
        // as its function-text vector or its raw-oracle vector), so reading those back out of
        // embeddingCache is a cache lookup, not a new model call - this diversity pass costs
        // nothing beyond arithmetic on vectors that already exist.
        const vectorOf = (card) => {
            const functionText = card._parsedEffects ? canonicalFunctionToText(getCanonicalFunctions(card._parsedEffects)) : null;
            if (functionText && embeddingCache.has(functionText)) return embeddingCache.get(functionText);
            const oracleText = card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text).join(' ') : '');
            const normalizedOracle = oracleText ? normalizeOracleForEmbedding(oracleText, card.name) : '';
            return (normalizedOracle && embeddingCache.has(normalizedOracle)) ? embeddingCache.get(normalizedOracle) : null;
        };

        // MMR is naturally O(pool^2) per pick (compare every remaining candidate against every
        // already-selected one), so O(pool^3) overall - fine for dozens of candidates, not for a
        // pool that could now run into the hundreds thanks to the widened relevance floor above.
        // Cap the pool at the top-scored candidates (candidates is already sorted by scoreKey
        // coming into this block) rather than letting the algorithmic cost scale unbounded with
        // however permissive the floor turned out to be this search.
        const MMR_POOL_CAP = 80;
        const pool = candidates.slice(0, MMR_POOL_CAP).map(card => ({ card, vector: vectorOf(card) }));
        const bestScore = pool.reduce((max, p) => Math.max(max, p.card[scoreKey] || 0), 0) || 1;

        updateProgress(4, totalSteps, "Selecting a diverse spread of results...");
        // Lambda balances "is this a good match on its own" against "is this different from what
        // I've already picked". 0.6 keeps relevance in the driver's seat - the single best match
        // overall is always picked first, since nothing is selected yet to be different from -
        // while still giving real, not token, weight to diversity on every pick after that.
        const LAMBDA = 0.6;
        // Two candidates with no comparable vector (neither side embedded, or the model was
        // unavailable this search) shouldn't be treated as "unknown, so assume they're diverse" -
        // that would let genuinely redundant results slip through unpenalized just because their
        // embeddings happened to be missing. Default the unknown case to a moderately high assumed
        // similarity instead, erring toward caution rather than false diversity.
        const UNKNOWN_SIMILARITY = 0.5;

        const selected = [];
        const remaining = pool.slice();
        while (remaining.length > 0) {
            let bestIdx = 0;
            let bestMmr = -Infinity;
            for (let i = 0; i < remaining.length; i++) {
                const relevance = (remaining[i].card[scoreKey] || 0) / bestScore;
                let maxSimToSelected = 0;
                for (const sel of selected) {
                    const sim = (remaining[i].vector && sel.vector)
                        ? Math.max(0, cosineSimilarity(remaining[i].vector, sel.vector))
                        : UNKNOWN_SIMILARITY;
                    if (sim > maxSimToSelected) maxSimToSelected = sim;
                }
                const mmr = (LAMBDA * relevance) - ((1 - LAMBDA) * maxSimToSelected);
                if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
            }
            selected.push(remaining[bestIdx]);
            remaining.splice(bestIdx, 1);
        }
        // Any candidates beyond the MMR_POOL_CAP (lower-scored than everything actually
        // considered for diversity) are appended after, still in score order, rather than
        // dropped outright - divergent mode should show MORE results, not fewer, than a normal
        // search (user request), so a deep relevance-floor pool isn't silently truncated back
        // down to the cap.
        candidates = [...selected.map(s => s.card), ...candidates.slice(MMR_POOL_CAP)];
        updateProgress(5, totalSteps, "Finalizing diverse ranked results...");
    }

    // Stage 7: final ranked output actually shown to the user.
    const finalRankedNames = new Set(candidates.map(c => (c.name || '').toLowerCase()));

    timings.rankingMs = Date.now() - rankingStartedAt;

    lastSearchResults = candidates;
    // Count unique, hard-filtered candidates that actually reached scoring. The raw retrieved
    // count can contain duplicates because multiple retrieval streams can surface the same card.
    lastSearchCandidateCount = countAfterHardFilters;

    // Collect a resumable cursor from every stream that was deliberately capped mid-pagination
    // (see fetchScryfallSearch's `.continuation`) - Search D (Card2Vec via fetchScryfallCollection)
    // and Search G (local session-corpus lookup) aren't paginated the same way and never carry one.
    // Search Deeper must preserve every authoritative constraint from the original search.
    // In particular, Exact Highlight retrieval (Search H) is a real paginated stream too; if its
    // continuation is omitted here, deeper clicks can start pulling from A/B/C/E/F only. Even more
    // importantly, exact-highlight constraints must be re-applied before scoring/ranking deeper
    // candidates, because a continuation page is not semantically privileged just because it came
    // from a broader lexical stream.
    const deeperStreamCursors = [resultsA, resultsB, resultsC, resultsE, resultsBroad, ...resultsFSets, ...resultsExactSets]
        .map(r => r?.continuation)
        .filter(Boolean);
    pendingDeeperSearch = deeperStreamCursors.length > 0 ? {
        requestId,
        streams: deeperStreamCursors,
        existingNames: new Set(candidates.map(c => (c.name || '').toLowerCase())),
        context: {
            filters, broadFallbackFilters,
            weights: { mechanical: wM, synergy: wS, context: wC, exactness: wE, category: wCa },
            tags: activeTags, topNNames, sniperIds: sniperCardIds,
            targetTextForScoring, targetVector, targetVectors, extractor,
            sourceCard: currentSourceCard, scoreKey, orderCriteria: validOrderCriteriaForOrdering(priorityValue),
            // Snapshot the highlight state so Search Deeper cannot accidentally consult mutated
            // global UI state if the user changes/removes a highlight after the initial search.
            highlightConstraints: (manualHighlights || []).map(h => ({
                text: typeof h?.text === 'string' ? h.text : '',
                mode: h?.mode === 'variable' ? 'variable' : 'exact'
            }))
        }
    } : null;
    const searchDeeperBtn = document.getElementById('search-deeper-btn');
    if (searchDeeperBtn) {
        searchDeeperBtn.classList.toggle('hidden', !pendingDeeperSearch);
        searchDeeperBtn.disabled = false;
        searchDeeperBtn.textContent = '🔍 Search Deeper (+8 pages/stream)';
    }

    const rankingEvidenceTop = candidates.slice(0, 20).map((card, index) => ({
        rank: index + 1, name: card.name || '', overall: Number(card.similarityScore) || 0,
        evidence: card.rankingEvidence || null, retrievalEvidence: card.retrievalEvidence || []
    }));

    lastSearchDiagnostics = {
        retrieved: countRetrieved,
        passedFiltersRaw: countPassedFiltersRaw,
        afterHardFilters: countAfterHardFilters,
        afterRelevanceFloor: countAfterRelevanceFloor,
        relevanceFloorRescued,
        relevanceFloorStrictCount: strictQualified.length,
        relevanceFloorBestScore: bestKeyScore,
        relevanceFloorRelativeThreshold: relativeFloor,
        finalResults: candidates.length,
        streams: streamDiagnostics,
        streamCoverage,
        searchFQueryDetail,
        exactHighlightQueryDetail,
        timings,
        // How the embedding cache performed for this search's scoring pass, including how many
        // candidates fell back to lexical-only contextScore because a model call failed mid-batch
        // - previously silent (review: embedding diagnostics).
        embeddingDiagnostics,
        semanticCalibration,
        rankingEvidenceTop,
        highlightIntentDiagnostics: hasHighlight ? highlightProfilesForSearch.map(p => ({
            groupId: p.groupId, contextText: p.contextText, mode: p.mode, selections: p.selections,
            canonicalText: p.canonicalText, parserConfidence: p.parserConfidence,
            benchmarkIntentOnly: Boolean(p.benchmarkIntentOnly)
        })) : [],
        // Stage-by-stage candidate visibility tracking: retrieved -> filtered -> deduplicated ->
        // parsed meaningfully -> scored -> pruned (relevance floor) -> ranked (final).
        rawCandidateNames,
        passedFilterNames,
        dedupedNames,
        meaningfulParseNames,
        scoredNames,
        passedRelevanceFloorNames,
        finalRankedNames,
        filterFailureReasons
    };
} else {
    lastSearchResults = [];
    lastSearchDiagnostics = {
        retrieved: countRetrieved,
        passedFiltersRaw: countPassedFiltersRaw,
        afterHardFilters: 0,
        afterRelevanceFloor: 0,
        finalResults: 0,
        streams: streamDiagnostics,
        streamCoverage,
        searchFQueryDetail,
        exactHighlightQueryDetail,
        timings,
        // No candidates reached scoring, so no embedding calls were made this search.
        embeddingDiagnostics: null,
        rawCandidateNames,
        passedFilterNames,
        dedupedNames,
        meaningfulParseNames: new Set(),
        scoredNames: new Set(),
        passedRelevanceFloorNames: new Set(),
        finalRankedNames: new Set(),
        filterFailureReasons
    };
}

        // A newer search or an active Related Search owns the Results grid. Never let a slow
        // background main-search completion overwrite the active result view.
        if (requestId !== searchRequestId || activeResultView.mode !== 'main' || activeResultView.requestId !== requestId) return;

        pipelineCompleted = true;
        activeSearchStreamProgressReporter = null;
        updateProgress(3, totalSteps, `Finalizing results — ranking complete; found ${Array.isArray(lastSearchResults) ? lastSearchResults.length : 0} final matches.`);
        clearTimeout(searchTimeoutId);
        if (previewRenderTimer) { clearTimeout(previewRenderTimer); previewRenderTimer = null; }
        previewRenderDirty = false;
        document.getElementById('provisional-results-banner')?.classList.add('hidden');
        const renderStartedAt = Date.now();
        renderResults(lastSearchResults);
        updateResultsSummary();

        // Search G has already been executed as part of the main candidate pool. The old
        // post-render scan of the same static index was removed because it duplicated work and
        // made semantic retrieval appear to arrive late. If the static asset is unavailable,
        // normal lexical/functional retrieval remains the graceful fallback.

        // The diagnostics object is a plain object now (not a property hung off the results
        // array), so mutating it after the fact is safe and doesn't risk the loss bug that
        // motivated separating this state in the first place.
        if (lastSearchDiagnostics) {
            lastSearchDiagnostics.timings.renderMs = Date.now() - renderStartedAt;
            lastSearchDiagnostics.timings.totalMs = Date.now() - searchStartedAt;
        }

    } catch (error) {
        if (requestId !== searchRequestId) return;
        pipelineCompleted = true;
        clearTimeout(searchTimeoutId);
        document.getElementById('provisional-results-banner')?.classList.add('hidden');
        if (isScryfallRateLimitError(error) || error?.scryfallCircuitOpen) {
            if (!error?.isLocalCooldownRejection) {
                console.warn('Scryfall retrieval stopped for the affected stream:', error?.message || error);
            }
            showScryfallCooldownNotice('Scryfall rate limit/network block affected one retrieval stream. Partial results were retained; no retry was sent for the failed request.');
        } else {
            console.error("Error in findSimilarCards:", error);
            if (typeof alert === 'function') alert(error.message);
        }
    } finally {
        if (requestId === searchRequestId) activeSearchStreamProgressReporter = null;
        clearTimeout(searchTimeoutId);
        if (requestId === searchRequestId && activeResultView.mode === 'main' && activeResultView.requestId === requestId) {
            updateProgress(null, null, "All done! Candidates retrieved and ranked purely by similarity.");
            showLoading(false);
        }
    }
}

/**
 * Fetches another batch of pages (8 per stream by default) for whichever retrieval streams were
 * capped mid-pagination on the last search, scores just the newly-found candidates, merges them
 * into the already-displayed results, and re-renders. This is deliberately NOT a full re-run of
 * findSimilarCards: re-deriving queries from the DOM again would re-fetch pages already fetched
 * (Scryfall search results are cached by exact query/page, so a fresh fetchScryfallSearch call
 * would just hand back the same truncated cache entry, not new pages) and would re-score cards
 * already scored. Using the saved continuation cursors and search context from pendingDeeperSearch
 * instead means every fetch here is for genuinely new pages, and every score computed here is for
 * a genuinely new card.
 *
 * Scope note: this applies the same relevance-quality gate as the main pipeline uses, but does not
 * re-run the relative-to-best pruning pass or the divergent/MMR pass against the newly-merged set.
 * Matrix Sweep is an Order mode and is re-applied through the saved order criterion instead.
 * New results are simply merged in and re-sorted by the same scoreKey the original search used.
 */
async function searchDeeper() {
    if (!pendingDeeperSearch || pendingDeeperSearch.streams.length === 0) return;
    if (pendingDeeperSearch.requestId !== searchRequestId) {
        pendingDeeperSearch = null;
        const staleBtn = document.getElementById('search-deeper-btn');
        if (staleBtn) staleBtn.classList.add('hidden');
        return;
    }

    const requestId = searchRequestId;
    const searchDeeperBtn = document.getElementById('search-deeper-btn');
    if (searchDeeperBtn) {
        searchDeeperBtn.disabled = true;
        searchDeeperBtn.textContent = 'Searching deeper...';
    }

    const PAGES_PER_CLICK = 8;
    const { streams, existingNames, context } = pendingDeeperSearch;

    try {
        const batchResults = await Promise.all(
            streams.map(c => fetchScryfallContinuationPages(c, PAGES_PER_CLICK).catch(() => ({ results: [], continuation: null, bailedAfterRetries: true })))
        );
        if (requestId !== searchRequestId || pendingDeeperSearch?.requestId !== requestId) return;

        const newRawCards = [];
        const seenThisBatch = new Set();
        for (const batch of batchResults) {
            for (const card of batch.results) {
                const key = (card.name || '').toLowerCase();
                if (existingNames.has(key) || seenThisBatch.has(key)) continue;
                seenThisBatch.add(key);
                newRawCards.push(card);
            }
        }

        // Apply the exact-highlight constraint BEFORE any expensive scoring. Search Deeper is an
        // extension of the original search, not a new unrestricted search, so an Exact highlight
        // remains mandatory on every additional page/stream. Flexible highlights remain ranking
        // intent only.
        const passedFilters = newRawCards.filter(c =>
            matchesExactHighlightConstraints(c, context.highlightConstraints || []) &&
            matchesActiveFilters(c, context.filters, context.broadFallbackFilters)
        );

        if (passedFilters.length > 0) {
            await scoreCardBatch({
                cards: passedFilters,
                sourceCard: context.sourceCard,
                targetText: context.targetTextForScoring,
                targetVector: context.targetVector,
                targetVectors: context.targetVectors,
                extractor: context.extractor,
                isCancelled: () => requestId !== searchRequestId,
                weights: context.weights,
                tags: context.tags,
                topNNames: context.topNNames,
                sniperIds: context.sniperIds,
                activeFilters: context.filters
            });
            if (requestId !== searchRequestId || pendingDeeperSearch?.requestId !== requestId) return;

            // Same basic quality gate as the main pipeline's absolute floor (kept in sync with the
            // constant in findSimilarCards) - a candidate that scores below this was never a
            // plausible result regardless of which search pass found it. Gated on context.scoreKey
            // rather than always similarityScore, matching the main pipeline's floor (rank system
            // item 5) - a "search deeper" run should respect the same active sort criteria as the
            // search it's extending.
            const ABSOLUTE_RELEVANCE_FLOOR = 0.18;
            const qualified = passedFilters.filter(c => {
                // Defense-in-depth: the exact constraint was already applied before scoring, but
                // keep the invariant here too so future search-deeper changes cannot accidentally
                // render an invalid candidate.
                if (!matchesExactHighlightConstraints(c, context.highlightConstraints || [])) return false;
                const score = c[context.scoreKey] || 0;
                const direct = Math.max(c.mechanicalScore || 0, c.functionScore || 0, c.roleScore || 0, c.highlightIntentScore || 0);
                return score >= ABSOLUTE_RELEVANCE_FLOOR || (direct >= 0.80 && score >= 0.14);
            });

            lastSearchResults = applyResultOrdering(
                [...lastSearchResults, ...qualified],
                context.orderCriteria || 'overall'
            );
            if (Number.isFinite(lastSearchCandidateCount)) lastSearchCandidateCount += qualified.length;
            renderResults(lastSearchResults);
            updateResultsSummary();

            qualified.forEach(c => existingNames.add((c.name || '').toLowerCase()));
        }

        // Keep only the streams that still have more pages; drop the ones that are now exhausted.
        if (requestId !== searchRequestId || pendingDeeperSearch?.requestId !== requestId) return;
        pendingDeeperSearch.streams = batchResults.map(b => b.continuation).filter(Boolean);

        if (pendingDeeperSearch.streams.length === 0) {
            pendingDeeperSearch = null;
            if (searchDeeperBtn) searchDeeperBtn.classList.add('hidden');
        } else if (searchDeeperBtn) {
            searchDeeperBtn.disabled = false;
            searchDeeperBtn.textContent = '🔍 Search Deeper (+8 pages/stream)';
        }
    } catch (error) {
        console.error("Error in searchDeeper:", error);
        if (requestId === searchRequestId && searchDeeperBtn) {
            searchDeeperBtn.disabled = false;
            searchDeeperBtn.textContent = '🔍 Search Deeper (+8 pages/stream)';
        }
    }
}

function getRankingScoreForCriteria(card, criteria) {
    if (!card) return 0;
    switch (criteria) {
        case 'functional': return Number(card.functionScore) || 0;
        case 'semantic': return Number(card.contextScore) || 0;
        case 'role': return Number(card.roleScore) || 0;
        case 'balanced': {
            const mechanical = Number(card.mechanicalScore) || 0;
            const functional = Number(card.functionScore) || 0;
            return (mechanical * 0.65) + (functional * 0.35);
        }
        case 'mechanical': return Number(card.mechanicalScore) || 0;
        case 'synergy': return Number(card.synergyScore) || 0;
        case 'exactness': return Number(card.exactnessScore) || 0;
        case 'category': return Number(card.categoryScore) || 0;
        case 'overall':
        default: return Number(card.similarityScore) || 0;
    }
}

function buildMatrixSweepOrder(cards, criteria = 'overall') {
    const groups = new Map();
    (cards || []).forEach(card => {
        const cmc = Number.isFinite(Number(card?.cmc)) ? Math.floor(Number(card.cmc)) : 'X';
        const typeLine = String(card?.type_line || '').toLowerCase();
        const type = ['creature', 'instant', 'sorcery', 'enchantment', 'artifact', 'planeswalker', 'land']
            .find(t => typeLine.includes(t)) || 'other';
        const key = `${cmc}-${type}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(card);
    });
    const scoreOf = card => getRankingScoreForCriteria(card, criteria);
    const orderedGroups = Array.from(groups.values()).map(group =>
        group.slice().sort((a, b) => scoreOf(b) - scoreOf(a))
    );
    const output = [];
    const maxLength = orderedGroups.reduce((m, group) => Math.max(m, group.length), 0);
    for (let round = 0; round < maxLength; round++) {
        const roundCards = orderedGroups.filter(group => group[round]).map(group => group[round]);
        roundCards.sort((a, b) => scoreOf(b) - scoreOf(a));
        output.push(...roundCards);
    }
    return output;
}

function buildDiverseOrder(cards, criteria = 'overall') {
    const input = Array.isArray(cards) ? cards.slice() : [];
    if (input.length < 3) return input;
    const pool = input.slice(0, 80);
    const rest = input.slice(80);
    const vectorOf = card => {
        const functionText = card?._parsedEffects ? canonicalFunctionToText(getCanonicalFunctions(card._parsedEffects)) : null;
        if (functionText && embeddingCache.has(functionText)) return embeddingCache.get(functionText);
        const oracleText = card?.oracle_text || (card?.card_faces ? card.card_faces.map(f => f.oracle_text || '').join(' ') : '');
        const normalized = oracleText ? normalizeOracleForEmbedding(oracleText, card?.name) : '';
        return normalized && embeddingCache.has(normalized) ? embeddingCache.get(normalized) : null;
    };
    const entries = pool.map(card => ({ card, vector: vectorOf(card) }));
    const scoreOf = card => Math.max(0, Number(getRankingScoreForCriteria(card, criteria)) || 0);
    const bestScore = Math.max(0.0001, ...entries.map(e => scoreOf(e.card)));
    const selected = [];
    const remaining = entries.slice();
    const lambda = 0.62;
    const unknownSimilarity = 0.5;
    while (remaining.length) {
        let bestIndex = 0;
        let bestValue = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const item = remaining[i];
            const relevance = scoreOf(item.card) / bestScore;
            let redundancy = 0;
            for (const picked of selected) {
                const sim = item.vector && picked.vector
                    ? Math.max(0, cosineSimilarity(item.vector, picked.vector))
                    : unknownSimilarity;
                redundancy = Math.max(redundancy, sim);
            }
            const value = lambda * relevance - (1 - lambda) * redundancy;
            if (value > bestValue) { bestValue = value; bestIndex = i; }
        }
        selected.push(remaining.splice(bestIndex, 1)[0]);
    }
    return [...selected.map(x => x.card), ...rest];
}

function applyResultOrdering(cards, criteria, featureFlags = null) {
    const input = Array.isArray(cards) ? cards.slice() : [];
    const ranking = validOrderCriteriaForOrdering(criteria);
    const features = featureFlags || activeOrderFeatureFlags;
    let output = input.sort((a, b) => getRankingScoreForCriteria(b, ranking) - getRankingScoreForCriteria(a, ranking));

    // Features are presentation modifiers layered on top of the selected ranking. They can be
    // combined with one another and never replace the primary ranking category.
    if (features.diverse) output = buildDiverseOrder(output, ranking);
    if (features.matrix) output = buildMatrixSweepOrder(output, ranking);
    return output;
}

function validOrderCriteriaForOrdering(criteria) {
    const allowed = new Set(['overall','mechanical','functional','semantic','role','balanced','synergy','exactness','category']);
    return allowed.has(criteria) ? criteria : 'overall';
}

function reorderResults() {
    if (!lastSearchResults || lastSearchResults.length === 0) return;
    const criteria = validOrderCriteriaForOrdering(document.getElementById('sort-results')?.value || 'overall');
    lastSearchResults = applyResultOrdering(lastSearchResults, criteria, activeOrderFeatureFlags);
}

async function copyCardNameToClipboard(cardName, button = null) {
    const text = String(cardName || '').trim();
    if (!text) return;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
        }
        if (button) {
            const previous = button.textContent;
            button.textContent = 'Copied';
            button.classList.add('copied');
            setTimeout(() => {
                if (button.isConnected) {
                    button.textContent = previous;
                    button.classList.remove('copied');
                }
            }, 1100);
        }
    } catch (error) {
        console.warn('Could not copy card name:', error.message);
        if (button) button.textContent = 'Copy';
    }
}

// Result-card face state is kept separately from the Scryfall objects so re-ranking or
// progressive re-renders do not reset a user's front/back selection on double-faced cards.
const resultCardFaceState = new Map();

function getResultCardStateKey(card) {
    return String(card?.id || card?.oracle_id || card?.name || '').toLowerCase();
}

function updateResultsSummary() {
    const summary = document.getElementById('results-summary');
    if (!summary) return;

    const finalCount = Array.isArray(lastSearchResults) ? lastSearchResults.length : 0;
    const candidateCount = Number.isFinite(lastSearchCandidateCount) ? lastSearchCandidateCount : null;
    const visibleCount = Math.min(finalCount, getDisplayedResultLimit());

    if (candidateCount === null) {
        summary.textContent = '';
        summary.classList.add('hidden');
        return;
    }

    const resultWord = finalCount === 1 ? 'result' : 'results';
    const candidateWord = candidateCount === 1 ? 'candidate' : 'candidates';

    if (finalCount === 0) {
        summary.textContent = `No final results matched. ${candidateCount} ${candidateWord} were evaluated.`;
    } else if (finalCount > visibleCount) {
        summary.textContent = `Found ${finalCount} ${resultWord} from ${candidateCount} ${candidateWord} evaluated. Showing the top ${visibleCount}.`;
    } else {
        summary.textContent = `Found ${finalCount} ${resultWord} from ${candidateCount} ${candidateWord} evaluated.`;
    }
    summary.classList.remove('hidden');
}

function renderResults(cards) {
    resultsSection.classList.remove('hidden');

    // Final safety-net filtering, right before anything touches the DOM. Keep this local to the
    // presentation layer; callers retain ownership of lastSearchResults/diagnostics.
    let displayCards = cards;
    if (Array.isArray(cards)) {
        const seenNames = new Set();
        const deduped = [];
        for (const card of cards) {
            const key = normalizeCardNameForIdentity(card?.name || '');
            if (!key || seenNames.has(key)) continue;
            if (currentSourceCard && card?.name && isSameCardName(card.name, currentSourceCard.name)) continue;
            seenNames.add(key);
            deduped.push(card);
        }
        displayCards = deduped;
    }

    if (!displayCards || displayCards.length === 0) {
        visibleResultCardData.clear();
        resultsGrid.replaceChildren();
        const note = document.createElement('p');
        note.className = 'instruction-note';
        note.style.gridColumn = '1 / -1';
        note.textContent = 'No matching cards found. Try loosening your filters.';
        resultsGrid.appendChild(note);
        exportBtn.style.display = 'none';
        return;
    }

    exportBtn.style.display = 'block';
    const topCards = displayCards.slice(0, getDisplayedResultLimit());
    visibleResultCardData.clear();
    // Event delegation identifies cards by the same stable name key stored on each result node.
    // Keep this map keyed by getCardKey(), not getResultCardStateKey(): the latter uses the
    // Scryfall id and was the cause of result-selection clicks resolving to no card.
    topCards.forEach(card => visibleResultCardData.set(
        normalizeCardNameForIdentity(card?.name || '') || getResultCardStateKey(card),
        card
    ));

    // Result identity is by Oracle/card name for DOM stability. Different printings of the same
    // card are already deduplicated before display, and using the name here keeps the existing DOM
    // node (especially its image) alive if a later stream replaces the printing object.
    const getCardKey = card => normalizeCardNameForIdentity(card?.name || '') || getResultCardStateKey(card);
    const existingNodes = new Map();
    resultsGrid.querySelectorAll('.card-item[data-card-key]').forEach(node => existingNodes.set(node.dataset.cardKey, node));
    const fragment = document.createDocumentFragment();

    const updateResultCard = (cardElement, card) => {
        const isSelected = selectedRelatedCards.has(card.id);
        const cardImg = card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || 'https://placeholder.pics/svg/220x310/EAEAEA/999999/No%20Image';
        const displaySimilarityScore = Number.isFinite(Number(card.similarityScore))
            ? Number(card.similarityScore)
            : (Number.isFinite(Number(card._previewScore)) ? Number(card._previewScore) : 0);
        const matchPercentage = Math.round(Math.max(0, Math.min(1, displaySimilarityScore)) * 100);
        const priceUsd = card.prices?.usd ? '$' + card.prices.usd : 'N/A';
        const priceEur = card.prices?.eur ? '€' + card.prices.eur : 'N/A';
        const scores = {
            Mechanical: card.mechanicalScore ? Math.round(card.mechanicalScore * 100) : 0,
            Context: card.contextScore ? Math.round(card.contextScore * 100) : 0,
            Synergy: card.synergyScore ? Math.round(card.synergyScore * 100) : 0,
            Exactness: card.exactnessScore ? Math.round(card.exactnessScore * 100) : 0,
            Category: card.categoryScore ? Math.round(card.categoryScore * 100) : 0
        };

        cardElement.classList.toggle('selected-card', isSelected);
        // Do not animate/recolor cards during progressive ranking; score updates should be visually stable.
        cardElement.classList.remove('newly-added');
        cardElement.dataset.cardKey = getCardKey(card);

        const img = cardElement.querySelector('.card-art-wrap img');
        const faceImages = Array.isArray(card.card_faces) ? card.card_faces.filter(face => face?.image_uris?.normal) : [];
        const hasMultipleFaces = faceImages.length > 1;
        const stateKey = getResultCardStateKey(card);
        const faceIndex = hasMultipleFaces
            ? Math.max(0, Math.min(faceImages.length - 1, Number(resultCardFaceState.get(stateKey)) || 0))
            : 0;
        const desiredSrc = hasMultipleFaces ? faceImages[faceIndex].image_uris.normal : cardImg;
        if (img && img.getAttribute('src') !== desiredSrc) img.src = desiredSrc;
        if (img) img.alt = hasMultipleFaces ? (faceImages[faceIndex].name || card.name) : card.name;

        const flipBtn = cardElement.querySelector('.card-flip-btn');
        if (flipBtn) flipBtn.hidden = !hasMultipleFaces;

        const title = cardElement.querySelector('.card-item-title');
        if (title) title.textContent = card.name;
        const typeLine = cardElement.querySelector('.result-type-line');
        if (typeLine) typeLine.textContent = card.type_line || '';
        const matchLine = cardElement.querySelector('.card-match-line');
        if (matchLine) matchLine.textContent = `Overall Match: ${matchPercentage}%`;

        const badge = cardElement.querySelector('.weak-match-badge');
        if (card._weakBackfillMatch) {
            if (badge) {
                badge.hidden = false;
            } else {
                const b = document.createElement('p');
                b.className = 'weak-match-badge';
                b.textContent = 'Weak match - shown to fill out the list';
                b.title = 'This result didn\'t clear the usual relevance bar. It\'s shown because too few stronger matches were found, not because it\'s a confident recommendation.';
                const info = cardElement.querySelector('.card-item-info');
                const scoreBreakdown = cardElement.querySelector('.result-score-breakdown');
                if (info) info.insertBefore(b, scoreBreakdown || null);
            }
        } else if (badge) {
            badge.remove();
        }

        const breakdown = cardElement.querySelector('.result-score-breakdown');
        if (breakdown) {
            const lines = Array.from(breakdown.querySelectorAll('.score-line'));
            ['Mechanical','Context','Synergy','Exactness','Category'].forEach((label, i) => {
                if (lines[i]) lines[i].textContent = `${label}: ${scores[label]}%`;
            });
            const priceLabel = breakdown.querySelector('.card-price-label');
            const fullPriceLabel = `Price: ${priceUsd} / ${priceEur}`;
            if (priceLabel) { priceLabel.textContent = fullPriceLabel; priceLabel.title = fullPriceLabel; }
            breakdown.style.display = displayPreferences.showScoreBreakdown ? '' : 'none';
        }

        const favoriteBtn = cardElement.querySelector('.result-favorite-btn');
        if (favoriteBtn) {
            const isFav = getStoredArray(FAVORITES_KEY).some(name => String(name).toLowerCase() === String(card.name).toLowerCase());
            favoriteBtn.textContent = isFav ? '★' : '☆';
            favoriteBtn.classList.toggle('is-favorited', isFav);
            favoriteBtn.title = isFav ? `Remove ${card.name} from favorites` : `Add ${card.name} to favorites`;
            favoriteBtn.setAttribute('aria-label', favoriteBtn.title);
        }
        const checkbox = cardElement.querySelector('.related-checkbox');
        if (checkbox) checkbox.checked = isSelected;
    };

    const createResultCard = card => {
        const el = document.createElement('div');
        el.className = 'card-item';
        el.dataset.cardKey = getCardKey(card);

        const artWrap = document.createElement('div');
        artWrap.className = 'card-art-wrap';
        const img = document.createElement('img');
        img.loading = 'lazy';
        artWrap.appendChild(img);
        const flipBtn = document.createElement('button');
        flipBtn.type = 'button';
        flipBtn.className = 'card-flip-btn';
        flipBtn.textContent = 'Flip';
        flipBtn.title = 'Flip card face';
        flipBtn.setAttribute('aria-label', `Flip ${card.name}`);
        flipBtn.hidden = true;
        artWrap.appendChild(flipBtn);

        const info = document.createElement('div');
        info.className = 'card-item-info';
        const titleRow = document.createElement('div');
        titleRow.className = 'card-item-title-row';
        const title = document.createElement('h4');
        title.className = 'card-item-title';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'copy-card-name-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.title = `Copy ${card.name}`;
        copyBtn.setAttribute('aria-label', `Copy ${card.name} to clipboard`);
        titleRow.append(title, copyBtn);

        const typeLine = document.createElement('p');
        typeLine.className = 'result-type-line';
        typeLine.style.cssText = 'font-size: 12px; color: var(--text-muted); margin: 0;';
        const matchLine = document.createElement('p');
        matchLine.className = 'card-match-line';
        matchLine.style.cssText = 'font-size: 11px; color: var(--accent-color); font-weight: bold; margin: 4px 0;';

        const breakdown = document.createElement('div');
        breakdown.className = 'result-score-breakdown';
        for (const label of ['Mechanical','Context','Synergy','Exactness','Category']) {
            const line = document.createElement('span');
            line.className = 'score-line';
            line.dataset.scoreLabel = label;
            breakdown.appendChild(line);
        }
        const priceLabel = document.createElement('div');
        priceLabel.className = 'card-price-label';
        breakdown.appendChild(priceLabel);

        const actions = document.createElement('div');
        actions.className = 'card-actions';
        actions.style.cssText = 'display: grid; grid-template-columns: 40px minmax(110px, 1fr) auto; align-items: center; gap: 8px; margin-top: 8px;';
        const favoriteBtn = document.createElement('button');
        favoriteBtn.type = 'button';
        favoriteBtn.className = 'result-favorite-btn';
        favoriteBtn.style.alignSelf = 'center';
        favoriteBtn.dataset.role = 'favorite';
        const compareBtn = document.createElement('button');
        compareBtn.type = 'button';
        compareBtn.className = 'compare-btn';
        compareBtn.dataset.role = 'compare';
        compareBtn.textContent = 'Compare';
        const selectLabel = document.createElement('label');
        selectLabel.className = 'result-select-label';
        selectLabel.style.cssText = 'font-size: 11px; display: flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; white-space: nowrap;';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'related-checkbox';
        selectLabel.append(checkbox, document.createTextNode(' Select'));
        actions.append(favoriteBtn, compareBtn, selectLabel);
        info.append(titleRow, typeLine, matchLine, breakdown, actions);
        el.append(artWrap, info);
        return el;
    };

    for (const card of topCards) {
        const key = getCardKey(card);
        let node = existingNodes.get(key);
        if (!node) node = createResultCard(card);
        updateResultCard(node, card);
        fragment.appendChild(node);
    }
    resultsGrid.replaceChildren(fragment);

    // One delegated listener set handles both stable/reused nodes and newly-created nodes. This
    // avoids index-based closures becoming stale when progressive ranking reorders the grid.
    if (!resultsGrid.dataset.resultEventsBound) {
        resultsGrid.dataset.resultEventsBound = 'true';
        resultsGrid.addEventListener('click', event => {
            const cardEl = event.target.closest('.card-item[data-card-key]');
            if (!cardEl) return;
            const card = visibleResultCardData.get(cardEl.dataset.cardKey);
            if (!card) return;
            if (event.target.closest('.compare-btn')) {
                event.preventDefault();
                event.stopPropagation();
                addToCompare(card);
                return;
            }
            if (event.target.closest('.result-favorite-btn')) {
                event.preventDefault();
                event.stopPropagation();
                toggleFavoriteCard(card);
                return;
            }
            const flip = event.target.closest('.card-flip-btn');
            if (flip) {
                event.preventDefault();
                event.stopPropagation();
                const faces = Array.isArray(card.card_faces) ? card.card_faces.filter(face => face?.image_uris?.normal) : [];
                if (faces.length > 1) {
                    const key = getResultCardStateKey(card);
                    const next = (Number(resultCardFaceState.get(key)) + 1) % faces.length;
                    resultCardFaceState.set(key, next);
                    const img = cardEl.querySelector('.card-art-wrap img');
                    if (img) {
                        img.src = faces[next].image_uris.normal;
                        img.alt = faces[next].name || card.name;
                    }
                }
            }
        });
        resultsGrid.addEventListener('change', event => {
            const checkbox = event.target.closest('.related-checkbox');
            if (!checkbox) return;
            const cardEl = checkbox.closest('.card-item[data-card-key]');
            const card = cardEl ? visibleResultCardData.get(cardEl.dataset.cardKey) : null;
            if (!card) return;
            toggleSelectRelatedCard(card);
        });
        resultsGrid.addEventListener('click', event => {
            const copyBtn = event.target.closest('.copy-card-name-btn');
            if (!copyBtn) return;
            const cardEl = copyBtn.closest('.card-item[data-card-key]');
            const card = cardEl ? visibleResultCardData.get(cardEl.dataset.cardKey) : null;
            if (!card) return;
            event.preventDefault();
            event.stopPropagation();
            copyCardNameToClipboard(card.name, copyBtn);
        });
    }
}

// --- COMPARISON PRESENTATION & EXPLANATION HELPERS ---
// Compare deliberately does NOT alter the existing result scores or their presentation. It adds
// a human-readable mechanical explanation using the same canonical-function and strategic-role
// representations that the search engine already uses for retrieval/ranking.
function ensureComparePresentationStyles() {
    if (document.getElementById('manamatch-compare-presentation-style')) return;
    const style = document.createElement('style');
    style.id = 'manamatch-compare-presentation-style';
    style.textContent = `
        #compare-modal { overflow-y: auto; }
        #compare-modal .modal-content {
            width: min(1120px, calc(100vw - 28px));
            max-width: 1120px;
            max-height: calc(100vh - 28px);
            overflow-y: auto;
            box-sizing: border-box;
            padding: 24px;
        }
        #compare-modal #close-modal {
            z-index: 3;
            cursor: pointer;
            font-size: 28px;
            line-height: 1;
            padding: 4px 8px;
        }
        #compare-modal .compare-container {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 20px;
            align-items: start;
            width: 100%;
        }
        #compare-modal .compare-card {
            min-width: 0;
            box-sizing: border-box;
            padding: 16px;
            border: 1px solid var(--border-color);
            border-radius: 12px;
            background: var(--bg-secondary);
            overflow: hidden;
        }
        #compare-modal .compare-card h3 {
            margin: 0 0 10px;
            font-size: 20px;
            line-height: 1.25;
            overflow-wrap: anywhere;
        }
        #compare-modal .compare-card .compare-card-art {
            display: block;
            width: min(100%, 260px);
            height: auto;
            margin: 0 auto 14px;
            border-radius: 10px;
            box-shadow: 0 3px 12px rgba(0,0,0,.16);
        }
        #compare-modal .compare-card-meta {
            margin: 0 0 12px;
            line-height: 1.5;
            font-size: 13px;
        }
        #compare-modal .compare-card-type {
            color: var(--text-muted);
        }
        #compare-modal .compare-oracle {
            white-space: pre-line;
            text-align: left;
            font-size: 14px;
            line-height: 1.55;
            padding: 12px;
            border-radius: 8px;
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            overflow-wrap: anywhere;
        }
        #compare-modal .compare-section {
            margin-top: 18px;
            padding-top: 14px;
            border-top: 1px solid var(--border-color);
        }
        #compare-modal .compare-section h3,
        #compare-modal .compare-section h4 {
            margin: 0 0 8px;
            line-height: 1.3;
        }
        #compare-modal .compare-section h3 { font-size: 17px; }
        #compare-modal .compare-section h4 { font-size: 14px; }
        #compare-modal .compare-explanation {
            margin: 0;
            line-height: 1.55;
            font-size: 14px;
        }
        #compare-modal .compare-evidence-list {
            display: flex;
            flex-wrap: wrap;
            gap: 7px;
            margin: 0;
            padding: 0;
            list-style: none;
        }
        #compare-modal .compare-evidence-list li {
            padding: 5px 9px;
            border-radius: 999px;
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            font-size: 12px;
            line-height: 1.25;
            overflow-wrap: anywhere;
        }
        #compare-modal .compare-difference-list {
            margin: 0;
            padding-left: 18px;
            line-height: 1.5;
            font-size: 13px;
        }
        #compare-modal .compare-empty {
            color: var(--text-muted);
            font-size: 13px;
            line-height: 1.5;
        }
        @media (max-width: 760px) {
            #compare-modal .modal-content { padding: 16px; }
            #compare-modal .compare-container { grid-template-columns: 1fr; gap: 14px; }
            #compare-modal .compare-card-art { width: min(100%, 300px) !important; }
        }
    `;
    document.head.appendChild(style);
}

function getCompareParsedCard(card) {
    const text = card?.oracle_text || (card?.card_faces ? card.card_faces.map(f => f.oracle_text || '').join(' ') : '');
    try {
        const parsed = card?._parsedEffects || parseMTGEffect(text);
        const canonical = getCanonicalFunctions(parsed);
        const roles = inferStrategicRoleProfile(card, parsed, '') || [];
        return { text, parsed, canonical, roles };
    } catch (_) {
        return { text, parsed: [], canonical: [], roles: [] };
    }
}

function compareFunctionLabel(fn) {
    return String(fn || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function compareFunctionKey(cf) {
    if (!cf) return '';
    const p = cf.params || {};
    return [cf.function, cf.outcome, p.object, p.subtype, p.from, p.to, p.scope, p.duration].filter(Boolean).join('|').toLowerCase();
}

function compareFunctionFamily(cf) {
    if (!cf) return '';
    return ACTION_TAXONOMY[cf.function]?.family || FUNCTION_OUTCOMES[cf.function] || cf.function || '';
}

function compareManaValue(card) {
    const cost = String(card?.mana_cost || '').toUpperCase();
    if (!cost) return 0;
    let total = 0;
    const tokens = cost.match(/\{([^}]+)\}/g) || [];
    tokens.forEach(token => {
        const inner = token.slice(1, -1);
        if (/^\d+$/.test(inner)) total += Number(inner);
        else if (/^[WUBRGC]$/.test(inner)) total += 1;
        // Hybrid/Phyrexian/special symbols still represent a colored component of a mana cost.
        else if (/\//.test(inner) || /^[XYZ]$/.test(inner)) total += 1;
    });
    return total;
}

function compareNumberPhrase(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'number') return String(value);
    return String(value);
}

function compareObjectArticle(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    if (/^(a|an|the|each|any)\b/i.test(s)) return s;
    return /^(opponent|player|creature|artifact|enchantment|permanent|planeswalker|spell|card|token)/i.test(s) ? `a ${s}` : s;
}

function compareTargetDescription(cf) {
    const p = cf?.params || {};
    const raw = String(p.raw || cf?.raw || '').replace(/\s+/g, ' ').trim();
    const lowerRaw = raw.toLowerCase();
    const rawObject = String(p.object || '').toLowerCase();
    const rawTarget = String(p.target || '').toLowerCase();
    const subtype = String(p.subtype || '').replace(/_/g, ' ').trim();
    const scope = String(p.scope || '').toLowerCase();
    const targetProfile = p.targetProfile || {};
    const restriction = Array.isArray(p.restriction) ? p.restriction : [];
    const restrictionText = restriction.map(x => String(x).toLowerCase());

    const objectWords = 'creature|artifact|enchantment|planeswalker|land|permanent|spell|card|token|battle';
    let object = rawObject;

    // Prefer the target profile and the actual rules clause over a broad parser container such as
    // "permanent". This prevents a mass-creature effect from being described as mass-permanent
    // removal.
    const profileObject = String(targetProfile.object || targetProfile.type || '').toLowerCase();
    if (profileObject && profileObject !== 'permanent') object = profileObject;
    if (subtype && new RegExp(`(?:${objectWords})`, 'i').test(subtype)) object = subtype.toLowerCase();

    const objectMap = {
        'any target': 'any target', 'creature': 'a creature', 'artifact': 'an artifact',
        'enchantment': 'an enchantment', 'planeswalker': 'a planeswalker', 'land': 'a land',
        'permanent': 'a permanent', 'nonland permanent': 'a nonland permanent', 'spell': 'a spell',
        'card': 'a card', 'token': 'a token', 'battle': 'a battle', 'player': 'a player',
        'opponent': 'an opponent', 'creature or planeswalker': 'a creature or planeswalker',
        'creature or player': 'a creature or player', 'creature or artifact': 'a creature or artifact'
    };

    // Any-target wording is authoritative and more specific than the generic target/object fields.
    if (/\bany\s+target\b/i.test(lowerRaw) || targetProfile.kind === 'any') return 'any target';

    // Preserve qualified target forms such as "target nonland permanent" and "target noncreature spell".
    const qualifiedTarget = lowerRaw.match(/\btarget\s+((?:nonland|noncreature|legendary|nontoken|nonbasic)\s+)*(creature|artifact|enchantment|planeswalker|land|permanent|spell|card|player|battle)\b/i);
    if (qualifiedTarget) {
        const prefix = String(qualifiedTarget[1] || '').replace(/\s+/g, ' ').trim();
        const noun = String(qualifiedTarget[2] || '').toLowerCase();
        const phrase = [prefix, noun].filter(Boolean).join(' ');
        return (/^[aeiou]/i.test(phrase) ? `an ${phrase}` : `a ${phrase}`);
    }

    // Preserve compound target classes such as "target creature or artifact".
    const compoundTarget = lowerRaw.match(new RegExp(`\\btarget\\s+((?:non)?(?:${objectWords})(?:\\s+or\\s+(?:non)?(?:${objectWords}))+?)\\b`, 'i'));
    if (compoundTarget) {
        const words = compareClean(compoundTarget[1]).split(/\s+or\s+/i).map(part => part.trim()).filter(Boolean);
        if (words.length > 1) {
            return words.map((part, i) => {
                const article = /^[aeiou]/i.test(part) ? 'an' : 'a';
                return `${article} ${part}`;
            }).join(' or ');
        }
    }

    // For mass effects, read the noun after "all"/"each" directly from Oracle text.
    const massTarget = lowerRaw.match(new RegExp(`\\b(all|each)\\s+((?:non)?(?:${objectWords}))s?\\b`, 'i'));
    if (massTarget) return `${massTarget[1].toLowerCase()} ${massTarget[2].toLowerCase()}${massTarget[2].toLowerCase().endsWith('s') ? '' : 's'}`;

    let base = objectMap[object] || compareObjectArticle(object.replace(/_/g, ' '));
    const profileTarget = String(targetProfile.target || targetProfile.scope || '').toLowerCase();
    const isEach = rawTarget === 'each' || scope === 'each' || profileTarget === 'each';
    const isAll = rawTarget === 'all' || scope === 'all' || profileTarget === 'all';

    if (!base && profileTarget && profileTarget !== 'each' && profileTarget !== 'all') {
        base = objectMap[profileTarget] || compareObjectArticle(profileTarget.replace(/_/g, ' '));
    }
    if (!base) return (isEach || isAll) ? `${isAll ? 'all' : 'each'} relevant objects` : '';
    if (isEach || isAll) return `${isAll ? 'all' : 'each'} ${base.replace(/^an? /i, '').replace(/s$/, '')}s`;
    if (restrictionText.includes('controlledbyyou')) return `${base} you control`;
    if (restrictionText.includes('controlledbyopponent')) return `${base} an opponent controls`;
    return base;
}

function compareRestrictionPhrase(cf) {
    const p = cf?.params || {};
    const restriction = Array.isArray(p.restriction) ? p.restriction.map(x => String(x).toLowerCase()) : [];
    const parts = [];
    const raw = String(p.raw || cf?.raw || '').replace(/\s+/g, ' ').trim();
    const manaValueMatch = raw.match(/\bwith\s+mana\s+value\s+(\d+|x)\s*(or\s+(?:less|more)|less\s+than|greater\s+than|equal\s+to)?/i);
    if (manaValueMatch) {
        const amount = manaValueMatch[1].toLowerCase() === 'x' ? 'X' : manaValueMatch[1];
        parts.push(`with mana value ${amount}${manaValueMatch[2] ? ` ${manaValueMatch[2].toLowerCase()}` : ''}`);
    }
    const known = new Set();
    const meaningful = x => {
        if (!x || /^(target|all|each|any|a|an|the|you|opponent|player|creature|artifact|enchantment|planeswalker|land|permanent|spell|card|token|lightning|bolt|deals|damage|destroy|exile|return|draw|cards?|counter|counters|mill|discard|gain|lose|life|create|tokens?)$/.test(x)) return false;
        return /control|mana|power|toughness|noncreature|nonland|legendary|basic|snow|tapped|untapped|other|with|without|color|type|subtype|converted|value|greater|less|equal|cost/i.test(x);
    };
    if (restriction.includes('controlledbyyou')) { parts.push('a permanent you control'); known.add('controlledbyyou'); }
    if (restriction.includes('controlledbyopponent')) { parts.push('a permanent an opponent controls'); known.add('controlledbyopponent'); }
    const suppressManaTokens = Boolean(manaValueMatch);
    restriction.filter(x => !known.has(x) && meaningful(x)).forEach(x => {
        if (suppressManaTokens && /^(mana|value|less|more|greater|equal|than|to|\d+|x)$/i.test(x)) return;
        parts.push(compareClean(x));
    });
    return Array.from(new Set(parts)).join(', ');
}

function comparePlural(word, quantity) {
    return Number(quantity) === 1 ? word : `${word}s`;
}

function compareClean(value) {
    return String(value || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function compareEffectDescription(cf) {
    const p = cf?.params || {};
    const fn = String(cf?.function || '');
    const q = compareNumberPhrase(p.quantity);
    const target = compareTargetDescription(cf);
    const object = compareObjectArticle(compareClean(p.object));
    const magnitude = compareClean(p.magnitude);
    const from = compareClean(p.from);
    const to = compareClean(p.to);
    const subtype = compareClean(p.subtype);
    const scope = p.scope === 'other' ? 'other' : '';
    const duration = p.duration === 'temporary' ? 'temporarily' : '';

    switch (fn) {
        case 'direct_damage': return q ? `${q} damage${target ? ` to ${target}` : ''}` : `damage${target ? ` to ${target}` : ''}`;
        case 'removal': return `destroy ${target || object || 'the relevant permanent'}`;
        case 'exile_removal': return `exile ${target || object || 'the relevant permanent'}`;
        case 'self_sacrifice': return `sacrifice${object ? ` ${object}` : ''}`;
        case 'bounce': return `return${object ? ` ${object}` : ''}${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}`;
        case 'reanimate': return `return${object ? ` ${object}` : ''} from the graveyard to the battlefield`;
        case 'recursion': return `return${object ? ` ${object}` : ''} from the graveyard to hand`;
        case 'cheat_into_play': return `put${object ? ` ${object}` : ''} onto the battlefield${from ? ` from ${from}` : ''}`;
        case 'tuck': return `put${object ? ` ${object}` : ''} into the library`;
        case 'zone_change': return `move${object ? ` ${object}` : ''}${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}`;
        case 'counter': return `counter${target ? ` ${target}` : ` ${object || 'the relevant spell or ability'}`}`;
        case 'gain_control': {
            const restriction = compareRestrictionPhrase(cf);
            return `gain control of ${target || object || 'the relevant permanent'}${restriction ? ` ${restriction}` : ''}`;
        }
        case 'card_draw': return q ? `draw ${q} ${comparePlural('card', p.quantity)}` : 'draw cards';
        case 'mill': return q ? `mill ${q} ${comparePlural('card', p.quantity)}` : 'mill cards';
        case 'discard': return q ? `discard ${q} ${comparePlural('card', p.quantity)}` : 'discard cards';
        case 'gain_life': return q ? `gain ${q} life` : 'gain life';
        case 'lose_life': return q ? `lose ${q} life` : 'lose life';
        case 'mana_ability': return magnitude || (q ? `add ${q} mana` : 'add mana');
        case 'token_creation': return q ? `create ${q} ${comparePlural('token', p.quantity)}${subtype ? ` (${subtype})` : ''}` : `create tokens${subtype ? ` (${subtype})` : ''}`;
        case 'token_multiplier': return 'multiply or copy tokens';
        case 'place_counter': return q ? `put ${q} ${magnitude || 'counter'}${Number(p.quantity) === 1 ? '' : 's'}` : `put ${magnitude || 'counters'}`;
        case 'stat_buff':
        case 'anthem':
        case 'tribal_anthem': return `${duration ? duration + ' ' : ''}change ${scope ? scope + ' ' : ''}creature stats${magnitude ? ` by ${magnitude}` : ''}${subtype ? ` for ${subtype}` : ''}`;
        case 'tap': return `tap${object ? ` ${object}` : ''}`;
        case 'untap': return `untap${object ? ` ${object}` : ''}`;
        case 'cost_reduction': return magnitude ? `reduce a cost by ${magnitude}` : 'reduce a cost';
        case 'tutor': return `search for${object ? ` ${object}` : ' a card'}`;
        case 'ramp_tutor': return `search for a land or other resource`;
        default: return compareFunctionLabel(fn).toLowerCase();
    }
}

function compareEffectCore(cf) {
    const p = cf?.params || {};
    return {
        fn: cf?.function || '',
        family: compareFunctionFamily(cf),
        outcome: cf?.outcome || '',
        quantity: typeof p.quantity === 'number' ? p.quantity : null,
        target: compareTargetDescription(cf),
        restriction: compareRestrictionPhrase(cf),
        object: compareClean(p.object).toLowerCase(),
        from: compareClean(p.from).toLowerCase(),
        to: compareClean(p.to).toLowerCase(),
        magnitude: compareClean(p.magnitude).toLowerCase(),
        duration: compareClean(p.duration).toLowerCase(),
        subtype: compareClean(p.subtype).toLowerCase(),
        controller: compareClean(p.controller).toLowerCase(),
        scope: compareClean(p.scope).toLowerCase(),
        effectMode: compareClean(p.effectMode).toLowerCase(),
        condition: compareClean(p.condition).toLowerCase(),
        conditionDetail: Array.isArray(p.conditionDetail) ? p.conditionDetail.join(', ').toLowerCase() : compareClean(p.conditionDetail).toLowerCase(),
        payCost: compareClean(p.payCost).toLowerCase(),
        activationCost: p.activationCost || null,
        additionalEffects: Array.isArray(p.additionalEffects) ? p.additionalEffects : [],
        targetProfile: p.targetProfile || null,
        quantityProfile: p.quantityProfile || null,
        triggerProfile: p.triggerProfile || null,
        dependencyProfile: p.dependencyProfile || null,
        durationProfile: p.durationProfile || null,
        raw: p.raw || ''
    };
}

function normalizeCompareListValues(values) {
    if (values == null) return [];
    if (Array.isArray(values)) return values;
    if (values instanceof Set) return Array.from(values);
    if (typeof values === 'string' || typeof values === 'number') return [values];

    // Some parser fields are structured records rather than arrays (for example activation
    // costs or condition metadata). Never call Array#filter directly on those objects. Prefer
    // their list-bearing properties, then fall back to their scalar values.
    if (typeof values === 'object') {
        for (const key of ['parts', 'values', 'items', 'options', 'conditions', 'restriction', 'restrictions']) {
            if (Array.isArray(values[key])) return values[key];
        }
        for (const key of ['text', 'phrase', 'description', 'label', 'value', 'name', 'event', 'detail']) {
            if (typeof values[key] === 'string' || typeof values[key] === 'number') return [values[key]];
        }
        return Object.values(values).filter(v => v != null && (typeof v === 'string' || typeof v === 'number'));
    }
    return [values];
}

function compareFormatList(values) {
    const clean = Array.from(new Set(normalizeCompareListValues(values).filter(Boolean).map(v => compareClean(v)).filter(Boolean)));
    if (!clean.length) return '';
    if (clean.length === 1) return clean[0];
    if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
    return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

function compareConditionPhrase(core) {
    if (!core) return '';
    if (core.condition === 'unless_pay') return core.payCost ? `unless its controller pays ${core.payCost}` : 'unless its controller pays an additional cost';
    if (core.condition === 'unless_other') return core.conditionDetail ? `unless ${compareFormatList(core.conditionDetail)}` : 'unless a condition is met';
    if (core.condition === 'if') return core.conditionDetail ? `if ${compareFormatList(core.conditionDetail)}` : 'if a condition is met';
    if (core.triggerProfile?.type === 'event') return core.triggerProfile.event ? `when/whenever ${compareClean(core.triggerProfile.event)}` : 'when a triggering event occurs';
    if (core.triggerProfile?.type === 'turn_window') return core.triggerProfile.window ? `at ${compareClean(core.triggerProfile.window).replace(/_/g, ' ')}` : 'during a turn window';
    return '';
}

function compareCostPhrase(core) {
    const pieces = [];
    if (core.activationCost?.parts?.length) pieces.push(`activation costs ${compareFormatList(core.activationCost.parts)}`);
    else if (core.payCost && !/^mana$/.test(core.payCost)) pieces.push(`requires ${core.payCost}`);
    const condition = compareConditionPhrase(core);
    if (condition && core.condition === 'unless_pay') pieces.push(condition);
    return pieces.join('; ');
}

function compareDifferenceSentences(cardA, cardB, af, bf) {
    const a = compareEffectCore(af), b = compareEffectCore(bf), out = [];
    const aName = cardA.name, bName = cardB.name;

    if (a.quantity !== null && b.quantity !== null && a.quantity !== b.quantity) {
        const descA = compareEffectDescription(af), descB = compareEffectDescription(bf);
        const unit = /damage|life|draw|mill|discard|token|counter|mana/.test(descA + ' ' + descB) ? '' : ' units';
        out.push(`The amount differs: ${aName} uses ${a.quantity}${unit}, while ${bName} uses ${b.quantity}${unit}.`);
    }

    if (a.target && b.target && a.target !== b.target) {
        out.push(`The targeting differs: ${aName} can affect ${a.target}, while ${bName} can affect ${b.target}.`);
    } else if (a.target && !b.target) {
        out.push(`${aName} specifies ${a.target}, while ${bName} uses a different targeting structure.`);
    } else if (!a.target && b.target) {
        out.push(`${bName} specifies ${b.target}, while ${aName} uses a different targeting structure.`);
    }

    if (a.restriction !== b.restriction) {
        if (a.restriction && !b.restriction) out.push(`${aName} has an additional restriction: it is limited to ${a.restriction}.`);
        else if (b.restriction && !a.restriction) out.push(`${bName} has an additional restriction: it is limited to ${b.restriction}.`);
        else if (a.restriction && b.restriction) out.push(`The restrictions differ: ${aName} is limited to ${a.restriction}, while ${bName} is limited to ${b.restriction}.`);
    }

    if (!a.target && !b.target && a.object && b.object && a.object !== b.object) out.push(`The affected object differs: ${aName} affects ${a.object}, while ${bName} affects ${b.object}.`);
    if (a.from !== b.from && (a.from || b.from)) out.push(`The starting zone differs: ${aName} moves the object from ${a.from || 'another zone'}, while ${bName} moves it from ${b.from || 'another zone'}.`);
    if (a.to !== b.to && (a.to || b.to)) out.push(`The destination differs: ${aName} moves the object to ${a.to || 'another zone'}, while ${bName} moves it to ${b.to || 'another zone'}.`);

    if (a.fn !== b.fn && a.family === b.family) {
        const verb = fn => fn === 'removal' ? 'destruction' : fn === 'exile_removal' ? 'exile' : compareFunctionLabel(fn).toLowerCase();
        out.push(`The effect is implemented differently: ${aName} uses ${verb(a.fn)}, while ${bName} uses ${verb(b.fn)}.`);
    }

    if (a.condition !== b.condition || a.conditionDetail !== b.conditionDetail) {
        const ca = compareConditionPhrase(a), cb = compareConditionPhrase(b);
        if (ca && cb && ca !== cb) out.push(`The conditions differ: ${aName} works ${ca}, while ${bName} works ${cb}.`);
        else if (ca && !cb) out.push(`${aName} has an additional condition: ${ca}.`);
        else if (cb && !ca) out.push(`${bName} has an additional condition: ${cb}.`);
    }

    const costA = compareCostPhrase(a), costB = compareCostPhrase(b);
    if (costA !== costB) {
        if (costA && costB) out.push(`The costs or requirements differ: ${aName} ${costA}, while ${bName} ${costB}.`);
        else if (costA) out.push(`${aName} has an additional cost or requirement: ${costA}.`);
        else if (costB) out.push(`${bName} has an additional cost or requirement: ${costB}.`);
    }

    if (a.effectMode !== b.effectMode && (a.effectMode || b.effectMode)) out.push(`The rules structure differs: ${aName} uses a ${a.effectMode || 'normal'} effect, while ${bName} uses a ${b.effectMode || 'normal'} effect.`);
    if (a.duration !== b.duration && (a.duration || b.duration)) out.push(`The duration differs: ${aName} is ${a.duration || 'not marked as temporary/static'}, while ${bName} is ${b.duration || 'not marked as temporary/static'}.`);
    if (a.subtype !== b.subtype && (a.subtype || b.subtype)) out.push(`The subtype restriction differs: ${aName} specifies ${a.subtype || 'no subtype restriction'}, while ${bName} specifies ${b.subtype || 'no subtype restriction'}.`);
    if (a.scope !== b.scope && (a.scope || b.scope)) out.push(`The scope differs: ${aName} affects ${a.scope || 'the default scope'}, while ${bName} affects ${b.scope || 'the default scope'}.`);
    if (a.magnitude && b.magnitude && a.magnitude !== b.magnitude && a.quantity === null && b.quantity === null) out.push(`The magnitude differs: ${aName} uses ${a.magnitude}, while ${bName} uses ${b.magnitude}.`);

    const extraA = compareFormatList(a.additionalEffects), extraB = compareFormatList(b.additionalEffects);
    if (extraA !== extraB && (extraA || extraB)) {
        if (extraA && extraB) out.push(`The follow-up effects differ: ${aName} also has ${extraA}, while ${bName} also has ${extraB}.`);
        else if (extraA) out.push(`${aName} also has a follow-up effect: ${extraA}.`);
        else out.push(`${bName} also has a follow-up effect: ${extraB}.`);
    }
    return Array.from(new Set(out));
}

function compareMatchScore(af, bf) {
    const a = compareEffectCore(af), b = compareEffectCore(bf);
    if (!a.fn || !b.fn) return -Infinity;
    let score = 0;
    if (a.fn === b.fn) score += 60;
    if (a.family === b.family) score += 28;
    if (a.outcome === b.outcome) score += 16;
    if (a.object && b.object && a.object === b.object) score += 12;
    if (a.target && b.target) score += 8;
    if (a.quantity !== null && b.quantity !== null) score += 6;
    if (a.from && b.from && a.from === b.from) score += 6;
    if (a.to && b.to && a.to === b.to) score += 6;
    if (a.subtype && b.subtype && a.subtype === b.subtype) score += 5;
    if (a.condition === b.condition && a.condition) score += 4;
    if (a.effectMode === b.effectMode) score += 3;
    if (a.duration === b.duration) score += 3;
    return score;
}

function compareCompoundEffects(cardA, cardB, a, b) {
    const matches = [];
    const usedB = new Set();
    const aEffects = a.canonical || [];
    const bEffects = b.canonical || [];

    // Match every meaningful effect independently. This is deliberately one-to-one so a card with
    // three effects cannot make the same candidate effect appear to match all three.
    const candidates = [];
    aEffects.forEach((af, ai) => bEffects.forEach((bf, bi) => {
        const score = compareMatchScore(af, bf);
        if (score > 0) candidates.push({ af, bf, ai, bi, score });
    }));
    candidates.sort((x, y) => y.score - x.score);
    for (const pair of candidates) {
        if (usedB.has(pair.bi) || matches.some(m => m.ai === pair.ai)) continue;
        if (pair.score < 28) continue;
        usedB.add(pair.bi);
        matches.push(pair);
    }

    const matchedA = new Set(matches.map(m => m.ai));
    const matchedB = new Set(matches.map(m => m.bi));
    const onlyA = aEffects.filter((_, i) => !matchedA.has(i));
    const onlyB = bEffects.filter((_, i) => !matchedB.has(i));
    return { matches, onlyA, onlyB };
}

function normalizeCompareRoleTag(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw
        .replace(/^otag:/i, '')
        .replace(/^tag:/i, '')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase());
}

// Scryfall's ordinary card object does not universally include tagger/oracle-tag membership.
// ManaSearch therefore treats explicit tag metadata as authoritative only when a card payload or
// one of our data/cache layers actually supplies it. We never manufacture an archetype from an
// Oracle-text heuristic here. This also means a future Scryfall/tag-data importer can populate
// these fields without changing Compare's logic.
function getAuthoritativeCompareRoleTags(card) {
    const candidateFields = [
        'oracle_tags', 'oracleTags', 'otags',
        'scryfall_tags', 'scryfallTags',
        'deckbuilding_tags', 'deckbuildingTags',
        'tagger_tags', 'taggerTags', 'tags'
    ];
    const values = [];
    for (const field of candidateFields) {
        const value = card?.[field];
        if (Array.isArray(value)) values.push(...value);
        else if (typeof value === 'string') values.push(...value.split(/[,;|]/));
    }
    return Array.from(new Set(values.map(normalizeCompareRoleTag).filter(Boolean)));
}

function detectCompareArchetypes(card) {
    return getAuthoritativeCompareRoleTags(card).map(label => ({
        role: label.toLowerCase(),
        label,
        source: 'explicit tag metadata',
        confidence: 'explicit'
    }));
}

function compareArchetypeSentences(cardA, cardB) {
    const arA = detectCompareArchetypes(cardA), arB = detectCompareArchetypes(cardB);
    const mapB = new Map(arB.map(r => [r.role, r]));
    const mapA = new Map(arA.map(r => [r.role, r]));
    const shared = [], differences = [];

    arA.forEach(r => {
        if (mapB.has(r.role)) {
            shared.push(`Both ${cardA.name} and ${cardB.name} have the explicit ${r.label} tag.`);
        } else {
            differences.push(`${cardA.name} has the explicit ${r.label} tag, while ${cardB.name} does not.`);
        }
    });
    arB.forEach(r => {
        if (!mapA.has(r.role)) differences.push(`${cardB.name} has the explicit ${r.label} tag, while ${cardA.name} does not.`);
    });
    return { shared, differences, profilesA: arA, profilesB: arB };
}

// A normalized comparison record keeps the Compare engine from repeatedly interpreting the
// parser's fields in unrelated places. It is deliberately derived from the existing canonical
// parser, so Search's scoring representation remains untouched.
function buildCompareEffectRecord(cf, index = 0) {
    const p = cf?.params || {};
    const list = key => Array.isArray(p[key]) ? p[key].map(compareClean).filter(Boolean) : [];
    const numeric = key => {
        const v = p[key];
        return v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : String(v);
    };
    return {
        index,
        function: String(cf?.function || ''),
        family: compareFunctionFamily(cf),
        outcome: compareClean(cf?.outcome),
        object: compareClean(p.object),
        target: compareClean(p.target),
        quantity: numeric('quantity'),
        amount: numeric('amount'),
        magnitude: compareClean(p.magnitude),
        from: compareClean(p.from),
        to: compareClean(p.to),
        subtype: compareClean(p.subtype),
        scope: compareClean(p.scope),
        duration: compareClean(p.duration),
        condition: compareClean(p.condition),
        conditions: list('conditions'),
        restriction: list('restriction'),
        restrictions: list('restrictions'),
        costs: list('costs'),
        cost: compareClean(p.cost),
        additionalCost: compareClean(p.additionalCost),
        effectMode: compareClean(p.effectMode),
        timing: compareClean(p.timing),
        isMode: Boolean(p.isMode),
        modeGroupId: p.modeGroupId ?? null,
        modeCount: p.modeCount || null,
        controlChangeDuration: compareClean(p.controlChangeDuration).toLowerCase(),
        sequence: p.sequence !== undefined ? p.sequence : index,
        choices: list('choices'),
        alternatives: list('alternatives'),
        raw: cf
    };
}

function compareConditionCostSentences(cardA, cardB, af, bf) {
    const a = buildCompareEffectRecord(af, af?.index || 0);
    const b = buildCompareEffectRecord(bf, bf?.index || 0);
    const out = [];
    const aCond = [...a.conditions, a.condition].filter(Boolean);
    const bCond = [...b.conditions, b.condition].filter(Boolean);
    const aCost = [...a.costs, a.cost, a.additionalCost].filter(Boolean);
    const bCost = [...b.costs, b.cost, b.additionalCost].filter(Boolean);
    const same = xs => xs.map(x => x.toLowerCase()).sort().join('|');

    if (same(aCond) !== same(bCond)) {
        if (aCond.length && bCond.length) out.push(`${cardA.name} has the condition ${compareFormatList(aCond)}, while ${cardB.name} has ${compareFormatList(bCond)}.`);
        else if (aCond.length) out.push(`${cardA.name} requires ${compareFormatList(aCond)}, while ${cardB.name} does not have that condition.`);
        else if (bCond.length) out.push(`${cardB.name} requires ${compareFormatList(bCond)}, while ${cardA.name} does not have that condition.`);
    }
    if (same(aCost) !== same(bCost)) {
        if (aCost.length && bCost.length) out.push(`The additional costs differ: ${cardA.name} requires ${compareFormatList(aCost)}, while ${cardB.name} requires ${compareFormatList(bCost)}.`);
        else if (aCost.length) out.push(`${cardA.name} has an additional cost (${compareFormatList(aCost)}), while ${cardB.name} does not.`);
        else if (bCost.length) out.push(`${cardB.name} has an additional cost (${compareFormatList(bCost)}), while ${cardA.name} does not.`);
    }
    if (a.duration !== b.duration && (a.duration || b.duration)) {
        out.push(`The duration differs: ${cardA.name} ${a.duration || 'has no stated duration'}, while ${cardB.name} ${b.duration || 'has no stated duration'}.`);
    }
    if (a.timing !== b.timing && (a.timing || b.timing)) {
        out.push(`The timing differs: ${cardA.name} ${a.timing || 'has no parsed timing restriction'}, while ${cardB.name} ${b.timing || 'has no parsed timing restriction'}.`);
    }
    return out;
}

function compareSequenceSignature(parsed) {
    return (parsed?.canonical || [])
        .map((e, index) => buildCompareEffectRecord(e, index))
        .filter(e => e.function && e.function !== 'generic')
        .sort((a, b) => Number(a.sequence) - Number(b.sequence) || a.index - b.index)
        .map(e => compareFunctionLabel(e.function).toLowerCase());
}

function compareSequenceSentences(cardA, cardB, a, b) {
    const seqA = compareSequenceSignature(a), seqB = compareSequenceSignature(b);
    if (seqA.length < 2 || seqB.length < 2) return [];
    if (seqA.join('|') === seqB.join('|')) return [];
    const shared = seqA.filter(x => seqB.includes(x));
    if (!shared.length) return [];
    return [`The cards have similar effects but sequence them differently: ${cardA.name} has ${compareFormatList(seqA.slice(0, 5))}, while ${cardB.name} has ${compareFormatList(seqB.slice(0, 5))}.`];
}

function compareModalModeGroups(parsedCard) {
    const groups = new Map();
    (parsedCard?.canonical || []).forEach(cf => {
        const p = cf?.params || {};
        if (!p.isMode || p.modeGroupId == null) return;
        const id = String(p.modeGroupId);
        if (!groups.has(id)) groups.set(id, { count: p.modeCount || 'one', effects: [] });
        groups.get(id).effects.push(cf);
    });
    return Array.from(groups.values());
}

function compareFormatOrList(values) {
    const clean = Array.from(new Set(normalizeCompareListValues(values).filter(Boolean).map(v => compareClean(v)).filter(Boolean)));
    if (!clean.length) return '';
    if (clean.length === 1) return clean[0];
    if (clean.length === 2) return `${clean[0]} or ${clean[1]}`;
    return `${clean.slice(0, -1).join(', ')}, or ${clean[clean.length - 1]}`;
}

function compareModalAlternativeSentences(cardA, cardB, a, b, matches) {
    const groupsA = compareModalModeGroups(a);
    const groupsB = compareModalModeGroups(b);
    if (!groupsA.length && !groupsB.length) return [];

    const matchedIdsA = new Set(matches.filter(m => m.af?.params?.isMode && m.af?.params?.modeGroupId != null).map(m => String(m.af.params.modeGroupId)));
    const matchedIdsB = new Set(matches.filter(m => m.bf?.params?.isMode && m.bf?.params?.modeGroupId != null).map(m => String(m.bf.params.modeGroupId)));
    const describe = effects => effects.map(e => compareEffectDescription(e)).filter(Boolean);
    const out = [];

    const emit = (card, groups, matchedIds) => {
        groups.forEach(group => {
            const matched = group.effects.filter(e => matchedIds.has(String(e.params?.modeGroupId)));
            const alternatives = group.effects.filter(e => !matched.includes(e));
            if (!matched.length || !alternatives.length) return;
            const alternativeText = compareFormatOrList(describe(alternatives));
            const matchedText = compareFormatOrList(describe(matched));
            if (!alternativeText || !matchedText) return;
            out.push(`${card.name} is more flexible: it can ${matchedText}, or it can instead ${alternativeText}.`);
        });
    };

    if (!groupsA.length && groupsB.length) emit(cardB, groupsB, matchedIdsB);
    else if (groupsA.length && !groupsB.length) emit(cardA, groupsA, matchedIdsA);
    else if (groupsA.length && groupsB.length) {
        const countA = groupsA.reduce((n, g) => n + g.effects.length, 0);
        const countB = groupsB.reduce((n, g) => n + g.effects.length, 0);
        if (countA !== countB) {
            const card = countA > countB ? cardA : cardB;
            const delta = Math.abs(countA - countB);
            out.push(`${card.name} offers ${delta} more distinct modal option${delta === 1 ? '' : 's'} than the other card.`);
        }
    }
    return Array.from(new Set(out));
}

function compareMechanicalSentences(cardA, cardB, a, b) {
    const compound = compareCompoundEffects(cardA, cardB, a, b);
    const sentences = [];
    sentences.push(...compareModalAlternativeSentences(cardA, cardB, a, b, compound.matches));
    sentences.push(...compareSequenceSentences(cardA, cardB, a, b));
    compound.matches.slice(0, 8).forEach(({ af, bf }) => {
        const aDesc = compareEffectDescription(af), bDesc = compareEffectDescription(bf);
        if (aDesc && bDesc && aDesc === bDesc) {
            sentences.push(`Both ${cardA.name} and ${cardB.name} ${aDesc}.`);
        } else {
            const differences = compareDifferenceSentences(cardA, cardB, af, bf);
            sentences.push(...compareConditionCostSentences(cardA, cardB, af, bf));
            if (differences.length) sentences.push(...differences);
            else if (aDesc && bDesc) sentences.push(`Both cards have a related effect: ${cardA.name} ${aDesc}, while ${cardB.name} ${bDesc}.`);
        }
    });

    const aMV = compareManaValue(cardA), bMV = compareManaValue(cardB);
    if (aMV !== bMV && aMV > 0 && bMV > 0) {
        const delta = Math.abs(aMV - bMV);
        const cheaper = aMV < bMV ? cardA.name : cardB.name;
        const pricier = aMV < bMV ? cardB.name : cardA.name;
        sentences.push(`The mana cost differs by ${delta}: ${pricier} costs ${delta === 1 ? 'one' : delta} more mana than ${cheaper}.`);
    }
    return { sentences: Array.from(new Set(sentences)), ...compound };
}

function compareSharedEffectSentence(cardA, cardB, af, bf) {
    const aDesc = compareEffectDescription(af);
    const bDesc = compareEffectDescription(bf);
    if (!aDesc && !bDesc) return '';
    if (aDesc && bDesc && aDesc === bDesc) return `Both ${cardA.name} and ${cardB.name} ${aDesc}.`;
    if (aDesc && bDesc) return `Both cards share a related ${compareFunctionLabel(af?.function).toLowerCase()} effect: ${cardA.name} ${aDesc}, while ${cardB.name} ${bDesc}.`;
    return '';
}

function compareAdditionalEffectSentence(cardName, cf) {
    const description = compareEffectDescription(cf);
    if (!description) return '';
    const fn = String(cf?.function || '');
    switch (fn) {
        case 'direct_damage': return `${cardName} additionally deals ${description.replace(/^\\s*damage/i, 'damage')}.`;
        case 'card_draw': return `${cardName} additionally ${description}.`;
        case 'mill': return `${cardName} additionally ${description}.`;
        case 'discard': return `${cardName} additionally ${description}.`;
        case 'gain_life': return `${cardName} additionally ${description}.`;
        case 'lose_life': return `${cardName} additionally causes its controller to ${description}.`;
        case 'mana_ability': return `${cardName} additionally ${description}.`;
        case 'token_creation': return `${cardName} additionally ${description}.`;
        case 'place_counter': return `${cardName} additionally ${description}.`;
        case 'self_sacrifice': return `${cardName} additionally must ${description}.`;
        case 'tap': return `${cardName} additionally ${description}.`;
        case 'untap': return `${cardName} additionally ${description}.`;
        default: return `${cardName} additionally ${description}.`;
    }
}

function compareAdditionalEffects(cardName, effects) {
    return (effects || [])
        .slice(0, 6)
        .map(cf => compareAdditionalEffectSentence(cardName, cf))
        .filter(Boolean);
}

function buildCompareExplanation(cardA, cardB) {
    const a = getCompareParsedCard(cardA);
    const b = getCompareParsedCard(cardB);
    const mechanical = compareMechanicalSentences(cardA, cardB, a, b);
    const { matches, onlyA, onlyB } = mechanical;
    const archetypes = compareArchetypeSentences(cardA, cardB, a, b);

    const detail = [...mechanical.sentences, ...archetypes.shared];

    const evidence = [];
    matches.slice(0, 8).forEach(({ af, bf }) => {
        const ad = compareEffectDescription(af), bd = compareEffectDescription(bf);
        if (ad && bd && ad === bd) evidence.push(`Both ${cardA.name} and ${cardB.name} ${ad}.`);
    });
    evidence.push(...archetypes.shared);

    const differences = [];
    differences.push(...compareAdditionalEffects(cardA.name, onlyA));
    differences.push(...compareAdditionalEffects(cardB.name, onlyB));
    differences.push(...archetypes.differences);
    if (onlyA.length || onlyB.length) {
        differences.push(`${cardA.name} has ${onlyA.length} unmatched parsed effect${onlyA.length === 1 ? '' : 's'}, while ${cardB.name} has ${onlyB.length} unmatched parsed effect${onlyB.length === 1 ? '' : 's'}.`);
    }

    let summary;
    if (matches.length) {
        // Prefer the most informative concrete sentence(s) and collapse repetitions. The UI shows
        // one human-readable explanation; the detailed evidence remains internal to the engine.
        const unique = [];
        const seenSignatures = new Set();
        detail.forEach(sentence => {
            const normalized = sentence.toLowerCase()
                .replace(/both\s+/g, '')
                .replace(/the\s+(cards?|effect|targeting|amount|mana cost)\s+/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (!normalized || seenSignatures.has(normalized)) return;
            seenSignatures.add(normalized);
            unique.push(sentence);
        });
        const selected = unique.slice(0, 2);
        if (selected.length) {
            // Keep the visible explanation to one compact sentence while allowing a second clause
            // when it adds a genuinely new fact.
            const clauses = selected.map(sentence => String(sentence).trim().replace(/[.!?]+$/g, ''));
            summary = clauses.join('; ') + '.';
        } else {
            summary = `These cards are similar because they share ${matches.length === 1 ? 'a mechanical effect' : `${matches.length} mechanical effects`}.`;
        }
        if (!/^[A-Z]/.test(summary)) summary = summary.charAt(0).toUpperCase() + summary.slice(1);
    } else if (archetypes.shared.length) {
        summary = archetypes.shared[0];
    } else {
        summary = 'The engine did not find a directly matched mechanical effect or strong shared strategic role to explain their similarity.';
    }

    return {
        summary,
        detail: Array.from(new Set(detail)),
        evidence: Array.from(new Set(evidence)),
        differences: Array.from(new Set(differences)),
        archetypes,
        a, b, matches, onlyA, onlyB
    };
}

// --- COMPARISON & EXPORT LOGIC ---
function addToCompare(card) {
    if (!currentSourceCard || !card || card.id === currentSourceCard.id) return;
    // Every Compare button is a direct comparison against the current source card.
    // Reusing the previous compareQueue made later Compare clicks appear to do nothing.
    compareQueue = [currentSourceCard, card];
    renderComparison();
}

function buildCompareInsightModel(cardA, cardB, explanation) {
    const matches = Array.isArray(explanation?.matches) ? explanation.matches : [];
    const shared = [];
    const sharedSeen = new Set();

    // Compare is meant to explain the relationship between cards, not repeat their Oracle text.
    // Each shared row therefore names the common job/function once. Concrete differences belong
    // in the differences table below.
    matches.slice(0, 8).forEach(({ af, bf }) => {
        const aCore = compareEffectCore(af), bCore = compareEffectCore(bf);
        const family = aCore.family || bCore.family || aCore.fn || bCore.fn || 'mechanical effect';
        const label = compareFunctionLabel(aCore.fn || bCore.fn || family);
        const target = aCore.target && bCore.target && aCore.target === bCore.target ? aCore.target : '';
        const object = aCore.object && bCore.object && aCore.object === bCore.object ? aCore.object : '';
        const zone = aCore.from && bCore.from && aCore.from === bCore.from
            ? `${aCore.from}${aCore.to && bCore.to && aCore.to === bCore.to ? ` → ${aCore.to}` : ''}`
            : '';

        let fact = label || 'Related effect';
        if (target) fact += ` — ${target}`;
        else if (object) fact += ` — ${object}`;
        if (zone) fact += ` (${zone})`;

        const normalized = fact.toLowerCase().replace(/\s+/g, ' ').trim();
        if (sharedSeen.has(normalized)) return;
        sharedSeen.add(normalized);
        shared.push({
            fact,
            identical: Boolean(aCore.fn && bCore.fn && aCore.fn === bCore.fn)
        });
    });

    const differences = [];
    const pushDifference = (label, aValue, bValue) => {
        const cleanA = compareClean(aValue), cleanB = compareClean(bValue);
        if (!cleanA && !cleanB) return;
        const key = `${label}|${cleanA.toLowerCase()}|${cleanB.toLowerCase()}`;
        if (differences.some(d => d.key === key)) return;
        differences.push({ key, label, a: cleanA || '—', b: cleanB || '—' });
    };

    const matchedPairs = matches.slice(0, 8);
    matchedPairs.forEach(({ af, bf }) => {
        const a = compareEffectCore(af), b = compareEffectCore(bf);
        if (a.quantity !== null && b.quantity !== null && a.quantity !== b.quantity) pushDifference('Amount', a.quantity, b.quantity);
        if (a.target !== b.target && (a.target || b.target)) pushDifference('Target', a.target, b.target);
        if (a.restriction !== b.restriction && (a.restriction || b.restriction)) pushDifference('Restriction', a.restriction, b.restriction);
        if (a.from !== b.from && (a.from || b.from)) pushDifference('From', a.from, b.from);
        if (a.to !== b.to && (a.to || b.to)) pushDifference('To', a.to, b.to);
        if (a.condition !== b.condition || a.conditionDetail !== b.conditionDetail) {
            pushDifference('Condition', compareConditionPhrase(a), compareConditionPhrase(b));
        }
        const costA = compareCostPhrase(a), costB = compareCostPhrase(b);
        if (costA !== costB) pushDifference('Requirement', costA, costB);
        if (a.duration !== b.duration && (a.duration || b.duration)) pushDifference('Duration', a.duration, b.duration);
        if (a.subtype !== b.subtype && (a.subtype || b.subtype)) pushDifference('Subtype', a.subtype, b.subtype);
        if (a.scope !== b.scope && (a.scope || b.scope)) pushDifference('Scope', a.scope, b.scope);
        if (a.magnitude !== b.magnitude && (a.magnitude || b.magnitude) && a.quantity === null && b.quantity === null) {
            pushDifference('Magnitude', a.magnitude, b.magnitude);
        }
    });

    const aMV = compareManaValue(cardA), bMV = compareManaValue(cardB);
    if (aMV !== bMV && aMV > 0 && bMV > 0) pushDifference('Mana value', aMV, bMV);

    const additionalA = (explanation.onlyA || []).slice(0, 4).map(compareEffectDescription).filter(Boolean);
    const additionalB = (explanation.onlyB || []).slice(0, 4).map(compareEffectDescription).filter(Boolean);

    const sharedRoles = Array.from(new Set(
        (explanation.archetypes?.shared || []).map(compareClean).filter(Boolean)
    ));

    return {
        summary: explanation?.summary || '',
        shared,
        sharedRoles,
        differences,
        additionalA,
        additionalB,
        matchedCount: matches.length,
        unmatchedA: explanation.onlyA?.length || 0,
        unmatchedB: explanation.onlyB?.length || 0
    };
}

function renderComparison() {
    if (!compareModal || !compareContainer) return;
    ensureComparePresentationStyles();
    compareModal.classList.remove('hidden');
    compareContainer.innerHTML = '';
    compareStatus.textContent = compareQueue.length === 1 ? 'Select one more card from the results to compare.' : '';

    if (compareQueue.length < 2) {
        const empty = document.createElement('div');
        empty.className = 'compare-empty';
        empty.textContent = 'Choose a second result card to see the mechanical comparison.';
        compareContainer.appendChild(empty);
        return;
    }

    const [cardA, cardB] = compareQueue;
    const explanation = buildCompareExplanation(cardA, cardB);
    const insight = buildCompareInsightModel(cardA, cardB, explanation);

    // --- The two cards: identity and rules text only. The analysis below explains the relationship. ---
    [cardA, cardB].forEach((card, index) => {
        const cardImg = card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || '';
        const oracleText = card.oracle_text || (card.card_faces ? card.card_faces.map(f => f.oracle_text || '').join('\n') : 'No rules text.');

        const cardDiv = document.createElement('article');
        cardDiv.className = 'compare-card';

        const kicker = document.createElement('div');
        kicker.className = 'compare-card-kicker';
        kicker.textContent = index === 0 ? 'Source card' : 'Compared card';

        const heading = document.createElement('h3');
        heading.textContent = card.name;

        const img = document.createElement('img');
        img.className = 'compare-card-art';
        img.src = cardImg;
        img.alt = card.name;
        img.loading = 'lazy';
        img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });

        const meta = document.createElement('div');
        meta.className = 'compare-card-meta';
        const cost = document.createElement('div');
        const costLabel = document.createElement('strong');
        costLabel.textContent = 'Mana cost: ';
        cost.append(costLabel, document.createTextNode(card.mana_cost || 'None'));
        const type = document.createElement('div');
        type.className = 'compare-card-type';
        type.textContent = card.type_line || '';
        meta.append(cost, type);

        const rulesLabel = document.createElement('div');
        rulesLabel.className = 'compare-rules-label';
        rulesLabel.textContent = 'Rules text';

        const textDiv = document.createElement('div');
        textDiv.className = 'compare-oracle';
        textDiv.textContent = oracleText;

        cardDiv.append(kicker, heading, img, meta, rulesLabel, textDiv);
        compareContainer.appendChild(cardDiv);
    });

    // --- Human-readable analysis ---
    const analysis = document.createElement('section');
    analysis.className = 'compare-analysis';

    const analysisHeader = document.createElement('div');
    analysisHeader.className = 'compare-analysis-heading';
    const analysisTitle = document.createElement('h3');
    analysisTitle.textContent = 'How these cards compare';
    const count = document.createElement('span');
    count.className = 'compare-match-count';
    count.textContent = insight.matchedCount
        ? `${insight.matchedCount} shared mechanical effect${insight.matchedCount === 1 ? '' : 's'}`
        : 'No direct mechanical effect match';
    analysisHeader.append(analysisTitle, count);
    analysis.appendChild(analysisHeader);

    const summary = document.createElement('p');
    summary.className = 'compare-summary';
    summary.textContent = insight.summary || 'The engine could not produce a concise direct explanation for this comparison.';
    analysis.appendChild(summary);

    if (insight.shared.length || insight.sharedRoles.length) {
        const sharedSection = document.createElement('div');
        sharedSection.className = 'compare-insight-section';
        const sharedHeading = document.createElement('h4');
        sharedHeading.textContent = 'Shared functionality';
        sharedSection.appendChild(sharedHeading);

        const sharedIntro = document.createElement('p');
        sharedIntro.className = 'compare-section-note';
        sharedIntro.textContent = 'These are the core jobs the comparison engine found in common. Specific differences are shown separately below.';
        sharedSection.appendChild(sharedIntro);

        const list = document.createElement('div');
        list.className = 'compare-shared-list';
        insight.shared.slice(0, 6).forEach(item => {
            const row = document.createElement('div');
            row.className = 'compare-shared-row';
            const marker = document.createElement('span');
            marker.className = 'compare-shared-marker';
            marker.textContent = 'Both cards';
            const fact = document.createElement('span');
            fact.className = 'compare-shared-fact';
            fact.textContent = item.fact;
            row.append(marker, fact);
            list.appendChild(row);
        });
        sharedSection.appendChild(list);

        if (insight.sharedRoles.length) {
            const roleWrap = document.createElement('div');
            roleWrap.className = 'compare-shared-role-line';
            const roleLabel = document.createElement('span');
            roleLabel.className = 'compare-shared-marker';
            roleLabel.textContent = 'Shared tags';
            roleWrap.appendChild(roleLabel);
            const roles = document.createElement('div');
            roles.className = 'compare-role-tags';
            insight.sharedRoles.slice(0, 5).forEach(role => {
                const tag = document.createElement('span');
                tag.className = 'compare-role-tag';
                tag.textContent = role;
                roles.appendChild(tag);
            });
            roleWrap.appendChild(roles);
            sharedSection.appendChild(roleWrap);
        }
        analysis.appendChild(sharedSection);
    }

    if (insight.differences.length || insight.additionalA.length || insight.additionalB.length) {
        const diffSection = document.createElement('div');
        diffSection.className = 'compare-insight-section';
        const diffHeading = document.createElement('h4');
        diffHeading.textContent = 'Key differences';
        diffSection.appendChild(diffHeading);

        const diffIntro = document.createElement('p');
        diffIntro.className = 'compare-section-note';
        diffIntro.textContent = 'These differences explain why two cards can be similar without being interchangeable.';
        diffSection.appendChild(diffIntro);

        if (insight.differences.length) {
            const table = document.createElement('div');
            table.className = 'compare-diff-table';
            const headerLabel = document.createElement('div');
            headerLabel.className = 'compare-diff-label';
            headerLabel.textContent = 'Aspect';
            const headerA = document.createElement('div');
            headerA.className = 'compare-diff-card-name';
            headerA.textContent = cardA.name;
            const headerB = document.createElement('div');
            headerB.className = 'compare-diff-card-name';
            headerB.textContent = cardB.name;
            table.append(headerLabel, headerA, headerB);

            insight.differences.slice(0, 8).forEach(diff => {
                const label = document.createElement('div');
                label.className = 'compare-diff-label';
                label.textContent = diff.label;
                const aCell = document.createElement('div');
                aCell.className = 'compare-diff-value';
                aCell.textContent = diff.a;
                const bCell = document.createElement('div');
                bCell.className = 'compare-diff-value';
                bCell.textContent = diff.b;
                table.append(label, aCell, bCell);
            });
            diffSection.appendChild(table);
        }

        if (insight.additionalA.length || insight.additionalB.length) {
            const extraGrid = document.createElement('div');
            extraGrid.className = 'compare-unique-grid';
            [[`Only ${cardA.name}`, insight.additionalA], [`Only ${cardB.name}`, insight.additionalB]].forEach(([label, values]) => {
                if (!values.length) return;
                const block = document.createElement('div');
                block.className = 'compare-unique-block';
                const h = document.createElement('h5');
                h.textContent = label;
                block.appendChild(h);
                const ul = document.createElement('ul');
                values.forEach(value => {
                    const li = document.createElement('li');
                    li.textContent = value;
                    ul.appendChild(li);
                });
                block.appendChild(ul);
                extraGrid.appendChild(block);
            });
            diffSection.appendChild(extraGrid);
        }
        analysis.appendChild(diffSection);
    } else if (!insight.shared.length && !insight.sharedRoles.length) {
        const note = document.createElement('p');
        note.className = 'compare-empty';
        note.textContent = 'No directly matched mechanical effects were found. The similarity may come from broader function, role, or context.';
        analysis.appendChild(note);
    }

    compareContainer.appendChild(analysis);
}

function exportToCSV() {
    if (!lastSearchResults || lastSearchResults.length === 0) return;
    let csvContent = "Name,Mana Cost,Type,Price (USD),Price (EUR),Overall Score,Synergy Score,Context Score,Exactness Score,Category Score,Scryfall URI\n";

    lastSearchResults.forEach(card => {
        const name = `"${card.name.replace(/"/g, '""')}"`;
        const mana = `"${(card.mana_cost || '').replace(/"/g, '""')}"`;
        const type = `"${card.type_line.replace(/"/g, '""')}"`;
        const usd = `"${card.prices?.usd ? '$' + card.prices.usd : 'N/A'}"`;
        const eur = `"${card.prices?.eur ? '€' + card.prices.eur : 'N/A'}"`;
        const score = card.similarityScore ? Math.round(card.similarityScore * 100) : 0;
        const syn = card.synergyScore ? Math.round(card.synergyScore * 100) : 0;
        const con = card.contextScore ? Math.round(card.contextScore * 100) : 0;
        const exa = card.exactnessScore ? Math.round(card.exactnessScore * 100) : 0;
        const uri = `"${card.scryfall_uri}"`;
        const cat = card.categoryScore ? Math.round(card.categoryScore * 100) : 0;
        csvContent += `${name},${mana},${type},${usd},${eur},${score}%,${syn}%,${con}%,${exa}%,${cat}%,${uri}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `ManaMatch_Results_${new Date().getTime()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Release the temporary Blob URL after the browser has consumed the download request.
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function showLoading(isLoading) {
    if (isLoading) {
        loadingIndicator.classList.remove('hidden');
    } else {
        loadingIndicator.classList.add('hidden');
    }
}
