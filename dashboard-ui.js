/* Four persistent destinations. Navigation never recreates capture or source nodes. */
(function (root) {
  'use strict';
  if (root.SynapDashboardUI?.__stableShell) return;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const ACTION_VIEWS = {
    dailyFocus: 'dailyFocus',
    followupInbox: 'followupInbox',
    peopleMemory: 'peopleMemory',
  };
  const VIEW_IDS = {
    today: '#memoryWorkspace',
    library: '#library',
    actions: '#myActions',
    ask: '#ask',
  };
  let activeView = 'today';
  const positions = new Map();
  function normalizeView(view) {
    if (view === 'weekly' || view === 'memories') return 'today';
    return ACTION_VIEWS[view] ? 'actions' : VIEW_IDS[view] ? view : 'today';
  }
  function viewForHref(href) {
    const key = href?.slice(1);
    if (key === 'memoryWeekPanel' || key === 'synapWeeklyReview') return 'weekly';
    if (key === 'insights') return 'memories';
    if (key === 'myActions') return 'actions';
    return key;
  }
  function syncNav(view) {
    activeView = normalizeView(view);
    document.body.dataset.synapView = activeView;
    for (const [key, selector] of Object.entries(VIEW_IDS)) {
      const node = $(selector);
      if (node) node.hidden = key !== activeView;
    }
    $$('.brain-tabs a').forEach((link) => {
      const active = normalizeView(viewForHref(link.getAttribute('href'))) === activeView;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }
  function setView(view, scroll = true) {
    const next = normalizeView(view),
      changed = next !== activeView;
    if (changed) positions.set(activeView, window.scrollY);
    if (ACTION_VIEWS[view]) root.SynapMyActions?.select(view);
    if (next === 'today') root.SynapMemoryWorkspace?.select(view === 'weekly' ? 'week' : 'day');
    syncNav(next);
    const target = $(VIEW_IDS[next]);
    if (scroll && target) {
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      window.scrollTo({ top: changed ? positions.get(next) || 0 : 0, behavior: 'instant' });
    }
    root.dispatchEvent(new CustomEvent('synap-view-changed', { detail: { view: next } }));
    return Boolean(target);
  }
  function reveal(target) {
    if (typeof target === 'string') target = document.getElementById(target.replace(/^#/, ''));
    if (!target) return;
    if (target.closest('#ask')) setView('ask', false);
    else if (target.closest('#myActions')) setView('actions', false);
    else if (target.closest('#library')) setView('library', false);
    else if (target.closest('#memoryWorkspace'))
      setView(target.closest('#memoryWeekPanel') ? 'weekly' : 'today', false);
  }
  function bindTabs() {
    $('.brain-tabs')?.addEventListener('click', (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setView(viewForHref(link.getAttribute('href')));
      history.replaceState(history.state, '', location.pathname + location.search);
    });
    $('.brand')?.addEventListener('click', (event) => {
      event.preventDefault();
      setView('today');
    });
    addEventListener('hashchange', () => {
      if (location.hash) setView(viewForHref(location.hash));
    });
    addEventListener('synap-memory-period-changed', () => {
      if (activeView === 'today') syncNav('today');
    });
  }
  function bindDailyWorkspace() {
    const tabs = $('.focus-tabs');
    if (!tabs || tabs.dataset.bound) return;
    tabs.dataset.bound = '1';
    const buttons = [...tabs.querySelectorAll('[data-focus-tab]')];
    function select(button, focus = false) {
      for (const item of buttons) {
        const active = item === button;
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
        const panel = document.getElementById(item.dataset.focusTab);
        if (panel) panel.hidden = !active;
      }
      if (focus) button.focus();
    }
    tabs.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-focus-tab]');
      if (button) select(button);
    });
    tabs.addEventListener('keydown', (event) => {
      const index = buttons.indexOf(event.target);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      select(buttons[next], true);
    });
  }

  function init() {
    bindTabs();
    bindDailyWorkspace();
    syncNav('today');
    if (location.hash) setView(viewForHref(location.hash));
  }
  root.SynapDashboardUI = Object.freeze({
    __stableShell: true,
    setView,
    syncNav,
    reveal,
    observeSections() {},
  });
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
