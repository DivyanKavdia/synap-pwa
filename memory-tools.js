/* Reversible cloud merges. Source recordings and their audio remain untouched. */
(function (root) {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const sourceCards = () => [...document.querySelectorAll('#insightsList .insight-card[data-recording-id]')];
  const selected = new Set();
  let records = [], merges = [], apiSupported = false, selectionMode = false, busy = false;
  let scopeKey = '', refreshEpoch = 0, recordsEpoch = 0, refreshTimer = 0, errorText = '';

  function day(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }
  function scope() {
    const uid = String(root.SynapAuth?.session?.()?.profile?.uid || '');
    const date = $('#datePicker')?.value || day(Date.now());
    const signedIn = Boolean(root.SynapAuth?.isSignedIn?.());
    return { uid, date, key: uid + '|' + date + '|' + signedIn, signedIn };
  }
  function resetScope() {
    const current = scope();
    if (current.key !== scopeKey) {
      scopeKey = current.key;
      records = []; merges = []; selected.clear(); selectionMode = false; errorText = ''; apiSupported = false;
    }
    return current;
  }
  async function request(path, options = {}) {
    if (!root.SynapAuth?.authedFetch) throw new Error('Sign in to merge cloud memories.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await root.SynapAuth.authedFetch(path, { ...options, signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(data?.error?.message || (response.status === 404
          ? 'Memory merging is unavailable on the server. Try again later.' : 'Could not complete the request. Please retry.'));
        error.status = response.status;
        throw error;
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  async function loadRecords() {
    const db = await new Promise((resolve, reject) => {
      const q = indexedDB.open('dk-pendant-recordings');
      q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const q = db.transaction('recordings').objectStore('recordings').getAll();
        q.onsuccess = () => resolve(q.result || []); q.onerror = () => reject(q.error);
      });
    } finally { db.close(); }
  }
  function visibleRecords() {
    const current = scope();
    return records.filter(r => day(r.createdAt) === current.date &&
      (String(r.summary || '').trim() || String(r.transcript || '').trim()) &&
      (!current.uid || !r.ownerUid || String(r.ownerUid) === current.uid))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  function recordingForCard(card, list) {
    const id = card?.dataset?.recordingId;
    if (id) return list.find(r => String(r.id) === id) || null;
    const stamp = card?.querySelector('time')?.dateTime;
    return stamp ? list.find(r => new Date(r.createdAt).getTime() === new Date(stamp).getTime()) || null : null;
  }
  function occupiedIds() { return new Set(merges.flatMap(m => m.source_recording_ids)); }
  function selectedIsConsecutive(list) {
    const positions = [...selected].map(id => list.findIndex(r => String(r.id) === id)).sort((a, b) => a - b);
    const occupied = occupiedIds();
    return positions.length >= 2 && positions.length <= 5 && positions.every(x => x >= 0) &&
      positions[positions.length - 1] - positions[0] + 1 === positions.length &&
      [...selected].every(id => !occupied.has(id));
  }
  function ensureControls() {
    const section = $('#insights'), heading = section?.querySelector('.section-heading');
    if (!heading || $('#synapMergeMemories')) return;
    const actions = document.createElement('div'); actions.className = 'synap-memory-actions';
    const merge = document.createElement('button'); merge.type = 'button'; merge.id = 'synapMergeMemories';
    merge.className = 'synap-merge-button'; merge.textContent = 'Merge'; merge.setAttribute('aria-label', 'Merge memories');
    merge.addEventListener('click', enterSelection);
    actions.appendChild(merge); heading.appendChild(actions);
    const tools = document.createElement('div'); tools.className = 'synap-merge-tools';
    tools.innerHTML = '<p id="synapMergeError" class="synap-merge-error" role="alert" hidden></p>' +
      '<div class="synap-merge-toolbar" hidden><span id="synapMergeStatus" role="status"></span>' +
      '<button type="button" id="synapMergeConfirm" class="primary">Merge</button>' +
      '<button type="button" id="synapMergeCancel">Cancel</button></div>';
    heading.after(tools);
    $('#synapMergeConfirm').addEventListener('click', mergeSelected);
    $('#synapMergeCancel').addEventListener('click', () => {
      if (busy) return;
      selectionMode = false; selected.clear(); errorText = ''; render();
    });
  }
  function setText(node, value) { if (node && node.textContent !== value) node.textContent = value; }
  function renderToolbar() {
    ensureControls();
    const toolbar = $('.synap-merge-toolbar'), go = $('#synapMergeConfirm'), button = $('#synapMergeMemories');
    if (!toolbar) return;
    const count = selected.size, valid = selectedIsConsecutive(visibleRecords());
    toolbar.hidden = !selectionMode;
    setText($('#synapMergeStatus'), busy ? 'Merging memories…' : !count ? 'Select 2–5 consecutive memories.' :
      count === 1 ? '1 selected · choose an adjacent memory.' : valid ? count + ' selected · ready to merge.' :
        count + ' selected · choose consecutive memories.');
    go.disabled = !valid || busy;
    $('#synapMergeCancel').disabled = busy;
    const available = visibleRecords().filter(r => !occupiedIds().has(String(r.id))).length;
    button.hidden = selectionMode || available < 2;
    button.disabled = busy;
    const error = $('#synapMergeError'); error.hidden = !errorText; setText(error, errorText);
  }
  function renderSelectors() {
    const occupied = occupiedIds();
    for (const card of sourceCards()) {
      const id = card.dataset.recordingId;
      let button = card.querySelector('.synap-merge-check');
      if (!selectionMode || occupied.has(id)) { button?.remove(); continue; }
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.className = 'synap-merge-check';
        button.setAttribute('aria-label', 'Select ' + (card.querySelector('h3')?.textContent || 'memory') + ' to merge');
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          if (busy) return;
          errorText = '';
          if (selected.has(id)) selected.delete(id);
          else if (selected.size >= 5) errorText = 'Select up to 5 memories at a time.';
          else selected.add(id);
          renderSelectors(); renderToolbar();
        });
        card.querySelector('.insight-top')?.prepend(button);
      }
      button.setAttribute('aria-pressed', String(selected.has(id)));
      button.disabled = busy;
    }
  }
  function shareText(merge) {
    const memory = merge?.memory || {};
    const title = String(memory.title || 'Synap memory').trim();
    const sections = [title];
    const summary = String(memory.executive_summary || '').trim();
    if (summary) sections.push(summary);
    const points = Array.isArray(memory.key_points) ? memory.key_points.filter(Boolean) : [];
    if (points.length) sections.push('Key points\n' + points.map(item => '• ' + String(item).trim()).join('\n'));
    const conversations = Array.isArray(memory.conversations) ? memory.conversations : [];
    const decisions = conversations.flatMap(item => Array.isArray(item?.decisions) ? item.decisions : [])
      .map(item => typeof item === 'string' ? item : item?.text).filter(Boolean);
    if (decisions.length) sections.push('Decisions\n' + decisions.map(item => '• ' + item).join('\n'));
    const actions = conversations.flatMap(item => Array.isArray(item?.action_items) ? item.action_items : [])
      .map(item => {
        if (typeof item === 'string') return item;
        return [item?.task, item?.owner ? 'Owner: ' + item.owner : '', item?.due_date ? 'Due: ' + item.due_date : ''].filter(Boolean).join(' · ');
      }).filter(Boolean);
    if (actions.length) sections.push('Actions\n' + actions.map(item => '• ' + item).join('\n'));
    sections.push('Shared from Synap · infinite memories');
    return sections.join('\n\n');
  }
  function openShare(url) {
    const popup = root.open(url, '_blank', 'noopener,noreferrer');
    if (!popup) root.location.href = url;
  }
  function shareWhatsApp(merge) {
    openShare('https://wa.me/?text=' + encodeURIComponent(shareText(merge).slice(0, 7000)));
  }
  function shareGmail(merge) {
    const title = String(merge?.memory?.title || 'Synap memory').trim();
    const body = shareText(merge).slice(0, 12000);
    openShare('https://mail.google.com/mail/?view=cm&fs=1&su=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body));
  }
  function asciiPdf(value) {
    return String(value || '')
      .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/•/g, '-').normalize('NFKD').replace(/[^\x20-\x7E\n]/g, '');
  }
  function wrapPdf(text, width = 86) {
    const lines = [];
    for (const paragraph of asciiPdf(text).split(/\n/)) {
      if (!paragraph) { lines.push(''); continue; }
      const words = paragraph.split(/\s+/);
      let line = '';
      for (const word of words) {
        const next = line ? line + ' ' + word : word;
        if (next.length > width && line) { lines.push(line); line = word; }
        else line = next;
      }
      lines.push(line);
    }
    return lines;
  }
  function pdfEscape(value) {
    return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
  function buildPdf(merge) {
    const lines = wrapPdf(shareText(merge));
    const perPage = 48;
    const pages = [];
    for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
    if (!pages.length) pages.push(['Synap memory']);
    const fontNum = 3 + pages.length * 2;
    const objects = [];
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    const kids = pages.map((_, i) => (3 + i * 2) + ' 0 R').join(' ');
    objects[2] = '<< /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >>';
    pages.forEach((pageLines, i) => {
      const pageNum = 3 + i * 2, contentNum = pageNum + 1;
      const stream = 'BT /F1 11 Tf 48 790 Td 15 TL ' +
        pageLines.map(line => '(' + pdfEscape(line) + ') Tj T*').join(' ') + ' ET';
      objects[pageNum] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ' + fontNum + ' 0 R >> >> /Contents ' + contentNum + ' 0 R >>';
      objects[contentNum] = '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream';
    });
    objects[fontNum] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    let pdf = '%PDF-1.4\n', offsets = [0];
    for (let i = 1; i < objects.length; i++) {
      offsets[i] = pdf.length;
      pdf += i + ' 0 obj\n' + objects[i] + '\nendobj\n';
    }
    const xref = pdf.length;
    pdf += 'xref\n0 ' + objects.length + '\n0000000000 65535 f \n';
    for (let i = 1; i < objects.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    pdf += 'trailer\n<< /Size ' + objects.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
    return new Blob([pdf], { type: 'application/pdf' });
  }
  function downloadPdf(merge) {
    const title = String(merge?.memory?.title || 'Synap memory').trim()
      .replace(/[^a-z0-9 _-]+/gi, '').replace(/\s+/g, ' ').slice(0, 60) || 'Synap memory';
    const url = URL.createObjectURL(buildPdf(merge));
    const link = document.createElement('a');
    link.href = url; link.download = title + '.pdf'; link.hidden = true;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function mergedCard(merge) {
    const card = document.createElement('details'); card.className = 'insight-card synap-merged-card';
    card.dataset.mergeId = merge.merge_id;
    const top = document.createElement('summary'); top.className = 'insight-top';
    const title = document.createElement('h3'); title.textContent = merge.memory?.title || 'Merged memory';
    const badge = document.createElement('span'); badge.className = 'synap-merged-badge';
    badge.textContent = 'Merged · ' + merge.source_recording_ids.length;
    const time = document.createElement('time'); time.dateTime = merge.started_at;
    time.textContent = new Date(merge.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    title.appendChild(badge); top.append(title, time); card.appendChild(top);
    const summary = [merge.memory?.executive_summary || '', ...(merge.memory?.key_points || []).map(x => '• ' + x)].filter(Boolean).join('\n');
    card.appendChild(root.SynapProvenance.buildMemoryView({ summary, transcript: merge.transcript || '' }));
    const sources = document.createElement('div'); sources.className = 'synap-merged-sources';
    for (const id of merge.source_recording_ids) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'synap-source-link';
      button.dataset.recordingId = id; button.dataset.offsetMs = '0';
      button.textContent = records.find(r => String(r.id) === id)?.name || 'Open source recording'; sources.appendChild(button);
    }
    const foot = document.createElement('div'); foot.className = 'synap-merged-footer';
    const note = document.createElement('small'); note.textContent = 'Source audio stays unchanged in Library.';
    const actions = document.createElement('div'); actions.className = 'synap-merged-actions';
    const recreateButton = document.createElement('button'); recreateButton.type = 'button'; recreateButton.className = 'synap-recreate';
    recreateButton.textContent = 'Recreate'; recreateButton.title = 'Rebuild one unified memory from the source recordings';
    recreateButton.addEventListener('click', () => recreate(merge.merge_id));
    const whatsapp = document.createElement('button'); whatsapp.type = 'button'; whatsapp.textContent = 'WhatsApp';
    whatsapp.addEventListener('click', () => shareWhatsApp(merge));
    const gmail = document.createElement('button'); gmail.type = 'button'; gmail.textContent = 'Gmail';
    gmail.addEventListener('click', () => shareGmail(merge));
    const pdf = document.createElement('button'); pdf.type = 'button'; pdf.textContent = 'PDF';
    pdf.addEventListener('click', () => downloadPdf(merge));
    const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'synap-unmerge'; undo.textContent = 'Unmerge';
    undo.addEventListener('click', () => unmerge(merge.merge_id));
    actions.append(recreateButton, whatsapp, gmail, pdf, undo);
    foot.append(note, actions); card.append(sources, foot); return card;
  }
  function render() {
    const list = $('#insightsList'); if (!list) return;
    const cards = sourceCards(), occupied = occupiedIds();
    const validIds = new Set(visibleRecords().map(r => String(r.id)));
    for (const id of selected) if (!validIds.has(id) || occupied.has(id)) selected.delete(id);
    cards.forEach(card => card.classList.toggle('synap-memory-source-hidden', occupied.has(card.dataset.recordingId)));
    const existing = new Map([...list.querySelectorAll('.synap-merged-card')].map(card => [card.dataset.mergeId, card]));
    for (const merge of merges) {
      const source = cards.find(card => merge.source_recording_ids.includes(card.dataset.recordingId));
      if (!source) continue;
      const card = existing.get(merge.merge_id) || mergedCard(merge);
      if (card.nextElementSibling !== source) source.before(card);
      card.querySelectorAll('.synap-unmerge, .synap-recreate').forEach(button => { button.disabled = busy; });
      existing.delete(merge.merge_id);
    }
    existing.forEach(card => card.remove());
    setText($('#insightsCount'), String(cards.filter(card => !occupied.has(card.dataset.recordingId)).length + list.querySelectorAll('.synap-merged-card').length));
    renderSelectors(); renderToolbar();
  }
  async function refresh(fetchMerges = true) {
    const current = resetScope(), epoch = fetchMerges ? ++refreshEpoch : refreshEpoch, recordEpoch = ++recordsEpoch;
    try {
      const loaded = await loadRecords();
      if (scope().key !== current.key) return;
      if (recordEpoch === recordsEpoch) { records = loaded; render(); }
      if (epoch !== refreshEpoch) return;
      if (!fetchMerges || busy) return;
      if (!current.signedIn) { merges = []; apiSupported = false; render(); return; }
      const data = await request('/v1/memory-merges?day=' + encodeURIComponent(current.date));
      if (epoch !== refreshEpoch || scope().key !== current.key) return;
      if (!Array.isArray(data?.merges)) throw new Error('Could not load merged memories. Please retry.');
      merges = data.merges; apiSupported = true; errorText = ''; render();
    } catch (error) {
      if (epoch !== refreshEpoch || scope().key !== current.key) return;
      if (error.status === 401 || error.status === 404) apiSupported = false;
      errorText = error.message || 'Could not load memories. Please retry.'; renderToolbar();
    }
  }
  async function enterSelection() {
    root.SynapCompactLayout?.reveal('insights');
    resetScope(); errorText = '';
    if (!scope().signedIn) { errorText = 'Sign in in Settings to merge cloud memories.'; renderToolbar(); return; }
    if (!apiSupported) await refresh();
    if (!apiSupported || busy) return;
    selectionMode = true; selected.clear(); render();
  }
  async function mergeSelected() {
    const candidates = visibleRecords();
    if (busy || !selectedIsConsecutive(candidates)) return;
    const current = scope();
    const ids = candidates.filter(r => selected.has(String(r.id))).reverse().map(r => String(r.id));
    busy = true; errorText = ''; ++refreshEpoch; render();
    try {
      const merge = await request('/v1/memory-merges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_ids: ids }) });
      if (scope().key !== current.key) return;
      if (!merge?.merge_id || !Array.isArray(merge.source_recording_ids)) throw new Error('Could not confirm the merge. Refresh Memories before retrying.');
      merges = [...merges.filter(m => m.merge_id !== merge.merge_id), merge];
      selectionMode = false; selected.clear(); render();
      const card = [...document.querySelectorAll('.synap-merged-card')].find(c => c.dataset.mergeId === merge.merge_id);
      if (card) { card.open = true; card.scrollIntoView({ block: 'center' }); }
    } catch (error) {
      if (scope().key === current.key) errorText = error.name === 'AbortError'
        ? 'The merge timed out. Refresh Memories to check its result before retrying.' : error.message || 'Could not merge memories. Please retry.';
    } finally { busy = false; render(); }
  }
  async function recreate(id) {
    if (busy) return;
    const current = scope(); busy = true; errorText = ''; ++refreshEpoch; render();
    try {
      const merge = await request('/v1/memory-merges/' + encodeURIComponent(id) + '/recreate', { method: 'POST' });
      if (scope().key !== current.key) return;
      if (!merge?.merge_id || !Array.isArray(merge.source_recording_ids)) throw new Error('Could not confirm the recreated memory.');
      merges = [...merges.filter(item => item.merge_id !== id), merge];
      render();
      const card = [...document.querySelectorAll('.synap-merged-card')].find(item => item.dataset.mergeId === id);
      if (card) { card.open = true; card.scrollIntoView({ block: 'center' }); }
    } catch (error) {
      if (scope().key === current.key) errorText = error.name === 'AbortError'
        ? 'Recreating the memory timed out. Refresh Memories to check the result.'
        : error.message || 'Could not recreate the unified memory. Please retry.';
    } finally { busy = false; render(); }
  }
  async function unmerge(id) {
    if (busy) return;
    const current = scope(); busy = true; errorText = ''; ++refreshEpoch; render();
    try {
      await request('/v1/memory-merges/' + encodeURIComponent(id), { method: 'DELETE' });
      if (scope().key === current.key) merges = merges.filter(m => m.merge_id !== id);
    } catch (error) {
      if (scope().key === current.key) errorText = error.message || 'Could not unmerge. Please retry.';
    } finally { busy = false; render(); }
  }
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh(), 60); }
  function bind() {
    ensureControls();
    // Core owns source-card reconciliation. Only its completed render triggers ours.
    root.addEventListener('synap-insights-rendered', () => refresh(false));
    $('#datePicker')?.addEventListener('change', () => { resetScope(); render(); scheduleRefresh(); });
    root.SynapAuth?.onChange?.(() => { resetScope(); render(); scheduleRefresh(); });
    root.addEventListener('online', scheduleRefresh);
    root.addEventListener('synap-memory-ready', scheduleRefresh);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleRefresh(); });
    refresh();
  }
  root.SynapMemoryTools = { refresh, recordingForCard, get merges() { return merges.slice(); }, get mergeSupported() { return apiSupported; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true }); else bind();
})(globalThis);
