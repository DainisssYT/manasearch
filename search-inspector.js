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
      explanation: visibleText('#search-intent-body')
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
  panel.innerHTML = '<button type="button" class="ms-inspector-launch" aria-expanded="false">Developer inspector</button><section class="ms-inspector-window" hidden aria-label="ManaSearch developer inspector"><header><div><strong>Search inspector</strong><small>Passive view of the live production search</small></div><button type="button" class="ms-inspector-close" aria-label="Close inspector">×</button></header><nav><button type="button" data-tab="live" class="is-active">Live state</button><button type="button" data-tab="timeline">Timeline</button><button type="button" data-tab="worker">Worker</button></nav><div class="ms-inspector-toolbar"><span class="ms-inspector-state">Waiting for search activity</span><button type="button" data-action="refresh">Refresh</button><button type="button" data-action="copy">Copy JSON</button></div><pre class="ms-inspector-content" aria-live="polite"></pre></section>';
  document.body.append(panel);
  const launch = panel.querySelector('.ms-inspector-launch');
  const windowEl = panel.querySelector('.ms-inspector-window');
  const content = panel.querySelector('.ms-inspector-content');
  const status = panel.querySelector('.ms-inspector-state');
  let activeTab = 'live';
  const renderTimeline = () => { if (activeTab === 'timeline' && !windowEl.hidden) content.textContent = JSON.stringify(state.events, null, 2); };
  const renderWorker = () => { if (activeTab === 'worker' && !windowEl.hidden) content.textContent = JSON.stringify(state.workerMessages, null, 2); };
  const render = () => {
    status.textContent = state.searchCount ? state.searchCount + ' search action(s) observed' : 'Waiting for search activity';
    if (activeTab === 'live') {
      state.lastSnapshot = snapshot();
      content.textContent = JSON.stringify(state.lastSnapshot, null, 2);
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
    const data = JSON.stringify(snapshot(), null, 2);
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
