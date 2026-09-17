/* Human edits are saved separately from source evidence and extracted dates. */
(function (root) {
  'use strict';
  let active;
  function close() {
    active?.remove();
    active = null;
  }
  function open(item, options) {
    close();
    const dialog = document.createElement('dialog');
    active = dialog;
    dialog.className = 'action-editor';
    dialog.innerHTML =
      '<form><h2>Action details</h2><p class="action-context"></p><blockquote></blockquote><p class="action-condition"></p><label>Action<textarea name="task" rows="3" maxlength="600" required></textarea></label><label>Owner<select name="ownerType"><option value="self">Me</option><option value="other">Someone else</option><option value="unknown">Needs clarification</option></select></label><label class="action-owner">Name<input name="owner" maxlength="80" autocomplete="off"></label><label>Status<select name="state"><option value="open">Open</option><option value="done">Completed</option><option value="dismissed">Dismissed</option></select></label><label>Deadline<input type="date" name="due_date"></label><p class="deadline-help">A date you set is your plan. It does not change what was agreed in the recording.</p><div class="advanced-action-fields"><label>Check-in date<input type="date" name="check_in_date"></label><label>Defer from Focus until<input type="date" name="snoozed_until"></label><label class="action-pin"><input type="checkbox" name="pinned"> Pin in Focus</label><p>A check-in is a day to review or follow up. These dates do not send notifications.</p></div><p class="action-editor-status" role="status"></p><div class="action-editor-buttons"><button type="button" class="action-editor-source">Open source</button><button type="button" class="action-editor-cancel">Cancel</button><button type="submit">Save</button></div></form>';
    const form = dialog.querySelector('form'),
      field = (name) => form.elements.namedItem(name);
    field('task').value = item.text;
    field('state').value = item.state || 'open';
    field('ownerType').value = item.unknown ? 'unknown' : item.mine ? 'self' : 'other';
    field('owner').value = item.mine ? '' : item.owner;
    field('due_date').value = item.due || '';
    field('check_in_date').value = item.checkIn || '';
    field('snoozed_until').value = item.snoozedUntil || '';
    field('pinned').checked = item.pinned || false;
    const context = dialog.querySelector('.action-context');
    context.textContent = item.context || 'From your recording';
    const quote = dialog.querySelector('blockquote');
    quote.textContent = item.evidence || '';
    quote.hidden = !item.evidence;
    const condition = dialog.querySelector('.action-condition');
    condition.textContent = item.condition ? 'Depends on: ' + item.condition : '';
    condition.hidden = !item.condition;
    const owner = dialog.querySelector('.action-owner');
    const showOwner = () => {
      owner.hidden = field('ownerType').value !== 'other';
      field('owner').required = !owner.hidden;
    };
    field('ownerType').addEventListener('change', showOwner);
    showOwner();
    if (!options.advanced) {
      ['task', 'ownerType', 'owner', 'check_in_date', 'snoozed_until', 'pinned'].forEach(
        (name) => (field(name).disabled = true),
      );
      dialog.querySelector('.advanced-action-fields').hidden = true;
    }
    dialog.querySelector('.action-editor-cancel').addEventListener('click', close);
    dialog.querySelector('.action-editor-source').addEventListener('click', () => {
      close();
      root.SynapInteractionSurfaces.openSource(item.recordingId || item.r?.id, item.startMs);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = dialog.querySelector('[role=status]');
      const patch = {};
      if (field('state').value !== item.state) patch.state = field('state').value;
      if ((field('due_date').value || '') !== (item.due || ''))
        patch.due_date = field('due_date').value || null;
      if (options.advanced) {
        const ownerName =
          field('ownerType').value === 'self'
            ? 'self'
            : field('ownerType').value === 'unknown'
              ? ''
              : field('owner').value.normalize('NFKC').trim();
        if (/[:\x00-\x1f\x7f]/.test(ownerName)) {
          status.textContent = 'Use a name without colons or line breaks.';
          return;
        }
        const task = field('task').value.trim();
        if (!task) {
          status.textContent = 'Enter an action.';
          return;
        }
        if (task !== item.text) patch.task = task;
        if (ownerName !== (item.mine ? 'self' : item.owner)) patch.owner = ownerName;
        patch.check_in_date = field('check_in_date').value || null;
        patch.snoozed_until = field('snoozed_until').value || null;
        patch.pinned = field('pinned').checked;
      }
      if (!Object.keys(patch).length) {
        close();
        return;
      }
      const buttons = [...form.querySelectorAll('button')];
      buttons.forEach((button) => (button.disabled = true));
      status.textContent = 'Saving…';
      try {
        await options.save(item, patch);
        if (active === dialog) close();
      } catch (error) {
        if (active === dialog)
          status.textContent = error.message || 'Could not save. Your edits are kept.';
      } finally {
        buttons.forEach((button) => (button.disabled = false));
      }
    });
    dialog.addEventListener('cancel', close);
    document.body.appendChild(dialog);
    dialog.showModal();
  }
  root.SynapActionEditor = Object.freeze({ open, close });
})(globalThis);
