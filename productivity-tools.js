/* Synap productivity layer: weekly review, grounded calendar export and portable AI context. */
(function (root) {
  'use strict';
  const DB = 'dk-pendant-recordings',
    STYLE = 'synap-productivity-style';
  const WEEK_PAGE_SIZE = 5;
  let records = [],
    activeWeekView = 'conversations',
    detailVisibleCount = WEEK_PAGE_SIZE;
  let hydratedWeekKey = '',
    hydrationPromise = null,
    readEpoch = 0,
    refreshTimer = 0,
    selectedWeekKey = '';
  let weekStatus = '',
    localStatus = '';
  const $ = (s, h = document) => h.querySelector(s);
  function day(v) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
  }
  function parseDay(v) {
    const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : new Date(v);
  }
  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function weekRange(value) {
    const d = parseDay(value || day(Date.now())),
      js = d.getDay(),
      delta = js === 0 ? -6 : 1 - js,
      start = addDays(d, delta),
      end = addDays(start, 6);
    return { start: day(start), end: day(end), startDate: start, endDate: end };
  }
  function weekDays(range) {
    const out = [];
    for (let i = 0; i < 7; i++) out.push(day(addDays(range.startDate, i)));
    return out;
  }
  function meeting(r) {
    return r?.meeting || {};
  }
  function conversations(r) {
    const m = meeting(r),
      a =
        Array.isArray(m.conversations) && m.conversations.length
          ? m.conversations
          : r?.conversations;
    return Array.isArray(a) ? a : [];
  }
  function textOf(v) {
    if (typeof v === 'string') return v.trim();
    if (v && typeof v.text === 'string') return v.text.trim();
    return '';
  }
  function offset(v, c) {
    const x = v?.start_ms ?? (v?.start_seconds != null ? Number(v.start_seconds) * 1000 : null);
    if (x != null && Number.isFinite(Number(x))) return Number(x);
    const y = c?.start_ms ?? (c?.start_seconds != null ? Number(c.start_seconds) * 1000 : null);
    return Number.isFinite(Number(y)) ? Number(y) : 0;
  }
  function clock(r, ms) {
    const base = new Date(r.createdAt || 0).getTime();
    return Number.isFinite(base)
      ? new Date(base + Math.max(0, Number(ms) || 0)).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        })
      : '';
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
  function scoped(range) {
    return records.filter((r) => {
      const d = day(r.createdAt);
      return d >= range.start && d <= range.end;
    });
  }
  function unique(list, key) {
    const seen = new Set();
    return list.filter((x) => {
      const k = key(x);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  function extract(list) {
    let decisions = [],
      actions = [],
      followups = [],
      convs = [];
    const topics = new Map();
    for (const r of list) {
      const m = meeting(r),
        cs = conversations(r);
      for (const c of cs) {
        convs.push({ r, c, text: c.title || 'Conversation', startMs: offset(c) });
        for (const d of c.decisions || []) {
          const text = textOf(d);
          if (text) decisions.push({ r, c, value: d, text, startMs: offset(d, c) });
        }
        for (const a of c.action_items || []) {
          const text = String(a?.task || '').trim();
          if (text)
            actions.push({
              r,
              c,
              value: a,
              text,
              startMs: offset(a, c),
              due: String(a?.due_date || ''),
            });
        }
        for (const f of c.follow_ups || []) {
          const text = textOf(f);
          if (text) followups.push({ r, c, value: f, text, startMs: offset(f, c) });
        }
        for (const t of c.topics || []) {
          const k = String(t || '').trim();
          if (k) topics.set(k, (topics.get(k) || 0) + 1);
        }
      }
      for (const d of m.decisions || []) {
        const text = textOf(d);
        if (text) decisions.push({ r, c: null, value: d, text, startMs: offset(d) });
      }
      for (const a of m.action_items || []) {
        const text = String(a?.task || '').trim();
        if (text)
          actions.push({
            r,
            c: null,
            value: a,
            text,
            startMs: offset(a),
            due: String(a?.due_date || ''),
          });
      }
      for (const f of m.follow_ups || []) {
        const text = textOf(f);
        if (text) followups.push({ r, c: null, value: f, text, startMs: offset(f) });
      }
      for (const t of m.topics || r.topics || []) {
        const k = String(t || '').trim();
        if (k) topics.set(k, (topics.get(k) || 0) + 1);
      }
    }
    const key = (x) =>
      String(x.r.id) + '|' + String(x.startMs) + '|' + String(x.text).toLowerCase();
    decisions = unique(decisions, key);
    actions = unique(actions, key);
    followups = unique(followups, key);
    convs = unique(convs, key);
    // IndexedDB getAll() is key-ordered, not chronological. Sorting before paging
    // prevents today's evidence from falling behind an older, truncated week.
    const at = (x) =>
      (new Date(x.r.createdAt).getTime() || 0) + Math.max(0, Number(x.startMs) || 0);
    const newest = (a, b) => at(b) - at(a) || String(a.r.id).localeCompare(String(b.r.id));
    for (const entries of [decisions, actions, followups, convs]) entries.sort(newest);
    return {
      decisions,
      actions,
      followups,
      convs,
      topics: [...topics].sort((a, b) => b[1] - a[1]),
    };
  }
  function buildWeekSummary(list, range) {
    const e = extract(list),
      activeDays = new Set(list.map((r) => day(r.createdAt))).size;
    return {
      range,
      recordings: list.length,
      activeDays,
      conversations: e.convs.length,
      decisions: e.decisions.length,
      commitments: e.actions.length,
      followUps: e.followups.length,
      topics: e.topics.slice(0, 5).map((x) => x[0]),
      narrative: list.length
        ? `This week synap remembers ${e.convs.length} conversation${e.convs.length === 1 ? '' : 's'} across ${activeDays} day${activeDays === 1 ? '' : 's'}, with ${e.decisions.length} decision${e.decisions.length === 1 ? '' : 's'} and ${e.actions.length} commitment${e.actions.length === 1 ? '' : 's'}.`
        : 'No processed memories in this week yet.',
    };
  }
  function collectDueItems(list) {
    return extract(list)
      .actions.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.due) && !Number.isNaN(Date.parse(x.due)))
      .sort(
        (a, b) => a.due.localeCompare(b.due) || new Date(a.r.createdAt) - new Date(b.r.createdAt),
      );
  }
  function escIcs(s) {
    return String(s || '')
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }
  function icsDate(d) {
    return String(d || '').replace(/-/g, '');
  }
  function buildICS(items) {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Synap//Memory Actions//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];
    for (const x of items) {
      const next = day(addDays(parseDay(x.due), 1));
      lines.push(
        'BEGIN:VEVENT',
        'UID:synap-' + encodeURIComponent(x.r.id) + '-' + x.startMs + '@memory',
        'DTSTAMP:' +
          new Date()
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d{3}Z$/, 'Z'),
        'DTSTART;VALUE=DATE:' + icsDate(x.due),
        'DTEND;VALUE=DATE:' + icsDate(next),
        'SUMMARY:' + escIcs(x.text),
        'DESCRIPTION:' +
          escIcs(
            'Synap memory source: ' +
              (x.c?.title || x.r.name || 'Conversation') +
              ' · ' +
              clock(x.r, x.startMs) +
              ' · recording ' +
              x.r.id,
          ),
        'END:VEVENT',
      );
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }
  function download(name, type, text) {
    const blob = new Blob([text], { type }),
      url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function buildContext(list, label) {
    const out = [
      '# Synap memory context',
      label,
      '',
      'Use only the grounded memory below. Recording IDs and timestamps are source references.',
      '',
    ];
    for (const r of list.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
      const cs = conversations(r);
      if (!cs.length) continue;
      out.push('## ' + (r.name || 'Recording') + ' — ' + new Date(r.createdAt).toLocaleString());
      out.push('Recording ID: `' + r.id + '`');
      for (const c of cs) {
        const at = offset(c);
        out.push('', '### ' + (c.title || 'Conversation') + ' · ' + clock(r, at));
        if (c.summary) out.push(c.summary);
        for (const d of c.decisions || []) {
          const t = textOf(d);
          if (t) out.push('- Decision [' + clock(r, offset(d, c)) + ']: ' + t);
        }
        for (const a of c.action_items || []) {
          if (a?.task)
            out.push(
              '- Action [' +
                clock(r, offset(a, c)) +
                ']: ' +
                a.task +
                (a.owner ? ' — ' + a.owner : '') +
                (a.due_date ? ' · due ' + a.due_date : ''),
            );
        }
        for (const f of c.follow_ups || []) {
          const t = textOf(f);
          if (t) out.push('- Follow-up [' + clock(r, offset(f, c)) + ']: ' + t);
        }
      }
      out.push('');
    }
    return out.join('\n').trim();
  }
  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const old = button.textContent;
      button.textContent = 'Copied ✓';
      setTimeout(() => (button.textContent = old), 1400);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }
  function openSource(r, startMs) {
    // A just-processed recording may be newer than the Library's mounted list.
    // Refresh its date locally even when the picker already shows that day.
    const picker = $('#datePicker');
    if (picker) {
      picker.value = day(r.createdAt);
      const event = new Event('change', { bubbles: true });
      event.__synapCloudInternal = true;
      picker.dispatchEvent(event);
    }
    if (root.SynapProvenance?.openSource) {
      if (root.SynapProvenance.refresh)
        return Promise.resolve(root.SynapProvenance.refresh()).then(() =>
          root.SynapProvenance.openSource(r.id, startMs),
        );
      return root.SynapProvenance.openSource(r.id, startMs);
    }
    if (root.SynapDashboardUI?.setView) root.SynapDashboardUI.setView('library', true);
    else location.hash = '#library';
    return true;
  }
  function inject() {
    if (document.getElementById(STYLE)) return;
    const s = document.createElement('style');
    s.id = STYLE;
    s.textContent = `.synap-weekly{margin-top:14px;padding-top:14px;border-top:1px solid var(--border,#e2e8f0)}.synap-weekly-head,.synap-weekly-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.synap-weekly-head strong{font-size:13px}.synap-weekly-head span{font-size:11px;color:var(--muted,#64748b)}.synap-weekly-copy{margin:8px 0 10px;font-size:12px;line-height:1.5}.synap-weekly-metrics{display:flex;gap:7px;flex-wrap:wrap}.synap-week-metric{border:0;padding:6px 9px;border-radius:999px;background:rgba(127,145,165,.1);color:inherit;font:inherit;font-size:10px;font-weight:750;cursor:pointer}.synap-week-metric[aria-pressed=true]{outline:2px solid currentColor;outline-offset:1px}.synap-week-detail{display:grid;gap:6px;margin:9px 0}.synap-week-source{width:100%;display:grid;grid-template-columns:74px minmax(0,1fr);gap:8px;text-align:left;border:1px solid var(--border,#e2e8f0);background:var(--surface,#fff);color:inherit;border-radius:10px;padding:8px;font:inherit;cursor:pointer}.synap-week-source time{font-size:10px;color:var(--muted,#64748b)}.synap-week-source strong{display:block;font-size:11px}.synap-week-source small{display:block;margin-top:2px;color:var(--muted,#64748b)}.synap-weekly-actions button,.synap-calendar-add{border:1px solid var(--border,#d9e2ec);background:var(--surface,#fff);color:inherit;border-radius:10px;padding:7px 9px;font:inherit;font-size:11px;font-weight:750;cursor:pointer}.synap-due{margin-top:12px;display:grid;gap:6px}.synap-due-row{display:grid;grid-template-columns:72px minmax(0,1fr) auto;align-items:center;gap:7px;padding:7px 0;border-top:1px solid var(--border,#edf1f5);font-size:11px}.synap-due-source{border:0;background:transparent;color:inherit;text-align:left;padding:0;font:inherit;cursor:pointer}.synap-due-source strong{display:block;font-size:11px}.synap-due-source small{display:block;color:var(--muted,#64748b);margin-top:2px}@media(max-width:560px){.synap-due-row{grid-template-columns:62px minmax(0,1fr)}.synap-due-row .synap-calendar-add{grid-column:2}}`;
    document.head.appendChild(s);
  }
  function ensure() {
    const brief = $('#memoryWeekPanel') || $('.day-brief');
    if (!brief || $('#synapWeeklyReview')) return;
    const node = document.createElement('section');
    node.id = 'synapWeeklyReview';
    node.className = 'synap-weekly';
    node.innerHTML =
      '<div class="synap-weekly-head"><strong>Week in memory</strong><span id="synapWeekRange" class="sr-only"></span><button id="synapRefreshWeek" type="button" aria-label="Refresh weekly review">Refresh</button></div><p id="synapWeekNarrative" class="synap-weekly-copy"></p><div id="synapWeekMetrics" class="synap-weekly-metrics"></div><div id="synapWeekDetail" class="synap-week-detail"></div><div class="synap-week-pagination"><span id="synapWeekCount"></span><button id="synapWeekMore" type="button" hidden>Show more</button></div><p id="synapWeekStatus" class="synap-week-status" role="status" hidden></p><details class="memory-week-exports"><summary>Export &amp; calendar</summary><div class="synap-weekly-actions"><button id="synapCopyDay" type="button">Copy selected day for AI</button><button id="synapCopyWeek" type="button">Copy week for AI</button><button id="synapCalendarAll" type="button">Add due items to calendar</button></div><div id="synapDueList" class="synap-due"></div></details>';
    brief.appendChild(node);
    const navigation = $('.memory-week-navigation');
    if (navigation) {
      const refresh = $('#synapRefreshWeek');
      refresh.innerHTML = '<svg aria-hidden="true"><use href="#i-refresh"/></svg>';
      refresh.title = 'Refresh weekly review';
      navigation.appendChild(refresh);
      node.querySelector('.synap-weekly-head').classList.add('sr-only');
    }
    $('#synapCopyDay')?.addEventListener('click', (e) =>
      copy(
        buildContext(
          records.filter((r) => day(r.createdAt) === ($('#datePicker')?.value || day(Date.now()))),
          'Selected day',
        ),
        e.currentTarget,
      ),
    );
    $('#synapCopyWeek')?.addEventListener('click', (e) => {
      const range = weekRange($('#datePicker')?.value || day(Date.now()));
      copy(buildContext(scoped(range), range.start + ' to ' + range.end), e.currentTarget);
    });
    $('#synapCalendarAll')?.addEventListener('click', () => {
      const range = weekRange($('#datePicker')?.value || day(Date.now())),
        items = collectDueItems(scoped(range));
      if (items.length)
        download(
          'synap-due-' + range.start + '.ics',
          'text/calendar;charset=utf-8',
          buildICS(items),
        );
    });
  }
  function detailItems(kind, e) {
    return kind === 'conversations' ? e.convs : kind === 'decisions' ? e.decisions : e.actions;
  }
  function renderDetail(kind, e) {
    const host = $('#synapWeekDetail'),
      more = $('#synapWeekMore'),
      count = $('#synapWeekCount');
    if (!host) return;
    const entries = kind
        ? detailItems(kind, e)
            .slice()
            .sort(
              (a, b) => new Date(b.r.createdAt) - new Date(a.r.createdAt) || a.startMs - b.startMs,
            )
        : [],
      visible = entries.slice(0, detailVisibleCount);
    host.replaceChildren();
    host.hidden = !kind;
    if (more) {
      more.hidden = !kind || visible.length >= entries.length;
      more.textContent =
        'Show ' + Math.min(WEEK_PAGE_SIZE, entries.length - visible.length) + ' more';
      more.onclick = () => {
        detailVisibleCount += WEEK_PAGE_SIZE;
        render();
      };
    }
    if (count) {
      count.hidden = !kind || !entries.length;
      count.textContent =
        visible.length +
        ' of ' +
        entries.length +
        ' ' +
        (entries.length === 1 ? kind.slice(0, -1) : kind);
    }
    if (!kind) return;
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'brain-empty';
      empty.textContent =
        kind === 'conversations'
          ? 'No processed conversation details for this week yet. Saved audio appears in Library while its memory is being prepared.'
          : 'No ' + kind + ' found in this week’s processed conversations.';
      host.appendChild(empty);
      return;
    }
    let previousDay = '';
    for (const x of visible) {
      const sourceDay = day(x.r.createdAt);
      if (sourceDay !== previousDay) {
        const heading = document.createElement('h3');
        heading.className = 'memory-timeline-day';
        heading.textContent = new Date(x.r.createdAt).toLocaleDateString([], {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
        });
        host.appendChild(heading);
        previousDay = sourceDay;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'synap-week-source';
      b.dataset.recordingId = x.r.id;
      b.dataset.offsetMs = String(x.startMs || 0);
      const t = document.createElement('time');
      t.textContent = clock(x.r, x.startMs);
      t.dateTime = new Date(new Date(x.r.createdAt).getTime() + (x.startMs || 0)).toISOString();
      const copy = document.createElement('span'),
        strong = document.createElement('strong'),
        small = document.createElement('small');
      strong.textContent = x.text || x.c?.title || 'Conversation';
      small.textContent =
        x.c?.summary ||
        (x.c?.title && x.c.title !== strong.textContent ? x.c.title : '') ||
        x.r.name ||
        'Open source';
      copy.append(strong, small);
      b.append(t, copy);
      b.addEventListener('click', () => openSource(x.r, x.startMs));
      host.appendChild(b);
    }
  }
  function render() {
    ensure();
    const status = $('#synapWeekStatus');
    if (status) {
      status.hidden = !(localStatus || weekStatus);
      status.textContent = localStatus || weekStatus;
    }
    const refreshButton = $('#synapRefreshWeek');
    if (refreshButton) refreshButton.disabled = Boolean(hydrationPromise);
    const range = weekRange($('#datePicker')?.value || day(Date.now())),
      list = scoped(range),
      e = extract(list),
      s = buildWeekSummary(list, range),
      due = collectDueItems(list);
    if ($('#synapWeekRange')) $('#synapWeekRange').textContent = range.start + ' – ' + range.end;
    if ($('#synapWeekNarrative'))
      $('#synapWeekNarrative').textContent = s.conversations
        ? s.activeDays +
          ' active day' +
          (s.activeDays === 1 ? '' : 's') +
          (s.topics.length ? ' · ' + s.topics.slice(0, 3).join(' · ') : '')
        : s.narrative;
    const metrics = $('#synapWeekMetrics');
    if (metrics) {
      metrics.replaceChildren();
      [
        ['conversations', s.conversations],
        ['decisions', s.decisions],
        ['commitments', s.commitments],
      ].forEach(([kind, count]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'synap-week-metric';
        b.dataset.weekView = kind;
        b.textContent = count + ' ' + (count === 1 ? kind.slice(0, -1) : kind);
        b.setAttribute('aria-pressed', String(activeWeekView === kind));
        b.addEventListener('click', () => {
          activeWeekView = activeWeekView === kind ? '' : kind;
          detailVisibleCount = WEEK_PAGE_SIZE;
          render();
        });
        metrics.appendChild(b);
      });
    }
    renderDetail(activeWeekView, e);
    const all = $('#synapCalendarAll');
    if (all) {
      all.hidden = !due.length;
      all.textContent = due.length
        ? 'Add ' + due.length + ' due item' + (due.length === 1 ? '' : 's') + ' to calendar'
        : 'Add due items to calendar';
    }
    const host = $('#synapDueList');
    if (host)
      host.replaceChildren(
        ...due.slice(0, 12).map((x) => {
          const row = document.createElement('div');
          row.className = 'synap-due-row';
          const d = document.createElement('time');
          d.textContent = new Date(x.due + 'T12:00:00').toLocaleDateString([], {
            day: 'numeric',
            month: 'short',
          });
          const source = document.createElement('button');
          source.type = 'button';
          source.className = 'synap-due-source';
          const strong = document.createElement('strong'),
            small = document.createElement('small');
          strong.textContent = x.text;
          small.textContent =
            (x.c?.title || x.r.name || 'Conversation') + ' · ' + clock(x.r, x.startMs);
          source.append(strong, small);
          source.addEventListener('click', () => openSource(x.r, x.startMs));
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'synap-calendar-add';
          b.textContent = '+ Calendar';
          b.addEventListener('click', () =>
            download('synap-' + x.due + '.ics', 'text/calendar;charset=utf-8', buildICS([x])),
          );
          row.append(d, source, b);
          return row;
        }),
      );
  }
  function canHydrateWeek() {
    try {
      return Boolean(
        root.SynapCloudHistory?.restore &&
          root.SynapAuth?.isSignedIn?.() &&
          !root.SynapCloudHistory?.busy?.(),
      );
    } catch (_) {
      return false;
    }
  }
  async function hydrateWeek(range) {
    const key = range.start + '|' + range.end;
    if (hydratedWeekKey === key) return;
    // A request for another week must wait and then run, not return the previous
    // week's promise as though the new range had also been restored.
    if (hydrationPromise) {
      await hydrationPromise;
      return hydrateWeek(range);
    }
    if (!canHydrateWeek()) return;
    weekStatus = 'Updating weekly history…';
    render();
    hydrationPromise = (async () => {
      let changed = 0,
        complete = true;
      try {
        for (const d of weekDays(range)) {
          if (!canHydrateWeek()) {
            complete = false;
            break;
          }
          const result = await root.SynapCloudHistory.restore(true, { day: d, transcript: false });
          if (!result || result.error || result.skipped) complete = false;
          changed += (result?.restored || 0) + (result?.updated || 0);
        }
        if (complete) hydratedWeekKey = key;
        weekStatus = complete
          ? ''
          : 'Some history could not be refreshed. Showing saved conversations — use Refresh to try again.';
        if (changed)
          root.dispatchEvent?.(
            new CustomEvent('synap-week-hydrated', {
              detail: { start: range.start, end: range.end, changed },
            }),
          );
      } catch (_) {
        weekStatus =
          'History is unavailable right now. Showing saved conversations — use Refresh to try again.';
      }
    })().finally(() => {
      hydrationPromise = null;
      render();
    });
    render();
    return hydrationPromise;
  }
  async function refreshLocal() {
    const epoch = ++readEpoch;
    try {
      const fresh = await load();
      if (epoch !== readEpoch) return;
      records = fresh;
      localStatus = '';
      render();
    } catch (_) {
      if (epoch !== readEpoch) return;
      localStatus = 'Could not refresh saved conversations. Use Refresh to try again.';
      render(); // Preserve the last successful snapshot instead of painting zero.
    }
  }
  async function refresh(hydrate = true) {
    const range = weekRange($('#datePicker')?.value || day(Date.now()));
    await refreshLocal();
    if (hydrate) {
      await hydrateWeek(range);
      await refreshLocal();
    }
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(false), 60);
  }

  function init() {
    inject();
    ensure();
    const range = weekRange($('#datePicker')?.value || day(Date.now()));
    selectedWeekKey = range.start;
    refresh(true);
    $('#datePicker')?.addEventListener('change', (event) => {
      const next = weekRange($('#datePicker')?.value || day(Date.now())).start;
      const changed = next !== selectedWeekKey;
      selectedWeekKey = next;
      if (changed) {
        activeWeekView = 'conversations';
        detailVisibleCount = WEEK_PAGE_SIZE;
      }
      // Same-day cloud hydration is a data update, not a request to collapse the review.
      refresh(changed && !event.__synapCloudInternal);
    });
    $('#synapRefreshWeek')?.addEventListener('click', () => {
      hydratedWeekKey = '';
      weekStatus = '';
      refresh(true);
    });
    [
      'synap-cloud-history-updated',
      'synap-memory-ready',
      'synap-transcript-updated',
      'synap-processing-complete',
      'synap-recording-saved',
    ].forEach((n) => root.addEventListener(n, scheduleRefresh));
    root.SynapAuth?.onChange?.(() => {
      hydratedWeekKey = '';
      setTimeout(() => refresh(true), 40);
    });
  }
  root.SynapProductivity = {
    weekRange,
    weekDays,
    buildWeekSummary,
    collectDueItems,
    buildContext,
    buildICS,
    refresh,
    openSource,
    hydrateWeek,
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
