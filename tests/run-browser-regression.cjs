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
      typeof window.runManaSearchRepeatabilityRegressionSuite === 'function' &&
      typeof window.runManaSearchHighlightIsolationSuite === 'function' &&
      typeof window.runManaSearchPerformanceSuite === 'function' &&
      typeof window.runManaSearchRealCardBenchmarkSuite === 'function' &&
      typeof window.runManaSearchRealCardBenchmark === 'function' &&
      typeof window.runManaSearchIntentRegressionSuite === 'function' &&
      typeof window.runLocalBenchmarkInApp === 'function' &&
      typeof window.ManaSearchDebug?.getSnapshot === 'function' &&
      typeof window.ManaSearchDebug?.getLiveIntent === 'function' &&
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
            request: { sourceCard: { name: 'Source A' }, highlights: [{ text: 'draw a card' }], intent: { sourceText: 'draw a card', semanticText: 'draw a card' }, constraints: {}, methods: { functional: true }, ordering: 'overall' },
            streams: { 'Search B': ['shared card', 'removed card'] },
            finalResults: [{ rank: 1, name: 'Shared Card' }, { rank: 2, name: 'Removed Card' }],
            candidates: [
              { name: 'Shared Card', preFloorRank: 1, scores: { similarityScore: 0.65, mechanicalScore: 0.7 }, mechanicalBreakdown: { graphScore: 0.7 } },
              { name: 'Removed Card', scores: { similarityScore: 0.42 } }
            ]
          }
        };
        const later = {
          number: 2,
          completedAt: '2026-11-19T08:01:00.000Z',
          pipeline: {
            request: { sourceCard: { name: 'Source A' }, highlights: [{ text: 'draw two cards' }], intent: { sourceText: 'draw two cards', semanticText: 'draw two cards' }, constraints: {}, methods: { functional: true }, ordering: 'overall' },
            streams: { 'Search B': ['shared card', 'added card'] },
            finalResults: [{ rank: 1, name: 'Added Card' }, { rank: 2, name: 'Shared Card' }],
            candidates: [
              { name: 'Shared Card', scores: { similarityScore: 0.75, mechanicalScore: 0.8 }, mechanicalBreakdown: { graphScore: 0.85 } },
              { name: 'Added Card', scores: { similarityScore: 0.81 } }
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
            rankingEvidence: { mechanical: 0.8, highlightIntent: 0.9 }, mechanicalBreakdown: { graphScore: 0.82, relationshipMismatch: 0.1 }, retrievalEvidence: ['Search B']
          }],
          finalResults: [{ name: 'Shared Card', rank: 1, similarityScore: 0.75, flags: { weakBackfill: false } }],
          rankingEvidenceTop: [{ name: 'Shared Card', rank: 1, overall: 0.75 }]
        };
        const candidateTrace = window.ManaSearchInspector.traceCandidate(tracePipeline, 'shared card');
        const filteredTrace = window.ManaSearchInspector.traceCandidate(tracePipeline, 'Filtered Card');
        const comparison = window.ManaSearchInspector.compareRuns(earlier, later);
        const sharedScore = comparison.sharedCandidateScoreChanges.find(item => item.name === 'Shared Card');
        const history = window.ManaSearchInspector.getRunHistory();
        const errorRun = {
          number: 6,
          status: 'error',
          errorMessage: 'Synthetic retrieval failure',
          durationMs: 3200,
          summary: { sourceName: 'Source A', resultCount: 0, status: 'error', errorMessage: 'Synthetic retrieval failure' },
          pipeline: { request: structuredClone(earlier.pipeline.request), finalResults: [] }
        };
        const errorRunComparison = window.ManaSearchInspector.compareRuns(earlier, errorRun);

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
              ordering: 'overall'
            },
            finalResults: []
          }
        }, {
          number: 10,
          pipeline: {
            request: {
              ordering: 'overall',
              methods: { role: false, functional: true },
              constraints: { cmc: 2, type: 'creature' },
              intent: { semanticText: 'draw a card', sourceText: 'draw a card' },
              highlights: [{ mode: 'exact', text: 'draw a card' }],
              sourceCard: { name: 'Source A', id: 'stable' }
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
            requestId: 9001, completedStreams: 1, totalStreams: 2,
            streams: [
              { label: 'Exact Phrase', done: true, detail: 'Done · 1 page · 4 cards' },
              { label: 'Semantic Index', done: false, detail: 'Searching vectors' }
            ]
          }
        }));
        window.dispatchEvent(new CustomEvent('manasearch:search-preview-updated', {
          detail: { requestId: 9001, phase: 'progressive-preview', sourceLabel: 'Exact Phrase', provisional: true, resultCount: 1, topNames: ['Shared Card'], at: 1100 }
        }));
        window.dispatchEvent(new CustomEvent('manasearch:progress-updated', {
          detail: { requestId: 9000, step: 2, total: 3, message: 'STALE EVENT MUST BE IGNORED', at: 1200 }
        }));
        const activeSearchBeforeFinish = window.ManaSearchInspector.getActiveSearch();
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
          summary: { sourceName: 'Source A', resultCount: 1, status: 'completed_with_warnings', errorMessage: 'Semantic stream timed out' },
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
              broad: true,
              queryPlans: { semantic: 'draw two cards' }
            },
            finalResults: structuredClone(earlier.pipeline.finalResults)
          }
        };
        const derivedIntentReport = window.ManaSearchInspector.compareRegressionCase(regressionCase, derivedIntentRun);
        const derivedPlanRunComparison = window.ManaSearchInspector.compareRuns(earlier, derivedIntentRun);
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
        return {
          compareApiAvailable: !!comparison && Array.isArray(comparison.finalRanking?.rankChanges),
          candidateTraceApiAvailable: typeof window.ManaSearchInspector.traceCandidate === 'function',
          traceMatchesCaseInsensitively: candidateTrace.found === true && candidateTrace.candidateName === 'shared card',
          traceShowsRetrievalProvenance: candidateTrace.retrieval.streams.includes('Search B'),
          traceShowsStageProgression: candidateTrace.stages.find(stage => stage.stage === 'scored')?.present === true,
          traceShowsScoreBreakdown: candidateTrace.scoring?.scores?.mechanicalScore === 0.8 && candidateTrace.scoring?.rankingEvidence?.highlightIntent === 0.9,
          traceShowsMechanicalBreakdown: candidateTrace.scoring?.mechanicalBreakdown?.graphScore === 0.82,
          traceShowsFinalRank: candidateTrace.finalRanking?.rank === 1,
          traceShowsFilterRejection: filteredTrace.possibleHardFilterRejection?.reasons?.includes('exact highlight mismatch') === true,
          detectsChangedHighlight: comparison.changes.highlightsChanged === true,
          detectsChangedInterpretation: comparison.changes.intentChanged === true,
          detectsAddedAndRemovedCards: comparison.finalRanking.addedInLater.includes('Added Card') && comparison.finalRanking.missingFromLater.includes('Removed Card'),
          detectsRankMovement: comparison.finalRanking.rankChanges.some(item => item.name === 'Shared Card' && item.earlierRank === 1 && item.laterRank === 2),
          detectsScoreDelta: !!sharedScore && Math.abs(sharedScore.delta - 0.10) < 1e-9,
          computesRetrievalOverlap: comparison.retrieval.some(item => item.stream === 'Search B' && item.sharedCount === 1 && Math.abs(item.jaccard - (1 / 3)) < 1e-4),
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
          compareMarksFailedRunInvalid: errorRunComparison.outcomeComparison?.rankingComparisonValid === false && errorRunComparison.outcomeComparison?.laterStatus === 'error',
          compareMarksPartialRunIncomplete: partialRunComparison.outcomeComparison?.rankingComparisonValid === true && partialRunComparison.outcomeComparison?.rankingComparisonComplete === false,
          regressionCompareTreatsPartialRunAsNoVerdict: partialRegressionComparison.status === 'partial-run' && partialRegressionComparison.pass === null && partialRegressionComparison.comparedRun?.warning === 'Semantic stream timed out',
          compareShowsScoreChannelAndMechanicalBreakdownChanges: comparison.sharedCandidateScoreChanges.some(item => item.name === 'Shared Card' && item.scoreChannelChanges?.some(change => change.field === 'mechanicalScore' && Math.abs(change.delta - 0.1) < 1e-9) && item.mechanicalBreakdownChanges?.some(change => change.field === 'graphScore' && Math.abs(change.delta - 0.15) < 1e-9)),
          regressionCompareDoesNotCountFailedRunAsRankingFailure: failedRegressionComparison.status === 'search-error' && failedRegressionComparison.pass === null,
          regressionBuilderRejectsFailedBaseline: refusesFailedBaseline,
          compareNormalizesCandidateNameWhitespaceAndCase: normalizedNameComparison.finalRanking.sharedCount === 1 && normalizedNameComparison.retrieval[0]?.sharedCount === 1,
          compareIgnoresRequestObjectKeyOrder: [
            'sourceCardChanged', 'highlightsChanged', 'intentChanged', 'constraintsChanged',
            'methodsChanged', 'orderingChanged', 'formatChanged', 'colorChanged',
            'broadChanged', 'divergentChanged', 'plannedStreamsChanged', 'queryPlansChanged'
          ].every(key => requestKeyOrderComparison.changes[key] === false) &&
            requestKeyOrderComparison.changes.changedInputFields.length === 0 &&
            requestKeyOrderComparison.changes.changedDerivedFields.length === 0,
          liveInspectorCapturesProgress: activeSearchBeforeFinish?.progress?.message === 'Searching for candidates',
          liveInspectorIgnoresStaleProgress: activeSearchBeforeFinish?.progress?.message !== 'STALE EVENT MUST BE IGNORED',
          liveInspectorCapturesStreamProgress: activeSearchBeforeFinish?.completedStreams === 1 && activeSearchBeforeFinish?.totalStreams === 2 && activeSearchBeforeFinish?.streams?.[0]?.done === true,
          liveInspectorCapturesProvisionalResults: activeSearchBeforeFinish?.preview?.phase === 'progressive-preview' && activeSearchBeforeFinish?.preview?.topNames?.includes('Shared Card'),
          liveInspectorStoresWarningOutcome: telemetryRun?.status === 'completed_with_warnings' && telemetryRun?.durationMs === 3200,
          liveInspectorStoresEventTraceWithRun: telemetryRun?.liveSearch?.previewHistory?.length === 1 && telemetryRun?.liveSearch?.streams?.length === 2,
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
        return { available: !!snapshot && typeof snapshot === 'object', serializable: JSON.stringify(snapshot).length > 0, hasPipelineFields: ['request', 'funnel', 'streams', 'candidates', 'filterRejections'].every(key => Object.prototype.hasOwnProperty.call(snapshot, key)), liveIntentAvailable: typeof window.ManaSearchDebug.getLiveIntent === 'function' };
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
          error: strict.errorMessage || ''
        };
      });
      return {
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
      liveSearchEvaluation.inspector?.comparison?.outcomeComparison?.rankingComparisonValid === true;
    console.log('Live search benchmark summary:', JSON.stringify(liveSearchEvaluation.summary));
    console.log('Lowest-recall live search cases:', JSON.stringify(liveSearchEvaluation.lowestRecallCases));
    const suitePasses = [
      liveSearchPass,
      summarize('Core mechanical checks', report.base),
      summarize('Mechanical family/ranking regressions', report.mechanical),
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
