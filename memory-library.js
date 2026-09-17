/* One Library entry per capture, with explicitly linked media kept together. */
(function (root) {
  'use strict';
  const list = (value) => (Array.isArray(value) ? value : []);
  const clean = (value) => String(value || '').trim();
  const labels = { audio: 'Audio', image: 'Photo', video: 'Video' };

  function compose(recordings, media) {
    const audio = new Map(
      list(recordings).map((row) => [String(row.id), { ...row, libraryMedia: [] }]),
    );
    const standalone = [];
    for (const row of list(media)) {
      const parent = row.audioId && audio.get(String(row.audioId));
      // An ID or a nearby timestamp alone must never join two accounts' data.
      if (parent && row.ownerUid && parent.ownerUid === row.ownerUid) parent.libraryMedia.push(row);
      else standalone.push(row);
    }
    return [...audio.values(), ...standalone].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );
  }
  function types(row) {
    return [
      ...new Set([
        row.mediaKind || 'audio',
        ...list(row.libraryMedia).map((item) => item.mediaKind),
      ]),
    ];
  }
  function favourite(row) {
    return Boolean(row.favourite || list(row.libraryMedia).some((item) => item.favourite));
  }
  function title(row) {
    const name = clean(row.name),
      memoryTitle = clean(row.meeting?.title);
    const automatic =
      !name || /^(Recording |Video soundtrack$|Untitled recording$|Chakshu audio$)/i.test(name);
    if (automatic && memoryTitle) return memoryTitle;
    if (automatic && row.libraryMedia?.length) {
      const video = row.libraryMedia.find((item) => item.mediaKind === 'video');
      return (
        clean((video || row.libraryMedia[0]).name) ||
        (video ? 'Video with audio' : 'Photo with audio')
      );
    }
    return (
      name ||
      (row.mediaKind === 'image' ? 'Photo' : row.mediaKind === 'video' ? 'Video' : 'Audio memory')
    );
  }
  function conversations(row) {
    return list(row.meeting?.conversations || row.conversations);
  }
  function preview(row) {
    return clean(
      row.meeting?.executive_summary ||
        row.summary ||
        row.notes ||
        list(row.libraryMedia)
          .map((item) => item.notes)
          .filter(Boolean)
          .join(' · '),
    );
  }
  function searchText(row) {
    return [
      title(row),
      ...list(row.libraryMedia).flatMap((item) => [item.name, item.notes]),
      ...conversations(row).flatMap((item) => [
        ...list(item.participants),
        ...list(item.mentioned_people),
        ...list(item.outcomes).map((value) => value.text),
        ...list(item.key_facts).map((value) => value.text),
        ...list(item.risks).map((value) => value.text),
        ...list(item.decisions).map((value) => value.text),
        ...list(item.action_items).flatMap((value) => [value.task, value.owner, value.due_date]),
        ...list(item.follow_ups).map((value) => value.text),
        ...list(item.unresolved_questions).map((value) => value.text),
      ]),
    ].join(' ');
  }
  function facts(row) {
    const items = conversations(row);
    const people = [
      ...new Set(
        items
          .flatMap((item) => list(item.participants))
          .map(clean)
          .filter((name) => name && name !== 'self'),
      ),
    ];
    const decisions = items.length
      ? items.reduce((count, item) => count + list(item.decisions).length, 0)
      : list(row.meeting?.decisions).length;
    const outcomes = items.reduce((count, item) => count + list(item.outcomes).length, 0);
    const actions = items.length
      ? items.reduce((count, item) => count + list(item.action_items).length, 0)
      : list(row.meeting?.action_items).length;
    return [
      types(row)
        .map((type) => labels[type])
        .filter(Boolean)
        .join(' + '),
      people.length
        ? people.slice(0, 3).join(', ') + (people.length > 3 ? ' +' + (people.length - 3) : '')
        : '',
      outcomes ? outcomes + (outcomes === 1 ? ' outcome' : ' outcomes') : '',
      decisions ? decisions + (decisions === 1 ? ' decision' : ' decisions') : '',
      actions ? actions + (actions === 1 ? ' to-do' : ' to-dos') : '',
    ].filter(Boolean);
  }
  function decorate(card, row) {
    const info = card.querySelector('.recording-row-info');
    if (info) {
      let tags = info.querySelector('.memory-card-facts');
      if (!tags) {
        tags = document.createElement('span');
        tags.className = 'memory-card-facts';
        info.append(tags);
      }
      const values = facts(row),
        signature = JSON.stringify(values);
      if (tags.dataset.signature !== signature) {
        tags.dataset.signature = signature;
        tags.replaceChildren(
          ...values.map((value) => {
            const tag = document.createElement('span');
            tag.textContent = value;
            return tag;
          }),
        );
      }
    }
    const content = card.querySelector('.recording-content');
    if (!content) return;
    if (preview(row) && !content.querySelector('.memory-explore')) {
      const explore = document.createElement('button');
      explore.type = 'button';
      explore.className = 'memory-explore';
      explore.textContent = 'Explore this topic in Ask ↗';
      explore.addEventListener('click', () =>
        root.SynapAsk?.open(
          'What decisions, next steps and unresolved questions relate to ' +
            title(card.synapRecording || row) +
            '?',
        ),
      );
      content.appendChild(explore);
    }
    const attachments = list(row.libraryMedia);
    let host = content.querySelector('.memory-attachments');
    if (!attachments.length) {
      if (host) {
        root.SynapChakshuLibrary?.disposeCard(host);
        host.remove();
      }
      return;
    }
    if (!host) {
      host = document.createElement('section');
      host.className = 'memory-attachments';
      const heading = document.createElement('h4');
      heading.textContent = 'Photos & videos in this memory';
      host.append(heading);
      content.prepend(host);
    }
    const ids = new Set(attachments.map((item) => item.mediaId));
    for (const child of host.querySelectorAll('.library-media-card')) {
      if (!ids.has(child.dataset.mediaId)) {
        root.SynapChakshuLibrary.disposeCard(child);
        child.remove();
      }
    }
    for (const attachment of attachments) {
      let child = [...host.querySelectorAll('.library-media-card')].find(
        (node) => node.dataset.mediaId === attachment.mediaId,
      );
      if (child) root.SynapChakshuLibrary.updateCard(child, attachment);
      else {
        child = root.SynapChakshuLibrary.createCard(attachment);
        child.classList.remove('recording-card');
        host.append(child);
      }
    }
  }
  root.SynapMemoryLibrary = {
    compose,
    types,
    favourite,
    title,
    preview,
    searchText,
    facts,
    decorate,
  };
  if (typeof module !== 'undefined') module.exports = root.SynapMemoryLibrary;
})(globalThis);
