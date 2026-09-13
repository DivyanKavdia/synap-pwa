/* Day and week share one memory workspace; source cards stay mounted. */
(function (root) {
  'use strict';
  const periods = ['day', 'week'];
  const $ = (id) => document.getElementById(id);

  function select(period, { focus = false } = {}) {
    if (!periods.includes(period)) return false;
    for (const key of periods) {
      const active = key === period;
      const tab = $('memoryTab-' + key);
      const panel = $(key === 'day' ? 'memoryDayPanel' : 'memoryWeekPanel');
      if (!tab || !panel) return false;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panel.hidden = !active;
    }
    if (focus) $('memoryTab-' + period).focus({ preventScroll: true });
    updateWeek();
    return true;
  }

  function reveal(target) {
    if (typeof target === 'string') target = $(target.replace(/^#/, ''));
    if (target?.closest('#memoryWeekPanel')) select('week');
    else if (target?.closest('#memoryDayPanel')) select('day');
  }

  function updateWeek() {
    const api = root.SynapProductivity;
    if (!api || !$('memoryWeekLabel')) return;
    const range = api.weekRange($('datePicker')?.value || root.SynapActionState.day(new Date()));
    const format = (day) =>
      new Date(day + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
    $('memoryWeekLabel').textContent = format(range.start) + ' – ' + format(range.end);
    const current = api.weekRange(root.SynapActionState.day(new Date()));
    $('nextMemoryWeek').disabled = range.start >= current.start;
    $('currentMemoryWeek').hidden = range.start === current.start;
  }

  function moveWeek(offset) {
    const picker = $('datePicker');
    if (!picker) return;
    const today = root.SynapActionState.day(new Date());
    const value = new Date((picker.value || today) + 'T12:00:00');
    value.setDate(value.getDate() + offset * 7);
    picker.value = offset === 0 ? today : [root.SynapActionState.day(value), today].sort()[0];
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    updateWeek();
  }

  function init() {
    const tabs = document.querySelector('.memory-workspace-tabs');
    if (!tabs) return;
    tabs.addEventListener('click', (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) select(tab.id.slice('memoryTab-'.length));
    });
    tabs.addEventListener('keydown', (event) => {
      const index = periods.indexOf(event.target.id?.slice('memoryTab-'.length));
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      select(periods[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index], {
        focus: true,
      });
    });
    $('previousMemoryWeek').addEventListener('click', () => moveWeek(-1));
    $('nextMemoryWeek').addEventListener('click', () => moveWeek(1));
    $('currentMemoryWeek').addEventListener('click', () => moveWeek(0));
    $('datePicker')?.addEventListener('change', updateWeek);
    select('day');
  }

  root.SynapMemoryWorkspace = Object.freeze({ select, reveal });
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(globalThis);
