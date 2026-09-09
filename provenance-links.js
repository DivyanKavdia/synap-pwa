/* Synap provenance links: one recording, one evidence chain.
 *
 * The structured memory already carries recording-relative start_ms/end_ms and
 * the transcript already carries grounded timestamps. This module keeps those
 * two layers visibly connected without changing the source audio or memory.
 */
(function (root) {
  'use strict';

  const DB = 'dk-pendant-recordings';
  const STYLE_ID = 'synap-provenance-style';
  let records = [];
  let refreshing = false;

  const $ = (selector, host = document) => host.querySelector(selector);
  const $$ = (selector, host = document) => [...host.querySelectorAll(selector)];

  function localDay(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }

  function clock(recording, offsetMs = 0) {
    const base = new Date(recording?.createdAt || recording?.startedAt || 0).getTime();
    if (!Number.isFinite(base)) return '';
    return new Date(base + Math.max(0, Number(offsetMs) || 0)).toLocaleTimeString([], {
      hour: 'numeric', minute: '2-digit'
    });
  }

  function meeting(recording) {
    return recording?.meeting || {};
  }

  function conversations(recording) {
    const m = meeting(recording);
    const list = Array.isArray(m.conversations) && m.conversations.length ? m.conversations : recording?.conversations;
    return Array.isArray(list) ? list : [];
  }

  function textOf(value) {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value.text === 'string') return value.text.trim();
    return '';
  }

  function sourceStart(value, fallback) {
    const raw = value?.start_ms ?? value?.start_seconds;
    if (raw != null && Number.isFinite(Number(raw))) {
      return value?.start_ms != null ? Number(raw) : Number(raw) * 1000;
    }
    const fallbackRaw = fallback?.start_ms ?? fallback?.start_seconds;
    if (fallbackRaw != null && Number.isFinite(Number(fallbackRaw))) {
      return fallback?.start_ms != null ? Number(fallbackRaw) : Number(fallbackRaw) * 1000;
    }
    return 0;
  }

  function sourceEnd(value, fallback) {
    const raw = value?.end_ms ?? value?.end_seconds;
    if (raw != null && Number.isFinite(Number(raw))) {
      return value?.end_ms != null ? Number(raw) : Number(raw) * 1000;
    }
    const fallbackRaw = fallback?.end_ms ?? fallback?.end_seconds;
    if (fallbackRaw != null && Number.isFinite(Number(fallbackRaw))) {
      return fallback?.end_ms != null ? Number(fallbackRaw) : Number(fallbackRaw) * 1000;
    }
    return sourceStart(value, fallback);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function loadRecords() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('recordings').objectStore('recordings').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .synap-provenance-summary{display:grid;gap:10px}.synap-provenance-summary>p{margin:0;white-space:pre-wrap}
      .synap-source-list{display:grid;gap:8px}.synap-source-link{width:100%;display:grid;grid-template-columns:68px minmax(0,1fr);gap:9px;text-align:left;border:1px solid var(--border,#d9e2ec);border-radius:12px;background:var(--surface,#fff);padding:9px 10px;color:inherit;cursor:pointer;font:inherit}
      .synap-source-link time{font-size:11px;font-weight:800;color:var(--muted,#64748b);font-variant-numeric:tabular-nums}.synap-source-link strong{display:block;font-size:12px}.synap-source-link span{display:block;margin-top:2px;font-size:11px;line-height:1.4;color:var(--muted,#64748b)}
      .synap-note-source{font-size:10px;color:var(--muted,#64748b);margin:0 0 6px}.synap-note-body{white-space:pre-wrap;margin:0;font-size:12px;line-height:1.5}
      .synap-provenance-transcript{display:grid;gap:7px;max-height:420px;overflow:auto}.synap-provenance-line{display:grid;grid-template-columns:52px 48px minmax(0,1fr);gap:7px;align-items:start;font-size:12px;line-height:1.45}.synap-provenance-line time{font-variant-numeric:tabular-nums;color:var(--muted,#64748b)}.synap-provenance-line b{font-size:11px}.synap-provenance-line p{margin:0}
      .recording-transcript[readonly]{cursor:text;background:transparent}.synap-transcript-integrity{display:block;margin:5px 0 0;font-size:10px;color:var(--muted,#64748b)}
    `;
    document.head.appendChild(style);
  }

  function recordById(id) {
    return records.find((recording) => String(recording.id) === String(id));
  }

  function recordForInsight(card) {
    const dateTime = $('time', card)?.dateTime;
    if (dateTime) {
      const target = new Date(dateTime).getTime();
      const exact = records.find((recording) => new Date(recording.createdAt).getTime() === target);
      if (exact) return exact;
    }
    const existing = card.dataset.recordingId;
    return existing ? recordById(existing) : null;
  }

  function timestampToMs(value) {
    const first = String(value || '').split(/[–-]/)[0].trim();
    const parts = first.split(':').map(Number);
    if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    return null;
  }

  function transcriptPanel(recording) {
    const host = document.createElement('div');
    host.className = 'synap-memory-panel synap-provenance-transcript';
    const lines = String(recording.transcript || '').split(/\n+/).filter((line) => line.trim());
    for (const line of lines) {
      const match = line.match(/^\[([^\]]+)\]\s+([^:]+):\s*(.*)$/);
      if (!match) {
        const p = document.createElement('p');
        p.className = 'synap-transcript-flat';
        p.textContent = line;
        host.appendChild(p);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'synap-provenance-line';
      const at = timestampToMs(match[1]);
      if (at != null) row.dataset.startMs = String(at);
      const time = document.createElement('time');
      time.textContent = match[1];
      const speaker = document.createElement('b');
      speaker.textContent = /^(YOU|SELF|ME)$/i.test(match[2].trim()) ? 'You' : match[2].trim();
      const text = document.createElement('p');
      text.textContent = match[3];
      row.append(time, speaker, text);
      host.appendChild(row);
    }
    return host;
  }

  function summaryPanel(recording) {
    const host = document.createElement('div');
    host.className = 'synap-memory-panel synap-provenance-summary';
    const lead = document.createElement('p');
    lead.textContent = meeting(recording).executive_summary || recording.summary || '';
    if (lead.textContent.trim()) host.appendChild(lead);

    const list = document.createElement('div');
    list.className = 'synap-source-list';
    for (const conversation of conversations(recording)) {
      const startMs = sourceStart(conversation);
      const endMs = sourceEnd(conversation);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'synap-source-link';
      button.dataset.recordingId = recording.id;
      button.dataset.offsetMs = String(startMs);
      button.dataset.endMs = String(endMs);
      const time = document.createElement('time');
      time.textContent = clock(recording, startMs);
      const copy = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = conversation.title || 'Conversation';
      const summary = document.createElement('span');
      summary.textContent = conversation.summary || 'Open supporting transcript';
      copy.append(title, summary);
      button.append(time, copy);
      list.appendChild(button);
    }
    if (list.children.length) host.appendChild(list);
    return host;
  }

  function notesPanel(recording) {
    const host = document.createElement('div');
    host.className = 'synap-memory-panel';
    const source = document.createElement('p');
    source.className = 'synap-note-source';
    source.textContent = 'Recording note · attached to ' + clock(recording, 0) + ' · not used as transcript evidence';
    const note = document.createElement('p');
    note.className = 'synap-note-body';
    note.textContent = recording.notes || '';
    host.append(source, note);
    return host;
  }

  function buildMemoryView(recording) {
    const host = document.createElement('div');
    host.className = 'synap-memory-view';
    host.dataset.synapProvenance = '1';
    const tabs = document.createElement('div');
    tabs.className = 'synap-memory-tabs';
    tabs.setAttribute('role', 'tablist');
    const panels = [];

    function add(name, panel) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.setAttribute('role', 'tab');
      button.dataset.synapView = name.toLowerCase();
      const entry = { button, panel };
      panels.push(entry);
      button.addEventListener('click', () => activate(entry));
      tabs.appendChild(button);
    }

    function activate(active) {
      for (const entry of panels) {
        const yes = entry === active;
        entry.button.setAttribute('aria-selected', String(yes));
        entry.panel.hidden = !yes;
      }
    }

    if (recording.summary || meeting(recording).executive_summary || conversations(recording).length) add('Summary', summaryPanel(recording));
    if (String(recording.notes || '').trim()) add('Notes', notesPanel(recording));
    if (String(recording.transcript || '').trim()) add('Transcript', transcriptPanel(recording));
    if (!panels.length) return host;
    host.append(tabs, ...panels.map((entry) => entry.panel));
    activate(panels[0]);
    return host;
  }

  function repairInsightBindings() {
    for (const card of $$('#insightsList .insight-card:not(.synap-merged-card)')) {
      const recording = recordForInsight(card);
      if (!recording) continue;
      card.dataset.recordingId = recording.id;
      $$('.synap-memory-view', card).forEach((node) => node.remove());
      const top = $('.insight-top', card);
      const view = buildMemoryView(recording);
      if (view.childNodes.length && top) top.insertAdjacentElement('afterend', view);
      const label = $('.insight-label', card); if (label) label.hidden = true;
      const summary = $('.insight-summary', card); if (summary) summary.hidden = true;
      const transcript = $('.transcript-preview', card); if (transcript) transcript.hidden = true;
    }
  }

  function inferOffset(button, recording) {
    const explicit = Number(button.dataset.offsetMs || button.dataset.sourceOffsetMs);
    if (Number.isFinite(explicit)) return explicit;
    const strong = $('strong', button)?.textContent?.trim() || '';
    if (!strong) return 0;

    for (const conversation of conversations(recording)) {
      if (String(conversation.title || '').trim() === strong) return sourceStart(conversation);
      for (const decision of conversation.decisions || []) {
        if (textOf(decision) === strong) return sourceStart(decision, conversation);
      }
      for (const action of conversation.action_items || []) {
        if (String(action.task || '').trim() === strong) return sourceStart(action, conversation);
      }
      for (const follow of conversation.follow_ups || []) {
        if (textOf(follow) === strong) return sourceStart(follow, conversation);
      }
    }
    return 0;
  }

  function repairTodayTimes() {
    for (const button of $$('.source-jump[data-id]')) {
      const recording = recordById(button.dataset.id);
      if (!recording) continue;
      const offsetMs = inferOffset(button, recording);
      button.dataset.sourceOffsetMs = String(offsetMs);
      const conversationTime = $('.conversation-time', button);
      if (conversationTime) conversationTime.textContent = clock(recording, offsetMs);
      const meta = $('small', button);
      if (meta && button.classList.contains('brain-action-row')) {
        const stamp = clock(recording, offsetMs);
        if (stamp && !meta.textContent.startsWith(stamp)) meta.textContent = stamp + (meta.textContent ? ' · ' + meta.textContent : '');
      }
    }
  }

  function nearestTranscriptPosition(text, targetMs) {
    let best = { index: 0, delta: Infinity };
    const regex = /^\[([^\]]+)\]/gm;
    let match;
    while ((match = regex.exec(text))) {
      const at = timestampToMs(match[1]);
      if (at == null) continue;
      const delta = Math.abs(at - targetMs);
      if (delta < best.delta) best = { index: match.index, delta };
    }
    return best.index;
  }

  function seekAudio(audio, seconds) {
    if (!audio) return;
    const apply = () => {
      try { audio.currentTime = Math.max(0, seconds); } catch (_) {}
    };
    if (audio.readyState >= 1) apply();
    else audio.addEventListener('loadedmetadata', apply, { once: true });
  }

  function revealLibraryCard(recordingId, offsetMs) {
    let attempts = 0;
    const find = () => {
      let card = document.getElementById('recording-' + recordingId);
      if (!card) {
        const more = document.getElementById('showMoreRecordingsButton');
        if (more && !more.hidden) more.click();
        if (++attempts < 20) return setTimeout(find, 40);
        return;
      }
      card.open = true;
      const transcriptDetails = $$('details', card).find((node) => $('summary', node)?.textContent?.trim() === 'Transcript');
      if (transcriptDetails) transcriptDetails.open = true;
      const textarea = $('.recording-transcript', card);
      if (textarea) {
        textarea.readOnly = true;
        textarea.title = 'Transcript is generated source evidence. Corrections require a memory rebuild.';
        if (!card.querySelector('.synap-transcript-integrity')) {
          const note = document.createElement('small');
          note.className = 'synap-transcript-integrity';
          note.textContent = 'Transcript is the evidence behind this summary; it is read-only to keep the memory linked.';
          textarea.insertAdjacentElement('afterend', note);
        }
        const index = nearestTranscriptPosition(textarea.value, offsetMs);
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(index, index);
        const ratio = textarea.value.length ? index / textarea.value.length : 0;
        textarea.scrollTop = Math.max(0, ratio * (textarea.scrollHeight - textarea.clientHeight));
      }

      const audio = $('audio', card);
      if (audio) {
        if (!audio.getAttribute('src')) {
          const load = $$('.recording-actions button', card).find((button) => button.textContent.trim() === 'Load audio');
          load?.click();
          let audioAttempts = 0;
          const waitForSource = () => {
            if (audio.getAttribute('src')) seekAudio(audio, offsetMs / 1000);
            else if (++audioAttempts < 30) setTimeout(waitForSource, 70);
          };
          waitForSource();
        } else seekAudio(audio, offsetMs / 1000);
      }
      card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    };
    find();
  }

  function openSource(recordingId, offsetMs = 0) {
    const recording = recordById(recordingId);
    if (!recording) return false;
    const picker = document.getElementById('datePicker');
    if (picker) {
      const day = localDay(recording.createdAt);
      if (picker.value !== day) {
        picker.value = day;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    location.hash = '#library';
    setTimeout(() => revealLibraryCard(recordingId, Math.max(0, Number(offsetMs) || 0)), 90);
    return true;
  }

  function bindClicks() {
    document.addEventListener('click', (event) => {
      const own = event.target.closest?.('.synap-source-link');
      if (own) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openSource(own.dataset.recordingId, Number(own.dataset.offsetMs) || 0);
        return;
      }
      const legacy = event.target.closest?.('.source-jump[data-id]');
      if (!legacy) return;
      const recording = recordById(legacy.dataset.id);
      if (!recording) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openSource(recording.id, inferOffset(legacy, recording));
    }, true);
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      records = await loadRecords().catch(() => []);
      repairInsightBindings();
      repairTodayTimes();
    } finally {
      refreshing = false;
    }
  }

  function init() {
    injectStyle();
    bindClicks();
    const schedule = () => setTimeout(refresh, 60);
    ['synap-memory-ready', 'synap-cloud-history-updated', 'synap-transcript-updated'].forEach((name) => root.addEventListener(name, schedule));
    document.getElementById('datePicker')?.addEventListener('change', schedule);
    refresh();
    setTimeout(refresh, 250);
  }

  root.SynapProvenance = Object.freeze({ refresh, openSource, inferOffset, timestampToMs });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
