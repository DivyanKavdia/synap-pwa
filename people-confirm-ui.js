/* Confirm, correct or remove people without changing their source recordings. */
(function (root) {
  'use strict';
  var LIST_SELECTOR = '#peopleList',
    cache = null,
    inFlight = null,
    decorating = false,
    watching = false,
    cacheGeneration = 0;
  function doc() {
    return root.document;
  }
  function normalize(name) {
    return String(name == null ? '' : name)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function backend() {
    return root.SynapBackend || null;
  }
  function signedIn() {
    return Boolean(root.SynapAuth && root.SynapAuth.isSignedIn && root.SynapAuth.isSignedIn());
  }
  function accountKey() {
    try {
      return signedIn() ? String(root.SynapAuth.session?.()?.profile?.uid || 'signed-in') : '';
    } catch (_) {
      return '';
    }
  }
  const deletedIds = new Set();
  const deletionKey = () => 'synap-hidden-people-v1:' + (accountKey() || 'local');
  const deletionName = (name) =>
    String(name || '')
      .normalize('NFKC')
      .trim()
      .toLowerCase();
  function hiddenPeople() {
    try {
      const value = JSON.parse(localStorage.getItem(deletionKey()) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
      return {};
    }
  }
  function isDeleted(person) {
    const id = person.person_id || person.id;
    if (id) return deletedIds.has(accountKey() + '|' + id);
    const hiddenAt = hiddenPeople()[deletionName(person.name)];
    return typeof hiddenAt === 'number' && (!person.last || Number(person.last) <= hiddenAt);
  }
  function hideLocalName(person) {
    const hidden = hiddenPeople();
    hidden[deletionName(person.name)] = Date.now();
    localStorage.setItem(deletionKey(), JSON.stringify(hidden));
  }
  function indexPeople(result) {
    var byName = new Map(),
      list = Array.isArray(result?.people) ? result.people : [];
    byName.byId = new Map();
    for (var i = 0; i < list.length; i++) {
      var person = list[i],
        key = normalize(person && person.name);
      if (person?.person_id) {
        byName.byId.set(String(person.person_id), person);
        if (key) byName.set(key, person);
      }
    }
    return byName;
  }
  function people() {
    if (cache) return Promise.resolve(cache);
    if (inFlight) return inFlight;
    var api = backend();
    if (!api || !api.people || !signedIn()) return Promise.resolve(null);
    var generation = cacheGeneration,
      key = accountKey();
    var task = api
      .people()
      .then(function (result) {
        if (generation !== cacheGeneration || key !== accountKey()) return null;
        cache = indexPeople(result);
        return cache;
      })
      .catch(function () {
        return null;
      })
      .finally(function () {
        if (inFlight === task) inFlight = null;
      });
    inFlight = task;
    return task;
  }
  function invalidate() {
    ++cacheGeneration;
    cache = null;
    inFlight = null;
  }
  function acceptPeople(result) {
    invalidate();
    cache = indexPeople(result);
  }
  function styles() {
    if (!doc() || doc().getElementById('synapPeopleConfirmStyles')) return;
    var style = doc().createElement('style');
    style.id = 'synapPeopleConfirmStyles';
    style.textContent = [
      '.person-entry{display:flex;flex-direction:column;gap:.35rem;min-width:0}',
      '.person-entry>.person-card{width:100%}',
      '.person-verify{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;font-size:.75rem}',
      '.person-verify button{font-size:.72rem;padding:.2rem .5rem;border-radius:999px;border:1px solid currentColor;background:transparent;color:inherit;opacity:.72;cursor:pointer}',
      '.person-verify button:hover{opacity:1}',
      '.person-verify button[disabled]{opacity:.4;cursor:default}',
      '.person-verify .person-confirmed{opacity:.7;display:inline-flex;align-items:center;gap:.25rem}',
      '.person-verify form{display:flex;gap:.3rem;flex:1;min-width:0}',
      '.person-verify input{flex:1;min-width:0;font:inherit;font-size:.78rem;padding:.2rem .45rem;border-radius:.4rem;border:1px solid currentColor;background:transparent;color:inherit}',
      '.person-verify .person-verify-note{opacity:.65}',
    ].join('');
    (doc().head || doc().documentElement).appendChild(style);
  }
  function note(host, message) {
    var el = host.querySelector('.person-verify-note');
    if (!el) {
      el = doc().createElement('span');
      el.className = 'person-verify-note';
      host.appendChild(el);
    }
    el.setAttribute('role', 'status');
    el.textContent = message || '';
  }
  function renderControls(host, person) {
    host.synapPersonSignature = JSON.stringify([
      person.person_id,
      person.name,
      person.confirmed_by_user,
    ]);
    host.innerHTML = '';
    if (person.person_id && person.confirmed_by_user) {
      var badge = doc().createElement('span');
      badge.className = 'person-confirmed';
      badge.textContent = '✓ Confirmed';
      host.appendChild(badge);
    } else if (person.person_id) {
      var confirm = doc().createElement('button');
      confirm.type = 'button';
      confirm.dataset.action = 'confirm';
      confirm.textContent = '✓ That’s right';
      host.appendChild(confirm);
    }
    var rename = doc().createElement('button');
    rename.type = 'button';
    rename.dataset.action = 'rename';
    rename.textContent = person.confirmed_by_user ? 'Rename' : 'Wrong name';
    if (person.person_id) host.appendChild(rename);
    const remove = doc().createElement('button');
    remove.type = 'button';
    remove.dataset.action = 'delete';
    remove.textContent = 'Delete person';
    host.appendChild(remove);
  }
  function confirmDelete(host, person) {
    host.innerHTML = '';
    const text = doc().createElement('p');
    text.className = 'person-delete-copy';
    text.textContent =
      'Remove ' +
      person.name +
      ' from People? Recordings stay available. New conversations may add this name again.';
    const remove = doc().createElement('button');
    remove.type = 'button';
    remove.dataset.action = 'delete-confirm';
    remove.textContent = 'Delete person';
    const cancel = doc().createElement('button');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel';
    cancel.textContent = 'Keep person';
    host.append(text, remove, cancel);
    cancel.focus();
  }
  async function deletePerson(host, person) {
    if (host.synapSaving) return;
    const key = accountKey();
    host.synapSaving = true;
    host.querySelectorAll('button').forEach((button) => {
      button.disabled = true;
    });
    note(host, 'Deleting…');
    try {
      if (person.person_id) {
        if (!backend()?.deletePerson) throw Error('Reconnect to delete this person.');
        await backend().deletePerson(person.person_id);
        if (key !== accountKey()) return;
        deletedIds.add(key + '|' + person.person_id);
        // The cloud deletion is durable even if this browser cannot store its fallback filter.
        try {
          hideLocalName(person);
        } catch (_) {}
      } else hideLocalName(person);
      if (key !== accountKey()) return;
      cache?.delete(normalize(person.name));
      cache?.byId?.delete(String(person.person_id));
      root.dispatchEvent?.(
        new CustomEvent('synap-person-deleted', {
          detail: { personId: person.person_id || '', name: person.name },
        }),
      );
      doc().getElementById('actionsTab-peopleMemory')?.focus({ preventScroll: true });
    } catch (error) {
      if (key === accountKey())
        note(host, error.message || 'Could not delete this person. Try again.');
    } finally {
      host.synapSaving = false;
      host.querySelectorAll('button').forEach((button) => {
        button.disabled = false;
      });
    }
  }
  function renderEditor(host, person) {
    host.innerHTML = '';
    var form = doc().createElement('form'),
      input = doc().createElement('input');
    input.type = 'text';
    input.value = person.name || '';
    input.maxLength = 120;
    input.setAttribute('aria-label', 'Correct this person’s name');
    var save = doc().createElement('button');
    save.type = 'submit';
    save.textContent = 'Save';
    var cancel = doc().createElement('button');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel';
    cancel.textContent = 'Cancel';
    form.append(input, save, cancel);
    host.appendChild(form);
    input.focus();
    input.select();
  }
  function canonicalizeCard(card, person) {
    if (!card || !person?.name) return;
    var label = card.querySelector('strong');
    if (label) label.textContent = person.name;
    card.dataset.person = person.name;
    card.dataset.personId = person.person_id || card.dataset.personId || '';
    card.setAttribute('aria-label', 'Recall conversations with ' + person.name);
    var row = card.closest('.person-with-preparation');
    row
      ?.querySelector('.meeting-prepare')
      ?.setAttribute('aria-label', 'Prepare for meeting with ' + person.name);
    card
      .closest('.person-entry')
      ?.querySelector('.person-management summary')
      ?.setAttribute('aria-label', 'Manage ' + person.name);
    var avatar = card.querySelector('.person-avatar');
    if (avatar) avatar.textContent = person.name.charAt(0).toUpperCase();
  }
  function personFromCard(card, byName) {
    if (!card) return null;
    var byId = card.dataset.personId;
    if (byId) {
      var found = byName.byId?.get(String(byId));
      if (found) return found;
    }
    return byName.get(normalize(card.dataset.person)) || null;
  }
  function decorate() {
    if (decorating || !doc()) return;
    var list = doc().querySelector(LIST_SELECTOR);
    if (!list) return;
    var cards = [].slice.call(list.querySelectorAll('.person-card'));
    if (!cards.length) return;
    people().then(function (byName) {
      if (!doc().querySelector(LIST_SELECTOR)) return;
      decorating = true;
      try {
        cards.forEach(function (card) {
          if (!card.isConnected) return;
          var person = byName && personFromCard(card, byName);
          if (!person && !card.dataset.personId) person = { name: card.dataset.person };
          if (!person) return;
          canonicalizeCard(card, person);
          if (card.parentElement && card.parentElement.classList.contains('person-entry')) {
            var existing = card.parentElement.querySelector('.person-verify');
            if (existing) {
              existing.dataset.personId = person.person_id || '';
              existing.synapPerson = person;
              if (
                !existing.querySelector('form') &&
                !existing.synapSaving &&
                existing.synapPersonSignature !==
                  JSON.stringify([person.person_id, person.name, person.confirmed_by_user])
              )
                renderControls(existing, person);
            }
            return;
          }
          var entry = doc().createElement('div');
          entry.className = 'person-entry';
          card.parentNode.insertBefore(entry, card);
          entry.appendChild(card);
          var host = doc().createElement('div');
          host.className = 'person-verify';
          host.dataset.personId = person.person_id || '';
          host.synapPerson = person;
          var manage = doc().createElement('details');
          manage.className = 'person-management';
          var toggle = doc().createElement('summary');
          toggle.textContent = '•••';
          toggle.setAttribute('aria-label', 'Manage ' + person.name);
          manage.append(toggle, host);
          entry.appendChild(manage);
          renderControls(host, person);
        });
      } finally {
        decorating = false;
      }
    });
  }
  function personFor(host) {
    return cache?.byId?.get(String(host.dataset.personId)) || host.synapPerson || null;
  }
  function reindex(person, oldName) {
    if (!cache || !person) return;
    if (oldName) cache.delete(normalize(oldName));
    cache.set(normalize(person.name), person);
    cache.byId?.set(String(person.person_id), person);
  }
  function apply(host, promise, pendingLabel) {
    var key = accountKey(),
      before = personFor(host),
      oldName = before && before.name;
    host.synapSaving = true;
    [].forEach.call(host.querySelectorAll('button,input'), function (control) {
      control.disabled = true;
    });
    note(host, pendingLabel);
    return promise
      .then(function (result) {
        if (key !== accountKey()) return;
        var person = personFor(host) || before;
        if (person) {
          if (result && result.name) person.name = result.name;
          person.confirmed_by_user =
            result && 'confirmed_by_user' in result ? Boolean(result.confirmed_by_user) : true;
          reindex(person, oldName);
          renderControls(host, person);
          var card = host.closest('.person-entry')?.querySelector('.person-card');
          canonicalizeCard(card, person);
        }
        note(host, '');
        root.dispatchEvent?.(
          new CustomEvent('synap-person-updated', {
            detail: { personId: person?.person_id || '', name: person?.name || '' },
          }),
        );
      })
      .catch(function (error) {
        if (key === accountKey())
          note(host, (error && error.message) || 'Could not save that. Try again.');
      })
      .finally(function () {
        host.synapSaving = false;
        [].forEach.call(host.querySelectorAll('button,input'), function (control) {
          control.disabled = false;
        });
      });
  }
  function onClick(event) {
    var host = event.target.closest ? event.target.closest('.person-verify') : null;
    if (!host) return;
    var button = event.target.closest('button');
    if (!button || button.type === 'submit') return;
    event.preventDefault();
    event.stopPropagation();
    var person = personFor(host);
    if (!person) return;
    var action = button.dataset.action;
    if (host.synapSaving) return;
    if (action === 'delete') {
      confirmDelete(host, person);
      return;
    }
    if (action === 'delete-confirm') {
      deletePerson(host, person);
      return;
    }
    if (action === 'rename') {
      renderEditor(host, person);
      return;
    }
    if (action === 'cancel') {
      renderControls(host, person);
      return;
    }
    if (action === 'confirm') {
      var api = backend();
      if (!api || !api.confirmPerson) return;
      apply(host, api.confirmPerson(person.person_id, true), 'Saving…');
    }
  }
  function onSubmit(event) {
    var host = event.target.closest ? event.target.closest('.person-verify') : null;
    if (!host) return;
    event.preventDefault();
    event.stopPropagation();
    var person = personFor(host),
      input = event.target.querySelector('input');
    if (!person || !input) return;
    var name = String(input.value || '').trim();
    if (!name || name === person.name) {
      renderControls(host, person);
      return;
    }
    var api = backend();
    if (!api || !api.renamePerson) return;
    apply(host, api.renamePerson(person.person_id, name), 'Saving…');
  }
  function watch() {
    var list = doc() && doc().querySelector(LIST_SELECTOR);
    if (!list) return false;
    if (watching) {
      decorate();
      return true;
    }
    watching = true;
    new root.MutationObserver(function () {
      if (decorating) return;
      decorate();
    }).observe(list, { childList: true });
    decorate();
    return true;
  }
  function refreshCanonical() {
    invalidate();
    setTimeout(decorate, 40);
  }
  function init() {
    if (!doc() || !root.MutationObserver) return;
    styles();
    doc().addEventListener('click', onClick, true);
    doc().addEventListener('submit', onSubmit, true);
    if (watch()) return;
    var observer = new root.MutationObserver(function () {
      if (watch()) observer.disconnect();
    });
    observer.observe(doc().body || doc().documentElement, { childList: true, subtree: true });
  }
  var activeAccount = accountKey();
  if (root.SynapAuth && root.SynapAuth.onChange)
    root.SynapAuth.onChange(function () {
      var next = accountKey();
      if (next !== activeAccount) {
        activeAccount = next;
        refreshCanonical();
      }
    });
  ['synap-processing-complete', 'synap-memory-ready', 'synap-cloud-history-updated'].forEach(
    (name) => root.addEventListener(name, refreshCanonical),
  );
  if (doc() && doc().readyState === 'loading')
    doc().addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  root.SynapPeopleConfirmUI = {
    decorate,
    isDeleted,
    acceptPeople,
    invalidate: refreshCanonical,
    normalize,
    indexPeople,
    canonicalizeCard,
  };
})(globalThis);
