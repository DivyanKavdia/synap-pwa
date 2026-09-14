'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { Player, frameAt, timeLabel } = require('../chakshu-player.js');
function clock() {
  let now = 0,
    tick = null;
  const states = [];
  const p = new Player({
    frames: [{ atMs: 0 }, { atMs: 200 }, { atMs: 950 }],
    durationMs: 1500,
    change: (s) => states.push(s),
    now: () => now,
    schedule: (f) => ((tick = f), 1),
    cancel: () => (tick = null),
  });
  return {
    p,
    states,
    advance(ms) {
      now += ms;
      const f = tick;
      tick = null;
      f?.();
    },
    get pending() {
      return Boolean(tick);
    },
  };
}
class Audio extends EventTarget {
  duration = 1.5;
  currentTime = 0;
  paused = true;
  ended = false;
  playbackRate = 1;
  async play() {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event('play'));
  }
  pause() {
    if (!this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }
  }
}
test('video follows irregular frame timestamps, pauses, seeks, changes speed and replays', async () => {
  const { p, states, advance } = clock();
  await p.play();
  advance(230);
  assert.equal(states.at(-1).index, 1);
  p.pause();
  advance(1000);
  assert.equal(p.position(), 230);
  p.seek(900);
  assert.equal(states.at(-1).index, 1);
  p.setRate(2);
  await p.play();
  advance(30);
  assert.equal(states.at(-1).index, 2);
  advance(300);
  assert.equal(p.playing, false);
  assert.equal(p.position(), 1500);
  await p.play();
  assert.equal(p.position(), 0);
  p.dispose();
  assert.equal(frameAt([{ atMs: 0 }, { atMs: 200 }, { atMs: 200 }], 200), 2);
  assert.equal(timeLabel(65000), '1:05');
});
test('linked audio is the playback clock including stalls, native pause and seeking', async () => {
  const { p, states, advance, pending } = clock(),
    audio = new Audio();
  p.setAudio(audio);
  await p.play();
  audio.currentTime = 0.21;
  advance(1000);
  assert.equal(states.at(-1).index, 1);
  assert.equal(p.position(), 210);
  advance(2000);
  assert.equal(p.position(), 210, 'buffered or stalled sound must not let video race ahead');
  audio.pause();
  assert.equal(p.playing, false);
  audio.currentTime = 1;
  audio.dispatchEvent(new Event('seeked'));
  assert.equal(states.at(-1).index, 2);
  p.seek(100);
  assert.equal(audio.currentTime, 0.1);
  await audio.play();
  assert.equal(p.playing, true);
  p.dispose();
  assert.equal(audio.paused, true);
  assert.equal(p.playing, false);
  audio.dispatchEvent(new Event('play'));
  assert.equal(p.playing, false, 'closed viewer removes audio handlers');
});
test('silent playback remains available when no soundtrack is linked', async () => {
  const f = clock();
  await f.p.play();
  f.advance(1600);
  assert.equal(f.p.position(), 1500);
  assert.equal(f.pending, false);
});
test('video continues beyond a shorter soundtrack and preserves seeks into its silent tail', async () => {
  const { p, advance } = clock(),
    audio = new Audio();
  audio.duration = 0.5;
  p.setAudio(audio);
  p.seek(1000);
  audio.dispatchEvent(new Event('seeked'));
  assert.equal(p.position(), 1000);
  await p.play();
  advance(100);
  assert.equal(p.position(), 1100);
  p.pause();
  p.seek(200);
  audio.dispatchEvent(new Event('seeked'));
  await p.play();
  audio.currentTime = 0.5;
  audio.ended = true;
  audio.pause();
  audio.dispatchEvent(new Event('ended'));
  advance(300);
  assert.equal(p.position(), 800);
  p.dispose();
});
test('blocked audio playback stops the player so it can retry silently', async () => {
  const { p, advance } = clock(),
    audio = new Audio();
  audio.play = async () => {
    throw Error('Playback blocked');
  };
  p.setAudio(audio);
  await assert.rejects(p.play(), /Playback blocked/);
  assert.equal(p.playing, false);
  p.setAudio(null);
  await p.play();
  advance(300);
  assert.equal(p.position(), 300);
  p.dispose();
});
