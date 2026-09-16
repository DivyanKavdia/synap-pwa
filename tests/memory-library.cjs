'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const library = require('../memory-library.js');

test('one capture keeps its explicit soundtrack, video and photos together without changing originals', () => {
  const audio = {
    id: 'a',
    ownerUid: 'u',
    name: 'Video soundtrack',
    createdAt: '2026-09-16T10:00:00Z',
  };
  const media = [
    {
      id: 'visual:v',
      mediaId: 'v',
      mediaKind: 'video',
      ownerUid: 'u',
      audioId: 'a',
      name: 'Garden walk',
      createdAt: audio.createdAt,
    },
    {
      id: 'visual:p',
      mediaId: 'p',
      mediaKind: 'image',
      ownerUid: 'u',
      audioId: 'a',
      notes: 'Yellow flowers',
      favourite: true,
      createdAt: audio.createdAt,
    },
  ];
  const rows = library.compose([audio], media);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'a', 'source links still resolve to the original audio ID');
  assert.deepEqual(library.types(rows[0]), ['audio', 'video', 'image']);
  assert.equal(library.title(rows[0]), 'Garden walk');
  assert.equal(library.preview(rows[0]), 'Yellow flowers');
  assert(library.favourite(rows[0]));
  assert.match(library.searchText(rows[0]), /Yellow flowers/);
  assert.equal(audio.libraryMedia, undefined);
  assert.equal(media[0].audioId, 'a');
});

test('nearby captures, missing audio and different accounts never merge by accident', () => {
  const time = '2026-09-16T10:00:00Z';
  const rows = library.compose(
    [{ id: 'a', ownerUid: 'u', createdAt: time }],
    [
      { id: 'visual:x', mediaKind: 'video', ownerUid: 'other', audioId: 'a', createdAt: time },
      { id: 'visual:y', mediaKind: 'image', ownerUid: 'u', audioId: 'missing', createdAt: time },
      { id: 'visual:a', mediaKind: 'image', ownerUid: 'u', createdAt: time },
    ],
  );
  assert.equal(rows.length, 4);
  assert.equal(rows[0].libraryMedia.length, 0);
});

test('memory cards expose outcomes and tasks to search while preserving custom titles and speaker distinctions', () => {
  const row = {
    name: 'Recording Sep 16',
    meeting: {
      title: 'Budget review',
      executive_summary: 'Pilot approved; Priya will send the plan.',
      conversations: [
        {
          participants: ['Priya'],
          mentioned_people: ['Arun'],
          outcomes: [{ text: 'Prototype demonstrated' }],
          decisions: [{ text: 'Pilot approved' }],
          action_items: [{ task: 'Send the plan', owner: 'Priya', due_date: '2026-09-18' }],
        },
      ],
    },
  };
  assert.equal(library.title(row), 'Budget review');
  assert.equal(library.title({ ...row, name: 'My important meeting' }), 'My important meeting');
  assert.match(library.searchText(row), /Prototype demonstrated.*Pilot approved.*Send the plan/);
  assert(library.searchText(row).includes('2026-09-18'));
  assert(library.facts(row).includes('Priya'));
  assert(
    !library.facts(row).some((value) => value.includes('Arun')),
    'a mentioned person is not presented as a participant',
  );
});
