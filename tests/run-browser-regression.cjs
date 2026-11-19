#!/usr/bin/env node
'use strict';

// Executes ManaSearch's real parser, mechanical scorer, repeatability and highlight suites in a
// Chromium page. No Scryfall calls are needed for these deterministic test cases.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream', '.wasm': 'application/wasm'
};
function safeFile(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, 'http://127.0.0.1').pathname);
  const resolved = path.resolve(root, '.' + pathname);
  if (!(resolved === root || resolved.startsWith(root + path.sep))) return null;
  return resolved;
}
async function main() {
  const server = http.createServer((req, res) => {
    const file = safeFile(req.url || '/');
    if (!file) { res.writeHead(403); return res.end('Forbidden'); }
    let selected = file;
    if (fs.existsSync(selected) && fs.statSync(selected).isDirectory()) selected = path.join(selected, 'index.html');
    if (!fs.existsSync(selected) || !fs.statSync(selected).isFile()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': mime[path.extname(selected)] || 'application/octet-stream' });
    fs.createReadStream(selected).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  let browser;
  try {
    const launchOptions = { headless: true, args: ['--no-sandbox'] };
    // CI uses Playwright's installed Chromium; local/offline environments can point this runner
    // at a preinstalled browser without changing the test code.
    if (process.env.MANASEARCH_CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.MANASEARCH_CHROMIUM_EXECUTABLE;
    browser = await chromium.launch(launchOptions);
    const page = await browser.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const failedRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', request => {
      failedRequests.push(`${request.url()}: ${request.failure()?.errorText || 'request failed'}`);
    });
    await page.goto(`http://127.0.0.1:${address.port}/index.html?manasearch-test=1`, {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    try {
      await page.waitForFunction(() =>
      typeof window.runMechanicalRegressionSuite === 'function' &&
      typeof window.runManaSearchMechanicalRegressionSuite === 'function' &&
      typeof window.runManaSearchRankingScoringRegressionSuite === 'function' &&
      typeof window.runManaSearchRepeatabilityRegressionSuite === 'function' &&
      typeof window.runManaSearchHighlightIsolationSuite === 'function' &&
      typeof window.runManaSearchPerformanceSuite === 'function' &&
      typeof window.runManaSearchRealCardBenchmarkSuite === 'function' &&
      typeof window.runManaSearchRealCardBenchmark === 'function' &&
      typeof window.runManaSearchIntentRegressionSuite === 'function' &&
      typeof window.runLocalBenchmarkInApp === 'function' &&
      typeof window.ManaSearchDebug?.getSnapshot === 'function' &&
      typeof window.ManaSearchDebug?.getLiveIntent === 'function' &&
      typeof window.ManaSearchDebug?.resolveSearchOutcome === 'function' &&
      typeof window.ManaSearchDebug?.normalizeRetrievalStreamDisplayLabel === 'function' &&
      typeof window.ManaSearchInspector?.getRunHistory === 'function' &&
      typeof window.ManaSearchInspector?.getActiveSearch === 'function' &&
      typeof window.ManaSearchInspector?.compareRuns === 'function' &&
      typeof window.ManaSearchInspector?.getExport === 'function' &&
      typeof window.ManaSearchInspector?.createRegressionCase === 'function' &&
      typeof window.ManaSearchInspector?.compareRegressionCase === 'function' &&
      !!document.getElementById('mana-search-inspector'),
      null, { timeout: 60000 }
      );
    } catch (error) {
      if (pageErrors.length) console.error('Browser page errors before ManaSearch test startup:', pageErrors.join('\\n'));
      if (consoleErrors.length) console.error('Browser console errors before ManaSearch test startup:', consoleErrors.join('\\n'));
      if (failedRequests.length) console.error('Browser requests that failed before ManaSearch test startup:', failedRequests.join('\\n'));
      throw error;
    }
    const report = await page.evaluate(async () => ({
      base: window.runMechanicalRegressionSuite(),
      mechanical: window.runManaSearchMechanicalRegressionSuite({ log: false }),
      rankingScoring: window.runManaSearchRankingScoringRegressionSuite({ log: false }),
      repeatability: window.runManaSearchRepeatabilityRegressionSuite({ log: false }),
      highlights: window.runManaSearchHighlightIsolationSuite({ log: false }),
      searchIntent: window.runManaSearchIntentRegressionSuite(),
      performance: window.runManaSearchPerformanceSuite({ iterations: 12, maxDurationMs: 15000, log: false }),
      // Exercise the same no-argument helper users call from DevTools. It fetches only the static
      // JSON fixture on this same test server; scoring remains local and deterministic.
      realCardBenchmark: await window.runManaSearchRealCardBenchmark({ log: false }),
      // Also exercise the suite-named public console entry point with no fixture argument.
      realCardBenchmarkSuiteNoArgs: await window.runManaSearchRealCardBenchmarkSuite({ log: false }),
      developerInspectorRegression: (() => {
        const earlier = {
          number: 1,
          completedAt: '2026-11-19T08:00:00.000Z',
          pipeline: {
            appBuild: '20261119-148',
            request: {
              inputSnapshotVersion: 2,
              sourceCard: { name: 'Source A' },
              highlights: [{ text: 'draw a card' }],
              intent: { sourceText: 'draw a card', semanticText: 'draw a card' },
              constraints: {}, methods: { functional: true }, ordering: 'overall',
              searchDepthPercent: 100,
              orderingFeatures: { matrix: false, diverse: false },
              rankingWeights: { mechanical: 0, synergy: 0, context: 0, exactness: 0, category: 0 },
              broad: false, divergent: false
            },
            funnel: { stages: {
              retrieved: ['Shared Card', 'Removed Card'], passedFilters: ['Shared Card', 'Removed Card'],
              deduplicated: ['Shared Card', 'Removed Card'], meaningfulParse: ['Shared Card', 'Removed Card'],
              scored: ['Shared Card', 'Removed Card'], passedRelevanceFloor: ['Shared Card', 'Removed Card'],
              finalRanked: ['Shared Card', 'Removed Card']
            } },
            streams: { 'Search B': ['shared card', 'removed card'] },
            streamFailures: [{ label: 'Semantic Index', message: 'Worker startup timed out' }],
            finalResults: [{ rank: 1, name: 'Shared Card' }, { rank: 2, name: 'Removed Card' }],
            candidates: [
              { name: 'Shared Card', preFloorRank: 1, scores: { similarityScore: 0.65, mechanicalScore: 0.7, effectAwareFunctionSemanticScore: 0.4 }, functionSemanticEvidence: { effectAwareScore: 0.4, matches: [{ sourceFunction: 'counter', candidateFunction: 'counter', sourceIndex: 0, candidateIndex: 0 }] }, mechanicalBreakdown: { graphScore: 0.7 } },
              { name: 'Removed Card', scores: { similarityScore: 0.42 } },
              { name: 'ChannelOnly Card', scores: { similarityScore: 0.60, mechanicalScore: 0.10 }, mechanicalBreakdown: { graphScore: 0.10 } }
            ]
          }
        };
        const later = {
          number: 2,
          completedAt: '2026-11-19T08:01:00.000Z',
          pipeline: {
            appBuild: '20261119-149',
            request: {
              inputSnapshotVersion: 2,
              sourceCard: { name: 'Source A' },
              highlights: [{ text: 'draw two cards' }],
              intent: { sourceText: 'draw two cards', semanticText: 'draw two cards' },
              constraints: {}, methods: { functional: true }, ordering: 'overall',
              searchDepthPercent: 100,
              orderingFeatures: { matrix: false, diverse: false },
              rankingWeights: { mechanical: 0, synergy: 0, context: 0, exactness: 0, category: 0 }
            },
            funnel: { stages: {
              retrieved: ['Shared Card', 'Added Card'], passedFilters: ['Shared Card', 'Added Card'],
              deduplicated: ['Shared Card', 'Added Card'], meaningfulParse: ['Shared Card', 'Added Card'],
              scored: ['Shared Card', 'Added Card'], passedRelevanceFloor: ['Shared Card', 'Added Card'],
              finalRanked: ['Added Card', 'Shared Card']
            } },
            streams: { 'Search B': ['shared card', 'added card'] },
            finalResults: [{ rank: 1, name: 'Added Card' }, { rank: 2, name: 'Shared Card' }],
            candidates: [
              { name: 'Shared Card', scores: { similarityScore: 0.75, mechanicalScore: 0.8, effectAwareFunctionSemanticScore: 0.9 }, mechanicalBreakdown: { graphScore: 0.85 }, functionSemanticEvidence: { effectAwareScore: 0.9, matches: [{ sourceFunction: 'counter', candidateFunction: 'counter', sourceIndex: 0, candidateIndex: 1 }] } },
              { name: 'Added Card', scores: { similarityScore: 0.81 } },
              { name: 'ChannelOnly Card', scores: { similarityScore: 0.60, mechanicalScore: 0.90 }, mechanicalBreakdown: { graphScore: 0.90 } }
            ]
          }
        };
        const tracePipeline = {
          request: { sourceCard: { name: 'Source A' } },
          streams: { 'Search B': ['Shared Card', 'Filtered Card'] },
          funnel: { stages: {
            retrieved: ['Shared Card', 'Filtered Card'],
            passedFilters: ['Shared Card'],
            deduplicated: ['Shared Card'],
            meaningfulParse: ['Shared Card'],
            scored: ['Shared Card'],
            passedRelevanceFloor: ['Shared Card'],
            finalRanked: ['Shared Card']
          } },
          filterRejections: [{ name: 'Filtered Card', reasons: ['exact highlight mismatch'] }],
          candidates: [{
            name: 'Shared Card', preFloorRank: 1, scores: { mechanicalScore: 0.8, similarityScore: 0.75 },
            rankingEvidence: { mechanical: 0.8, highlightIntent: 0.9 }, mechanicalBreakdown: { graphScore: 0.82, relationshipMismatch: 0.1 }, functionSemanticEvidence: { effectAwareScore: 0.94, matches: [{ sourceFunction: 'counter', candidateFunction: 'counter' }] }, retrievalEvidence: ['Search B']
          }],
          finalResults: [{ name: 'Shared Card', rank: 1, similarityScore: 0.75, flags: { weakBackfill: false } }],
          rankingEvidenceTop: [{ name: 'Shared Card', rank: 1, overall: 0.75 }]
        };
        const candidateTrace = window.ManaSearchInspector.traceCandidate(tracePipeline, 'shared card');
        const filteredTrace = window.ManaSearchInspector.traceCandidate(tracePipeline, 'Filtered Card');
        const comparison = window.ManaSearchInspector.compareRuns(earlier, later);
        const compareSummaryText = window.ManaSearchInspector.formatCompareSummary(comparison);
        const sharedScore = comparison.sharedCandidateScoreChanges.find(item => item.name === 'Shared Card');
        const history = window.ManaSearchInspector.getRunHistory();
        const errorRun = {
          number: 6,
          status: 'error',
          errorMessage: 'Synthetic retrieval failure',
          durationMs: 3200,
          summary: { sourceName: 'Source A', resultCount: 0, provisionalResultCount: 3, status: 'error', errorMessage: 'Synthetic retrieval failure' },
          pipeline: { request: structuredClone(earlier.pipeline.request), finalResults: [] }
        };
        const errorRunComparison = window.ManaSearchInspector.compareRuns(earlier, errorRun);
        const errorCompareSummaryText = window.ManaSearchInspector.formatCompareSummary(errorRunComparison);

        let refusesFailedBaseline = false;
        try { window.ManaSearchInspector.createRegressionCase(errorRun); }
        catch (_) { refusesFailedBaseline = true; }
        const normalizedNameComparison = window.ManaSearchInspector.compareRuns({
          number: 7,
          pipeline: { request: earlier.pipeline.request, streams: { 'Search B': ['Shared  Card'] }, finalResults: [{ rank: 1, name: 'Shared  Card' }] }
        }, {
          number: 8,
          pipeline: { request: later.pipeline.request, streams: { 'Search B': [' shared card '] }, finalResults: [{ rank: 1, name: ' shared card ' }] }
        });
        const requestKeyOrderComparison = window.ManaSearchInspector.compareRuns({
          number: 9,
          pipeline: {
            request: {
              sourceCard: { id: 'stable', name: 'Source A' },
              highlights: [{ text: 'draw a card', mode: 'exact' }],
              intent: { sourceText: 'draw a card', semanticText: 'draw a card' },
              constraints: { type: 'creature', cmc: 2 },
              methods: { functional: true, role: false },
              ordering: 'overall',
              inputSnapshotVersion: 2,
              searchDepthPercent: 100,
              orderingFeatures: { matrix: false, diverse: true },
              rankingWeights: { mechanical: 0, synergy: 0, context: 0, exactness: 0, category: 0 },
              broad: false, divergent: false
            },
            finalResults: []
          }
        }, {
          number: 10,
          pipeline: {
            request: {
              rankingWeights: { category: 0, exactness: 0, context: 0, synergy: 0, mechanical: 0 },
              orderingFeatures: { diverse: true, matrix: false },
              searchDepthPercent: 100,
              inputSnapshotVersion: 2,
              ordering: 'overall',
              methods: { role: false, functional: true },
              constraints: { cmc: 2, type: 'creature' },
              intent: { semanticText: 'draw a card', sourceText: 'draw a card' },
              highlights: [{ mode: 'exact', text: 'draw a card' }],
              sourceCard: { name: 'Source A', id: 'stable' },
              divergent: false, broad: false
            },
            finalResults: []
          }
        });
        // Feed synthetic request-scoped events through the same browser event listeners used by
        // the real app, including an old request's late progress update which must be ignored.
        window.dispatchEvent(new CustomEvent('manasearch:search-started', {
          detail: { requestId: 9001, sourceName: 'Telemetry Source', highlightCount: 1, startedAt: '2026-11-19T08:10:00.000Z' }
        }));
        window.dispatchEvent(new CustomEvent('manasearch:progress-updated', {
          detail: { requestId: 9001, step: 1, total: 3, message: 'Searching for candidates', at: 1000 }
        }));
        window.dispatchEvent(new CustomEvent('manasearch:search-streams-updated', {
          detail: {
            requestId: 9001, completedStreams: 1, failedStreams: 1, settledStreams: 2, totalStreams: 2,
            streams: [
              { label: 'Exact Phrase', done: true, status: 'completed', failed: false, detail: 'Done · 1 page · 4 cards' },
              { label: 'Semantic Index', done: false, status: 'failed', failed: true, detail: 'Failed — worker unavailable' }
            ]
          }
        }));
        window.dispatchEvent(new CustomEvent('manasearch:search-preview-updated', {
          detail: { requestId: 9001, phase: 'progressive-preview', sourceLabel: 'Exact Phrase', provisional: true, resultCount: 1, topNames: ['Shared Card'], at: 1100 }
        }));
        window.dispatchEvent(new CustomEvent('manasearch:progress-updated', {
          detail: { requestId: 9000, step: 2, total: 3, message: 'STALE EVENT MUST BE IGNORED', at: 1200 }
        }));
        window.dispatchEvent(new CustomEvent('manasearch:search-preview-updated', {
          detail: { requestId: 9001, phase: 'final-ranking', sourceLabel: 'Authoritative final ranking', provisional: false, resultCount: 1, topNames: ['Shared Card'], at: 1300 }
        }));
        const activeSearchBeforeFinish = window.ManaSearchInspector.getActiveSearch();
        const liveSummaryText = window.ManaSearchInspector.formatLiveSummary({
          source: { name: 'Telemetry Source' },
          liveSearch: activeSearchBeforeFinish,
          runtime: { loading: true }
        });
        const liveSettingsSummaryText = window.ManaSearchInspector.formatLiveSummary({
          source: { name: 'Settings Source' },
          searchIntent: { productionModel: {
            searchDepthPercent: 85,
            orderingFeatures: { matrix: true, diverse: false },
            rankingWeights: { mechanical: 0.25, synergy: 0, context: -0.1 }
          } },
          liveSearch: { status: 'running' },
          runtime: { loading: true }
        });
        window.dispatchEvent(new CustomEvent('manasearch:search-finished', {
          detail: {
            requestId: 9001, status: 'completed_with_warnings', partial: true,
            sourceName: 'Telemetry Source', resultCount: 1, errorMessage: 'One retrieval lane was interrupted',
            startedAt: '2026-11-19T08:10:00.000Z', finishedAt: '2026-11-19T08:10:03.200Z', durationMs: 3200
          }
        }));
        const telemetryHistory = window.ManaSearchInspector.getRunHistory();
        const telemetryRun = telemetryHistory.find(run => run.number === (telemetryHistory[telemetryHistory.length - 1]?.number));

        const regressionCase = window.ManaSearchInspector.createRegressionCase(earlier, {
          title: 'Shared Card must stay first',
          notes: 'A deliberate rank regression fixture.',
          focusCandidate: 'Shared Card',
          focusBehavior: 'rank-at-most',
          maxRank: 1,
          expectedTopCandidates: ['Shared Card', 'Removed Card']
        });
        const failedRegressionComparison = window.ManaSearchInspector.compareRegressionCase(regressionCase, errorRun);
        const partialRun = {
          number: 11,
          status: 'completed_with_warnings',
          errorMessage: 'Semantic stream timed out',
          summary: { sourceName: 'Source A', resultCount: 1, provisionalResultCount: 2, status: 'completed_with_warnings', errorMessage: 'Semantic stream timed out' },
          pipeline: {
            request: structuredClone(earlier.pipeline.request),
            finalResults: [{ rank: 1, name: 'Shared Card' }]
          }
        };
        const partialRegressionComparison = window.ManaSearchInspector.compareRegressionCase(regressionCase, partialRun);
        const partialRunComparison = window.ManaSearchInspector.compareRuns(earlier, partialRun);
        const replayRun = {
          number: 3,
          completedAt: '2026-11-19T08:02:00.000Z',
          pipeline: {
            appBuild: '20261119-149',
            request: structuredClone(earlier.pipeline.request),
            candidates: [
              { name: 'Shared Card', preFloorRank: 2, scores: { similarityScore: 0.75, mechanicalScore: 0.8 }, mechanicalBreakdown: { graphScore: 0.85 } },
              { name: 'Added Card', preFloorRank: 1, scores: { similarityScore: 0.81 } }
            ],
            finalResults: [{ rank: 1, name: 'Added Card' }, { rank: 2, name: 'Shared Card' }]
          }
        };
        const stableRequest = {
          ...earlier.pipeline.request,
          sourceCard: { id: 'stable-id', name: 'Source A' }
        };
        const stableFixture = window.ManaSearchInspector.createRegressionCase({
          number: 4, pipeline: { ...earlier.pipeline, request: stableRequest }
        }, { expectedTopCandidates: ['Shared Card'] });
        const reorderedStableRequest = {
          ...stableRequest,
          sourceCard: { name: 'Source A', id: 'stable-id' }
        };
        const stableOrderReport = window.ManaSearchInspector.compareRegressionCase(stableFixture, {
          number: 5,
          pipeline: { request: reorderedStableRequest, finalResults: [{ rank: 1, name: 'Shared Card' }] }
        });

        const derivedIntentRun = {
          number: 12,
          pipeline: {
            request: {
              ...structuredClone(earlier.pipeline.request),
              intent: { sourceText: 'draw a card', semanticText: 'draw two cards', exactnessText: 'draw two cards' },
              queryPlans: { semantic: 'draw two cards' }
            },
            finalResults: structuredClone(earlier.pipeline.finalResults)
          }
        };
        const derivedIntentReport = window.ManaSearchInspector.compareRegressionCase(regressionCase, derivedIntentRun);
        const derivedPlanRunComparison = window.ManaSearchInspector.compareRuns(earlier, derivedIntentRun);
        const broadOptionRun = {
          number: 13,
          pipeline: {
            request: { ...structuredClone(earlier.pipeline.request), broad: true, divergent: true },
            finalResults: structuredClone(earlier.pipeline.finalResults)
          }
        };
        const broadOptionComparison = window.ManaSearchInspector.compareRuns(earlier, broadOptionRun);
        const broadOptionRegression = window.ManaSearchInspector.compareRegressionCase(regressionCase, broadOptionRun);
        const settingsChangedRun = {
          number: 14,
          pipeline: {
            request: {
              ...structuredClone(earlier.pipeline.request),
              searchDepthPercent: 70,
              orderingFeatures: { matrix: true, diverse: false },
              rankingWeights: { ...earlier.pipeline.request.rankingWeights, mechanical: 0.25 }
            },
            finalResults: structuredClone(earlier.pipeline.finalResults)
          }
        };
        const settingsChangedComparison = window.ManaSearchInspector.compareRuns(earlier, settingsChangedRun);
        const incompleteInputSnapshotRun = {
          number: 15,
          pipeline: {
            request: {
              sourceCard: { name: 'Source A' },
              highlights: [{ text: 'draw a card' }],
              constraints: {}, methods: { functional: true }, ordering: 'overall'
            },
            finalResults: structuredClone(earlier.pipeline.finalResults)
          }
        };
        const incompleteInputComparison = window.ManaSearchInspector.compareRuns(earlier, incompleteInputSnapshotRun);
        const provisionalErrorSummary = window.ManaSearchInspector.formatLiveSummary({
          source: { name: 'Interrupted Source' },
          liveSearch: {
            status: 'error', sourceName: 'Interrupted Source',
            provisionalResultCount: 3,
            preview: { resultCount: 3, provisional: true, topNames: ['Provisional A'] }
          }
        });
        const regressionReport = window.ManaSearchInspector.compareRegressionCase(regressionCase, replayRun);
        const inputMismatchReport = window.ManaSearchInspector.compareRegressionCase(regressionCase, later);
        const excludedCase = window.ManaSearchInspector.createRegressionCase(earlier, {
          focusCandidate: 'Added Card',
          focusBehavior: 'must-not-appear',
          expectedTopCandidates: []
        });
        const exclusionReport = window.ManaSearchInspector.compareRegressionCase(excludedCase, replayRun);
        let rejectsInvalidCase = false;
        try { window.ManaSearchInspector.validateRegressionCase({ schema: 'wrong', version: 1 }); }
        catch (_) { rejectsInvalidCase = true; }
        const cleanLaneOutcome = window.ManaSearchDebug.resolveSearchOutcome(
          'completed', '', [['Exact Phrase', 'completed']], []
        );
        const failedLaneOutcome = window.ManaSearchDebug.resolveSearchOutcome(
          'completed', '',
          [['Exact Phrase', 'completed'], ['Semantic Index', 'failed']],
          [{ label: 'Semantic Index', message: 'Worker startup timed out' }]
        );
        const partialFunctionalOutcome = window.ManaSearchDebug.resolveSearchOutcome(
          'completed', '',
          [['Exact Phrase', 'completed'], ['Functional Match', 'completed_with_warnings']],
          [{ label: 'Search F #1 (Functional Match)', message: 'One functional query timed out' }]
        );
        const fatalSearchOutcome = window.ManaSearchDebug.resolveSearchOutcome(
          'error', 'Unexpected scorer failure', [['Semantic Index', 'failed']],
          [{ label: 'Semantic Index', message: 'Worker startup timed out' }]
        );
        return {
          cleanSearchOutcomeStaysCompleted: cleanLaneOutcome.status === 'completed' && cleanLaneOutcome.errorMessage === '',
          failedRetrievalLaneDowngradesSuccessToWarning: failedLaneOutcome.status === 'completed_with_warnings' &&
            failedLaneOutcome.errorMessage.includes('Semantic Index') && failedLaneOutcome.errorMessage.includes('Worker startup timed out'),
          functionalQueryWarningIsCountedOnce: partialFunctionalOutcome.status === 'completed_with_warnings' &&
            (partialFunctionalOutcome.errorMessage.match(/Functional Match/g) || []).length === 1,
          fatalSearchOutcomeIsNotDowngraded: fatalSearchOutcome.status === 'error' && fatalSearchOutcome.errorMessage === 'Unexpected scorer failure',
          compareApiAvailable: !!comparison && Array.isArray(comparison.finalRanking?.rankChanges),
          compareSummaryExplainsValidityAndMetrics: compareSummaryText.includes('COMPARE RUNS SUMMARY') &&
            compareSummaryText.includes('Changed user inputs:') && compareSummaryText.includes('Top-K overlap:') &&
            compareSummaryText.includes('FULL COMPARISON JSON'),
          compareSummaryUsesRealLineBreaks: compareSummaryText.includes('COMPARE RUNS SUMMARY\nComparison type:') &&
            !compareSummaryText.includes('COMPARE RUNS SUMMARY\\nComparison type:'),
          compareSummaryShowsChangedScoringFactors: compareSummaryText.includes('Changed factors:'),
          compareShowsAppBuildEvolution: comparison.outcomeComparison?.earlierBuild === '20261119-148' &&
            comparison.outcomeComparison?.laterBuild === '20261119-149' && comparison.outcomeComparison?.buildChanged === true &&
            compareSummaryText.includes('App builds: 20261119-148 → 20261119-149 (different builds)'),
          regressionCasePreservesSourceBuild: regressionCase.source.appBuild === '20261119-148' &&
            regressionReport.comparedRun?.appBuild === '20261119-149' && regressionReport.comparedRun?.buildChanged === true,

          compareSummaryIncludesRecoveredStream: compareSummaryText.includes('[RECOVERED] Semantic Index'),
          liveSummaryExplainsCurrentSearch: liveSummaryText.includes('LIVE SEARCH SUMMARY') &&
            liveSummaryText.includes('Telemetry Source') && liveSummaryText.includes('[FAILED] Semantic Index') &&
            liveSummaryText.includes('FULL CAPTURED STATE'),
          liveSummaryUsesRealLineBreaks: liveSummaryText.includes('LIVE SEARCH SUMMARY\nSource:') &&
            !liveSummaryText.includes('LIVE SEARCH SUMMARY\\nSource:'),
          liveSummaryLabelsVisibleProvisionalResults: provisionalErrorSummary.includes('Provisional results still visible: 3') &&
            provisionalErrorSummary.includes('not a complete final ranking'),
          liveSummaryShowsFinalRankingEvent: liveSummaryText.includes('final ranked results') &&
            liveSummaryText.includes('Shared Card'),
          liveSummaryShowsCurrentSearchSettings: liveSettingsSummaryText.includes('Search depth: 85%') &&
            liveSettingsSummaryText.includes('Ordering features: matrix') &&
            liveSettingsSummaryText.includes('Score-weight offsets: mechanical=0.25'),
          candidateTraceApiAvailable: typeof window.ManaSearchInspector.traceCandidate === 'function',
          traceMatchesCaseInsensitively: candidateTrace.found === true && candidateTrace.candidateName === 'shared card',
          traceShowsRetrievalProvenance: candidateTrace.retrieval.streams.includes('Search B'),
          traceShowsStageProgression: candidateTrace.stages.find(stage => stage.stage === 'scored')?.present === true,
          traceShowsScoreBreakdown: candidateTrace.scoring?.scores?.mechanicalScore === 0.8 && candidateTrace.scoring?.rankingEvidence?.highlightIntent === 0.9,
          traceShowsMechanicalBreakdown: candidateTrace.scoring?.mechanicalBreakdown?.graphScore === 0.82,
          traceShowsAbilityAwareSemanticEvidence: candidateTrace.scoring?.functionSemanticEvidence?.effectAwareScore === 0.94 && candidateTrace.scoring?.functionSemanticEvidence?.matches?.[0]?.candidateFunction === 'counter',
          traceShowsFinalRank: candidateTrace.finalRanking?.rank === 1,
          traceShowsFilterRejection: filteredTrace.possibleHardFilterRejection?.reasons?.includes('exact highlight mismatch') === true,
          detectsChangedHighlight: comparison.changes.highlightsChanged === true,
          detectsChangedInterpretation: comparison.changes.intentChanged === true,
          detectsAddedAndRemovedCards: comparison.finalRanking.addedInLater.includes('Added Card') && comparison.finalRanking.missingFromLater.includes('Removed Card'),
          detectsRankMovement: comparison.finalRanking.rankChanges.some(item => item.name === 'Shared Card' && item.earlierRank === 1 && item.laterRank === 2),
          detectsScoreDelta: !!sharedScore && Math.abs(sharedScore.delta - 0.10) < 1e-9,
          comparePrioritizesMaterialFactorOnlyChanges: comparison.sharedCandidateScoreChanges[0]?.name === 'ChannelOnly Card' && comparison.sharedCandidateScoreChanges[0]?.delta === 0 && comparison.sharedCandidateScoreChanges[0]?.largestFactorDelta > 0.7,
          compareRunsSurfacesAbilityAwareFunctionScoreDelta: !!sharedScore?.scoreChannelChanges?.some(change => change.field === 'effectAwareFunctionSemanticScore' && Math.abs(change.delta - 0.5) < 1e-9),
          compareRunsSurfacesAbilityEvidenceScoreDelta: !!sharedScore?.scoreChannelChanges?.some(change => change.field === 'functionSemanticEvidence.effectAwareScore' && Math.abs(change.delta - 0.5) < 1e-9),
          compareRunsDetectsAbilityMatchIdentityChange: sharedScore?.functionSemanticEvidence?.abilityMatchesChanged === true && sharedScore.functionSemanticEvidence.laterMatches?.[0]?.candidateIndex === 1,
          compareSummaryShowsAbilityMatchEvolution: compareSummaryText.includes('Matched ability change:') &&
            compareSummaryText.includes('candidate ability 1') && compareSummaryText.includes('candidate ability 2'),
          computesRetrievalOverlap: comparison.retrieval.some(item => item.stream === 'Search B' && item.sharedCount === 1 && Math.abs(item.jaccard - (1 / 3)) < 1e-4),
          comparesResolvedRetrievalFailures: comparison.retrievalFailures?.earlierCount === 1 && comparison.retrievalFailures?.laterCount === 0 && comparison.retrievalFailures?.resolved?.[0]?.label === 'Semantic Index',
          historyIsArray: Array.isArray(history),
          exportSerializable: JSON.stringify(window.ManaSearchInspector.getExport()).length > 0,
          compareTabAvailable: !!document.querySelector('[data-tab="compare"]'),

          regressionCaseApiAvailable: typeof window.ManaSearchInspector.createRegressionCase === 'function',
          regressionCaseHasOriginalDiagnostics: !!regressionCase.diagnostics?.request && regressionCase.schema === 'manasearch-regression-case-v1',
          regressionComparisonDetectsFocusRankFailure: regressionReport.focusCheck?.actualRank === 2 && regressionReport.focusCheck?.pass === false && regressionReport.pass === false,
          regressionComparisonDetectsRankingRegression: regressionReport.rankingCheck?.exactOrderMatch === false && regressionReport.rankingCheck?.missingFromTop.includes('Removed Card') && regressionReport.rankingCheck?.unexpectedInTop.includes('Added Card'),
          regressionComparisonMeasuresTopKOverlap: regressionReport.rankingCheck?.overlap === 0.5,
          regressionComparisonShowsScoringPoolCoverage: regressionReport.scoringEvolution?.sharedScoredSampleCount === 1 && regressionReport.scoringEvolution?.newlyPresentInScoredSample.includes('Added Card') && regressionReport.scoringEvolution?.sampleLimit === 300,
          regressionComparisonShowsScoreChannelDeltas: regressionReport.scoringEvolution?.changedSampleCandidates.some(item => item.name === 'Shared Card' && item.scoreChanges.some(change => change.field === 'similarityScore' && Math.abs(change.delta - 0.1) < 1e-9) && item.mechanicalBreakdownChanges.some(change => change.field === 'graphScore' && Math.abs(change.delta - 0.15) < 1e-9)),
          regressionComparisonIncludesCandidateJourneyEvolution: regressionReport.focusCheck?.baselineTrace?.found === true && regressionReport.focusCheck?.currentTrace?.found === true,
          regressionComparisonRejectsChangedInputs: inputMismatchReport.status === 'input-mismatch' && inputMismatchReport.pass === null && inputMismatchReport.inputCheck.changedFields.includes('highlights'),
          regressionAllowsDerivedIntentEvolution: derivedIntentReport.inputCheck?.matches === true && derivedIntentReport.derivedRequestChanges.includes('intent') && derivedIntentReport.pass === true,
          compareReportsChangedDerivedSearchPlanSeparately: derivedPlanRunComparison.changes.intentChanged === true && derivedPlanRunComparison.changes.queryPlansChanged === true && derivedPlanRunComparison.changes.changedInputFields.length === 0 && derivedPlanRunComparison.changes.changedDerivedFields.includes('intent'),
          compareTreatsBroadAndDivergentAsUserInputs: broadOptionComparison.changes.broadChanged === true && broadOptionComparison.changes.divergentChanged === true &&
            broadOptionComparison.changes.changedInputFields.includes('broad') && broadOptionComparison.changes.changedInputFields.includes('divergent') &&
            !broadOptionComparison.changes.changedDerivedFields.includes('broad') && !broadOptionComparison.outcomeComparison.comparableForAlgorithmRegression,
          regressionRejectsChangedBroadAndDivergentInputs: broadOptionRegression.status === 'input-mismatch' && broadOptionRegression.pass === null &&
            broadOptionRegression.inputCheck.changedFields.includes('broad') && broadOptionRegression.inputCheck.changedFields.includes('divergent'),
          compareMarksFailedRunInvalid: errorRunComparison.outcomeComparison?.rankingComparisonValid === false && errorRunComparison.outcomeComparison?.laterStatus === 'error',
          compareShowsProvisionalCountsForInterruptedRuns: errorRunComparison.outcomeComparison?.laterProvisionalResultCount === 3 &&
            partialRunComparison.outcomeComparison?.laterProvisionalResultCount === 2 &&
            errorCompareSummaryText.includes('Provisional cards still visible: earlier 0 → later 3'),
          compareMarksPartialRunIncomplete: partialRunComparison.outcomeComparison?.rankingComparisonValid === false && partialRunComparison.outcomeComparison?.rankingComparisonAvailable === true && partialRunComparison.outcomeComparison?.rankingComparisonComplete === false,
          compareExplainsAddedAndRemovedCardPaths: comparison.candidatePathChanges?.some(item => item.name === 'Removed Card' &&
            item.firstDivergence?.stage === 'retrieved' && item.earlierFinalRank === 2 && item.laterFinalRank === null) &&
            comparison.candidatePathChanges?.some(item => item.name === 'Added Card' &&
            item.firstDivergence?.stage === 'retrieved' && item.earlierFinalRank === null && item.laterFinalRank === 1),
          compareExplainsSharedCardRankMoves: comparison.candidatePathChanges?.some(item => item.name === 'Shared Card' &&
            item.earlierFinalRank === 1 && item.laterFinalRank === 2 && item.explanation.includes('same retained pipeline stages')),
          compareSummaryShowsCandidatePathDifferences: compareSummaryText.includes('Changed-card pipeline paths') && compareSummaryText.includes('Removed Card'),
          compareShowsPipelineStageRecallChanges: comparison.stageProgression.find(stage => stage.stage === 'retrieved')?.addedInLater.includes('Added Card') && comparison.stageProgression.find(stage => stage.stage === 'retrieved')?.missingFromLater.includes('Removed Card'),
          compareShowsScoredSampleTurnover: comparison.scoredCandidateEvolution?.newlyPresentInSample.includes('Added Card') && comparison.scoredCandidateEvolution?.noLongerPresentInSample.includes('Removed Card') && comparison.scoredCandidateEvolution?.sampleLimit === 300,
          compareShowsTopKOverlapAndCaptureLimit: comparison.finalRanking?.topKOverlap?.find(item => item.k === 10)?.overlap === 0.1 && comparison.finalRanking?.topKOverlap?.find(item => item.k === 10)?.capturedListOverlap === 0.5 && comparison.finalRanking?.capturedLimit === 100,
          compareDetectsSearchDepthChange: settingsChangedComparison.changes.searchDepthPercentChanged === true &&
            settingsChangedComparison.changes.changedInputFields.includes('searchDepthPercent'),
          compareDetectsOrderingFeatureChange: settingsChangedComparison.changes.orderingFeaturesChanged === true &&
            settingsChangedComparison.changes.changedInputFields.includes('orderingFeatures'),
          compareDetectsRankingWeightChange: settingsChangedComparison.changes.rankingWeightsChanged === true &&
            settingsChangedComparison.changes.changedInputFields.includes('rankingWeights'),
          compareRejectsIncompleteInputSnapshots: incompleteInputComparison.outcomeComparison?.inputSnapshotComplete === false &&
            incompleteInputComparison.outcomeComparison?.comparableForAlgorithmRegression === false &&
            incompleteInputComparison.outcomeComparison?.missingInputFields?.later?.includes('searchDepthPercent'),
          compareFlagsChangedInputsAsUncontrolled: comparison.outcomeComparison?.sameUserInputs === false && comparison.outcomeComparison?.comparableForAlgorithmRegression === false,
          regressionCompareTreatsPartialRunAsNoVerdict: partialRegressionComparison.status === 'partial-run' && partialRegressionComparison.pass === null && partialRegressionComparison.comparedRun?.warning === 'Semantic stream timed out',
          compareShowsScoreChannelAndMechanicalBreakdownChanges: comparison.sharedCandidateScoreChanges.some(item => item.name === 'Shared Card' && item.scoreChannelChanges?.some(change => change.field === 'mechanicalScore' && Math.abs(change.delta - 0.1) < 1e-9) && item.mechanicalBreakdownChanges?.some(change => change.field === 'graphScore' && Math.abs(change.delta - 0.15) < 1e-9)),
          regressionCompareDoesNotCountFailedRunAsRankingFailure: failedRegressionComparison.status === 'search-error' && failedRegressionComparison.pass === null,
          regressionBuilderRejectsFailedBaseline: refusesFailedBaseline,
          compareNormalizesCandidateNameWhitespaceAndCase: normalizedNameComparison.finalRanking.sharedCount === 1 && normalizedNameComparison.retrieval[0]?.sharedCount === 1,
          compareIgnoresRequestObjectKeyOrder: [
            'sourceCardChanged', 'highlightsChanged', 'intentChanged', 'constraintsChanged',
            'methodsChanged', 'orderingChanged', 'formatChanged', 'colorChanged',
            'broadChanged', 'divergentChanged', 'searchDepthPercentChanged', 'orderingFeaturesChanged',
            'rankingWeightsChanged', 'plannedStreamsChanged', 'queryPlansChanged'
          ].every(key => requestKeyOrderComparison.changes[key] === false) &&
            requestKeyOrderComparison.changes.changedInputFields.length === 0 &&
            requestKeyOrderComparison.changes.changedDerivedFields.length === 0,
          liveInspectorCapturesProgress: activeSearchBeforeFinish?.progress?.message === 'Searching for candidates',
          liveInspectorIgnoresStaleProgress: activeSearchBeforeFinish?.progress?.message !== 'STALE EVENT MUST BE IGNORED',
          liveInspectorCapturesStreamProgress: activeSearchBeforeFinish?.completedStreams === 1 && activeSearchBeforeFinish?.failedStreams === 1 && activeSearchBeforeFinish?.settledStreams === 2 && activeSearchBeforeFinish?.totalStreams === 2 && activeSearchBeforeFinish?.streams?.[0]?.done === true && activeSearchBeforeFinish?.streams?.[1]?.failed === true,
          liveInspectorCapturesProvisionalResults: activeSearchBeforeFinish?.previewHistory?.some(item => item.phase === 'progressive-preview' && item.provisional === true && item.topNames?.includes('Shared Card')),
          liveInspectorCapturesFinalRanking: activeSearchBeforeFinish?.preview?.phase === 'final-ranking' && activeSearchBeforeFinish?.preview?.provisional === false,
          liveInspectorStoresWarningOutcome: telemetryRun?.status === 'completed_with_warnings' && telemetryRun?.durationMs === 3200,
          liveInspectorStoresEventTraceWithRun: telemetryRun?.liveSearch?.previewHistory?.length === 2 && telemetryRun?.liveSearch?.streams?.length === 2 && telemetryRun?.liveSearch?.failedStreams === 1,
          regressionComparisonChecksMustNotAppear: exclusionReport.focusCheck?.pass === false,
          regressionImportValidationRejectsUnknownSchema: rejectsInvalidCase,
          regressionTabAvailable: !!document.querySelector('[data-tab="regression"]'),
          regressionImportControlAvailable: !!document.querySelector('[data-regression-import]'),
          regressionExpectedRankingEditorAvailable: !!document.querySelector('[data-regression-top]'),
          downloadActionAvailable: !!document.querySelector('[data-action="download"]')
        };
      })(),
      developerDiagnostics: (() => {
        const snapshot = window.ManaSearchDebug.getSnapshot();
        return { available: !!snapshot && typeof snapshot === 'object', serializable: JSON.stringify(snapshot).length > 0, hasPipelineFields: ['request', 'funnel', 'streams', 'streamFailures', 'candidates', 'filterRejections'].every(key => Object.prototype.hasOwnProperty.call(snapshot, key)), liveIntentAvailable: typeof window.ManaSearchDebug.getLiveIntent === 'function', functionalStreamFailureLabelsNormalize: window.ManaSearchDebug.normalizeRetrievalStreamDisplayLabel('Search F #3 (Functional Match)') === 'Functional Match' && window.ManaSearchDebug.normalizeRetrievalStreamDisplayLabel('Exact Phrase') === 'Exact Phrase' };
      })()
    }));
    // Exercise the real end-to-end local search path, not only isolated scorer helpers.
    // The 12 fixed cases use bundled cards.bin + semantic-index.bin and do not call Scryfall.
    const liveSearchEvaluation = await page.evaluate(async () => {
      const benchmark = await window.runLocalBenchmarkInApp();
      const history = window.ManaSearchInspector.getRunHistory();
      const latestPair = history.length >= 2 ? history.slice(-2) : [];
      const comparison = latestPair.length === 2
        ? window.ManaSearchInspector.compareRuns(latestPair[0], latestPair[1])
        : null;
      const cases = (benchmark.structuredResults || []).map(item => {
        const strict = item.strict || {};
        return {
          id: item.id,
          name: item.name,
          source: item.source,
          status: strict.testStatus,
          recall20: strict.recall20 ?? null,
          adjustedRecall20: strict.adjustedRecall20 ?? null,
          retrievalRecall: strict.stageRecalls?.retrieval ?? null,
          filterRecall: strict.stageRecalls?.filter ?? null,
          scoringRecall: strict.stageRecalls?.scoring ?? null,
          pruningRecall: strict.stageRecalls?.pruning ?? null,
          mrr: strict.mrr ?? null,
          ndcg20: strict.ndcg20 ?? null,
          precision10: strict.precision10 ?? null,
          expectedRanks: strict.cardRanks || {},
          // Print the leading names and score channels for low-recall cases. This makes it possible
          // to inspect which false positives outrank known-good cards without rerunning the app
          // manually or relying on a browser screenshot.
          topRankedCandidates: (strict.recall20 ?? 1) < 0.5
            ? (strict.rankedResults || []).slice(0, 20).map((name, index) => {
                const score = strict.scoreByName instanceof Map ? (strict.scoreByName.get(String(name || '').toLowerCase()) || null) : null;
                return {
                  rank: index + 1,
                  name,
                  similarityScore: score?.similarityScore ?? null,
                  mechanicalScore: score?.mechanicalScore ?? null,
                  functionScore: score?.functionScore ?? null,
                  effectAwareFunctionSemanticScore: score?.effectAwareFunctionSemanticScore ?? null,
                  functionSemanticEvidence: score?.functionSemanticEvidence ?? null,
                  roleScore: score?.roleScore ?? null,
                  contextScore: score?.contextScore ?? score?.oracleSemanticScore ?? null,
                  highlightIntentScore: score?.highlightIntentScore ?? null,
                  exactnessScore: score?.exactnessScore ?? null,
                  mechanicRankingTier: score?.mechanicRankingTier ?? null,
                  mechanicRankingTierLabel: score?.mechanicRankingTierLabel ?? null,
                  rankingIntent: score?.rankingIntent ?? null,
                  rankingIntentRole: score?.rankingIntentRole ?? null
                };
              })
            : [],
          expectedCardEvidence: (item.expected || []).map(name => {
            const key = String(name || '').trim().toLowerCase();
            const score = strict.scoreByName instanceof Map ? (strict.scoreByName.get(key) || null) : null;
            const diagnostics = strict.diagnostics || {};
            const hasName = values => {
              if (values instanceof Set) return [...values].some(value => String(value || '').trim().toLowerCase() === key);
              if (Array.isArray(values)) return values.some(value => String(value || '').trim().toLowerCase() === key);
              return false;
            };
            const stageSources = {
              retrieved: diagnostics.rawCandidateNames,
              passedFilters: diagnostics.passedFilterNames,
              deduplicated: diagnostics.dedupedNames,
              meaningfulParse: diagnostics.meaningfulParseNames,
              scored: diagnostics.scoredNames,
              passedRelevanceFloor: diagnostics.passedRelevanceFloorNames,
              finalRanked: diagnostics.finalRankedNames
            };
            const rejectionEntry = diagnostics.filterFailureReasons instanceof Map
              ? [...diagnostics.filterFailureReasons.entries()].find(([candidate]) => String(candidate || '').trim().toLowerCase() === key)
              : null;
            const retrievalStreams = Object.entries(diagnostics.streams || {})
              .filter(([, values]) => hasName(values)).map(([stream]) => stream);
            return {
              name,
              rank: strict.cardRanks?.[name] ?? null,
              stageMembership: Object.fromEntries(Object.entries(stageSources).map(([stage, values]) => [stage, hasName(values)])),
              retrievalStreams,
              filterRejection: rejectionEntry ? rejectionEntry[1] : null,
              score: score ? {
                similarityScore: score.similarityScore ?? null,
                mechanicalScore: score.mechanicalScore ?? null,
                functionScore: score.functionScore ?? null,
                effectAwareFunctionSemanticScore: score.effectAwareFunctionSemanticScore ?? null,
                functionSemanticEvidence: score.functionSemanticEvidence ?? null,
                contextScore: score.contextScore ?? null,
                highlightIntentScore: score.highlightIntentScore ?? null,
                exactnessScore: score.exactnessScore ?? null,
                effectCoverageScore: score.effectCoverageScore ?? null,
                primaryEffectMatchScore: score.primaryEffectMatchScore ?? null,
                modalModeSimilarityScore: score.modalModeSimilarityScore ?? null,
                semanticRrfAgreement: score.semanticRrfAgreement ?? null,
                semanticAbilityCoverage: score.semanticAbilityCoverage ?? null,
                semanticRetrievalViews: score.semanticRetrievalViews || [],
                rankingIntent: score.rankingIntent ?? null,
                rankingIntentRole: score.rankingIntentRole ?? null,
                evidenceGate: score.evidenceGate ?? null,
                mechanicRankingTier: score.mechanicRankingTier ?? null,
                mechanicRankingTierLabel: score.mechanicRankingTierLabel ?? null,
                mechanicRankingEvidence: score.mechanicRankingEvidence ?? null,
                contradictionPenalty: score.contradictionPenalty ?? null,
                quantitativeConflictPenalty: score.quantitativeConflictPenalty ?? null,
                acquisitionCadenceRankFactor: score.acquisitionCadenceRankFactor ?? null,
                mechanicalBreakdown: score.mechanicalBreakdown ?? null
              } : null
            };
          }),
          error: strict.errorMessage || '',
          // Retain the actual retrieval plan and corpus evidence for low-recall cases.
          // This lets us identify whether an expected card was absent because the query was
          // too narrow, its stream failed, or the indexed corpus did not contain the card.
          retrievalDiagnostics: (strict.recall20 ?? 1) < 0.5 ? {
            benchmarkSignals: strict.diagnostics?.benchmarkSignals || null,
            streamCoverage: strict.diagnostics?.streamCoverage || null,
            streamCounts: Object.fromEntries(Object.entries(strict.diagnostics?.streams || {}).map(([name, values]) => [name, values instanceof Set ? values.size : Array.isArray(values) ? values.length : 0])),
            functionalQueryResults: strict.diagnostics?.searchFQueryDetail || [],
            exactHighlightQueryResults: strict.diagnostics?.exactHighlightQueryDetail || [],
            highlightIntentDiagnostics: strict.diagnostics?.highlightIntentDiagnostics || [],
            streamFailures: strict.diagnostics?.streamFailures || []
          } : null,
          candidateTextEvidence: (strict.recall20 ?? 1) < 0.5
            ? [...new Set([...(item.expected || []), ...(strict.rankedResults || []).slice(0, 10)])]
                .slice(0, 20).map(cardName => {
                  const card = window.ManaSearchApi?.getCardByName?.(cardName);
                  return card ? { name: card.name, typeLine: card.type_line || '', oracleText: card.oracle_text || '' } : { name: cardName, missingFromLocalCardApi: true };
                })
            : []
        };
      });
      return {
        labelLintRows: benchmark.labelLintRows || [],
        summary: {
          runId: benchmark.runId,
          durationMs: benchmark.durationMs,
          totalTests: benchmark.totalTests,
          completedTests: benchmark.completedTests,
          measuredTests: benchmark.measuredTests,
          blockedTests: benchmark.blockedTests,
          erroredTests: benchmark.erroredTests,
          benchmarkCompleted: benchmark.benchmarkCompleted,
          benchmarkFullyMeasured: benchmark.benchmarkFullyMeasured,
          meanRecall20: benchmark.meanRecall20,
          meanAdjustedRecall20: benchmark.meanAdjustedRecall20,
          meanRetrievalRecall: benchmark.meanRetrievalRecall,
          meanMRR: benchmark.meanMRR,
          meanNDCG20: benchmark.meanNDCG20,
          meanPrecision10: benchmark.meanPrecision10
        },
        cases,
        lowestRecallCases: cases.slice().sort((a, b) => (a.recall20 ?? 0) - (b.recall20 ?? 0)).slice(0, 5),
        focusCardEvidence: cases.filter(item => [3, 8, 9].includes(item.id)).map(item => ({
          id: item.id, name: item.name, source: item.source,
          expectedCardEvidence: item.expectedCardEvidence
        })),
        effectAwareCounterEvidenceCaptured: cases.find(item => item.id === 3)?.expectedCardEvidence?.some(item =>
          item.name === 'Deprive' && item.score?.functionSemanticEvidence?.effectAwareScore != null &&
          item.score?.functionSemanticEvidence?.matches?.some(match => match.sourceFunction === 'counter' && match.candidateFunction === 'counter')
        ) === true,
        inspector: {
          retainedRuns: history.length,
          latestRuns: history.slice(-2).map(run => ({
            number: run.number,
            status: run.status,
            sourceName: run.summary?.sourceName,
            resultCount: run.summary?.resultCount,
            durationMs: run.durationMs,
            streamCount: run.liveSearch?.streams?.length || 0,
            completedStreams: run.liveSearch?.completedStreams || 0,
            previewCount: run.liveSearch?.previewHistory?.length || 0
          })),
          comparison: comparison ? {
            outcomeComparison: comparison.outcomeComparison,
            changedInputs: comparison.changes,
            retrievalStreams: comparison.retrieval,
            finalRanking: comparison.finalRanking,
            sharedCandidateScoreChanges: comparison.sharedCandidateScoreChanges.length
          } : null,
          activeSearch: window.ManaSearchInspector.getActiveSearch()
        }
      };
    });
    console.log('Live end-to-end search benchmark:', JSON.stringify(liveSearchEvaluation));
    const summarize = (label, suite) => {
      if (suite?.checks) {
        const failed = suite.checks.filter(x => !x.pass);
        console.log(`${label}: ${suite.checks.length - failed.length}/${suite.checks.length} passed`);
        if (failed.length) console.log(failed.map(x => `${x.name}: ${x.detail || x.error || 'failed'}`).join('\n'));
        return failed.length === 0;
      }
      const failed = suite?.results?.filter(x => !x.pass) || [];
      console.log(`${label}: ${suite?.passed ?? (suite?.results?.length - failed.length)}/${suite?.total ?? suite?.results?.length} passed`);
      if (failed.length) console.log(failed.map(x => `${x.id}: ${x.error || JSON.stringify(x)}`).join('\n'));
      return failed.length === 0 && suite?.pass !== false && (suite?.passRate == null || suite.passRate === 1);
    };
    const liveSearchPass =
      liveSearchEvaluation.summary?.benchmarkCompleted === true &&
      liveSearchEvaluation.summary?.completedTests === liveSearchEvaluation.summary?.totalTests &&
      liveSearchEvaluation.summary?.erroredTests === 0 &&
      liveSearchEvaluation.summary?.blockedTests === 0 &&
      liveSearchEvaluation.inspector?.retainedRuns >= 2 &&
      liveSearchEvaluation.inspector?.latestRuns?.every(run => run.status !== 'error') &&
      liveSearchEvaluation.inspector?.comparison?.outcomeComparison?.rankingComparisonValid === true &&
      liveSearchEvaluation.effectAwareCounterEvidenceCaptured === true;
    console.log('Live search benchmark summary:', JSON.stringify(liveSearchEvaluation.summary));
    console.log('Lowest-recall live search cases:', JSON.stringify(liveSearchEvaluation.lowestRecallCases));
    const suitePasses = [
      liveSearchPass,
      summarize('Core mechanical checks', report.base),
      summarize('Mechanical family/ranking regressions', report.mechanical),
      summarize('Deterministic ranking/scoring regressions', report.rankingScoring),
      summarize('Repeatability regression suite', report.repeatability),
      summarize('Highlight-isolation suite', report.highlights),
      summarize('Live Search intent model/highlight suite', {
        pass: report.searchIntent?.pass,
        passed: report.searchIntent?.passed,
        total: report.searchIntent?.total,
        results: report.searchIntent?.checks || [],
        failures: report.searchIntent?.failures
      }),
      summarize('Real-card mechanical benchmark (console wrapper)', {
        pass: report.realCardBenchmark?.pass,
        passed: report.realCardBenchmark?.passed,
        total: report.realCardBenchmark?.total,
        results: [...(report.realCardBenchmark?.cardChecks || []), ...(report.realCardBenchmark?.pairChecks || [])],
        failures: report.realCardBenchmark?.failures,
        cardCount: report.realCardBenchmark?.cardCount,
        pairCount: report.realCardBenchmark?.pairCount
      }),
      summarize('Real-card mechanical benchmark (suite name, no arguments)', {
        pass: report.realCardBenchmarkSuiteNoArgs?.pass,
        passed: report.realCardBenchmarkSuiteNoArgs?.passed,
        total: report.realCardBenchmarkSuiteNoArgs?.total,
        results: [...(report.realCardBenchmarkSuiteNoArgs?.cardChecks || []), ...(report.realCardBenchmarkSuiteNoArgs?.pairChecks || [])],
        failures: report.realCardBenchmarkSuiteNoArgs?.failures,
        cardCount: report.realCardBenchmarkSuiteNoArgs?.cardCount,
        pairCount: report.realCardBenchmarkSuiteNoArgs?.pairCount
      })
    ];
    console.log('Developer inspector API:', JSON.stringify(report.developerDiagnostics));
    console.log('Developer inspector comparison regression:', JSON.stringify(report.developerInspectorRegression));
    suitePasses.push(Object.values(report.developerInspectorRegression || {}).every(value => value === true));
    suitePasses.push(report.developerDiagnostics?.available === true && report.developerDiagnostics?.serializable === true && report.developerDiagnostics?.hasPipelineFields === true);
    console.log('Mechanical scorer performance:', JSON.stringify(report.performance));
    suitePasses.push(report.performance?.pass === true);
    if (!report.performance?.pass) console.error('Performance suite failed: invalid scores, errors, or runtime threshold exceeded.');
    if (pageErrors.length) {
      console.error('Browser page errors:', pageErrors.join('\n'));
      suitePasses.push(false);
    }
    if (suitePasses.some(pass => !pass)) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
