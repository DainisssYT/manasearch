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
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/index.html?manasearch-test=1`, {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    await page.waitForFunction(() =>
      typeof window.runMechanicalRegressionSuite === 'function' &&
      typeof window.runManaSearchMechanicalRegressionSuite === 'function' &&
      typeof window.runManaSearchRepeatabilityRegressionSuite === 'function' &&
      typeof window.runManaSearchHighlightIsolationSuite === 'function' &&
      typeof window.runManaSearchPerformanceSuite === 'function' &&
      typeof window.runManaSearchRealCardBenchmarkSuite === 'function' &&
      typeof window.runManaSearchRealCardBenchmark === 'function' &&
      typeof window.runManaSearchIntentRegressionSuite === 'function',
      null, { timeout: 60000 }
    );
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
      realCardBenchmarkSuiteNoArgs: await window.runManaSearchRealCardBenchmarkSuite({ log: false })
    }));
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
    const suitePasses = [
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
