/* Synap interaction surfaces: canonical People/follow-ups with grounded local fallback. */
(function (root) {
  'use strict';
  const DB = 'dk-pendant-recordings';
  const $ = (s, h = document) => h.querySelector(s),
    $$ = (s, h = document) => [...h.querySelectorAll(s)];
  const mine = (o) => /^(me|i|myself|self|you|user)$/i.test(String(o || '').trim());
  let currentRecords = [],
    canonicalPeople = null,
    canonicalFollowups = null,
    canonicalAt = 0,
    canonicalScope = '';
  let canonicalPending = { people: null, followups: null },
    canonicalGeneration = 0,
    refreshGeneration = 0,
    actionRevision = 0;
  const listStates = { people: {}, followups: {} },
    pendingActions = new Set(),
    actionMutations = new Map(),
    actionItems = new Map();
  function signedIn() {
    try {
      return Boolean(root.SynapAuth?.isSignedIn?.());
    } catch (_) {
      return false;
    }
  }
  function sourceOffset(value, conversation) {
    if (value?.start_ms != null && Number.isFinite(Number(value.start_ms)))
      return Number(value.start_ms);
    if (value?.start_seconds != null && Number.isFinite(Number(value.start_seconds)))
      return Number(value.start_seconds) * 1000;
    if (conversation?.start_ms != null && Number.isFinite(Number(conversation.start_ms)))
      return Number(conversation.start_ms);
    if (conversation?.start_seconds != null && Number.isFinite(Number(conversation.start_seconds)))
      return Number(conversation.start_seconds) * 1000;
    return 0;
  }
  function openDb() {
    return new Promise((res, rej) => {
      const q = indexedDB.open(DB);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function load() {
    const db = await openDb();
    try {
      return await new Promise((res, rej) => {
        const q = db.transaction('recordings').objectStore('recordings').getAll();
        q.onsuccess = () => res(q.result || []);
        q.onerror = () => rej(q.error);
      });
    } finally {
      db.close();
    }
  }
  function dedupeId(id) {
    const nodes = $$('[id="' + id + '"]');
    nodes.slice(1).forEach((n) => n.remove());
    return nodes[0] || null;
  }
  function dedupe() {
    [
      'followupInbox',
      'peopleMemory',
      'ask',
      'followupList',
      'peopleList',
      'askForm',
      'askInput',
      'askAnswer',
    ].forEach(dedupeId);
    const links = $$('.brain-tabs a[href="#myActions"]');
    links.slice(1).forEach((n) => n.remove());
  }
  function localRecord(id) {
    return currentRecords.find((x) => String(x.id) === String(id)) || null;
  }
  function showLibrary() {
    if (root.SynapDashboardUI?.setView) root.SynapDashboardUI.setView('library', false);
    else location.hash = '#library';
  }
  function openSource(id, ms = 0) {
    const offset = Math.max(0, Number(ms) || 0);
    const finish = async () => {
      currentRecords = await load().catch(() => currentRecords);
      await root.SynapProvenance?.refresh?.();
      if (root.SynapProvenance?.openSource) return root.SynapProvenance.openSource(id, offset);
      const r = localRecord(id);
      if (!r) return false;
      const p = $('#datePicker');
      if (p) {
        p.value = root.SynapActionState.day(r.createdAt);
        p.dispatchEvent(new Event('change', { bubbles: true }));
      }
      showLibrary();
      return true;
    };
    if (localRecord(id)) return finish();
    if (root.SynapCloudHistory?.restoreRecording)
      return Promise.resolve(root.SynapCloudHistory.restoreRecording(id, false)).then(finish);
    return Promise.resolve(false);
  }
  function openAsk(person) {
    dedupe();
    if (root.SynapAsk?.open) {
      root.SynapAsk.open(person);
      return;
    }
    if (root.SynapDashboardUI?.setView) root.SynapDashboardUI.setView('ask', false);
    else location.hash = '#ask';
    const input = $('#askInput'),
      form = $('#askForm');
    if (input) {
      input.value = person;
      input.focus({ preventScroll: true });
    }
    if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
  function followEntries(r) {
    const api = root.SynapBrainUI;
    if (!api) return [];
    const out = [];
    for (const entry of api.actionEntries?.(r) || []) {
      const a = entry.value || {},
        text = String(a.task || '').trim();
      if (!text) continue;
      const owner = String(a.owner || '').trim();
      out.push({
        r,
        text,
        owner,
        due: a.due_date || '',
        state: a.state || a.status || 'open',
        kind: a.kind || 'commitment',
        mine: mine(owner) || !owner,
        startMs: sourceOffset(a, entry.conversation),
      });
    }
    for (const entry of api.followUpEntries?.(r) || []) {
      const v = entry.value || {},
        text = typeof v === 'string' ? v.trim() : String(v.text || '').trim();
      if (!text) continue;
      const owner = String(v.owner || '').trim();
      out.push({
        r,
        text,
        owner,
        due: v.due_date || '',
        state: v.state || v.status || 'open',
        mine: mine(owner),
        startMs: sourceOffset(v, entry.conversation),
        kind: 'follow-up',
      });
    }
    const seen = new Set();
    return out.filter((x) => {
      const k = x.r.id + '|' + x.startMs + '|' + x.text.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  function canonicalFollowEntry(item) {
    const ownerType = String(item?.owner?.type || '');
    return {
      id: String(item?.id || ''),
      recordingId: String(item?.source?.recording_id || ''),
      startMs: Math.max(0, Number(item?.source?.start_ms) || 0),
      text: String(item?.task || '').trim(),
      owner: String(item?.owner?.display_name || ''),
      due: item?.due_date || '',
      state: item?.state || 'open',
      recordedAt:
        localRecord(item?.source?.recording_id)?.createdAt || item?.source?.recorded_at || '',
      mine: ownerType === 'self',
      kind: item?.kind || 'commitment',
    };
  }
  function makeSourceButton(x, kind) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'brain-action-row source-jump';
    b.dataset.id = x.recordingId || x.r?.id || '';
    b.dataset.offsetMs = String(x.startMs || 0);
    const icon = document.createElement('span');
    icon.className = 'brain-action-icon';
    icon.textContent = kind === 'decision' ? '✓' : kind === 'mine' ? '→' : '←';
    const copy = document.createElement('span'),
      strong = document.createElement('strong');
    strong.textContent = x.text;
    copy.appendChild(strong);
    if (x.meta) {
      const small = document.createElement('small');
      small.textContent = x.meta;
      copy.appendChild(small);
    }
    b.append(icon, copy);
    return b;
  }
  function activeMode() {
    return $('.followup-tabs .active')?.dataset.follow || 'mine';
  }
  function followData() {
    const local = (records) =>
      records.flatMap(followEntries).map((x) => ({ ...x, recordingId: x.r.id }));
    if (!Array.isArray(canonicalFollowups)) return local(currentRecords);
    const cloud = canonicalFollowups
      .map(canonicalFollowEntry)
      .filter((x) => x.text && x.recordingId);
    const cloudSources = new Set(cloud.map((item) => item.recordingId));
    // Cloud state owns synced sources; direct-provider and unsynced local tasks remain available.
    return [
      ...cloud,
      ...local(
        currentRecords.filter((r) => r.provider !== 'synap' && !cloudSources.has(String(r.id))),
      ),
    ];
  }
  function actions() {
    return followData().map((item) => ({
      ...item,
      state: item.id ? item.state : root.SynapActionState.state(item, accountKey()),
      actionKey: item.id ? 'cloud:' + item.id : 'local:' + root.SynapActionState.key(item),
    }));
  }
  function filteredActions() {
    const api = root.SynapActionState;
    const filters = root.SynapMyActions?.filters?.() || { period: 'all', state: 'open' };
    const entries = actions();
    actionItems.clear();
    entries.forEach((item) => actionItems.set(item.actionKey, item));
    return entries
      .filter(
        (item) =>
          (filters.state === 'all' || item.state === filters.state) &&
          api.matches(item, filters.period),
      )
      .sort(
        (a, b) =>
          (api.dueDay(a.due) || '9999').localeCompare(api.dueDay(b.due) || '9999') ||
          new Date(b.recordedAt || b.r?.createdAt || 0) -
            new Date(a.recordedAt || a.r?.createdAt || 0),
      );
  }
  function actionRow(item) {
    const row = document.createElement('div');
    row.className = 'synap-follow-row';
    row.dataset.state = item.state;
    const due = root.SynapActionState.dueDay(item.due);
    const recorded = root.SynapActionState.day(item.recordedAt || item.r?.createdAt);
    const dateLabel = (value) =>
      new Date(value + 'T12:00:00').toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        ...(value.slice(0, 4) !== String(new Date().getFullYear()) ? { year: 'numeric' } : {}),
      });
    const label = due
      ? 'Due ' + dateLabel(due)
      : recorded
        ? 'Recorded ' + dateLabel(recorded) + ' · No due date'
        : 'No due date';
    row.appendChild(
      makeSourceButton(
        {
          ...item,
          meta: [
            item.kind === 'reminder' ? 'Suggested reminder' : '',
            item.mine ? 'You' : item.owner,
            label,
            item.state === 'dismissed' ? 'Dismissed' : '',
          ]
            .filter(Boolean)
            .join(' · '),
        },
        item.mine ? 'mine' : 'waiting',
      ),
    );
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'synap-follow-done';
    button.dataset.actionKey = item.actionKey;
    if (item.id) button.dataset.followupId = item.id;
    button.disabled = pendingActions.has(item.actionKey);
    const completed = item.state !== 'open';
    button.textContent = button.disabled ? 'Saving…' : completed ? 'Reopen' : 'Complete';
    button.setAttribute('aria-label', (completed ? 'Reopen: ' : 'Mark complete: ') + item.text);
    row.appendChild(button);
    return row;
  }
  function renderActionList(id, items, decisions = false) {
    const host = $('#' + id);
    if (!host) return;
    host.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'brain-empty';
      empty.textContent = decisions
        ? 'No decisions in this period.'
        : 'No actions match this timeline and status.';
      host.appendChild(empty);
    } else
      items.forEach((item) =>
        host.appendChild(decisions ? makeSourceButton(item, 'decision') : actionRow(item)),
      );
  }
  function renderFollowups(mode = activeMode()) {
    const entries = filteredActions();
    const mineItems = entries.filter((x) => x.mine);
    const waiting = entries.filter((x) => !x.mine);
    const count = $('#followupCount');
    if (count) count.textContent = String(entries.length);
    renderActionList(
      'followupList',
      mode === 'mine' ? mineItems : mode === 'waiting' ? waiting : entries,
    );
    renderActionList('commitmentList', mineItems);
    renderActionList('waitingList', waiting);
    const period = root.SynapMyActions?.filters?.().period || 'all';
    const decisions = (root.SynapBrainUI?.derive(currentRecords).decisions || []).filter((item) =>
      root.SynapActionState.matches(item, period),
    );
    renderActionList('decisionList', decisions, true);
    for (const [id, items] of [
      ['commitmentCount', mineItems],
      ['waitingCount', waiting],
      ['decisionCount', decisions],
    ]) {
      if ($('#' + id)) $('#' + id).textContent = String(items.length);
    }
  }
  const PEOPLE_PREVIEW_LIMIT = 3;
  let peopleExpanded = false,
    peopleQuery = '',
    peopleRows = [];
  function ensurePeopleControls() {
    const section = $('#peopleMemory'),
      heading = section && $('.section-heading', section);
    if (!heading || $('#peopleBrowseToggle')) return;
    const title = $('h2', heading),
      copy = $('.section-copy', heading);
    if (copy) copy.textContent = 'The people in your conversations.';
    const count = document.createElement('span');
    count.id = 'peopleCount';
    count.className = 'count-badge';
    title?.append(' ', count);
    const toggle = document.createElement('button');
    toggle.id = 'peopleBrowseToggle';
    toggle.type = 'button';
    toggle.className = 'people-browse-toggle';
    toggle.setAttribute('aria-controls', 'peopleList peopleSearch');
    heading.appendChild(toggle);
    const search = document.createElement('label');
    search.id = 'peopleSearch';
    search.className = 'people-search';
    search.hidden = true;
    search.innerHTML =
      '<span class="sr-only">Find a person</span><input type="search" placeholder="Find a person…" aria-label="Find a person" autocomplete="off">';
    heading.after(search);
    toggle.addEventListener('click', () => {
      peopleExpanded = !peopleExpanded;
      if (!peopleExpanded) {
        peopleQuery = '';
        $('input', search).value = '';
      }
      renderPeopleRows();
      if (peopleExpanded) $('input', search).focus({ preventScroll: true });
    });
    $('input', search).addEventListener('input', (event) => {
      peopleQuery = event.target.value.trim().toLowerCase();
      renderPeopleRows();
    });
  }
  function renderPeopleRows() {
    ensurePeopleControls();
    const host = $('#peopleList');
    if (!host) return;
    const section = $('#peopleMemory'),
      toggle = $('#peopleBrowseToggle'),
      count = $('#peopleCount'),
      search = $('#peopleSearch');
    peopleRows = peopleRows.filter((person) => !root.SynapPeopleConfirmUI?.isDeleted(person));
    if (count) count.textContent = String(peopleRows.length);
    if (toggle) {
      toggle.hidden = peopleRows.length <= PEOPLE_PREVIEW_LIMIT && !peopleExpanded;
      toggle.textContent = peopleExpanded ? 'Show less' : 'View all (' + peopleRows.length + ')';
      toggle.setAttribute('aria-expanded', String(peopleExpanded));
    }
    if (search) search.hidden = !peopleExpanded;
    if (section) section.dataset.peopleExpanded = String(peopleExpanded);
    const matches = peopleRows.filter(
      (person) =>
        !peopleQuery || (person.name + ' ' + person.detail).toLowerCase().includes(peopleQuery),
    );
    const shown = peopleExpanded ? matches : matches.slice(0, PEOPLE_PREVIEW_LIMIT);
    const signature = JSON.stringify([peopleExpanded, peopleQuery, shown]);
    if (host.synapPeopleSignature === signature) {
      root.SynapMeetingTools?.decoratePeople(peopleRows, currentRecords);
      root.SynapPeopleConfirmUI?.decorate?.();
      return;
    }
    host.synapPeopleSignature = signature;
    host.replaceChildren();
    if (!shown.length) {
      const empty = document.createElement('p');
      empty.className = 'brain-empty';
      empty.textContent = peopleRows.length
        ? 'No matching people. Try another name.'
        : 'People appear here after a conversation is processed.';
      host.appendChild(empty);
      return;
    }
    for (const person of shown) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'person-card';
      button.dataset.person = person.name;
      if (person.id) button.dataset.personId = person.id;
      button.setAttribute('aria-label', 'Recall conversations with ' + person.name);
      const avatar = document.createElement('span');
      avatar.className = 'person-avatar';
      avatar.textContent = person.name.charAt(0).toUpperCase();
      avatar.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span'),
        name = document.createElement('strong'),
        detail = document.createElement('small');
      name.textContent = person.name;
      detail.textContent = person.detail;
      copy.append(name, detail);
      if (person.open) {
        const open = document.createElement('em');
        open.textContent = person.open + ' open follow-up' + (person.open === 1 ? '' : 's');
        copy.appendChild(open);
      }
      button.append(avatar, copy);
      host.appendChild(button);
    }
    root.SynapMeetingTools?.decoratePeople(peopleRows, currentRecords);
    root.SynapPeopleConfirmUI?.decorate?.();
  }
  function renderCanonicalPeople(list) {
    peopleRows = (list || [])
      .filter((p) => p?.name && !mine(p.name))
      .slice()
      .sort((a, b) => new Date(b.last_interaction_at || 0) - new Date(a.last_interaction_at || 0))
      .map((p) => ({
        name: p.name,
        id: p.person_id || '',
        detail:
          p.role && p.role !== 'unknown'
            ? p.role
            : (p.conversation_count || 0) + ' memor' + (p.conversation_count === 1 ? 'y' : 'ies'),
      }));
    renderPeopleRows();
  }
  function renderLocalPeople(list) {
    const api = root.SynapBrainUI;
    if (!api?.derive) return;
    const data = api.derive(list);
    const open = actions().filter((item) => item.state === 'open' && !item.mine);
    peopleRows = (data.people || []).map((p) => ({
      name: p.name,
      last: p.last,
      detail:
        p.role && p.role !== 'unknown'
          ? p.role
          : [...p.topics]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 2)
              .map((x) => x[0])
              .join(' · ') || p.count + ' memories',
      open: open.filter((x) => String(x.owner || '').toLowerCase() === p.name.toLowerCase()).length,
    }));
    renderPeopleRows();
  }
  function accountKey() {
    return signedIn() ? String(root.SynapAuth?.session?.()?.profile?.uid || 'signed-in') : '';
  }
  function resetCanonical(key) {
    canonicalScope = key;
    canonicalPeople = null;
    canonicalFollowups = null;
    canonicalAt = 0;
    canonicalPending = { people: null, followups: null };
    ++canonicalGeneration;
    listStates.people = {};
    listStates.followups = {};
    pendingActions.clear();
    actionMutations.clear();
    actionRevision = 0;
    actionItems.clear();
    actionFeedback('');
  }
  function listStatus(kind) {
    const state = listStates[kind],
      isPeople = kind === 'people',
      list = $(isPeople ? '#peopleList' : '#followupList');
    if (!list) return;
    let notice = $(isPeople ? '#peopleStatus' : '#followupStatus');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = isPeople ? 'peopleStatus' : 'followupStatus';
      notice.className = 'synap-action-status';
      const message = document.createElement('p');
      message.setAttribute('role', 'status');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'button button-secondary button-small';
      retry.textContent = isPeople ? 'Retry People' : 'Retry Follow-ups';
      retry.addEventListener('click', () => refresh(true, kind));
      notice.append(message, retry);
      list.before(notice);
    }
    const cached = Array.isArray(isPeople ? canonicalPeople : canonicalFollowups);
    const scope = isPeople
      ? 'Showing people from saved memories on this device.'
      : 'Saved on this device. Local completion stays on this device.';
    const message = state.error
      ? (isPeople ? 'Could not refresh People. ' : 'Could not refresh Follow-ups. ') +
        (cached ? 'Showing the last loaded list.' : scope)
      : state.loading
        ? cached
          ? 'Refreshing…'
          : 'Loading cloud ' + (isPeople ? 'people' : 'follow-ups') + '… ' + scope
        : !cached
          ? scope
          : '';
    const text = notice.querySelector('p');
    if (text.textContent !== message) text.textContent = message;
    notice.querySelector('button').hidden = !state.error;
    notice.querySelector('button').disabled = Boolean(state.loading);
    notice.hidden = !message;
    notice.setAttribute('aria-busy', String(Boolean(state.loading)));
  }
  function renderPeopleSource() {
    if (Array.isArray(canonicalPeople)) renderCanonicalPeople(canonicalPeople);
    else renderLocalPeople(currentRecords);
    listStatus('people');
  }
  async function loadCanonical(force = false, onlyKind) {
    const api = root.SynapBackend,
      key = accountKey();
    if (key !== canonicalScope) resetCanonical(key);
    if (!key || !api) return false;
    if (
      !force &&
      canonicalAt &&
      Date.now() - canonicalAt < 15000 &&
      canonicalPeople &&
      canonicalFollowups
    )
      return true;
    const generation = canonicalGeneration,
      mutationAtStart = actionRevision;
    const valid = () => generation === canonicalGeneration && key === accountKey();
    const loadOne = (kind, load) => {
      if (canonicalPending[kind]) return canonicalPending[kind];
      const task = (async () => {
        listStates[kind] = { loading: true };
        listStatus(kind);
        try {
          const result = await load();
          if (!valid()) return;
          const rows = kind === 'people' ? result?.people : result?.follow_ups;
          if (!Array.isArray(rows)) throw Error('Invalid list response');
          if (kind === 'people') {
            canonicalPeople = rows;
            root.SynapPeopleConfirmUI?.acceptPeople?.({ people: rows });
          } else
            canonicalFollowups = rows.map((item) => {
              const saved = actionMutations.get(String(item.id));
              return saved?.version > mutationAtStart ? { ...item, state: saved.state } : item;
            });
          listStates[kind] = {};
        } catch (error) {
          if (!valid()) return;
          listStates[kind] = { error: error.message || 'Could not load this list.' };
        }
        if (!valid()) return;
        if (kind === 'people') renderPeopleSource();
        else {
          renderFollowups(activeMode());
          listStatus(kind);
        }
      })().finally(() => {
        if (canonicalPending[kind] === task) canonicalPending[kind] = null;
      });
      canonicalPending[kind] = task;
      return task;
    };
    const requests = [];
    if (!onlyKind || onlyKind === 'people') requests.push(loadOne('people', () => api.people?.()));
    if (!onlyKind || onlyKind === 'followups')
      requests.push(loadOne('followups', () => api.followUps?.('all', 'all')));
    await Promise.allSettled(requests);
    if (
      valid() &&
      ['people', 'followups'].every((kind) => !listStates[kind].error && !listStates[kind].loading)
    )
      canonicalAt = Date.now();
    return valid() && Boolean(canonicalPeople || canonicalFollowups);
  }
  async function refresh(forceCanonical = false, onlyKind) {
    const version = ++refreshGeneration,
      key = accountKey();
    if (key !== canonicalScope) resetCanonical(key);
    dedupe();
    const loaded = await load().catch(() => currentRecords);
    if (version !== refreshGeneration || key !== accountKey()) return;
    currentRecords = loaded;
    renderPeopleSource();
    renderFollowups(activeMode());
    listStatus('followups');
    await loadCanonical(forceCanonical, onlyKind);
  }
  function actionFeedback(message) {
    const node = $('#actionUpdateStatus');
    if (node) {
      node.textContent = message;
      node.hidden = !message;
    }
  }
  async function toggleAction(actionKey, button) {
    const item = actionItems.get(actionKey);
    const key = accountKey(),
      generation = canonicalGeneration;
    if (!item || pendingActions.has(actionKey)) return;
    const state = item.state === 'open' ? 'done' : 'open';
    actionFeedback('');
    pendingActions.add(actionKey);
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      if (item.id) {
        if (!root.SynapBackend?.resolveFollowUp) throw Error('Reconnect to save this action.');
        await root.SynapBackend.resolveFollowUp(item.id, state);
        if (key !== accountKey() || generation !== canonicalGeneration) return;
        actionMutations.set(item.id, { version: ++actionRevision, state });
        canonicalFollowups = canonicalFollowups.map((x) =>
          String(x.id) === item.id ? { ...x, state } : x,
        );
      } else {
        const saved = await root.SynapActionState.save(item, state, key);
        if (key !== accountKey() || generation !== canonicalGeneration) return;
        ++refreshGeneration; // A read started before the write must not undo it.
        currentRecords = currentRecords.map((r) => (r.id === saved.id ? saved : r));
      }
      actionFeedback(
        state === 'done'
          ? 'Action completed' + (item.id ? '' : ' on this device') + '. Find it under Completed.'
          : 'Action reopened.',
      );
      root.dispatchEvent?.(
        new CustomEvent('synap-follow-up-updated', { detail: { id: item.id || actionKey, state } }),
      );
    } catch (error) {
      if (key === accountKey() && generation === canonicalGeneration)
        actionFeedback(error.message || 'Could not save this action. Please retry.');
    } finally {
      if (generation === canonicalGeneration) {
        pendingActions.delete(actionKey);
        renderFollowups();
        renderPeopleSource();
      }
    }
  }
  function recordingForInsight(card) {
    const id = card?.dataset?.recordingId;
    if (id) return id;
    const dt = card?.querySelector('time')?.dateTime;
    if (!dt) return '';
    const target = new Date(dt).getTime();
    return currentRecords.find((r) => new Date(r.createdAt).getTime() === target)?.id || '';
  }
  function bind() {
    document.addEventListener(
      'click',
      (event) => {
        const done = event.target.closest?.('.synap-follow-done');
        if (done) {
          event.preventDefault();
          event.stopImmediatePropagation();
          toggleAction(done.dataset.actionKey, done);
          return;
        }
        const person = event.target.closest?.('.person-card');
        if (person) {
          event.preventDefault();
          event.stopImmediatePropagation();
          openAsk(person.dataset.person || '');
          return;
        }
        const tab = event.target.closest?.('.followup-tabs button[data-follow]');
        if (tab) {
          event.preventDefault();
          event.stopImmediatePropagation();
          $$('.followup-tabs button').forEach((x) => x.classList.toggle('active', x === tab));
          renderFollowups(tab.dataset.follow);
          return;
        }
        const insight = event.target.closest?.('.insight-open');
        if (insight) {
          const id = recordingForInsight(insight.closest('.insight-card'));
          if (id) {
            event.preventDefault();
            event.stopImmediatePropagation();
            openSource(id, 0);
          }
          return;
        }
        const top = event.target.closest?.('.insight-card .insight-top');
        if (top && top.tagName !== 'SUMMARY' && !event.target.closest?.('.synap-merge-check')) {
          const id = recordingForInsight(top.closest('.insight-card'));
          if (id) {
            event.preventDefault();
            openSource(id, 0);
          }
        }
      },
      true,
    );
    root.addEventListener('synap-action-filters-changed', () => {
      actionFeedback('');
      renderFollowups();
    });
    $('#datePicker')?.addEventListener('change', () => setTimeout(() => refresh(false), 20));
    [
      'synap-memory-ready',
      'synap-cloud-history-updated',
      'synap-transcript-updated',
      'synap-processing-complete',
    ].forEach((n) =>
      root.addEventListener(n, () => {
        canonicalAt = 0;
        setTimeout(() => refresh(true), 50);
      }),
    );
    root.SynapAuth?.onChange?.(() => {
      const key = accountKey();
      if (key !== canonicalScope) {
        resetCanonical(key);
        ++refreshGeneration;
      }
      setTimeout(() => refresh(true), 20);
    });
    root.addEventListener('synap-person-deleted', () => {
      renderPeopleSource();
      canonicalAt = 0;
      refresh(true, 'people');
    });
    root.addEventListener('synap-person-updated', () => {
      canonicalAt = 0;
      setTimeout(() => refresh(true), 20);
    });
  }
  function style() {
    if ($('#synap-interaction-style')) return;
    const s = document.createElement('style');
    s.id = 'synap-interaction-style';
    s.textContent =
      '.synap-action-status{font-size:12px;line-height:1.4;margin:0 0 8px}.synap-action-status p{margin:0 0 6px}.insight-card .insight-top{cursor:pointer}.person-card,.brain-action-row,.followup-tabs button{cursor:pointer}.synap-follow-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center}.synap-follow-done{border:1px solid var(--border,#d9e2ec);background:var(--surface,#fff);color:inherit;border-radius:9px;padding:6px 8px;font:inherit;font-size:10px;font-weight:750;cursor:pointer}.synap-follow-done:disabled{opacity:.55;cursor:wait}';
    document.head.appendChild(s);
  }
  function init() {
    style();
    dedupe();
    bind();
    setTimeout(() => refresh(true), 80);
    setTimeout(() => refresh(false), 350);
  }
  root.SynapInteractionSurfaces = Object.freeze({
    refresh,
    dedupe,
    renderFollowups,
    openAsk,
    openSource,
    loadCanonical,
  });
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
