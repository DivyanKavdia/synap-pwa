/* Keep action surfaces mounted while switching their visible panel. */
(function (root) {
  'use strict';
  const panels = [
    ['ask', 'Ask Synap'],
    ['dailyFocus', 'Next steps'],
    ['followupInbox', 'Follow-ups'],
    ['peopleMemory', 'People'],
  ];
  let selected = 'ask',
    section,
    tablist,
    content;
  const scrollPositions = new Map();

  function select(id, { focus = false } = {}) {
    if (!section || !panels.some(([key]) => key === id)) return false;
    const changed = selected !== id;
    if (changed) scrollPositions.set(selected, content.scrollTop);
    selected = id;
    for (const [key] of panels) {
      const active = key === id,
        tab = document.getElementById('actionsTab-' + key),
        panel = document.getElementById(key);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (panel) panel.hidden = !active;
    }
    const filters = document.getElementById('actionFilters');
    if (filters) filters.hidden = !['dailyFocus', 'followupInbox'].includes(id);
    if (changed) content.scrollTop = scrollPositions.get(id) || 0;
    if (focus) document.getElementById('actionsTab-' + id).focus({ preventScroll: true });
    return true;
  }

  function reveal(target) {
    if (typeof target === 'string') target = document.getElementById(target.replace(/^#/, ''));
    const panel = target?.closest('[data-actions-panel]');
    if (panel && section?.contains(panel)) select(panel.id);
  }

  function filters() {
    return {
      period: document.getElementById('actionsTimeline')?.value || 'all',
      state: document.getElementById('actionsState')?.value || 'open',
    };
  }

  function mount() {
    const main = document.querySelector('main');
    if (!main || panels.some(([id]) => !document.getElementById(id))) return;
    if (!section) {
      section = document.createElement('section');
      section.id = 'myActions';
      section.className = 'section-card my-actions';
      section.setAttribute('aria-labelledby', 'myActionsTitle');
      section.innerHTML =
        '<div class="section-heading"><h2 id="myActionsTitle">My actions</h2></div><div class="actions-tabs" role="tablist" aria-label="My actions"></div><div id="actionFilters" class="action-filters" hidden><label>Timeline<select id="actionsTimeline"><option value="all">All time</option><option value="last-week">Last week</option><option value="today">Today</option><option value="this-week">This week</option><option value="next-week">Next week</option><option value="next-month">Next 30 days</option><option value="overdue">Overdue</option><option value="undated">No due date</option></select></label><label>Status<select id="actionsState"><option value="open">Open</option><option value="done">Completed</option><option value="all">All statuses</option></select></label><p id="actionsDay">Tasks use due dates, or recording dates when undated. Decisions use recording dates.</p><p id="actionUpdateStatus" role="status" hidden></p></div><div id="myActionsContent" class="actions-content"></div>';
      tablist = section.querySelector('.actions-tabs');
      content = section.querySelector('.actions-content');
      for (const [id, label] of panels) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.id = 'actionsTab-' + id;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', id);
        tab.textContent = label;
        tablist.appendChild(tab);
      }
      main.insertBefore(section, document.getElementById('library'));
      tablist.addEventListener('click', (event) => {
        const tab = event.target.closest('[role="tab"]');
        if (tab) select(tab.getAttribute('aria-controls'));
      });
      tablist.addEventListener('keydown', (event) => {
        const tabs = [...tablist.children],
          index = tabs.indexOf(event.target);
        if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        select(tabs[next].getAttribute('aria-controls'), { focus: true });
      });
      document.getElementById('actionFilters').addEventListener('change', () => {
        content.scrollTop = 0;
        root.dispatchEvent(new Event('synap-action-filters-changed'));
      });
    }
    for (const [id] of panels) {
      const panel = document.getElementById(id);
      if (content.contains(panel)) continue;
      panel.dataset.actionsPanel = '';
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', 'actionsTab-' + id);
      panel.tabIndex = 0;
      panel.classList.remove('section-card');
      content.appendChild(panel);
    }
    select(selected);
  }

  function init() {
    mount();
    const main = document.querySelector('main');
    if (main) new MutationObserver(mount).observe(main, { childList: true });
  }
  root.SynapMyActions = Object.freeze({ select, reveal, filters });
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
