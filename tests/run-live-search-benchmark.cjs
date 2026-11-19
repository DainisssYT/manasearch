#!/usr/bin/env node
'use strict';

// Run ManaSearch's real 12-scenario local retrieval/ranking benchmark in Chromium.
// The benchmark uses cards.bin + semantic-index.bin and disables runtime card API requests.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputPath = path.resolve(process.env.MANASEARCH_BENCHMARK_OUTPUT || path.join(root, 'search-quality-benchmark.json'));
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm'
};

function safeFile(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, 'http://127.0.0.1').pathname);
  const resolved = path.resolve(root, '.' + pathname);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

function compactReport(report, runtime) {
  const tests = (report.structuredResults || []).map(item => {
    const strict = item.strict || {};
    const diagnostics = strict.diagnostics || {};
    const semantic = item.semantic || null;
    const streamCoverage = Object.fromEntries(Object.entries(diagnostics.streamCoverage || {}).map(([name, coverage]) => [
      name,
      coverage ? {
        retrievedCount: coverage.retrievedCount ?? null,
        totalCards: coverage.totalCards ?? null,
        pagesFetched: coverage.pagesFetched ?? null,
        maxPages: coverage.maxPages ?? null,
        fullyCovered: coverage.fullyCovered ?? null,
        bailedAfterRetries: coverage.bailedAfterRetries ?? null,
        local: coverage.local ?? null
      } : null
    ]));
    return {
      id: item.id,
      name: item.name,
      source: item.source,
      highlights: item.highlightDefinitions || item.highlights || [],
      categories: item.categories || [],
      preferredConstraints: item.preferredConstraints || [],
      expected: item.expected || [],
      status: strict.testStatus || 'unknown',
      errorMessage: strict.errorMessage || '',
      durationMs: item.durationMs ?? null,
      metrics: {
        recall5: strict.recall5 ?? null, recall10: strict.recall10 ?? null,
        recall20: strict.recall20 ?? null, recall50: strict.recall50 ?? null,
        recall100: strict.recall100 ?? null, adjustedRecall20: strict.adjustedRecall20 ?? null,
        retrievalRecall: strict.stageRecalls?.retrieval ?? null,
        filterRecall: strict.stageRecalls?.filter ?? null,
        dedupRecall: strict.stageRecalls?.dedup ?? null,
        scoringRecall: strict.stageRecalls?.scoring ?? null,
        pruningRecall: strict.stageRecalls?.pruning ?? null,
        mrr: strict.mrr ?? null, ndcg10: strict.ndcg10 ?? null,
        ndcg20: strict.ndcg20 ?? null, precision10: strict.precision10 ?? null,
        precision20: strict.precision20 ?? null, averageExpectedRank: strict.avgTestRank ?? null,
        cardRanks: strict.cardRanks || {},
        predicatePrecision10: strict.predicatePrecision10 ?? null,
        predicateNdcg10: strict.predicateNdcg10 ?? null,
        semanticAbilityCoverageAt20: strict.semanticAbilityCoverageAt20 ?? null,
        semanticRetrievalProvenanceAt20: strict.semanticRetrievalProvenanceAt20 || []
      },
      semantic: semantic ? {
        status: semantic.testStatus || 'unknown',
        recall20: semantic.recall20 ?? null, mrr: semantic.mrr ?? null,
        ndcg20: semantic.ndcg20 ?? null, cardRanks: semantic.cardRanks || {}
      } : null,
      streamCoverage,
      searchSignals: diagnostics.benchmarkSignals || null
    };
  });
  return {
    schema: 'manasearch-live-search-benchmark-v1',
    generatedAt: new Date().toISOString(),
    appBuild: runtime.appBuild || null,
    runtime,
    run: {
      runId: report.runId || null, startedAt: report.startedAt || null,
      finishedAt: report.finishedAt || null, durationMs: report.durationMs ?? null,
      totalTests: report.totalTests ?? tests.length, completedTests: report.completedTests ?? tests.length,
      measuredTests: report.measuredTests ?? null, blockedTests: report.blockedTests ?? null,
      erroredTests: report.erroredTests ?? null,
      benchmarkCompleted: report.benchmarkCompleted === true,
      benchmarkFullyMeasured: report.benchmarkFullyMeasured === true,
      runtimeCardApiUsed: report.runtimeCardApiUsed === true,
      cardDataSource: report.cardDataSource || null,
      meanRecall5: report.meanRecall5 ?? null, meanRecall10: report.meanRecall10 ?? null,
      meanRecall20: report.meanRecall20 ?? null, meanRecall50: report.meanRecall50 ?? null,
      meanRecall100: report.meanRecall100 ?? null,
      meanAdjustedRecall20: report.meanAdjustedRecall20 ?? null,
      meanRetrievalRecall: report.meanRetrievalRecall ?? null,
      meanMRR: report.meanMRR ?? null, meanNDCG10: report.meanNDCG10 ?? null,
      meanNDCG20: report.meanNDCG20 ?? null, meanPrecision10: report.meanPrecision10 ?? null,
      meanPrecision20: report.meanPrecision20 ?? null,
      benchmarkConfiguration: report.benchmarkConfiguration || null
    },
    tests
  };
}
async function main() {
  const server = http.createServer((req, res) => {
    const file = safeFile(req.url || '/');
    if (!file) { res.writeHead(403); return res.end('Forbidden'); }
    let selected = file;
    if (fs.existsSync(selected) && fs.statSync(selected).isDirectory()) selected = path.join(selected, 'index.html');
    if (!fs.existsSync(selected) || !fs.statSync(selected).isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': mime[path.extname(selected)] || 'application/octet-stream' });
    fs.createReadStream(selected).pipe(res);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  let browser;
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];

  try {
    const launchOptions = { headless: true, args: ['--no-sandbox'] };
    if (process.env.MANASEARCH_CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.MANASEARCH_CHROMIUM_EXECUTABLE;
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(0);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', request => {
      failedRequests.push({
        url: request.url(),
        error: request.failure()?.errorText || 'request failed'
      });
    });
    page.on('dialog', dialog => dialog.dismiss());

    await page.goto('http://127.0.0.1:' + address.port + '/index.html?manasearch-live-benchmark=1', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForFunction(() => typeof window.runLocalBenchmarkInApp === 'function', null, { timeout: 60000 });

    const payload = await page.evaluate(async () => {
      const report = await window.runLocalBenchmarkInApp();
      const diagnostics = window.ManaSearchDebug?.getSnapshot?.() || {};
      return {
        report: {
          runId: report?.runId,
          startedAt: report?.startedAt,
          finishedAt: report?.finishedAt,
          durationMs: report?.durationMs,
          totalTests: report?.totalTests,
          completedTests: report?.completedTests,
          measuredTests: report?.measuredTests,
          blockedTests: report?.blockedTests,
          erroredTests: report?.erroredTests,
          benchmarkCompleted: report?.benchmarkCompleted,
          benchmarkFullyMeasured: report?.benchmarkFullyMeasured,
          runtimeCardApiUsed: report?.runtimeCardApiUsed,
          cardDataSource: report?.cardDataSource,
          meanRecall5: report?.meanRecall5,
          meanRecall10: report?.meanRecall10,
          meanRecall20: report?.meanRecall20,
          meanRecall50: report?.meanRecall50,
          meanRecall100: report?.meanRecall100,
          meanAdjustedRecall20: report?.meanAdjustedRecall20,
          meanRetrievalRecall: report?.meanRetrievalRecall,
          meanMRR: report?.meanMRR,
          meanNDCG10: report?.meanNDCG10,
          meanNDCG20: report?.meanNDCG20,
          meanPrecision10: report?.meanPrecision10,
          meanPrecision20: report?.meanPrecision20,
          benchmarkConfiguration: report?.benchmarkConfiguration,
          structuredResults: (report?.structuredResults || []).map(item => {
            const strict = item.strict || {};
            const diagnostics = strict.diagnostics || {};
            const semantic = item.semantic || null;
            const streamCoverage = Object.fromEntries(Object.entries(diagnostics.streamCoverage || {}).map(([name, coverage]) => [
              name,
              coverage ? {
                retrievedCount: coverage.retrievedCount ?? null,
                totalCards: coverage.totalCards ?? null,
                pagesFetched: coverage.pagesFetched ?? null,
                maxPages: coverage.maxPages ?? null,
                fullyCovered: coverage.fullyCovered ?? null,
                bailedAfterRetries: coverage.bailedAfterRetries ?? null,
                local: coverage.local ?? null
              } : null
            ]));
            return {
              id: item.id, name: item.name, source: item.source,
              highlightDefinitions: item.highlightDefinitions || [],
              highlights: item.highlights || [],
              categories: item.categories || [],
              preferredConstraints: item.preferredConstraints || [],
              expected: item.expected || [],
              durationMs: item.durationMs ?? null,
              strict: {
                testStatus: strict.testStatus || 'unknown',
                errorMessage: strict.errorMessage || '',
                recall5: strict.recall5 ?? null, recall10: strict.recall10 ?? null,
                recall20: strict.recall20 ?? null, recall50: strict.recall50 ?? null,
                recall100: strict.recall100 ?? null, adjustedRecall20: strict.adjustedRecall20 ?? null,
                stageRecalls: strict.stageRecalls || {},
                mrr: strict.mrr ?? null, ndcg10: strict.ndcg10 ?? null,
                ndcg20: strict.ndcg20 ?? null, precision10: strict.precision10 ?? null,
                precision20: strict.precision20 ?? null, avgTestRank: strict.avgTestRank ?? null,
                cardRanks: strict.cardRanks || {},
                predicatePrecision10: strict.predicatePrecision10 ?? null,
                predicateNdcg10: strict.predicateNdcg10 ?? null,
                semanticAbilityCoverageAt20: strict.semanticAbilityCoverageAt20 ?? null,
                semanticRetrievalProvenanceAt20: strict.semanticRetrievalProvenanceAt20 || [],
                diagnostics: {
                  streamCoverage,
                  benchmarkSignals: diagnostics.benchmarkSignals || null
                }
              },
              semantic: semantic ? {
                testStatus: semantic.testStatus || 'unknown',
                recall20: semantic.recall20 ?? null, mrr: semantic.mrr ?? null,
                ndcg20: semantic.ndcg20 ?? null, cardRanks: semantic.cardRanks || {}
              } : null
            };
          })
        },
        runtime: {
          appBuild: diagnostics.appBuild || null,
          finalSearchOutcome: diagnostics.outcome || null,
          sourceCard: diagnostics.request?.sourceCard?.name || null
        }
      };
    });

    const compact = compactReport(payload.report, {
      ...payload.runtime,
      pageErrors: pageErrors.slice(),
      consoleErrors: consoleErrors.slice(0, 50),
      failedRequests: failedRequests.slice(0, 50)
    });
    fs.writeFileSync(outputPath, JSON.stringify(compact, null, 2) + '\n', 'utf8');

    console.log('ManaSearch live search benchmark');
    console.log('Build: ' + (compact.appBuild || 'unknown'));
    console.log('Run: ' + (compact.run.runId || 'unknown') + ' | ' + compact.run.durationMs + ' ms');
    console.log('Measured: ' + compact.run.measuredTests + '/' + compact.run.totalTests +
      ' | blocked: ' + compact.run.blockedTests + ' | errored: ' + compact.run.erroredTests);
    console.log('Recall@20: ' + compact.run.meanRecall20 +
      ' | Retrieval recall: ' + compact.run.meanRetrievalRecall +
      ' | MRR: ' + compact.run.meanMRR +
      ' | NDCG@20: ' + compact.run.meanNDCG20);
    console.table(compact.tests.map(test => ({
      id: test.id,
      scenario: test.name,
      status: test.status,
      recall20: test.metrics.recall20,
      retrieval: test.metrics.retrievalRecall,
      ndcg20: test.metrics.ndcg20,
      mrr: test.metrics.mrr,
      durationMs: test.durationMs
    })));
    console.log('Benchmark JSON: ' + outputPath);

    const valid = compact.run.benchmarkCompleted &&
      compact.run.measuredTests === compact.run.totalTests &&
      compact.run.blockedTests === 0 &&
      compact.run.erroredTests === 0 &&
      compact.run.runtimeCardApiUsed === false;
    if (!valid) {
      console.error('Live search benchmark was incomplete, blocked, errored, or used runtime card API data.');
      process.exitCode = 1;
    }
    if (pageErrors.length) {
      console.error('Browser page errors:', pageErrors);
      process.exitCode = 1;
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
