/* Approximate AI processing spend for the local Synap pipeline.
 *
 * Rates are intentionally transparent and conservative, not a billing ledger.
 * Snapshot: 2026-09-09.
 * - Gemini 3.5 Transcribe official blended estimate: USD 0.005/min.
 * - Gemini 3.5 Flash-Lite: USD 0.30/M input, USD 2.50/M output.
 * - Transcribe documentation estimates ~175 output text tokens/min; memory build
 *   reuses that transcript as input. We reserve ~35 output tokens/min for the
 *   structured memory, which slightly overstates many ordinary conversations.
 * - FX snapshot: USD 1 = INR 94.85.
 *
 * Ask Synap, Cloud Run, storage/network, taxes and free-tier credits are excluded.
 */
(function (root) {
  'use strict';

  const DB = 'dk-pendant-recordings';
  const USD_INR = 94.85;
  const TRANSCRIBE_USD_PER_MIN = 0.005;
  const MEMORY_INPUT_TOKENS_PER_MIN = 175;
  const MEMORY_OUTPUT_TOKENS_PER_MIN = 35;
  const MEMORY_INPUT_USD_PER_M = 0.30;
  const MEMORY_OUTPUT_USD_PER_M = 2.50;
  const STYLE_ID = 'synap-cost-ui-style';

  function minutes(recording) {
    return Math.max(0, Number(recording?.durationMs) || 0) / 60000;
  }

  function stage(recording) {
    return String(recording?.processingStage || '').toLowerCase();
  }

  function transcriptionCharged(recording) {
    const s = stage(recording);
    return Boolean(String(recording?.transcript || '').trim()) ||
      ['transcribing', 'understanding', 'indexing', 'ready'].includes(s) ||
      recording?.processingState === 'done';
  }

  function memoryCharged(recording) {
    const s = stage(recording);
    return Boolean(String(recording?.summary || '').trim()) ||
      ['understanding', 'indexing', 'ready'].includes(s) ||
      recording?.processingState === 'done';
  }

  function estimate(recording) {
    const mins = minutes(recording);
    const transcribe = transcriptionCharged(recording)
      ? mins * TRANSCRIBE_USD_PER_MIN * USD_INR
      : 0;
    const memoryUsdPerMin =
      MEMORY_INPUT_TOKENS_PER_MIN * MEMORY_INPUT_USD_PER_M / 1000000 +
      MEMORY_OUTPUT_TOKENS_PER_MIN * MEMORY_OUTPUT_USD_PER_M / 1000000;
    const memory = memoryCharged(recording) ? mins * memoryUsdPerMin * USD_INR : 0;
    return {
      minutes: mins,
      transcribeInr: transcribe,
      memoryInr: memory,
      totalInr: transcribe + memory,
      projectedTotalInr: mins * (TRANSCRIBE_USD_PER_MIN + memoryUsdPerMin) * USD_INR
    };
  }

  function money(value) {
    const amount = Math.max(0, Number(value) || 0);
    if (amount < 0.01) return '₹0.00';
    if (amount < 10) return '₹' + amount.toFixed(2);
    return '₹' + amount.toFixed(1);
  }

  function setText(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }

  function localDay(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }

  function injectStyle() {
    if (root.document?.getElementById(STYLE_ID)) return;
    const style = root.document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.recording-cost-estimate{display:block;margin-top:4px;color:var(--muted);font-size:8px;line-height:1.35}' +
      '.today-cost-estimate{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px;padding-top:9px;border-top:1px solid rgba(255,255,255,.12);font-size:8px;color:#b9c8d9}' +
      '.today-cost-estimate strong{font-size:10px;color:#fff;font-variant-numeric:tabular-nums}' +
      '@media(min-width:600px){.recording-cost-estimate,.today-cost-estimate{font-size:10px}.today-cost-estimate strong{font-size:12px}}';
    root.document.head?.appendChild(style);
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const request = root.indexedDB.open(DB);
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function recordings() {
    const db = await openDb();
    try {
      return await new Promise(function (resolve, reject) {
        const request = db.transaction('recordings').objectStore('recordings').getAll();
        request.onsuccess = function () { resolve(request.result || []); };
        request.onerror = function () { reject(request.error); };
      });
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  function recordingId(card) {
    const explicit = card?.dataset?.recordingId;
    if (explicit) return explicit;
    const id = String(card?.id || '');
    return id.startsWith('recording-') ? id.slice('recording-'.length) : '';
  }

  function decorateLibrary(items) {
    const byId = new Map((items || []).map(function (item) { return [String(item.id), item]; }));
    root.document?.querySelectorAll?.('#recordingsList .recording-card').forEach(function (card) {
      const recording = byId.get(recordingId(card));
      if (!recording) return;
      const head = card.querySelector('.recording-processing-head');
      if (!head) return;
      let label = head.querySelector('.recording-cost-estimate');
      if (!label) {
        label = root.document.createElement('small');
        label.className = 'recording-cost-estimate';
        head.appendChild(label);
      }
      const value = estimate(recording);
      if (value.totalInr > 0) {
        setText(label, 'Approx. AI spend ' + money(value.totalInr) + ' · ' + value.minutes.toFixed(1) + ' min');
        label.title = 'Estimated transcription + memory-build model cost. Ask Synap, cloud infrastructure, taxes and credits are excluded.';
      } else {
        setText(label, 'Projected processing ' + money(value.projectedTotalInr) + ' · ' + value.minutes.toFixed(1) + ' min');
        label.title = 'Projected transcription + memory-build model cost once processing runs.';
      }
    });
  }

  function decorateToday(items) {
    const panel = root.document?.getElementById('todayMemoryPipeline');
    if (!panel) return;
    const selected = root.document.getElementById('datePicker')?.value || localDay(new Date());
    const sameDay = (items || []).filter(function (item) { return localDay(item.createdAt) === selected; });
    const values = sameDay.map(estimate);
    const total = values.reduce(function (sum, item) { return sum + item.totalInr; }, 0);
    const processedMinutes = values.reduce(function (sum, item) {
      return sum + (item.totalInr > 0 ? item.minutes : 0);
    }, 0);
    let row = panel.querySelector('.today-cost-estimate');
    if (!row) {
      row = root.document.createElement('div');
      row.className = 'today-cost-estimate';
      const label = root.document.createElement('span');
      label.textContent = 'Approx. AI spend';
      const amount = root.document.createElement('strong');
      row.append(label, amount);
      panel.appendChild(row);
    }
    const amount = row.querySelector('strong');
    setText(amount, money(total));
    row.title = processedMinutes.toFixed(1) + ' processed min · transcription + memory build only';
  }

  let refreshTimer = 0;
  let refreshing = false;
  function schedule(delay) {
    root.clearTimeout(refreshTimer);
    refreshTimer = root.setTimeout(refresh, Number.isFinite(delay) ? delay : 80);
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      injectStyle();
      const items = await recordings().catch(function () { return []; });
      decorateLibrary(items);
      decorateToday(items);
    } finally {
      refreshing = false;
    }
  }

  function init() {
    injectStyle();
    const targets = [root.document?.getElementById('recordingsList'), root.document?.getElementById('today')].filter(Boolean);
    if (root.MutationObserver) targets.forEach(function (target) {
      new MutationObserver(function () { schedule(40); }).observe(target, { childList: true, subtree: true, characterData: true });
    });
    root.document?.getElementById('datePicker')?.addEventListener('change', function () { schedule(20); });
    root.document?.addEventListener('visibilitychange', function () {
      if (root.document.visibilityState === 'visible') schedule(20);
    });
    schedule(250);
  }

  if (root.document?.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  root.SynapCostUI = Object.freeze({
    USD_INR,
    TRANSCRIBE_USD_PER_MIN,
    MEMORY_INPUT_TOKENS_PER_MIN,
    MEMORY_OUTPUT_TOKENS_PER_MIN,
    estimate,
    money
  });
})(globalThis);
