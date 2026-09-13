/* Action dates and local completion. Calendar ranges use local days, including across DST. */
(function (root) {
  'use strict';
  let journal;
  function day(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  }
  function dueDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '';
    return day(value + 'T12:00:00') === value ? value : '';
  }
  function range(period, now = new Date()) {
    const today = new Date(day(now) + 'T12:00:00');
    const offset = (n) => {
      const date = new Date(today);
      date.setDate(date.getDate() + n);
      return day(date);
    };
    const monday = -(today.getDay() + 6) % 7;
    switch (period) {
      case 'last-week':
        return [offset(monday - 7), offset(monday - 1)];
      case 'today':
        return [offset(0), offset(0)];
      case 'this-week':
        return [offset(monday), offset(monday + 6)];
      case 'next-week':
        return [offset(monday + 7), offset(monday + 13)];
      case 'next-month':
        return [offset(0), offset(29)];
      case 'overdue':
        return ['', offset(-1)];
      default:
        return null;
    }
  }
  function matches(item, period, now = new Date()) {
    const due = dueDay(item.due);
    if (period === 'undated') return !due;
    const bounds = range(period, now);
    if (!bounds) return true;
    // Future periods and overdue describe deadlines. Never invent one for an undated task.
    const future = ['next-week', 'next-month', 'overdue'].includes(period);
    const value = due || (!future ? day(item.recordedAt || item.r?.createdAt) : '');
    return Boolean(value && value >= bounds[0] && value <= bounds[1]);
  }
  function key(item) {
    return JSON.stringify([
      item.recordingId || item.r?.id,
      item.startMs || 0,
      String(item.text).trim().toLowerCase(),
      String(item.owner || '')
        .trim()
        .toLowerCase(),
    ]);
  }
  function state(item, scope) {
    return item.r?.actionStates?.[scope || 'local']?.[key(item)] || item.state || 'open';
  }
  async function save(item, value, scope) {
    if (!['open', 'done'].includes(value)) throw Error('Invalid action state.');
    journal ||= new root.DKAudioStore();
    const saved = await journal.atomic(['recordings'], (stores, result, tx) => {
      const request = stores.recordings.get(item.recordingId || item.r?.id);
      request.onsuccess = () => {
        const recording = request.result;
        if (!recording) {
          tx.abort();
          return;
        }
        const account = scope || 'local';
        const actionStates = {
          ...recording.actionStates,
          [account]: { ...recording.actionStates?.[account], [key(item)]: value },
        };
        const updated = { ...recording, actionStates };
        stores.recordings.put(updated);
        result(updated);
      };
    });
    return saved;
  }
  root.SynapActionState = Object.freeze({ day, dueDay, range, matches, key, state, save });
})(globalThis);
