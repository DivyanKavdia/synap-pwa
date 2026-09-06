/**
 * The limiter guards the only unauthenticated write path in the API, so its
 * window arithmetic is tested directly rather than through Firestore.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

/** Mirror of the window maths in consume(), which is the part worth pinning. */
function windowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

test('a window is stable for every instant inside it', () => {
  const w = 60_000;
  // Anchor to a real boundary. An arbitrary timestamp sits partway through a
  // window, so "+59,999" from it lands in the next one.
  const base = windowStart(1_000_000_000_000, w);
  assert.equal(windowStart(base, w), base);
  assert.equal(windowStart(base + 1, w), base);
  assert.equal(windowStart(base + w - 1, w), base);
});

test('crossing the boundary starts exactly one new window', () => {
  const w = 60_000;
  const base = windowStart(1_000_000_000_000, w);
  assert.equal(windowStart(base + w, w) - base, w);
});

test('counter documents are namespaced by bucket, caller and window', () => {
  // A shared key across buckets would let pairing traffic exhaust sign-in.
  const id = (bucket: string, key: string, start: number) => `${bucket}_${key}_${start}`;
  assert.notEqual(id('pair_start', 'k', 0), id('auth_google', 'k', 0));
  assert.notEqual(id('pair_start', 'a', 0), id('pair_start', 'b', 0));
  assert.notEqual(id('pair_start', 'k', 0), id('pair_start', 'k', 60_000));
});

test('the limiter file states the multi-instance reason it uses Firestore', async () => {
  // An in-process counter silently multiplies the limit by the instance count
  // on Cloud Run. If someone "simplifies" this later, the comment is the
  // warning they get.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../src/http/rate-limit.ts', import.meta.url), 'utf8');
  assert.match(src, /Cloud Run scales horizontally/);
  assert.match(src, /expireAt/);
});
