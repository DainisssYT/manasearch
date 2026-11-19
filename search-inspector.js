/* ManaSearch developer diagnostics. Passive observer: never changes search inputs, ranking, or results. */
(() => {
  'use strict';
  if (window.__manaSearchInspectorInstalled) return;
  window.__manaSearchInspectorInstalled = true;

  const state = { startedAt: new Date().toISOString(), events: [], workerMessages: [], lastSnapshot: null, searchCount: 0 };
  const MAX_EVENTS = 120;
  const MAX_WORKER_MESSAGES = 80;
  const clip = (value, max = 1200) => String(value ?? '').trim().slice(0, max);
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
  panel.innerHTML = '<button type="button" class="ms-inspector-launch" aria-expanded="false">Developer inspector</button><section class="ms-inspector-window" hidden aria-label="ManaSearch developer inspector"><header><div><strong>Search inspector</strong><small>Passive view of the live production search</small></div><button type="button" class="ms-inspector-close" aria-label="Close inspector">×</button></header><nav><button type="button" data-tab="live" class="is-active">Live state</button><button type="button" data-tab="pipeline">Pipeline</button><button type="button" data-tab="candidates">Candidates</button><button type="button" data-tab="exclusions">Exclusions</button><button type="button" data-tab="timeline">Timeline</button><button type="button" data-tab="worker">Worker</button></nav><div class="ms-inspector-toolbar"><span class="ms-inspector-state">Waiting for search activity</span><button type="button" data-action="refresh">Refresh</button><button type="button" data-action="copy">Copy JSON</button></div><pre class="ms-inspector-content" aria-live="polite"></pre></section>';
  document.body.append(panel);
  const launch = panel.querySelector('.ms-inspector-launch');
  const windowEl = panel.querySelector('.ms-inspector-window');
  const content = panel.querySelector('.ms-inspector-content');
  const status = panel.querySelector('.ms-inspector-state');
  let activeTab = 'live';
  let lastPipelineSnapshot = null;
  const getPipelineSnapshot = () => {
    try { if (window.ManaSearchDebug?.getSnapshot) lastPipelineSnapshot = window.ManaSearchDebug.getSnapshot(); }
    catch (error) { addEvent('diagnostics:error', { message: error?.message || String(error) }); }
    return lastPipelineSnapshot;
  };
  const buildExport = () => ({ exportedAt: new Date().toISOString(), ui: snapshot(), productionPipeline: getPipelineSnapshot(), timeline: state.events, workerMessages: state.workerMessages });
  const stageLosses = pipeline => {
    const stages = pipeline?.funnel?.stages;
    if (!stages) return [];
    const order = ['retrieved','passedFilters','deduplicated','scored','passedRelevanceFloor','finalRanked'];
    const labels = { retrieved: 'Raw retrieval', passedFilters: 'Hard constraints / exact highlights', deduplicated: 'Name deduplication', scored: 'Scoring', passedRelevanceFloor: 'Relevance floor', finalRanked: 'Final ranking' };
    return order.slice(1).map((stage, index) => {
      const previous = new Set(stages[order[index]] || []);
      const current = new Set(stages[stage] || []);
      const removed = [...previous].filter(name => !current.has(name));
      return { from: labels[order[index]], to: labels[stage], removedCount: removed.length, removedExamples: removed.slice(0, 40) };
    });
  };
  const renderTimeline = () => { if (activeTab === 'timeline' && !windowEl.hidden) content.textContent = JSON.stringify(state.events, null, 2); };
  const renderWorker = () => { if (activeTab === 'worker' && !windowEl.hidden) content.textContent = JSON.stringify(state.workerMessages, null, 2); };
  const render = () => {
    status.textContent = state.searchCount ? state.searchCount + ' search action(s) observed' : 'Waiting for search activity';
    if (activeTab === 'live') {
      state.lastSnapshot = snapshot();
      content.textContent = JSON.stringify(state.lastSnapshot, null, 2);
    } else if (activeTab === 'pipeline') {
      const p = getPipelineSnapshot();
      content.textContent = JSON.stringify(p ? { request: p.request, funnel: p.funnel ? Object.fromEntries(Object.entries(p.funnel).filter(([key]) => key !== 'stages')) : null, retrievalStreams: Object.fromEntries(Object.entries(p.streams || {}).map(([name, cards]) => [name, { count: cards.length, examples: cards.slice(0, 12) }])), streamCoverage: p.streamCoverage, functionalQueryResults: p.functionalQueryResults, exactHighlightQueryResults: p.exactHighlightQueryResults, scoring: p.scoring, benchmarkSignals: p.benchmarkSignals, highlightIntentDiagnostics: p.highlightIntentDiagnostics } : { message: 'No completed production search snapshot yet. Run Find Similar Cards, then refresh.' }, null, 2);
    } else if (activeTab === 'candidates') {
      const p = getPipelineSnapshot();
      content.textContent = JSON.stringify(p ? { explanation: 'Actual candidates scored by ManaSearch, including candidates later removed by the relevance floor. Scores are normalized 0–1 unless noted.', candidates: p.candidates, finalResults: p.finalResults, rankingEvidenceTop: p.rankingEvidenceTop } : { message: 'No scored candidates yet.' }, null, 2);
    } else if (activeTab === 'exclusions') {
      const p = getPipelineSnapshot();
      content.textContent = JSON.stringify(p ? { explanation: 'Compare stage membership to find where a candidate disappeared. Hard-filter rejection reasons are recorded separately.', stageLosses: stageLosses(p), hardFilterRejections: p.filterRejections, stageMembership: p.funnel?.stages } : { message: 'No exclusion diagnostics yet.' }, null, 2);
    } else if (activeTab === 'timeline') renderTimeline();
    else renderWorker();
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

  // Observe the real worker messages without replacing its handlers or changing payloads.
  if (window.Worker) {
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args, NewTarget) {
        const worker = Reflect.construct(Target, args, NewTarget === window.Worker ? Target : NewTarget);
        const label = String(args[0] || 'worker');
        const record = (direction, data) => {
          const entry = { time: new Date().toISOString(), worker: label, direction, data: clip(JSON.stringify(data), 5000) };
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
    addEvent('search:finished', { sourceName: detail.sourceName || '', resultCount: detail.resultCount ?? null, retrieved: lastPipelineSnapshot?.funnel?.retrieved ?? null, scored: lastPipelineSnapshot?.funnel?.scored ?? null, finalResults: lastPipelineSnapshot?.funnel?.finalResults ?? null });
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
  addEvent('inspector:ready', { note: 'Diagnostics are read-only; ranking and retrieval are not modified.' });
})();
