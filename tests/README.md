# ManaSearch automated regression tests

These checks exercise the **production** `app.js` parsing, ranking, repeatability and highlight logic.

## 1. Fast, dependency-free checks

Run from the repository root:

```sh
node --check app.js
node tests/run-static-regression.cjs
node tests/run-core-unit-regression.cjs
node tests/run-card-benchmark-data.cjs
```

## 2. Full browser regression + performance benchmark

Requires Node.js 20+ and network access to install Playwright/Chromium:

```sh
npm install --no-save playwright@1.55.0
npx playwright install chromium
node tests/run-browser-regression.cjs
```

The dependency-free core unit checks execute the new production contrast/ranking helpers. The browser runner executes the full production scorer suites:
- `runMechanicalRegressionSuite`
- `runManaSearchMechanicalRegressionSuite`
- `runManaSearchRepeatabilityRegressionSuite`
- `runManaSearchHighlightIsolationSuite`
- `runManaSearchPerformanceSuite`

The performance suite benchmarks real parser/profile/scorer code with fixed rules-text examples. It reports total elapsed time, average time per card pair, and p95 pair latency. It uses a generous hard threshold to catch severe regressions, not to promise exact timing on every machine.

GitHub Actions runs both the dependency-free checks and the browser suite automatically on pushes and pull requests to `main`. No paid API or Scryfall request is needed for the scorer regression fixtures.

## 3. Real-card mechanical benchmark

A curated, offline fixture set at `tests/fixtures/mtg-mechanical-benchmark.json` contains 31 real card names, type lines, Oracle text, source links, and 22 expected pairwise ranking/contrast comparisons spanning 17 mechanic categories. It includes cases for:
- mana rocks and colorless versus color-flexible mana,
- blink effects versus exile removal,
- token-creation replacement effects versus token-making spells,
- counter replacement effects,
- sacrifice outlets versus sacrifice-as-additional-cost spells,
- repeatable card-draw triggers versus one-time ETB draw,
- death-triggered draw and upkeep draw,
- enter-the-battlefield damage triggers,
- counterspells versus unrelated removal,
- graveyard-to-battlefield reanimation versus graveyard-to-hand recovery,
- replacement effects versus triggered effects.

Run fixture schema/coverage checks without a browser:

```sh
node tests/run-card-benchmark-data.cjs
```

The browser runner loads the JSON fixture and passes it to `runManaSearchRealCardBenchmarkSuite`, which uses production parsing, repeatability annotation, profile construction, and scoring. Fixture card pages are provenance links only; the tests are deterministic/offline and do not fetch card data during runs. When modifying a card Oracle-text fixture, recheck its linked reference page and retain the card source URL.
