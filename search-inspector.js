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
    results: readResults(),
    recentWorkerMessages: state.workerMessages.slice(0, 30)
  });
  const panel = document.createElement('aside');
  panel.id = 'mana-search-inspector';
  panel.className = 'ms-inspector';
  panel.innerHTML = '<button type="button" class="ms-inspector-launch" aria-expanded="false">Developer inspector</button><section class="ms-inspector-window" hidden aria-label="ManaSearch developer inspector"><header><div><strong>Search inspector</strong><small>Passive view of the live production search</small></div><button type="button" class="ms-inspector-close" aria-label="Close inspector">×</button></header><nav><button type="button" data-tab="live" class="is-active">Live state</button><button type="button" data-tab="pipeline">Pipeline</button><button type="button" data-tab="candidates">Candidates</button><button type="button" data-tab="trace">Trace card</button><button type="button" data-tab="exclusions">Exclusions</button><button type="button" data-tab="compare">Compare runs</button><button type="button" data-tab="timeline">Timeline</button><button type="button" data-tab="worker">Worker</button></nav><div class="ms-inspector-toolbar"><span class="ms-inspector-state">Waiting for search activity</span><button type="button" data-action="refresh">Refresh</button><button type="button" data-action="copy">Copy JSON</button><button type="button" data-action="download">Download JSON</button></div><div class="ms-inspector-compare-controls" hidden><label>Earlier run <select data-run-side="a"></select></label><label>Later run <select data-run-side="b"></select></label></div><div class="ms-inspector-trace-controls" hidden><label>Candidate <select data-trace-candidate></select></label></div><pre class="ms-inspector-content" aria-live="polite"></pre></section>';
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
  let activeTab = 'live';
  let lastPipelineSnapshot = null;
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
    return `#${run?.number ?? '?'} ${source} — ${resultCount} results — ${new Date(run?.completedAt || 0).toLocaleTimeString()}`;
  };
  const compareRuns = (earlier, later) => {
    if (!earlier || !later) return { message: 'Select two completed searches to compare. At least two searches are required.' };
    const a = earlier.pipeline || {};
    const b = later.pipeline || {};
    const aFinal = a.finalResults || [];
    const bFinal = b.finalResults || [];
    const aRanks = new Map(aFinal.map(item => [String(item.name || '').toLowerCase(), item.rank]));
    const bRanks = new Map(bFinal.map(item => [String(item.name || '').toLowerCase(), item.rank]));
    const aNames = new Map(aFinal.map(item => [String(item.name || '').toLowerCase(), item.name || '']));
    const bNames = new Map(bFinal.map(item => [String(item.name || '').toLowerCase(), item.name || '']));
    const common = [...aRanks.keys()].filter(name => bRanks.has(name));
    const added = [...bRanks.keys()].filter(name => !aRanks.has(name)).map(name => bNames.get(name) || name);
    const removed = [...aRanks.keys()].filter(name => !bRanks.has(name)).map(name => aNames.get(name) || name);
    const moved = common.map(name => ({
      name: bFinal.find(item => String(item.name || '').toLowerCase() === name)?.name || name,
      earlierRank: aRanks.get(name),
      laterRank: bRanks.get(name),
      movement: aRanks.get(name) - bRanks.get(name)
    })).filter(item => item.movement !== 0).sort((x, y) => Math.abs(y.movement) - Math.abs(x.movement)).slice(0, 40);
    const aCandidates = new Map((a.candidates || []).map(item => [String(item.name || '').toLowerCase(), item]));
    const bCandidates = new Map((b.candidates || []).map(item => [String(item.name || '').toLowerCase(), item]));
    const scoreChanges = [...aCandidates.keys()].filter(name => bCandidates.has(name)).map(name => {
      const left = aCandidates.get(name);
      const right = bCandidates.get(name);
      const before = Number(left?.scores?.similarityScore);
      const after = Number(right?.scores?.similarityScore);
      return {
        name: right?.name || left?.name || name,
        earlierScore: Number.isFinite(before) ? before : null,
        laterScore: Number.isFinite(after) ? after : null,
        delta: Number.isFinite(before) && Number.isFinite(after) ? after - before : null
      };
    }).filter(item => item.delta !== null && Math.abs(item.delta) > 0.000001)
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 40);
    const streamNames = new Set([...Object.keys(a.streams || {}), ...Object.keys(b.streams || {})]);
    const streamComparison = [...streamNames].map(name => {
      const left = new Set(a.streams?.[name] || []);
      const right = new Set(b.streams?.[name] || []);
      const intersection = [...left].filter(value => right.has(value)).length;
      const union = new Set([...left, ...right]).size;
      return { stream: name, earlierCount: left.size, laterCount: right.size, sharedCount: intersection, jaccard: union ? Number((intersection / union).toFixed(4)) : 1 };
    });
    return {
      earlier: { number: earlier.number, completedAt: earlier.completedAt, request: a.request },
      later: { number: later.number, completedAt: later.completedAt, request: b.request },
      changes: {
        sourceCardChanged: JSON.stringify(a.request?.sourceCard || {}) !== JSON.stringify(b.request?.sourceCard || {}),
        highlightsChanged: JSON.stringify(a.request?.highlights || []) !== JSON.stringify(b.request?.highlights || []),
        intentChanged: JSON.stringify(a.request?.intent || {}) !== JSON.stringify(b.request?.intent || {}),
        constraintsChanged: JSON.stringify(a.request?.constraints || {}) !== JSON.stringify(b.request?.constraints || {}),
        methodsChanged: JSON.stringify(a.request?.methods || {}) !== JSON.stringify(b.request?.methods || {}),
        orderingChanged: (a.request?.ordering || '') !== (b.request?.ordering || '')
      },
      retrieval: streamComparison,
      finalRanking: {
        earlierCount: aFinal.length,
        laterCount: bFinal.length,
        sharedCount: common.length,
        addedInLater: added.slice(0, 50),
        missingFromLater: removed.slice(0, 50),
        rankChanges: moved
      },
      sharedCandidateScoreChanges: scoreChanges,
      interpretation: 'Rank movement can result from changed inputs, candidate-pool membership, score changes, relevance pruning, or the selected ordering mode. Compare the request, stream overlap, score deltas, and rank changes together.'
    };
  };
  const normalizeCandidateName = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
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
        scores: candidate.scores || {},
        rankingEvidence: candidate.rankingEvidence || null,
        parse: candidate.parse || candidate.parseDiagnostics || null,
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
    content.textContent = JSON.stringify(compareRuns(a, b), null, 2);
  };
  const renderTimeline = () => { if (activeTab === 'timeline' && !windowEl.hidden) content.textContent = JSON.stringify(state.events, null, 2); };
  const renderWorker = () => { if (activeTab === 'worker' && !windowEl.hidden) content.textContent = JSON.stringify(state.workerMessages, null, 2); };
  const render = () => {
    status.textContent = state.searchRuns.length
      ? `${state.searchRuns.length} completed search run(s) retained in this session`
      : state.searchCount ? `${state.searchCount} search action(s) observed` : 'Waiting for search activity';
    if (activeTab === 'live') {
      state.lastSnapshot = snapshot();
      content.textContent = JSON.stringify(state.lastSnapshot, null, 2);
      compareControls.hidden = true;
    } else if (activeTab === 'pipeline') {
      const p = getPipelineSnapshot();
      content.textContent = JSON.stringify(p ? { request: p.request, funnel: p.funnel ? Object.fromEntries(Object.entries(p.funnel).filter(([key]) => key !== 'stages')) : null, retrievalStreams: Object.fromEntries(Object.entries(p.streams || {}).map(([name, cards]) => [name, { count: cards.length, examples: cards.slice(0, 12) }])), streamCoverage: p.streamCoverage, functionalQueryResults: p.functionalQueryResults, exactHighlightQueryResults: p.exactHighlightQueryResults, scoring: p.scoring, benchmarkSignals: p.benchmarkSignals, highlightIntentDiagnostics: p.highlightIntentDiagnostics } : { message: 'No completed production search snapshot yet. Run Find Similar Cards, then refresh.' }, null, 2);
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

  window.addEventListener('manasearch:search-finished', event => {
    const detail = event.detail || {};
    lastPipelineSnapshot = getPipelineSnapshot();
    const pipeline = cloneJson(lastPipelineSnapshot);
    const ui = cloneJson(snapshot());
    const run = {
      number: state.searchRuns.length ? state.searchRuns[state.searchRuns.length - 1].number + 1 : 1,
      completedAt: new Date().toISOString(),
      summary: {
        sourceName: detail.sourceName || pipeline?.request?.sourceCard?.name || ui?.source?.name || '',
        resultCount: detail.resultCount ?? pipeline?.finalResults?.length ?? 0
      },
      ui,
      pipeline
    };
    state.searchRuns.push(run);
    if (state.searchRuns.length > MAX_SEARCH_RUNS) state.searchRuns.shift();
    addEvent('search:finished', {
      runNumber: run.number,
      sourceName: run.summary.sourceName,
      resultCount: run.summary.resultCount,
      retrieved: pipeline?.funnel?.retrieved ?? null,
      scored: pipeline?.funnel?.scored ?? null,
      finalResults: pipeline?.funnel?.finalResults ?? null
    });
    if (!windowEl.hidden) render();
  });
  window.addEventListener('manasearch:search-started', event => addEvent('search:production-started', event.detail || {}));
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
    getExport: () => cloneJson(buildExport()),
    compareRuns,
    traceCandidate
  });
  addEvent('inspector:ready', { note: 'Diagnostics are read-only; ranking and retrieval are not modified.' });
})();
