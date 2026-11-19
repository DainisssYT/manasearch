/* ManaSearch developer diagnostics. Passive observer: never changes search inputs, ranking, or results. */
(() => {
  'use strict';
  if (window.__manaSearchInspectorInstalled) return;
  window.__manaSearchInspectorInstalled = true;

  const state = {
    startedAt: new Date().toISOString(),
    events: [],
    workerMessages: [],
    searchRuns: [],
    activeSearch: null,
    lastSnapshot: null,
    searchCount: 0
  };
  const MAX_EVENTS = 120;
  const MAX_WORKER_MESSAGES = 80;
  // Keep enough recent searches for useful comparisons without retaining an unbounded card-text archive.
  const MAX_SEARCH_RUNS = 6;
  const clip = (value, max = 1200) => String(value ?? '').trim().slice(0, max);
  const cloneJson = value => {
    try { return JSON.parse(JSON.stringify(value ?? null)); }
    catch (error) { return { serializationError: error?.message || String(error) }; }
  };
  const addEvent = (type, detail = {}) => {
    state.events.unshift({ time: new Date().toISOString(), type, ...detail });
    state.events.length = Math.min(state.events.length, MAX_EVENTS);
    renderTimeline();
  };
  const visibleText = selector => {
    const el = document.querySelector(selector);
    return el && !el.hidden ? clip(el.innerText || el.textContent, 5000) : '';
  };
  const valueOf = selector => {
    const el = document.querySelector(selector);
    return el ? (el.value ?? el.textContent ?? '') : null;
  };
  const readConstraints = () => [...document.querySelectorAll('[data-constraint-mode]')].map(el => ({
    key: el.dataset.constraintMode,
    mode: el.value,
    value: el.type === 'checkbox' ? el.checked : (el.value ?? '')
  })).filter(item => item.value !== '' && item.value !== 'none');
  const readSource = () => ({
    name: visibleText('#source-card-name'),
    type: visibleText('#source-card-type'),
    supertype: visibleText('#source-card-supertype'),
    subtype: visibleText('#source-card-subtype'),
    manaCost: visibleText('#source-card-mana'),
    manaValue: visibleText('#source-card-mana-value'),
    oracleText: visibleText('#source-card-loaded .source-card-oracle-text, #source-card-loaded [id*="oracle"]'),
    selectedText: clip(window.getSelection?.()?.toString(), 1000)
  });
  const readResults = () => {
    const grid = document.querySelector('#results-grid');
    if (!grid) return [];
    return [...grid.children].slice(0, 100).map((el, index) => ({
      rank: index + 1,
      name: clip(el.querySelector('h3,h4,.card-name,[data-card-name]')?.textContent || el.getAttribute('data-card-name') || el.innerText, 180),
      text: clip(el.innerText, 1800),
      image: el.querySelector('img')?.currentSrc || el.querySelector('img')?.src || null,
      classes: clip(el.className, 180)
    }));
  };
  const snapshot = () => ({
    capturedAt: new Date().toISOString(),
    source: readSource(),
    highlightedText: visibleText('#selected-highlight, #highlighted-text, .highlight-selection-summary'),
    searchIntent: {
      status: visibleText('#search-intent-status-text'),
      explanation: visibleText('#search-intent-body'),
      productionModel: window.ManaSearchDebug?.getLiveIntent?.() || null
    },
    searchConfiguration: {
      methods: visibleText('#selected-methods-badge'),
      order: valueOf('#sort-results'),
      constraints: readConstraints(),
      format: valueOf('#format-filter'),
      color: valueOf('#color-filter')
    },
    runtime: {
      searchStatus: visibleText('#static-search-status-text'),
      loading: !!document.querySelector('#loading-indicator:not(.hidden)'),
      resultsVisible: !!document.querySelector('#results-section:not(.hidden)'),
      resultCount: document.querySelectorAll('#results-grid > *').length,
      searchCount: state.searchCount
    },
    liveSearch: cloneJson(state.activeSearch),
    results: readResults(),
    recentWorkerMessages: state.workerMessages.slice(0, 30)
  });
  const panel = document.createElement('aside');
  panel.id = 'mana-search-inspector';
  panel.className = 'ms-inspector';
  panel.innerHTML = `<button type="button" class="ms-inspector-launch" aria-expanded="false">Developer inspector</button><section class="ms-inspector-window" hidden aria-label="ManaSearch developer inspector"><header><div><strong>Search inspector</strong><small>Passive view of the live production search</small></div><button type="button" class="ms-inspector-close" aria-label="Close inspector">×</button></header><nav><button type="button" data-tab="live" class="is-active">Live state</button><button type="button" data-tab="pipeline">Pipeline</button><button type="button" data-tab="candidates">Candidates</button><button type="button" data-tab="trace">Trace card</button><button type="button" data-tab="exclusions">Exclusions</button><button type="button" data-tab="compare">Compare runs</button><button type="button" data-tab="regression">Regression cases</button><button type="button" data-tab="timeline">Timeline</button><button type="button" data-tab="worker">Worker</button></nav><div class="ms-inspector-toolbar"><span class="ms-inspector-state">Waiting for search activity</span><button type="button" data-action="refresh">Refresh</button><button type="button" data-action="copy">Copy JSON</button><button type="button" data-action="download">Download JSON</button></div><div class="ms-inspector-compare-controls" hidden><label>Earlier run <select data-run-side="a"></select></label><label>Later run <select data-run-side="b"></select></label></div><div class="ms-inspector-trace-controls" hidden><label>Candidate <select data-trace-candidate></select></label></div>
  <div class="ms-inspector-regression-controls" hidden>
    <div class="ms-inspector-regression-row">
      <label>Build from run <select data-regression-source-run></select></label>
      <button type="button" data-regression-build>Build case</button>
      <label>Compare against <select data-regression-compare-run></select></label>
    </div>
    <label>Case title <input type="text" data-regression-title maxlength="140" placeholder="What should this search do?"></label>
    <label>Problem and expected behavior <textarea data-regression-notes rows="2" placeholder="Explain what is wrong, what should happen, and why this example matters."></textarea></label>
    <div class="ms-inspector-regression-row">
      <label>Focus card <input type="text" data-regression-focus list="ms-regression-candidates" placeholder="Optional candidate name"><datalist id="ms-regression-candidates"></datalist></label>
      <label>Focus expectation <select data-regression-behavior><option value="none">No focus assertion</option><option value="must-appear">Must appear</option><option value="must-not-appear">Must not appear</option><option value="rank-at-most">Must rank within top N</option></select></label>
      <label>Max rank <input type="number" data-regression-max-rank min="1" max="100" value="3"></label>
    </div>
    <label>Expected top ranking <small>(one card per line, best match first; edit this list to define the correct ranking)</small><textarea data-regression-top rows="5" placeholder="Card name — one per line"></textarea></label>
    <div class="ms-inspector-regression-actions">
      <button type="button" data-regression-export>Download case</button>
      <button type="button" data-regression-copy>Copy case JSON</button>
      <button type="button" data-regression-compare>Compare with run</button>
      <button type="button" data-regression-import>Import case</button>
      <input type="file" data-regression-file accept="application/json,.json" hidden>
    </div>
    <small class="ms-inspector-regression-help">Cases are portable JSON files. They include the original request and diagnostic pipeline. Import a case after updating ManaSearch, repeat its search normally, then compare the new run here. No cases are uploaded or saved automatically.</small>
  </div><pre class="ms-inspector-content" aria-live="polite"></pre></section>`;
  document.body.append(panel);
  const launch = panel.querySelector('.ms-inspector-launch');
  const windowEl = panel.querySelector('.ms-inspector-window');
  const content = panel.querySelector('.ms-inspector-content');
  const status = panel.querySelector('.ms-inspector-state');
  const compareControls = panel.querySelector('.ms-inspector-compare-controls');
  const runSelectA = panel.querySelector('[data-run-side="a"]');
  const runSelectB = panel.querySelector('[data-run-side="b"]');
  const traceControls = panel.querySelector('.ms-inspector-trace-controls');
  const traceSelect = panel.querySelector('[data-trace-candidate]');
  const regressionControls = panel.querySelector('.ms-inspector-regression-controls');
  const regressionSourceRun = panel.querySelector('[data-regression-source-run]');
  const regressionCompareRun = panel.querySelector('[data-regression-compare-run]');
  const regressionTitle = panel.querySelector('[data-regression-title]');
  const regressionNotes = panel.querySelector('[data-regression-notes]');
  const regressionFocus = panel.querySelector('[data-regression-focus]');
  const regressionBehavior = panel.querySelector('[data-regression-behavior]');
  const regressionMaxRank = panel.querySelector('[data-regression-max-rank]');
  const regressionTop = panel.querySelector('[data-regression-top]');
  const regressionFile = panel.querySelector('[data-regression-file]');
  let activeRegressionCase = null;
  let activeTab = 'live';
  let lastPipelineSnapshot = null;
  const activeRequestMatches = detail => Boolean(
    state.activeSearch && detail?.requestId !== undefined && detail?.requestId !== null &&
    Number(detail.requestId) === Number(state.activeSearch.requestId)
  );
  const renderLiveProgress = () => {
    if (!windowEl.hidden && activeTab === 'live') render();
  };
  const getPipelineSnapshot = () => {
    try { if (window.ManaSearchDebug?.getSnapshot) lastPipelineSnapshot = window.ManaSearchDebug.getSnapshot(); }
    catch (error) { addEvent('diagnostics:error', { message: error?.message || String(error) }); }
    return lastPipelineSnapshot;
  };
  const buildExport = () => ({
    schema: 'manasearch-diagnostics-export-v2',
    exportedAt: new Date().toISOString(),
    ui: snapshot(),
    productionPipeline: getPipelineSnapshot(),
    searchRuns: state.searchRuns,
    timeline: state.events,
    workerMessages: state.workerMessages
  });
  const stageLosses = pipeline => {
    const stages = pipeline?.funnel?.stages;
    if (!stages) return [];
    const order = ['retrieved','passedFilters','deduplicated','meaningfulParse','scored','passedRelevanceFloor','finalRanked'];
    const labels = {
      retrieved: 'Raw retrieval',
      passedFilters: 'Hard constraints / exact highlights',
      deduplicated: 'Name deduplication',
      meaningfulParse: 'Meaningful parse confidence',
      scored: 'Scoring',
      passedRelevanceFloor: 'Relevance floor',
      finalRanked: 'Final ranking'
    };
    return order.slice(1).map((stage, index) => {
      const previous = new Set(stages[order[index]] || []);
      const current = new Set(stages[stage] || []);
      const removed = [...previous].filter(name => !current.has(name));
      return { from: labels[order[index]], to: labels[stage], removedCount: removed.length, removedExamples: removed.slice(0, 40) };
    });
  };
  const htmlEscape = value => String(value ?? '').replace(/[&<>\"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[char]);
  const runLabel = run => {
    const source = run?.pipeline?.request?.sourceCard?.name || run?.summary?.sourceName || 'Unknown source';
    const resultCount = run?.summary?.resultCount ?? run?.pipeline?.finalResults?.length ?? 0;
    const provisionalCount = run?.summary?.provisionalResultCount ?? run?.liveSearch?.provisionalResultCount ?? 0;
    const outcome = run?.status || run?.summary?.status || run?.pipeline?.outcome?.status || 'completed';
    const buildLabel = run?.pipeline?.appBuild || run?.appBuild ? ' · build ' + (run.pipeline?.appBuild || run.appBuild) : '';
    const outcomeLabel = outcome === 'error' ? 'ERROR'
      : outcome === 'completed_with_warnings' ? 'PARTIAL'
        : outcome === 'running' ? 'RUNNING' : 'OK';
    const resultLabel = resultCount + ' final result(s)' + (provisionalCount > 0 ? ' + ' + provisionalCount + ' provisional' : '');
    return '#' + (run?.number ?? '?') + ' [' + outcomeLabel + '] ' + source + buildLabel + ' — ' + resultLabel + ' — ' + new Date(run?.completedAt || 0).toLocaleTimeString();
  };
  const compareRuns = (earlier, later) => {
    if (!earlier || !later) return { message: 'Select two retained searches to compare. At least two searches are required.' };
    const a = earlier.pipeline || {};
    const b = later.pipeline || {};
    const aStatus = earlier.status || earlier.summary?.status || a.outcome?.status || 'completed';
    const bStatus = later.status || later.summary?.status || b.outcome?.status || 'completed';
    const earlierBuild = a.appBuild || earlier.appBuild || null;
    const laterBuild = b.appBuild || later.appBuild || null;
    const buildChanged = Boolean(earlierBuild && laterBuild && earlierBuild !== laterBuild);
    const aFinal = a.finalResults || [];
    const bFinal = b.finalResults || [];
    const keyOf = item => normalizeCandidateName(item?.name);
    const aRanks = new Map(aFinal.map(item => [keyOf(item), item.rank]).filter(([key]) => key));
    const bRanks = new Map(bFinal.map(item => [keyOf(item), item.rank]).filter(([key]) => key));
    const aNames = new Map(aFinal.map(item => [keyOf(item), item.name || '']).filter(([key]) => key));
    const bNames = new Map(bFinal.map(item => [keyOf(item), item.name || '']).filter(([key]) => key));
    const common = [...aRanks.keys()].filter(name => bRanks.has(name));
    const added = [...bRanks.keys()].filter(name => !aRanks.has(name)).map(name => bNames.get(name) || name);
    const removed = [...aRanks.keys()].filter(name => !bRanks.has(name)).map(name => aNames.get(name) || name);
    const moved = common.map(name => ({
      name: bNames.get(name) || aNames.get(name) || name,
      earlierRank: aRanks.get(name),
      laterRank: bRanks.get(name),
      movement: aRanks.get(name) - bRanks.get(name)
    })).filter(item => item.movement !== 0).sort((x, y) => Math.abs(y.movement) - Math.abs(x.movement)).slice(0, 40);
    const aCandidates = new Map((a.candidates || []).map(item => [normalizeCandidateName(item.name), item]).filter(([key]) => key));
    const bCandidates = new Map((b.candidates || []).map(item => [normalizeCandidateName(item.name), item]).filter(([key]) => key));
    const scoreChanges = [...aCandidates.keys()].filter(name => bCandidates.has(name)).map(name => {
      const left = aCandidates.get(name);
      const right = bCandidates.get(name);
      const before = Number(left?.scores?.similarityScore);
      const after = Number(right?.scores?.similarityScore);
      const scoreChannelChanges = compareNumericFields(left?.scores, right?.scores);
      const mechanicalBreakdownChanges = compareNumericFields(left?.mechanicalBreakdown, right?.mechanicalBreakdown);
      return {
        name: right?.name || left?.name || name,
        earlierScore: Number.isFinite(before) ? before : null,
        laterScore: Number.isFinite(after) ? after : null,
        delta: Number.isFinite(before) && Number.isFinite(after) ? after - before : null,
        scoreChannelChanges,
        mechanicalBreakdownChanges
      };
    }).filter(item =>
      (item.delta !== null && Math.abs(item.delta) > 0.000001) ||
      item.scoreChannelChanges.length > 0 || item.mechanicalBreakdownChanges.length > 0
    ).sort((x, y) => Math.abs(y.delta || 0) - Math.abs(x.delta || 0)).slice(0, 40);
    const streamNames = new Set([...Object.keys(a.streams || {}), ...Object.keys(b.streams || {})]);
    const streamComparison = [...streamNames].map(name => {
      const left = new Set((a.streams?.[name] || []).map(value => normalizeCandidateName(value)).filter(Boolean));
      const right = new Set((b.streams?.[name] || []).map(value => normalizeCandidateName(value)).filter(Boolean));
      const intersection = [...left].filter(value => right.has(value)).length;
      const union = new Set([...left, ...right]).size;
      return { stream: name, earlierCount: left.size, laterCount: right.size, sharedCount: intersection, jaccard: union ? Number((intersection / union).toFixed(4)) : 1 };
    });
    const stageOrder = [
      ['retrieved', 'Raw retrieval'],
      ['passedFilters', 'Passed hard filters'],
      ['deduplicated', 'Survived deduplication'],
      ['meaningfulParse', 'Passed meaningful-parse threshold'],
      ['scored', 'Reached scoring'],
      ['passedRelevanceFloor', 'Passed relevance floor'],
      ['finalRanked', 'Final ranked results']
    ];
    const toNameMap = values => {
      const map = new Map();
      (Array.isArray(values) ? values : []).forEach(value => {
        const raw = typeof value === 'string' ? value : value?.name;
        const key = normalizeCandidateName(raw);
        if (key && !map.has(key)) map.set(key, String(raw));
      });
      return map;
    };
    const stageProgression = stageOrder.map(([field, label]) => {
      const left = toNameMap(a.funnel?.stages?.[field]);
      const right = toNameMap(b.funnel?.stages?.[field]);
      const shared = [...left.keys()].filter(key => right.has(key));
      const added = [...right.keys()].filter(key => !left.has(key));
      const removed = [...left.keys()].filter(key => !right.has(key));
      const union = new Set([...left.keys(), ...right.keys()]).size;
      return {
        stage: field, label,
        earlierCount: left.size, laterCount: right.size,
        sharedCount: shared.length,
        addedInLater: added.slice(0, 40).map(key => right.get(key)),
        missingFromLater: removed.slice(0, 40).map(key => left.get(key)),
        jaccard: union ? Number((shared.length / union).toFixed(4)) : 1
      };
    });
    const earlierScored = toNameMap((a.candidates || []).map(item => item.name));
    const laterScored = toNameMap((b.candidates || []).map(item => item.name));
    const newlyScoredInSample = [...laterScored.keys()].filter(key => !earlierScored.has(key)).map(key => laterScored.get(key));
    const noLongerScoredInSample = [...earlierScored.keys()].filter(key => !laterScored.has(key)).map(key => earlierScored.get(key));
    const topKOverlap = [10, 20, 50].map(k => {
      const left = new Set(aFinal.slice(0, k).map(item => normalizeCandidateName(item.name)).filter(Boolean));
      const right = new Set(bFinal.slice(0, k).map(item => normalizeCandidateName(item.name)).filter(Boolean));
      const shared = [...left].filter(name => right.has(name)).length;
      const shorterCapturedList = Math.min(k, left.size, right.size);
      return {
        k,
        earlierCaptured: left.size,
        laterCaptured: right.size,
        sharedCount: shared,
        overlap: Number((shared / k).toFixed(4)),
        capturedListOverlap: shorterCapturedList ? Number((shared / shorterCapturedList).toFixed(4)) : null,
        capturedListDenominator: shorterCapturedList
      };
    });
    const rankMovementValues = common.map(name => Math.abs((aRanks.get(name) || 0) - (bRanks.get(name) || 0)));
    const meanAbsoluteRankMovement = rankMovementValues.length
      ? Number((rankMovementValues.reduce((sum, value) => sum + value, 0) / rankMovementValues.length).toFixed(3))
      : null;
    // Explain changed final cards using the same candidate trace used by the Trace card tab.
    // A trace outside the bounded capture is deliberately labelled unknown, never asserted as a miss.
    const changedFinalKeys = new Set([
      ...added.map(name => normalizeCandidateName(name)),
      ...removed.map(name => normalizeCandidateName(name)),
      ...moved.map(item => normalizeCandidateName(item.name))
    ].filter(Boolean));
    const candidatePathChanges = [...changedFinalKeys].map(key => {
      const displayName = bNames.get(key) || aNames.get(key) || key;
      const earlierTrace = traceCandidate(a, displayName);
      const laterTrace = traceCandidate(b, displayName);
      const stageDifferences = stageOrder.map(([field, label]) => {
        const earlierPresent = earlierTrace.stages.find(stage => stage.stage === field)?.present === true;
        const laterPresent = laterTrace.stages.find(stage => stage.stage === field)?.present === true;
        return { stage: field, label, earlierPresent, laterPresent };
      }).filter(item => item.earlierPresent !== item.laterPresent);
      const firstDivergence = stageDifferences[0] || null;
      let explanation;
      if (!earlierTrace.found && laterTrace.found) {
        explanation = 'Not present in the earlier retained trace, but present in the later trace. It may be newly retrieved or may have fallen outside the earlier diagnostic sample.';
      } else if (earlierTrace.found && !laterTrace.found) {
        explanation = 'Not present in the later retained trace. It may have left retrieval or fallen outside the later diagnostic sample; this alone is not proof of a retrieval miss.';
      } else if (!earlierTrace.found && !laterTrace.found) {
        explanation = 'Neither retained trace contains this card. The bounded snapshots cannot establish where it was lost.';
      } else if (firstDivergence?.earlierPresent && !firstDivergence.laterPresent) {
        explanation = 'First recorded stage difference: the card appears in the earlier run but not in the later run at ' + firstDivergence.label + '. Check the later run’s rejection evidence and retrieval streams.';
      } else if (firstDivergence?.laterPresent && !firstDivergence.earlierPresent) {
        explanation = 'The later run records this card at ' + firstDivergence.label + ', while the earlier run does not. This is the first observed pipeline difference.';
      } else if (aRanks.has(key) && bRanks.has(key) && aRanks.get(key) !== bRanks.get(key)) {
        explanation = 'The card reached the same retained pipeline stages in both runs. Inspect score-channel changes and ordering preferences for the rank movement.';
      } else {
        explanation = 'The final membership differs, but the retained stage evidence does not isolate a single cause.';
      }
      return {
        name: displayName,
        earlierFinalRank: aRanks.get(key) ?? null,
        laterFinalRank: bRanks.get(key) ?? null,
        movement: aRanks.has(key) && bRanks.has(key) ? aRanks.get(key) - bRanks.get(key) : null,
        earlierObserved: earlierTrace.found,
        laterObserved: laterTrace.found,
        earlierRetrievalStreams: earlierTrace.retrieval.streams,
        laterRetrievalStreams: laterTrace.retrieval.streams,
        stageDifferences,
        firstDivergence,
        earlierFirstObservedLoss: earlierTrace.firstObservedLoss,
        laterFirstObservedLoss: laterTrace.firstObservedLoss,
        earlierHardFilterRejection: earlierTrace.possibleHardFilterRejection,
        laterHardFilterRejection: laterTrace.possibleHardFilterRejection,
        explanation
      };
    }).sort((left, right) => {
      const priority = item => item.earlierFinalRank === null || item.laterFinalRank === null ? 1000
        : Math.abs(item.movement || 0);
      return priority(right) - priority(left);
    }).slice(0, 30);
    const failureList = pipeline => Array.isArray(pipeline?.streamFailures) ? pipeline.streamFailures : [];
    const earlierFailures = failureList(a);
    const laterFailures = failureList(b);
    const failureKey = item => normalizeCandidateName(item?.label || 'unknown stream');
    const earlierFailureKeys = new Set(earlierFailures.map(failureKey));
    const laterFailureKeys = new Set(laterFailures.map(failureKey));
    const retrievalFailures = {
      earlier: earlierFailures,
      later: laterFailures,
      newlyFailed: laterFailures.filter(item => !earlierFailureKeys.has(failureKey(item))),
      resolved: earlierFailures.filter(item => !laterFailureKeys.has(failureKey(item))),
      earlierCount: earlierFailures.length,
      laterCount: laterFailures.length
    };
    const requestChanges = {
      sourceCard: stableJson(a.request?.sourceCard) !== stableJson(b.request?.sourceCard),
      highlights: stableJson(a.request?.highlights) !== stableJson(b.request?.highlights),
      intent: stableJson(a.request?.intent) !== stableJson(b.request?.intent),
      constraints: stableJson(a.request?.constraints) !== stableJson(b.request?.constraints),
      methods: stableJson(a.request?.methods) !== stableJson(b.request?.methods),
      ordering: stableJson(a.request?.ordering) !== stableJson(b.request?.ordering),
      searchDepthPercent: stableJson(a.request?.searchDepthPercent) !== stableJson(b.request?.searchDepthPercent),
      orderingFeatures: stableJson(a.request?.orderingFeatures) !== stableJson(b.request?.orderingFeatures),
      rankingWeights: stableJson(a.request?.rankingWeights) !== stableJson(b.request?.rankingWeights),
      format: stableJson(a.request?.format) !== stableJson(b.request?.format),
      color: stableJson(a.request?.color) !== stableJson(b.request?.color),
      broad: stableJson(a.request?.broad) !== stableJson(b.request?.broad),
      divergent: stableJson(a.request?.divergent) !== stableJson(b.request?.divergent),
      plannedStreams: stableJson(a.request?.plannedStreams) !== stableJson(b.request?.plannedStreams),
      queryPlans: stableJson(a.request?.queryPlans) !== stableJson(b.request?.queryPlans)
    };
    const requiredInputFields = ['sourceCard', 'highlights', 'constraints', 'methods', 'ordering', 'searchDepthPercent', 'orderingFeatures', 'rankingWeights', 'broad', 'divergent'];
    const inputSnapshotMissing = {
      earlier: requiredInputFields.filter(field => !Object.prototype.hasOwnProperty.call(a.request || {}, field)),
      later: requiredInputFields.filter(field => !Object.prototype.hasOwnProperty.call(b.request || {}, field))
    };
    const inputSnapshotComplete = Number(a.request?.inputSnapshotVersion) >= 2 &&
      Number(b.request?.inputSnapshotVersion) >= 2 &&
      inputSnapshotMissing.earlier.length === 0 && inputSnapshotMissing.later.length === 0;
    const changedInputFields = ['sourceCard', 'highlights', 'constraints', 'methods', 'ordering', 'searchDepthPercent', 'orderingFeatures', 'rankingWeights', 'format', 'color', 'broad', 'divergent']
      .filter(field => requestChanges[field]);
    const changedDerivedFields = ['intent', 'plannedStreams', 'queryPlans']
      .filter(field => requestChanges[field]);
    const aError = earlier.errorMessage || earlier.summary?.errorMessage || a.outcome?.errorMessage || '';
    const bError = later.errorMessage || later.summary?.errorMessage || b.outcome?.errorMessage || '';
    return {
      earlier: {
        number: earlier.number, status: aStatus, appBuild: earlierBuild, errorMessage: aError,
        durationMs: earlier.durationMs ?? earlier.summary?.durationMs ?? a.outcome?.durationMs ?? null,
        completedAt: earlier.completedAt, request: a.request
      },
      later: {
        number: later.number, status: bStatus, appBuild: laterBuild, errorMessage: bError,
        durationMs: later.durationMs ?? later.summary?.durationMs ?? b.outcome?.durationMs ?? null,
        completedAt: later.completedAt, request: b.request
      },
      outcomeComparison: {
        earlierStatus: aStatus,
        laterStatus: bStatus,
        earlierBuild,
        laterBuild,
        buildChanged,
        earlierResultCount: earlier.summary?.resultCount ?? aFinal.length,
        laterResultCount: later.summary?.resultCount ?? bFinal.length,
        earlierProvisionalResultCount: earlier.summary?.provisionalResultCount ?? earlier.liveSearch?.provisionalResultCount ?? 0,
        laterProvisionalResultCount: later.summary?.provisionalResultCount ?? later.liveSearch?.provisionalResultCount ?? 0,
        earlierError: aError,
        laterError: bError,
        rankingComparisonValid: aStatus === 'completed' && bStatus === 'completed',
        rankingComparisonAvailable: ['completed', 'completed_with_warnings'].includes(aStatus) && ['completed', 'completed_with_warnings'].includes(bStatus),
        rankingComparisonComplete: aStatus === 'completed' && bStatus === 'completed',
        inputSnapshotComplete,
        missingInputFields: inputSnapshotMissing,
        sameUserInputs: inputSnapshotComplete && changedInputFields.length === 0,
        comparableForAlgorithmRegression: aStatus === 'completed' && bStatus === 'completed' && inputSnapshotComplete && changedInputFields.length === 0,
        note: aStatus === 'error' || bStatus === 'error'
          ? 'At least one search failed. Treat its empty or partial result list as a failed run, not as a valid zero-result ranking.'
          : aStatus !== 'completed' || bStatus !== 'completed'
            ? 'At least one run completed with warnings or is incomplete. Inspect failed retrieval lanes before treating missing cards as true misses.'
            : !inputSnapshotComplete
              ? 'At least one run lacks a complete input snapshot. Ranking differences are descriptive only; repeat both searches on a build that captures search depth, ordering features, and ranking weight overrides.'
              : changedInputFields.length
                ? 'The two searches used different user-controlled inputs. This is useful for exploring the effect of those changes, but it is not a controlled algorithm comparison.'
                : 'Both searches completed with the same captured user-controlled inputs; this is a controlled comparison of retrieval and ranking changes.'
      },
      changes: {
        sourceCardChanged: requestChanges.sourceCard,
        highlightsChanged: requestChanges.highlights,
        intentChanged: requestChanges.intent,
        constraintsChanged: requestChanges.constraints,
        methodsChanged: requestChanges.methods,
        orderingChanged: requestChanges.ordering,
        searchDepthPercentChanged: requestChanges.searchDepthPercent,
        orderingFeaturesChanged: requestChanges.orderingFeatures,
        rankingWeightsChanged: requestChanges.rankingWeights,
        formatChanged: requestChanges.format,
        colorChanged: requestChanges.color,
        broadChanged: requestChanges.broad,
        divergentChanged: requestChanges.divergent,
        plannedStreamsChanged: requestChanges.plannedStreams,
        queryPlansChanged: requestChanges.queryPlans,
        changedInputFields,
        changedDerivedFields
      },
      retrieval: streamComparison,
      retrievalFailures,
      stageProgression,
      candidatePathChanges,
      scoredCandidateEvolution: {
        earlierSampleCount: earlierScored.size,
        laterSampleCount: laterScored.size,
        sharedSampleCount: [...earlierScored.keys()].filter(key => laterScored.has(key)).length,
        newlyPresentInSample: newlyScoredInSample.slice(0, 50),
        noLongerPresentInSample: noLongerScoredInSample.slice(0, 50),
        sampleLimit: 300,
        interpretation: 'The per-run scored-candidate diagnostics retain at most 300 candidates. Entry/exit from this sample is not proof that a card was or was not scored outside the retained sample.'
      },
      finalRanking: {
        earlierCount: aFinal.length,
        laterCount: bFinal.length,
        earlierReportedCount: earlier.summary?.resultCount ?? a.funnel?.finalResults ?? aFinal.length,
        laterReportedCount: later.summary?.resultCount ?? b.funnel?.finalResults ?? bFinal.length,
        capturedLimit: 100,
        sharedCount: common.length,
        topKOverlap,
        meanAbsoluteRankMovement,
        addedInLater: added.slice(0, 50),
        missingFromLater: removed.slice(0, 50),
        rankChanges: moved,
        interpretation: 'Rank comparison uses the first 100 final-result entries retained in each snapshot. Full reported counts are shown separately.'
      },
      sharedCandidateScoreChanges: scoreChanges,
      interpretation: aStatus === 'error' || bStatus === 'error'
        ? 'Resolve the failed search before interpreting ranking changes. A failed run is not evidence that the search engine returned zero relevant cards.'
        : aStatus !== 'completed' || bStatus !== 'completed'
          ? 'At least one run is warning-bearing or incomplete. Do not count absent candidates as reliable retrieval misses until its failed lanes are understood.'
          : !inputSnapshotComplete
            ? 'The captured inputs are incomplete. The comparison remains descriptive, but cannot be called a controlled algorithm test until search depth, ordering features, and ranking weights are captured for both runs.'
            : changedInputFields.length
              ? 'User-controlled inputs changed. The diff is descriptive, not a controlled test of algorithm quality. Use the same source, highlights, constraints, methods, ordering, search depth, ordering features, and ranking weights to evaluate code changes.'
              : 'The user-controlled inputs match. Stage membership isolates recall changes; score-channel deltas show ranking changes among shared scored candidates; top-K overlap and rank movement show the user-visible effect.'
    };
  };
  const formatLiveSummary = snapshotValue => {
    const sourceName = snapshotValue?.source?.name || snapshotValue?.liveSearch?.sourceName || 'Unknown source';
    const live = snapshotValue?.liveSearch || {};
    const statusValue = live.status || (snapshotValue?.runtime?.loading ? 'running' : 'waiting');
    const statusLabel = String(statusValue).toUpperCase().replace(/_/g, ' ');
    const liveSettings = snapshotValue?.searchIntent?.productionModel || {};
    const lines = [
      'LIVE SEARCH SUMMARY',
      'Source: ' + sourceName,
      'Status: ' + statusLabel
    ];
    if (live.requestId != null) lines.push('Request ID: ' + live.requestId);
    if (live.durationMs != null) lines.push('Duration: ' + (Number(live.durationMs) / 1000).toFixed(2) + 's');
    if (Number.isFinite(Number(liveSettings.searchDepthPercent))) {
      lines.push('Search depth: ' + Number(liveSettings.searchDepthPercent) + '%');
    }
    if (liveSettings.orderingFeatures) {
      const activeOrderFeatures = Object.entries(liveSettings.orderingFeatures).filter(([, enabled]) => Boolean(enabled)).map(([name]) => name);
      lines.push('Ordering features: ' + (activeOrderFeatures.length ? activeOrderFeatures.join(', ') : 'none'));
    }
    if (liveSettings.rankingWeights) {
      lines.push('Score-weight offsets: ' + Object.entries(liveSettings.rankingWeights).map(([name, value]) =>
        name + '=' + (value == null ? 'n/a' : value)
      ).join(', '));
    }
    if (live.progress?.message) lines.push('Current phase: ' + live.progress.message);
    if (live.totalStreams) {
      lines.push('Retrieval lanes: ' + (live.completedStreams || 0) + ' successful, ' +
        (live.failedStreams || 0) + ' failed/warning, ' + (live.settledStreams || 0) + '/' + live.totalStreams + ' settled');
      (live.streams || []).forEach(stream => {
        const streamStatus = stream.status || (stream.failed ? 'failed' : stream.done ? 'completed' : 'running');
        const marker = streamStatus === 'completed' ? 'OK'
          : streamStatus === 'failed' ? 'FAILED'
            : streamStatus === 'completed_with_warnings' ? 'WARNING'
              : streamStatus === 'running' ? 'RUNNING' : 'WAITING';
        lines.push('  [' + marker + '] ' + stream.label + ': ' + clip(stream.detail, 200));
      });
    }
    if (live.provisionalResultCount > 0 && ['error', 'completed_with_warnings'].includes(live.status)) {
      lines.push('Provisional results still visible: ' + live.provisionalResultCount + ' (not a complete final ranking)');
    }
    if (live.preview) {
      lines.push('Current results: ' + live.preview.resultCount + (live.preview.provisional ? ' provisional matches' : ' final ranked results'));
      if (live.preview.topNames?.length) lines.push('Top cards: ' + live.preview.topNames.join(' → '));
    }
    if (live.errorMessage) lines.push('Search warning/error: ' + live.errorMessage);
    if (Array.isArray(live.previewHistory) && live.previewHistory.length) {
      const provisionalCount = live.previewHistory.filter(item => item.provisional).length;
      const finalCount = live.previewHistory.filter(item => !item.provisional).length;
      lines.push('Preview history: ' + provisionalCount + ' provisional update(s), ' + finalCount + ' final ranking event(s)');
    }
    lines.push('', 'FULL CAPTURED STATE');
    return lines.join('\n') + '\n' + JSON.stringify(snapshotValue, null, 2);
  };
  const formatCompareSummary = comparison => {
    if (!comparison || comparison.message) return String(comparison?.message || 'No comparison is available.');
    const outcome = comparison.outcomeComparison || {};
    const controlled = outcome.comparableForAlgorithmRegression === true;
    const valid = outcome.rankingComparisonAvailable === true;
    const lines = [
      'COMPARE RUNS SUMMARY',
      'Comparison type: ' + (controlled ? 'CONTROLLED ALGORITHM COMPARISON'
        : valid ? 'EXPLORATORY / INPUTS OR RUN HEALTH DIFFER'
          : 'INVALID — ONE OR MORE RUNS FAILED'),
      'Earlier run: #' + (comparison.earlier?.number ?? '?') + ' — ' + (outcome.earlierStatus || comparison.earlier?.status || 'unknown') + ' — ' + (outcome.earlierResultCount ?? 0) + ' results',
      'Later run:   #' + (comparison.later?.number ?? '?') + ' — ' + (outcome.laterStatus || comparison.later?.status || 'unknown') + ' — ' + (outcome.laterResultCount ?? 0) + ' results'
    ];
    if (outcome.earlierBuild || outcome.laterBuild) {
      lines.push('App builds: ' + (outcome.earlierBuild || 'unknown') + ' → ' + (outcome.laterBuild || 'unknown') +
        (outcome.buildChanged ? ' (different builds)' : ''));
    }
    if (outcome.note) lines.push('Validity: ' + outcome.note);
    if (outcome.earlierProvisionalResultCount > 0 || outcome.laterProvisionalResultCount > 0) {
      lines.push('Provisional cards still visible: earlier ' + (outcome.earlierProvisionalResultCount || 0) +
        ' → later ' + (outcome.laterProvisionalResultCount || 0) + ' (not included in final ranking counts)');
    }
    const changedInputs = comparison.changes?.changedInputFields || [];
    const changedDerived = comparison.changes?.changedDerivedFields || [];
    lines.push('Input snapshot complete: ' + (outcome.inputSnapshotComplete ? 'yes' : 'no'));
    if (!outcome.inputSnapshotComplete && outcome.missingInputFields) {
      lines.push('Missing captured settings: earlier [' + (outcome.missingInputFields.earlier || []).join(', ') +
        ']; later [' + (outcome.missingInputFields.later || []).join(', ') + ']');
    }
    lines.push('Changed user inputs: ' + (changedInputs.length ? changedInputs.join(', ') : 'none'));
    lines.push('Changed derived intent/query outputs: ' + (changedDerived.length ? changedDerived.join(', ') : 'none'));
    if (comparison.retrievalFailures) {
      const failures = comparison.retrievalFailures;
      lines.push('Retrieval lane failures: ' + (failures.earlierCount || 0) + ' → ' + (failures.laterCount || 0) +
        '; newly failed ' + (failures.newlyFailed?.length || 0) + '; recovered ' + (failures.resolved?.length || 0));
      (failures.newlyFailed || []).slice(0, 5).forEach(item => lines.push('  [NEW FAILURE] ' + item.label + ': ' + clip(item.message, 200)));
      (failures.resolved || []).slice(0, 5).forEach(item => lines.push('  [RECOVERED] ' + item.label + ': ' + clip(item.message, 200)));
    }
    lines.push('Pipeline candidate counts (earlier → later):');
    (comparison.stageProgression || []).forEach(stage => {
      lines.push('  ' + stage.label + ': ' + stage.earlierCount + ' → ' + stage.laterCount +
        ' (shared ' + stage.sharedCount + ', overlap ' + Math.round((stage.jaccard || 0) * 100) + '%)');
      if (stage.addedInLater?.length) lines.push('    Added examples: ' + stage.addedInLater.slice(0, 5).join(', '));
      if (stage.missingFromLater?.length) lines.push('    Missing examples: ' + stage.missingFromLater.slice(0, 5).join(', '));
    });
    if (comparison.candidatePathChanges?.length) {
      lines.push('Changed-card pipeline paths (bounded trace evidence):');
      comparison.candidatePathChanges.slice(0, 8).forEach(item => {
        const ranks = '#' + (item.earlierFinalRank ?? '—') + ' → #' + (item.laterFinalRank ?? '—');
        const divergence = item.firstDivergence
          ? item.firstDivergence.label + ' (' + (item.firstDivergence.earlierPresent ? 'present' : 'absent') +
            ' → ' + (item.firstDivergence.laterPresent ? 'present' : 'absent') + ')'
          : 'no recorded stage divergence';
        lines.push('  ' + item.name + ': ' + ranks + ' — ' + divergence);
        if (item.earlierRetrievalStreams.length || item.laterRetrievalStreams.length) {
          lines.push('    Streams: earlier [' + item.earlierRetrievalStreams.join(', ') + '] → later [' + item.laterRetrievalStreams.join(', ') + ']');
        }
        lines.push('    ' + item.explanation);
      });
    }
    if (comparison.scoredCandidateEvolution) {
      const scored = comparison.scoredCandidateEvolution;
      lines.push('Scored-candidate sample: ' + scored.sharedSampleCount + ' shared of ' + scored.earlierSampleCount +
        ' earlier / ' + scored.laterSampleCount + ' later (retained sample cap ' + scored.sampleLimit + ')');
      if (scored.newlyPresentInSample?.length) lines.push('  Entered sample: ' + scored.newlyPresentInSample.slice(0, 8).join(', '));
      if (scored.noLongerPresentInSample?.length) lines.push('  Left sample: ' + scored.noLongerPresentInSample.slice(0, 8).join(', '));
    }
    if (comparison.finalRanking) {
      const ranking = comparison.finalRanking;
      lines.push('Top-K overlap: ' + ((ranking.topKOverlap || []).map(item =>
        'Top ' + item.k + ' ' + Math.round(item.overlap * 100) + '% of K' +
        (item.capturedListOverlap === null ? '' : ' / ' + Math.round(item.capturedListOverlap * 100) + '% of shorter list (' + item.capturedListDenominator + ')')
      ).join(' · ') || 'not available'));
      lines.push('Mean absolute rank movement among shared top-100 cards: ' + (ranking.meanAbsoluteRankMovement ?? 'n/a'));
      if (ranking.rankChanges?.length) {
        lines.push('Largest rank movements:');
        ranking.rankChanges.slice(0, 8).forEach(item => lines.push('  ' + item.name + ': #' + item.earlierRank + ' → #' + item.laterRank +
          ' (' + (item.movement > 0 ? '+' : '') + item.movement + ')'));
      }
      if (ranking.addedInLater?.length) lines.push('New final cards: ' + ranking.addedInLater.slice(0, 10).join(', '));
      if (ranking.missingFromLater?.length) lines.push('Removed final cards: ' + ranking.missingFromLater.slice(0, 10).join(', '));
    }
    const scoreChanges = (comparison.sharedCandidateScoreChanges || [])
      .filter(item => item.delta !== null || item.scoreChannelChanges?.length || item.mechanicalBreakdownChanges?.length)
      .sort((a, b) => {
        const magnitude = item => Math.max(
          Math.abs(item.delta || 0),
          ...(item.scoreChannelChanges || []).map(change => Math.abs(change.delta || 0)),
          ...(item.mechanicalBreakdownChanges || []).map(change => Math.abs(change.delta || 0))
        );
        return magnitude(b) - magnitude(a);
      }).slice(0, 8);
    if (scoreChanges.length) {
      lines.push('Largest shared-candidate score changes:');
      scoreChanges.forEach(item => {
        const headline = item.delta === null
          ? item.name + ': overall similarity unchanged/not captured'
          : item.name + ': similarity ' + Number(item.earlierScore).toFixed(3) +
            ' → ' + Number(item.laterScore).toFixed(3) + ' (' + (item.delta > 0 ? '+' : '') + item.delta.toFixed(3) + ')';
        lines.push('  ' + headline);
        const channelChanges = [
          ...(item.scoreChannelChanges || []).map(change => ({ ...change, group: 'score' })),
          ...(item.mechanicalBreakdownChanges || []).map(change => ({ ...change, group: 'mechanical' }))
        ].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 6);
        if (channelChanges.length) {
          lines.push('    Changed factors: ' + channelChanges.map(change =>
            change.group + '.' + change.field + ' ' + (change.delta > 0 ? '+' : '') + change.delta.toFixed(3)
          ).join('; '));
        }
      });
    }
    lines.push('', 'FULL COMPARISON JSON');
    return lines.join('\n') + '\n' + JSON.stringify(comparison, null, 2);
  };
  const normalizeCandidateName = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  const traceCandidate = (pipeline, candidateName) => {
    if (!pipeline || !candidateName) return { found: false, candidateName: candidateName || '', message: 'Select a candidate and a completed search.' };
    const key = normalizeCandidateName(candidateName);
    const stages = pipeline.funnel?.stages || {};
    const stageOrder = [
      ['retrieved', 'Retrieved'],
      ['passedFilters', 'Passed hard filters'],
      ['deduplicated', 'Survived deduplication'],
      ['meaningfulParse', 'Passed meaningful-parse threshold'],
      ['scored', 'Reached mechanical/semantic scoring'],
      ['passedRelevanceFloor', 'Passed relevance floor'],
      ['finalRanked', 'Included in final ranked results']
    ];
    const hasName = values => Array.isArray(values) && values.some(value => normalizeCandidateName(value) === key);
    const stageMembership = stageOrder.map(([field, label]) => ({
      stage: field, label, present: hasName(stages[field])
    }));
    const retrievalSources = Object.entries(pipeline.streams || {})
      .filter(([, names]) => hasName(names)).map(([stream]) => stream);
    const candidate = (pipeline.candidates || []).find(item => normalizeCandidateName(item.name) === key) || null;
    const rejection = (pipeline.filterRejections || []).find(item => normalizeCandidateName(item.name) === key) || null;
    const finalResult = (pipeline.finalResults || []).find(item => normalizeCandidateName(item.name) === key) || null;
    const rankingEvidence = (pipeline.rankingEvidenceTop || []).find(item => normalizeCandidateName(item.name) === key) || null;
    const stageLossesForCandidate = [];
    for (let i = 1; i < stageMembership.length; i++) {
      if (stageMembership[i - 1].present && !stageMembership[i].present) {
        stageLossesForCandidate.push({
          after: stageMembership[i - 1].label,
          before: stageMembership[i].label
        });
      }
    }
    const found = retrievalSources.length > 0 || stageMembership.some(stage => stage.present) || !!candidate || !!rejection || !!finalResult;
    return {
      found, candidateName,
      sourceCard: pipeline.request?.sourceCard?.name || '',
      retrieval: { foundInStreams: retrievalSources.length > 0, streams: retrievalSources },
      stages: stageMembership,
      firstObservedLoss: stageLossesForCandidate[0] || null,
      possibleHardFilterRejection: rejection,
      scoring: candidate ? {
        preFloorRank: candidate.preFloorRank ?? null,
        typeLine: candidate.type_line || '',
        oracleText: candidate.oracle_text || '',
        scores: candidate.scores || {},
        rankingEvidence: candidate.rankingEvidence || null,
        mechanicalBreakdown: candidate.mechanicalBreakdown || null,
        mechanicalEvidence: candidate.mechanicalEvidence || null,
        effectCoverage: candidate.effectCoverage || null,
        parse: candidate.parse || candidate.parseDiagnostics || null,
        rankingIntent: candidate.rankingIntent || null,
        flags: candidate.flags || {},
        retrievalEvidence: candidate.retrievalEvidence || []
      } : null,
      finalRanking: finalResult ? {
        rank: finalResult.rank ?? null,
        similarityScore: finalResult.similarityScore ?? null,
        preFloorScores: finalResult.preFloorScores || null,
        constraintPreferenceScore: finalResult.constraintPreferenceScore ?? null,
        flags: finalResult.flags || {}
      } : null,
      rankingEvidenceTop: rankingEvidence,
      interpretation: found
        ? 'Absence from a later stage means this snapshot does not record the candidate there. Use the first missing transition together with any hard-filter rejection and score evidence; a missing record is not proof of the exact internal cause.'
        : 'This candidate is not present in the captured retrieval streams, stage membership, scored-candidate sample, rejection sample, or final results. It may not have been retrieved, or it may fall outside the snapshot limits.'
    };
  };
  const REGRESSION_CASE_SCHEMA = 'manasearch-regression-case-v1';
  const regressionFinalRanking = pipeline => (pipeline?.finalResults || []).map((item, index) => ({
    rank: item.rank ?? index + 1,
    name: String(item.name || '').trim(),
    similarityScore: item.similarityScore ?? null
  })).filter(item => item.name);
  const createRegressionCase = (run, options = {}) => {
    if (!run?.pipeline) throw new Error('Choose a search run with a captured production pipeline.');
    const runStatus = run.status || run.summary?.status || run.pipeline?.outcome?.status || 'completed';
    if (runStatus === 'error') throw new Error('Cannot create a ranking regression case from a failed search. Fix the search failure and capture a valid baseline first.');
    const pipeline = run.pipeline;
    const sourceName = pipeline.request?.sourceCard?.name || run.summary?.sourceName || 'Search';
    const focusCandidate = String(options.focusCandidate || '').trim();
    const expectedTopCandidates = Array.isArray(options.expectedTopCandidates)
      ? options.expectedTopCandidates.map(value => String(value || '').trim()).filter(Boolean)
      : regressionFinalRanking(pipeline).slice(0, 10).map(item => item.name);
    return {
      schema: REGRESSION_CASE_SCHEMA,
      version: 1,
      createdAt: new Date().toISOString(),
      title: String(options.title || (sourceName + ' — regression case')).trim(),
      notes: String(options.notes || ''),
      source: {
        runNumber: run.number ?? null,
        completedAt: run.completedAt || null,
        appBuild: pipeline.appBuild || run.appBuild || null,
        request: cloneJson(pipeline.request || {}),
        ui: cloneJson(run.ui || {})
      },
      expectations: {
        focusCandidate,
        focusBehavior: options.focusBehavior || (focusCandidate ? 'must-appear' : 'none'),
        maxRank: Number(options.maxRank) || 3,
        expectedTopCandidates
      },
      baseline: {
        status: runStatus,
        warning: runStatus === 'completed_with_warnings' ? (run.errorMessage || run.summary?.errorMessage || pipeline.outcome?.errorMessage || '') : '',
        finalRanking: regressionFinalRanking(pipeline),
        focusTrace: focusCandidate ? traceCandidate(pipeline, focusCandidate) : null
      },
      diagnostics: cloneJson(pipeline)
    };
  };
  const validateRegressionCase = value => {
    if (!value || value.schema !== REGRESSION_CASE_SCHEMA || value.version !== 1) {
      throw new Error('Unsupported regression case. Expected ' + REGRESSION_CASE_SCHEMA + ' version 1.');
    }
    if (!value.source || !value.source.request || typeof value.source.request !== 'object') {
      throw new Error('Regression case is missing its original search request.');
    }
    if (!value.expectations || !Array.isArray(value.expectations.expectedTopCandidates)) {
      throw new Error('Regression case is missing its expected ranking.');
    }
    const checked = cloneJson(value);
    checked.expectations.focusCandidate = String(checked.expectations.focusCandidate || '').trim();
    checked.expectations.focusBehavior = ['none', 'must-appear', 'must-not-appear', 'rank-at-most'].includes(checked.expectations.focusBehavior)
      ? checked.expectations.focusBehavior : 'none';
    checked.expectations.maxRank = Math.max(1, Number(checked.expectations.maxRank) || 3);
    checked.expectations.expectedTopCandidates = checked.expectations.expectedTopCandidates
      .map(name => String(name || '').trim()).filter(Boolean);
    return checked;
  };
  const canonicalize = value => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
    return value;
  };
  const stableJson = value => JSON.stringify(canonicalize(value ?? null));
  const flattenNumericFields = (value, prefix = '', result = {}) => {
    if (Array.isArray(value)) return result;
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) flattenNumericFields(value[key], prefix ? prefix + '.' + key : key, result);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      result[prefix] = value;
    }
    return result;
  };
  const compareNumericFields = (before, after) => {
    const left = flattenNumericFields(before);
    const right = flattenNumericFields(after);
    return Object.keys(left).filter(key => Object.prototype.hasOwnProperty.call(right, key))
      .map(key => ({ field: key, baseline: left[key], current: right[key], delta: Number((right[key] - left[key]).toFixed(6)) }))
      .filter(item => Math.abs(item.delta) > 0.000001);
  };
  const compareRegressionCase = (regressionCase, run) => {
    const fixture = validateRegressionCase(regressionCase);
    if (!run?.pipeline) return { comparable: false, assertionsConfigured: false, pass: null, status: 'missing-run', message: 'Select a retained search run to compare.' };
    const runStatus = run.status || run.summary?.status || run.pipeline?.outcome?.status || 'completed';
    if (runStatus === 'error') {
      return {
        comparable: false,
        assertionsConfigured: false,
        pass: null,
        status: 'search-error',
        case: { title: fixture.title, sourceRunNumber: fixture.source.runNumber ?? null, appBuild: fixture.source.appBuild || fixture.diagnostics?.appBuild || null },
        comparedRun: {
          number: run.number ?? null,
          status: runStatus,
          appBuild: run.pipeline?.appBuild || run.appBuild || null,
          buildChanged: Boolean((fixture.source.appBuild || fixture.diagnostics?.appBuild) &&
            (run.pipeline?.appBuild || run.appBuild) &&
            (fixture.source.appBuild || fixture.diagnostics?.appBuild) !== (run.pipeline?.appBuild || run.appBuild)),
          errorMessage: run.errorMessage || run.summary?.errorMessage || run.pipeline?.outcome?.errorMessage || ''
        },
        interpretation: 'The search failed before producing a valid ranking. Diagnose the search error rather than counting this as a ranking regression.'
      };
    }
    const expectedRequest = fixture.source.request || {};
    const actualRequest = run.pipeline.request || {};
    // Only user-controlled request fields invalidate a replay. Intent and query plans are outputs
    // of the system under test: changes to them should be reported and evaluated, not rejected.
    const requestFields = ['inputSnapshotVersion', 'sourceCard', 'highlights', 'constraints', 'methods', 'ordering', 'searchDepthPercent', 'orderingFeatures', 'rankingWeights', 'format', 'color', 'broad', 'divergent'];
    const inputDifferences = requestFields.filter(field => stableJson(expectedRequest[field]) !== stableJson(actualRequest[field]));
    const derivedRequestFields = ['intent', 'plannedStreams', 'queryPlans'];
    const derivedRequestChanges = derivedRequestFields.filter(field => stableJson(expectedRequest[field]) !== stableJson(actualRequest[field]));
    const inputsMatch = inputDifferences.length === 0;
    const actualRanking = regressionFinalRanking(run.pipeline);
    const actualRanks = new Map(actualRanking.map(item => [normalizeCandidateName(item.name), item.rank]));
    const baselinePipeline = fixture.diagnostics || {};
    const baselineCandidates = new Map((baselinePipeline.candidates || []).map(item => [normalizeCandidateName(item.name), item]));
    const currentCandidates = new Map((run.pipeline.candidates || []).map(item => [normalizeCandidateName(item.name), item]));
    const sharedScoredNames = [...baselineCandidates.keys()].filter(name => currentCandidates.has(name));
    const scoreChanges = sharedScoredNames.map(key => {
      const before = baselineCandidates.get(key);
      const after = currentCandidates.get(key);
      const similarity = compareNumericFields(before.scores, after.scores);
      const mechanical = compareNumericFields(before.mechanicalBreakdown, after.mechanicalBreakdown);
      return {
        name: after.name || before.name || key,
        baselinePreFloorRank: before.preFloorRank ?? null,
        currentPreFloorRank: after.preFloorRank ?? null,
        baselineFinalRank: (fixture.baseline?.finalRanking || []).find(item => normalizeCandidateName(item.name) === key)?.rank ?? null,
        currentFinalRank: actualRanks.get(key) ?? null,
        scoreChanges: similarity,
        mechanicalBreakdownChanges: mechanical
      };
    }).filter(item => item.scoreChanges.length || item.mechanicalBreakdownChanges.length ||
      item.baselinePreFloorRank !== item.currentPreFloorRank || item.baselineFinalRank !== item.currentFinalRank)
      .sort((a, b) => {
        const scoreDelta = item => Math.abs(item.scoreChanges.find(change => change.field === 'similarityScore')?.delta || 0);
        return scoreDelta(b) - scoreDelta(a);
      }).slice(0, 40);
    const baselineScoredNames = new Set(baselineCandidates.keys());
    const currentScoredNames = new Set(currentCandidates.keys());
    const newlyScored = [...currentScoredNames].filter(name => !baselineScoredNames.has(name)).map(name => currentCandidates.get(name)?.name || name);
    const noLongerScored = [...baselineScoredNames].filter(name => !currentScoredNames.has(name)).map(name => baselineCandidates.get(name)?.name || name);
    const expected = fixture.expectations.expectedTopCandidates;
    const expectedTopK = expected.length;
    const actualTopK = actualRanking.slice(0, expectedTopK);
    const actualTopKeys = new Set(actualTopK.map(item => normalizeCandidateName(item.name)));
    const expectedKeys = new Set(expected.map(normalizeCandidateName));
    const matchedTop = expected.filter(name => actualTopKeys.has(normalizeCandidateName(name)));
    const missingFromTop = expected.filter(name => !actualTopKeys.has(normalizeCandidateName(name)));
    const unexpectedInTop = actualTopK.filter(item => !expectedKeys.has(normalizeCandidateName(item.name))).map(item => item.name);
    const rankChanges = expected.map((name, index) => ({
      name,
      expectedRank: index + 1,
      actualRank: actualRanks.get(normalizeCandidateName(name)) ?? null
    })).filter(item => item.actualRank !== item.expectedRank);
    const rankingPass = expected.length > 0
      ? expected.length === actualTopK.length && expected.every((name, index) => normalizeCandidateName(name) === normalizeCandidateName(actualTopK[index]?.name))
      : null;
    const focusName = fixture.expectations.focusCandidate;
    const focusRank = focusName ? (actualRanks.get(normalizeCandidateName(focusName)) ?? null) : null;
    let focusPass = null;
    if (focusName && fixture.expectations.focusBehavior === 'must-appear') focusPass = focusRank !== null;
    else if (focusName && fixture.expectations.focusBehavior === 'must-not-appear') focusPass = focusRank === null;
    else if (focusName && fixture.expectations.focusBehavior === 'rank-at-most') focusPass = focusRank !== null && focusRank <= fixture.expectations.maxRank;
    const assertionsConfigured = rankingPass !== null || focusPass !== null;
    const completeRun = runStatus === 'completed';
    // A warning-bearing run can still be inspected, but it cannot prove that omitted cards were
    // truly irrelevant: an interrupted retrieval lane may simply not have found them.
    const pass = inputsMatch && assertionsConfigured && completeRun
      ? rankingPass !== false && focusPass !== false : null;
    return {
      comparable: inputsMatch,
      assertionsConfigured,
      pass,
      status: !inputsMatch ? 'input-mismatch' : !completeRun ? 'partial-run' : !assertionsConfigured ? 'no-expectations' : pass ? 'pass' : 'fail',
      case: { title: fixture.title, sourceRunNumber: fixture.source.runNumber ?? null, appBuild: fixture.source.appBuild || fixture.diagnostics?.appBuild || null },
      comparedRun: {
        number: run.number ?? null,
        status: runStatus,
        appBuild: run.pipeline?.appBuild || run.appBuild || null,
        buildChanged: Boolean((fixture.source.appBuild || fixture.diagnostics?.appBuild) &&
          (run.pipeline?.appBuild || run.appBuild) &&
          (fixture.source.appBuild || fixture.diagnostics?.appBuild) !== (run.pipeline?.appBuild || run.appBuild)),
        warning: runStatus === 'completed_with_warnings' ? (run.errorMessage || run.summary?.errorMessage || run.pipeline?.outcome?.errorMessage || '') : '',
        completedAt: run.completedAt || null,
        durationMs: run.durationMs ?? run.summary?.durationMs ?? run.pipeline?.outcome?.durationMs ?? null
      },
      inputCheck: { matches: inputsMatch, changedFields: inputDifferences },
      derivedRequestChanges,
      scoringEvolution: {
        baselineScoredSampleCount: baselineCandidates.size,
        currentScoredSampleCount: currentCandidates.size,
        sharedScoredSampleCount: sharedScoredNames.length,
        newlyPresentInScoredSample: newlyScored.slice(0, 50),
        noLongerPresentInScoredSample: noLongerScored.slice(0, 50),
        changedSampleCandidates: scoreChanges,
        sampleLimit: 300,
        interpretation: 'Scored-candidate comparisons use the retained top-300 sample from each run. A card entering or leaving this sample does not prove it was newly scored or stopped being scored outside the captured sample.'
      },
      focusCheck: focusName ? {
        candidate: focusName,
        expectation: fixture.expectations.focusBehavior,
        maximumRank: fixture.expectations.maxRank,
        actualRank: focusRank,
        pass: focusPass,
        baselineTrace: fixture.baseline?.focusTrace || null,
        currentTrace: traceCandidate(run.pipeline, focusName)
      } : null,
      rankingCheck: expected.length ? {
        expectedCount: expected.length,
        matchedInTopK: matchedTop.length,
        overlap: Number((matchedTop.length / expected.length).toFixed(4)),
        exactOrderMatch: rankingPass,
        expectedTop: expected,
        actualTop: actualTopK.map(item => item.name),
        missingFromTop,
        unexpectedInTop,
        rankChanges
      } : null,
      interpretation: !inputsMatch
        ? 'The compared run used different user-controlled inputs. Repeat the source card, selected highlights, constraints, methods, and ordering before judging the algorithm change.'
        : derivedRequestChanges.length
          ? 'User-controlled inputs match. The interpreted intent or generated retrieval plan changed; these are outputs of the system under test and are shown for diagnosis rather than treated as replay mismatches.'
          : 'A pass requires matching user-controlled inputs and satisfying every configured focus-card and expected-ranking assertion.'
    };
  };
  const selectedRegressionRun = select => state.searchRuns.find(run => String(run.number) === select.value) || null;
  const setRunOptions = (select, preferredNumber) => {
    const previous = select.value;
    select.innerHTML = state.searchRuns.map(run =>
      '<option value="' + htmlEscape(run.number) + '">' + htmlEscape(clip(runLabel(run), 120)) + '</option>'
    ).join('');
    const wanted = preferredNumber ?? previous;
    if (state.searchRuns.some(run => String(run.number) === String(wanted))) select.value = String(wanted);
    else if (state.searchRuns.length) select.value = String(state.searchRuns[state.searchRuns.length - 1].number);
  };
  const populateRegressionCandidateList = run => {
    const names = new Map();
    const add = value => {
      const name = String(value || '').trim();
      if (name && !names.has(normalizeCandidateName(name))) names.set(normalizeCandidateName(name), name);
    };
    const pipeline = run?.pipeline || {};
    Object.values(pipeline.streams || {}).forEach(values => (values || []).forEach(add));
    Object.values(pipeline.funnel?.stages || {}).forEach(values => (values || []).forEach(add));
    (pipeline.candidates || []).forEach(item => add(item.name));
    (pipeline.filterRejections || []).forEach(item => add(item.name));
    (pipeline.finalResults || []).forEach(item => add(item.name));
    panel.querySelector('#ms-regression-candidates').innerHTML = [...names.values()].sort((a, b) => a.localeCompare(b))
      .map(name => '<option value="' + htmlEscape(name) + '"></option>').join('');
  };
  const fillRegressionForm = fixture => {
    regressionTitle.value = fixture.title || '';
    regressionNotes.value = fixture.notes || '';
    regressionFocus.value = fixture.expectations?.focusCandidate || '';
    regressionBehavior.value = fixture.expectations?.focusBehavior || 'none';
    regressionMaxRank.value = String(fixture.expectations?.maxRank || 3);
    regressionTop.value = (fixture.expectations?.expectedTopCandidates || []).join('\n');
  };
  const readRegressionForm = () => {
    let fixture;
    if (activeRegressionCase) fixture = cloneJson(activeRegressionCase);
    else {
      const run = selectedRegressionRun(regressionSourceRun);
      if (!run) throw new Error('Run Find Similar Cards, then use Build case to capture it.');
      fixture = createRegressionCase(run, { focusCandidate: regressionFocus.value });
    }
    fixture.title = regressionTitle.value.trim() || fixture.title;
    fixture.notes = regressionNotes.value.trim();
    fixture.expectations.focusCandidate = regressionFocus.value.trim();
    fixture.expectations.focusBehavior = regressionBehavior.value;
    fixture.expectations.maxRank = Math.max(1, Number(regressionMaxRank.value) || 3);
    fixture.expectations.expectedTopCandidates = regressionTop.value.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
    activeRegressionCase = validateRegressionCase(fixture);
    return activeRegressionCase;
  };
  const downloadJson = (data, filename) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const renderRegression = () => {
    regressionControls.hidden = activeTab !== 'regression';
    if (activeTab !== 'regression') return;
    if (!state.searchRuns.length) {
      content.textContent = JSON.stringify({ message: 'No completed search is retained. Run Find Similar Cards, then open Regression cases and build a case from that run. To compare a case from another build, import its JSON first.' }, null, 2);
      return;
    }
    setRunOptions(regressionSourceRun);
    setRunOptions(regressionCompareRun);
    populateRegressionCandidateList(selectedRegressionRun(regressionSourceRun));
    content.textContent = JSON.stringify(activeRegressionCase
      ? { message: 'Regression case loaded. Edit its expected behavior above, then download it or compare it with a captured run.', title: activeRegressionCase.title, schema: activeRegressionCase.schema, sourceRunNumber: activeRegressionCase.source.runNumber, expectedTopCandidates: activeRegressionCase.expectations.expectedTopCandidates.length }
      : { message: 'Build a portable test case from a completed search. The expected ranking starts with the captured result order; edit it to define the correct order before exporting.', retainedRuns: state.searchRuns.length }, null, 2);
  };
  const renderTrace = () => {
    compareControls.hidden = true;
    traceControls.hidden = activeTab !== 'trace';
    const pipeline = getPipelineSnapshot();
    if (!pipeline) {
      content.textContent = JSON.stringify({ message: 'Run Find Similar Cards to capture a production pipeline before tracing a candidate.' }, null, 2);
      return;
    }
    const names = new Map();
    const addName = value => {
      const label = String(value || '').trim();
      if (label && !names.has(normalizeCandidateName(label))) names.set(normalizeCandidateName(label), label);
    };
    for (const values of Object.values(pipeline.streams || {})) (values || []).forEach(addName);
    for (const values of Object.values(pipeline.funnel?.stages || {})) (values || []).forEach(addName);
    (pipeline.candidates || []).forEach(item => addName(item.name));
    (pipeline.filterRejections || []).forEach(item => addName(item.name));
    (pipeline.finalResults || []).forEach(item => addName(item.name));
    const previous = traceSelect.value;
    traceSelect.innerHTML = [...names.values()].sort((a, b) => a.localeCompare(b)).map(name =>
      '<option value="' + htmlEscape(name) + '">' + htmlEscape(name) + '</option>'
    ).join('');
    if ([...names.values()].some(name => normalizeCandidateName(name) === normalizeCandidateName(previous))) traceSelect.value = previous;
    else traceSelect.selectedIndex = 0;
    const selected = traceSelect.value;
    content.textContent = selected
      ? JSON.stringify(traceCandidate(pipeline, selected), null, 2)
      : JSON.stringify({ message: 'No candidate names were captured in this snapshot.' }, null, 2);
  };
  const selectedRuns = () => {
    const runs = state.searchRuns;
    if (runs.length < 2) return [null, null];
    const a = runs.find(run => String(run.number) === runSelectA.value) || runs[runs.length - 2];
    const b = runs.find(run => String(run.number) === runSelectB.value) || runs[runs.length - 1];
    return [a, b];
  };
  const renderCompare = () => {
    compareControls.hidden = activeTab !== 'compare';
    if (state.searchRuns.length < 2) {
      content.textContent = JSON.stringify({
        message: 'Run at least two Find Similar Cards searches in this page session to compare them.',
        retainedRuns: state.searchRuns.length,
        maximumRetainedRuns: MAX_SEARCH_RUNS
      }, null, 2);
      return;
    }
    const currentA = runSelectA.value;
    const currentB = runSelectB.value;
    const options = state.searchRuns.map(run => `<option value="${run.number}">${htmlEscape(clip(runLabel(run), 120))}</option>`).join('');
    runSelectA.innerHTML = options;
    runSelectB.innerHTML = options;
    runSelectA.value = state.searchRuns.some(run => String(run.number) === currentA) ? currentA : String(state.searchRuns[state.searchRuns.length - 2].number);
    runSelectB.value = state.searchRuns.some(run => String(run.number) === currentB) ? currentB : String(state.searchRuns[state.searchRuns.length - 1].number);
    const [a, b] = selectedRuns();
    content.textContent = formatCompareSummary(compareRuns(a, b));
  };
  const renderTimeline = () => { if (activeTab === 'timeline' && !windowEl.hidden) content.textContent = JSON.stringify(state.events, null, 2); };
  const renderWorker = () => { if (activeTab === 'worker' && !windowEl.hidden) content.textContent = JSON.stringify(state.workerMessages, null, 2); };
  const render = () => {
    traceControls.hidden = activeTab !== 'trace';
    regressionControls.hidden = activeTab !== 'regression';
    status.textContent = state.activeSearch?.status === 'running'
      ? `Searching ${state.activeSearch.sourceName || 'source card'} — ${state.activeSearch.settledStreams || 0}/${state.activeSearch.totalStreams || 0} streams settled`
      : state.searchRuns.length
        ? `${state.searchRuns.length} search run(s) retained — latest: ${state.searchRuns[state.searchRuns.length - 1].status || 'completed'}`
        : state.searchCount ? `${state.searchCount} search action(s) observed` : 'Waiting for search activity';
    if (activeTab === 'live') {
      state.lastSnapshot = snapshot();
      content.textContent = formatLiveSummary(state.lastSnapshot);
      compareControls.hidden = true;
    } else if (activeTab === 'pipeline') {
      const p = getPipelineSnapshot();
      content.textContent = JSON.stringify(p ? { request: p.request, funnel: p.funnel ? Object.fromEntries(Object.entries(p.funnel).filter(([key]) => key !== 'stages')) : null, retrievalStreams: Object.fromEntries(Object.entries(p.streams || {}).map(([name, cards]) => [name, { count: cards.length, examples: cards.slice(0, 12) }])), streamCoverage: p.streamCoverage, streamFailures: p.streamFailures || [], functionalQueryResults: p.functionalQueryResults, exactHighlightQueryResults: p.exactHighlightQueryResults, scoring: p.scoring, benchmarkSignals: p.benchmarkSignals, highlightIntentDiagnostics: p.highlightIntentDiagnostics } : { message: 'No completed production search snapshot yet. Run Find Similar Cards, then refresh.' }, null, 2);
      compareControls.hidden = true;
    } else if (activeTab === 'candidates') {
      const p = getPipelineSnapshot();
      content.textContent = JSON.stringify(p ? { explanation: 'Actual candidates scored by ManaSearch, including candidates later removed by the relevance floor. Scores are normalized 0–1 unless noted.', candidates: p.candidates, finalResults: p.finalResults, rankingEvidenceTop: p.rankingEvidenceTop } : { message: 'No scored candidates yet.' }, null, 2);
      compareControls.hidden = true;
    } else if (activeTab === 'exclusions') {
      const p = getPipelineSnapshot();
      content.textContent = JSON.stringify(p ? { explanation: 'Compare stage membership to find where a candidate disappeared. Hard-filter rejection reasons are recorded separately.', stageLosses: stageLosses(p), hardFilterRejections: p.filterRejections, stageMembership: p.funnel?.stages } : { message: 'No exclusion diagnostics yet.' }, null, 2);
      compareControls.hidden = true;
    } else if (activeTab === 'trace') renderTrace();
    else if (activeTab === 'compare') renderCompare();
    else if (activeTab === 'regression') renderRegression();
    else if (activeTab === 'timeline') { compareControls.hidden = true; renderTimeline(); }
    else { compareControls.hidden = true; renderWorker(); }
  };
  const open = value => {
    windowEl.hidden = !value;
    launch.setAttribute('aria-expanded', String(value));
    launch.textContent = value ? 'Hide inspector' : 'Developer inspector';
    if (value) render();
  };
  launch.addEventListener('click', () => open(windowEl.hidden));
  panel.querySelector('.ms-inspector-close').addEventListener('click', () => open(false));
  panel.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
    activeTab = button.dataset.tab;
    panel.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('is-active', item === button));
    render();
  }));
  runSelectA.addEventListener('change', renderCompare);
  runSelectB.addEventListener('change', renderCompare);
  traceSelect.addEventListener('change', renderTrace);
  regressionSourceRun.addEventListener('change', () => populateRegressionCandidateList(selectedRegressionRun(regressionSourceRun)));
  regressionCompareRun.addEventListener('change', () => {
    if (activeRegressionCase) content.textContent = JSON.stringify(compareRegressionCase(readRegressionForm(), selectedRegressionRun(regressionCompareRun)), null, 2);
  });
  panel.querySelector('[data-regression-build]').addEventListener('click', () => {
    try {
      const run = selectedRegressionRun(regressionSourceRun);
      if (!run) throw new Error('No completed run is available to build a case from.');
      activeRegressionCase = createRegressionCase(run, {
        focusCandidate: regressionFocus.value || traceSelect.value,
        focusBehavior: (regressionFocus.value || traceSelect.value) ? 'must-appear' : 'none'
      });
      fillRegressionForm(activeRegressionCase);
      populateRegressionCandidateList(run);
      content.textContent = JSON.stringify({ message: 'Case built. Edit the expected ranking and focus expectation, then download the JSON.', title: activeRegressionCase.title, baselineRanking: activeRegressionCase.baseline.finalRanking }, null, 2);
    } catch (error) { content.textContent = JSON.stringify({ error: error.message }, null, 2); }
  });
  panel.querySelector('[data-regression-export]').addEventListener('click', () => {
    try {
      const fixture = readRegressionForm();
      const safeName = fixture.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'case';
      downloadJson(fixture, 'manasearch-regression-' + safeName + '.json');
      status.textContent = 'Regression case download requested';
    } catch (error) { content.textContent = JSON.stringify({ error: error.message }, null, 2); }
  });
  panel.querySelector('[data-regression-copy]').addEventListener('click', async () => {
    try {
      const fixture = readRegressionForm();
      const data = JSON.stringify(fixture, null, 2);
      try {
        await navigator.clipboard.writeText(data);
        status.textContent = 'Regression case JSON copied';
      } catch (_) {
        content.textContent = data;
        status.textContent = 'Clipboard unavailable — select the case JSON below and copy it manually';
      }
    } catch (error) { content.textContent = JSON.stringify({ error: error.message || String(error) }, null, 2); }
  });
  panel.querySelector('[data-regression-compare]').addEventListener('click', () => {
    try {
      const fixture = readRegressionForm();
      const run = selectedRegressionRun(regressionCompareRun);
      const report = compareRegressionCase(fixture, run);
      content.textContent = JSON.stringify(report, null, 2);
      status.textContent = report.pass ? 'Regression case passed' : report.comparable ? 'Regression case failed' : 'Inputs differ — comparison is not valid yet';
    } catch (error) { content.textContent = JSON.stringify({ error: error.message }, null, 2); }
  });
  panel.querySelector('[data-regression-import]').addEventListener('click', () => regressionFile.click());
  regressionFile.addEventListener('change', async () => {
    const file = regressionFile.files?.[0];
    if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('Case file is larger than 8 MB. Export a smaller diagnostics capture.');
      const imported = validateRegressionCase(JSON.parse(await file.text()));
      activeRegressionCase = imported;
      fillRegressionForm(imported);
      content.textContent = JSON.stringify({ message: 'Regression case imported. Repeat the search normally, select the new run under Compare against, and compare.', title: imported.title, sourceRunNumber: imported.source.runNumber, expectedTopCandidates: imported.expectations.expectedTopCandidates.length }, null, 2);
      status.textContent = 'Regression case imported';
    } catch (error) {
      content.textContent = JSON.stringify({ importError: error.message || String(error) }, null, 2);
      status.textContent = 'Could not import regression case';
    } finally { regressionFile.value = ''; }
  });
  panel.querySelector('[data-action="refresh"]').addEventListener('click', render);
  panel.querySelector('[data-action="copy"]').addEventListener('click', async () => {
    const data = JSON.stringify(buildExport(), null, 2);
    try {
      await navigator.clipboard.writeText(data);
      status.textContent = 'Snapshot copied';
    } catch (_) {
      content.textContent = data;
      status.textContent = 'Clipboard unavailable — select the JSON above';
    }
  });
  panel.querySelector('[data-action="download"]').addEventListener('click', () => {
    const data = JSON.stringify(buildExport(), null, 2);
    const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `manasearch-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Diagnostic JSON download requested';
  });

  // Observe the real worker messages without replacing its handlers or changing payloads.
  if (window.Worker) {
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args, NewTarget) {
        const worker = Reflect.construct(Target, args, NewTarget === window.Worker ? Target : NewTarget);
        const label = String(args[0] || 'worker');
        const record = (direction, data) => {
          let serialized;
          try { serialized = JSON.stringify(data); }
          catch (error) { serialized = `[unserializable worker message: ${error?.message || String(error)}]`; }
          const entry = { time: new Date().toISOString(), worker: label, direction, data: clip(serialized, 5000) };
          state.workerMessages.unshift(entry);
          state.workerMessages.length = Math.min(state.workerMessages.length, MAX_WORKER_MESSAGES);
          addEvent('worker:' + direction, { worker: label, messageType: data?.type || data?.action || typeof data });
          renderWorker();
        };
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = (message, transfer) => {
          record('request', message);
          return transfer === undefined ? nativePostMessage(message) : nativePostMessage(message, transfer);
        };
        worker.addEventListener('message', event => record('response', event.data));
        worker.addEventListener('error', event => addEvent('worker:error', { worker: label, message: event.message || 'Worker error' }));
        return worker;
      }
    });
  }

  window.addEventListener('manasearch:search-started', event => {
    const detail = event.detail || {};
    state.activeSearch = {
      requestId: detail.requestId ?? null,
      sourceName: detail.sourceName || '',
      status: 'running',
      startedAt: detail.startedAt || new Date().toISOString(),
      progress: null,
      streams: [],
      completedStreams: 0,
      totalStreams: 0,
      preview: null,
      previewHistory: [],
      errorMessage: ''
    };
    addEvent('search:production-started', {
      requestId: state.activeSearch.requestId,
      sourceName: state.activeSearch.sourceName,
      highlightCount: detail.highlightCount ?? null
    });
    renderLiveProgress();
  });
  window.addEventListener('manasearch:progress-updated', event => {
    const detail = event.detail || {};
    if (!activeRequestMatches(detail)) return;
    const progress = {
      step: detail.step ?? null,
      total: detail.total ?? null,
      message: String(detail.message || ''),
      at: detail.at || Date.now()
    };
    const previous = state.activeSearch.progress;
    if (previous && previous.step === progress.step && previous.total === progress.total && previous.message === progress.message) return;
    state.activeSearch.progress = progress;
    addEvent('search:progress', { requestId: state.activeSearch.requestId, ...progress });
    renderLiveProgress();
  });
  window.addEventListener('manasearch:search-streams-updated', event => {
    const detail = event.detail || {};
    if (!activeRequestMatches(detail)) return;
    state.activeSearch.streams = cloneJson(detail.streams || []);
    state.activeSearch.completedStreams = Number(detail.completedStreams) || 0;
    state.activeSearch.failedStreams = Number(detail.failedStreams) || 0;
    state.activeSearch.settledStreams = Number(detail.settledStreams) || (state.activeSearch.completedStreams + state.activeSearch.failedStreams);
    state.activeSearch.totalStreams = Number(detail.totalStreams) || state.activeSearch.streams.length;
    const streamKey = state.activeSearch.streams.map(stream => String(stream.label) + ':' + Boolean(stream.done) + ':' + String(stream.status || '') + ':' + Boolean(stream.failed) + ':' + String(stream.detail)).join('|');
    if (state.activeSearch.lastStreamKey === streamKey) return;
    state.activeSearch.lastStreamKey = streamKey;
    addEvent('search:streams', {
      requestId: state.activeSearch.requestId,
      completedStreams: state.activeSearch.completedStreams,
      totalStreams: state.activeSearch.totalStreams,
      streams: state.activeSearch.streams.map(stream => ({ label: stream.label, done: stream.done, detail: clip(stream.detail, 180) }))
    });
    renderLiveProgress();
  });
  window.addEventListener('manasearch:search-preview-updated', event => {
    const detail = event.detail || {};
    if (!activeRequestMatches(detail)) return;
    const preview = {
      phase: detail.phase || 'preview',
      sourceLabel: detail.sourceLabel || '',
      provisional: detail.provisional !== false,
      resultCount: Number(detail.resultCount) || 0,
      topNames: (detail.topNames || []).slice(0, 10),
      at: detail.at || Date.now()
    };
    state.activeSearch.preview = preview;
    state.activeSearch.previewHistory.push(preview);
    state.activeSearch.previewHistory = state.activeSearch.previewHistory.slice(-16);
    addEvent('search:preview', {
      requestId: state.activeSearch.requestId,
      phase: preview.phase,
      sourceLabel: preview.sourceLabel,
      resultCount: preview.resultCount,
      topNames: preview.topNames.slice(0, 5)
    });
    renderLiveProgress();
  });
  window.addEventListener('manasearch:search-finished', event => {
    const detail = event.detail || {};
    if (state.activeSearch && detail.requestId != null && Number(detail.requestId) !== Number(state.activeSearch.requestId)) return;
    const runStatus = detail.status || 'completed';
    if (state.activeSearch) {
      state.activeSearch.status = runStatus;
      state.activeSearch.finishedAt = detail.finishedAt || new Date().toISOString();
      state.activeSearch.durationMs = detail.durationMs ?? null;
      state.activeSearch.errorMessage = detail.errorMessage || '';
      state.activeSearch.resultCount = detail.resultCount ?? 0;
      state.activeSearch.provisionalResultCount = detail.provisionalResultCount ?? 0;
    }
    lastPipelineSnapshot = getPipelineSnapshot();
    const pipeline = cloneJson(lastPipelineSnapshot);
    const ui = cloneJson(snapshot());
    const sourceName = detail.sourceName || pipeline?.request?.sourceCard?.name || ui?.source?.name || '';
    const resultCount = detail.resultCount ?? pipeline?.finalResults?.length ?? 0;
    const run = {
      number: state.searchRuns.length ? state.searchRuns[state.searchRuns.length - 1].number + 1 : 1,
      completedAt: detail.finishedAt || new Date().toISOString(),
      status: runStatus,
      errorMessage: detail.errorMessage || '',
      durationMs: detail.durationMs ?? null,
      summary: {
        sourceName,
        resultCount,
        provisionalResultCount: detail.provisionalResultCount ?? 0,
        status: runStatus,
        errorMessage: detail.errorMessage || '',
        durationMs: detail.durationMs ?? null
      },
      liveSearch: cloneJson(state.activeSearch),
      ui,
      pipeline
    };
    state.searchRuns.push(run);
    if (state.searchRuns.length > MAX_SEARCH_RUNS) state.searchRuns.shift();
    addEvent('search:finished', {
      runNumber: run.number,
      status: run.status,
      errorMessage: run.errorMessage,
      durationMs: run.durationMs,
      sourceName: run.summary.sourceName,
      resultCount: run.summary.resultCount,
      retrieved: pipeline?.funnel?.retrieved ?? null,
      scored: pipeline?.funnel?.scored ?? null,
      finalResults: pipeline?.funnel?.finalResults ?? null
    });
    if (!windowEl.hidden) render();
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('#find-similar-btn, #quick-start-search');
    if (button) {
      state.searchCount++;
      addEvent('search:start', { source: readSource(), intent: visibleText('#search-intent-body'), methods: visibleText('#selected-methods-badge'), order: valueOf('#sort-results'), constraints: readConstraints() });
      if (!windowEl.hidden) render();
    }
  }, true);
  document.addEventListener('change', event => {
    const el = event.target;
    if (el.matches('[data-constraint-mode], #sort-results, #source-card-picker-input')) {
      addEvent('configuration:change', { control: el.id || el.dataset.constraintMode || el.name, value: el.type === 'checkbox' ? el.checked : el.value });
      if (!windowEl.hidden) render();
    }
  }, true);
  const observer = new MutationObserver(records => {
    // Ignore our own panel updates to avoid a self-triggering observer loop.
    if (records.some(record => !panel.contains(record.target)) && !windowEl.hidden && activeTab === 'live') render();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-busy'] });
  // Read-only console hooks make exported runs and the comparison routine independently testable.
  window.ManaSearchInspector = Object.freeze({
    getRunHistory: () => cloneJson(state.searchRuns),
    getActiveSearch: () => cloneJson(state.activeSearch),
    getExport: () => cloneJson(buildExport()),
    compareRuns,
    formatCompareSummary,
    formatLiveSummary,
    traceCandidate,
    createRegressionCase,
    validateRegressionCase,
    compareRegressionCase
  });
  addEvent('inspector:ready', { note: 'Diagnostics are read-only; ranking and retrieval are not modified.' });
})();
