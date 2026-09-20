import assert from 'node:assert/strict';
import test from 'node:test';
import type { Firestore } from '@google-cloud/firestore';
import { Storage, type Bucket } from '@google-cloud/storage';
import { config } from '../src/config.js';
import { generateDek, openText, sealBytes } from '../src/crypto/envelope.js';
import { GeminiError } from '../src/gemini/client.js';
import { transcribeSegment } from '../src/gemini/transcribe.js';
import { cooldownContinuation, rescueBatchDuringCooldown } from '../src/pipeline/process.js';
import { makePcm16Wav } from '../src/speaker/audio.js';
import * as db from '../src/store/firestore.js';
import type { RecordingDoc, SegmentDoc } from '../src/store/types.js';

/*
 * The dedicated ASR model is blocked for hours. Its fallback model holds a
 * separate quota but returns plain text, which a twenty-minute batch cannot
 * split back onto durable 30-second windows. A single window is already its own
 * boundary, so the per-window path can use the fallback. These tests pin that
 * rescue: what it salvages, and what it refuses to lose.
 */

const WINDOWS = 3;

function fixture() {
  const rows = new Map<string, any>();
  const ref = (path: string): any => ({
    path,
    orderBy: () => ref(path),
    collection: (id: string) => ref(path + '/' + id),
    doc: (id: string) => ref(path + '/' + id),
    set: async (data: any, options?: { merge?: boolean }) =>
      rows.set(path, { ...(options?.merge ? rows.get(path) : {}), ...structuredClone(data) }),
    get: async () =>
      path.split('/').length % 2 === 0
        ? { exists: rows.has(path), data: () => structuredClone(rows.get(path)) }
        : {
            docs: [...rows]
              .filter(
                ([key]) =>
                  key.startsWith(path + '/') &&
                  key.split('/').length === path.split('/').length + 1,
              )
              .map(([, value]) => ({ data: () => structuredClone(value) })),
          },
    update: async (fields: any) => {
      if (!rows.has(path)) throw Object.assign(Error('Missing'), { code: 5 });
      rows.set(path, { ...rows.get(path), ...fields });
    },
  });
  db.setFirestoreForTest({
    collection: (path: string) => ref(path),
    runTransaction: async (fn: any) => {
      const writes: (() => void)[] = [];
      const result = await fn({
        get: (r: any) => r.get(),
        set: (r: any, doc: any, options?: { merge?: boolean }) =>
          writes.push(() => {
            rows.set(r.path, {
              ...(options?.merge ? rows.get(r.path) : {}),
              ...structuredClone(doc),
            });
          }),
        create: (r: any, doc: any) => writes.push(() => rows.set(r.path, structuredClone(doc))),
        update: (r: any, fields: any) =>
          writes.push(() => rows.set(r.path, { ...rows.get(r.path), ...structuredClone(fields) })),
      });
      for (const write of writes) write();
      return result;
    },
  } as unknown as Firestore);

  const parent = 'users/u/recordings/r';
  rows.set(parent, {
    recordingId: 'r',
    state: 'transcribing',
    createdAt: 'first',
    endedAt: 'ended',
    uploadedSegments: WINDOWS,
    segmentCount: WINDOWS,
    language: 'auto',
  } as RecordingDoc);

  const batch: SegmentDoc[] = [];
  for (let index = 0; index < WINDOWS; index++) {
    const segment = {
      index,
      startMs: index * 30_000,
      endMs: (index + 1) * 30_000,
      sha256: 'digest-' + index,
      bytes: 32044,
      storagePath: 'segment-' + index,
      state: 'accepted',
      sealedTranscript: null,
      sealedWords: null,
      language: null,
      uploadedAt: 'now',
      transcribedAt: null,
    } as unknown as SegmentDoc;
    rows.set(`${parent}/segments/${index}`, segment);
    batch.push(segment);
  }
  return { rows, parent, batch };
}

const DAY_MS = 43_200_000;

/**
 * Model cooldowns are process-wide by design: one Cloud Run instance must not
 * keep probing a model another request already found blocked. Freeze each test
 * at its own hour so a neighbour's recorded cooldown has expired rather than
 * silently shortening this one's deadline.
 */
function frozenClock(t: any, hour: number) {
  t.mock.method(Date, 'now', () => 1_800_000_000_000 + hour * 3_600_000);
}

const quotaExhausted = () =>
  new Response(
    JSON.stringify({
      error: {
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '43200s' }],
      },
    }),
    { status: 429 },
  );

/**
 * Reproduce the state the rescue actually starts from: the long-form batch has
 * already been rejected, so the dedicated model's cooldown is recorded and every
 * later request for it is refused locally rather than over the network.
 */
async function blockDedicatedModel(): Promise<GeminiError> {
  const audio = makePcm16Wav(Buffer.alloc(32000, 8));
  try {
    await transcribeSegment(audio, 'audio/wav', { primaryWordTimestamps: true });
  } catch (cause) {
    assert.ok(cause instanceof GeminiError);
    return cause;
  }
  throw new Error('The dedicated model was expected to be rate limited');
}

/** Sealed 30-second sources, one per window, all decodable with this key. */
function storage(t: any, dek: Buffer) {
  const audio = makePcm16Wav(Buffer.alloc(32000, 8));
  t.mock.method(
    Storage.prototype,
    'bucket',
    () =>
      ({
        file: (path: string) => ({
          exists: async () => [true],
          download: async () => [
            Buffer.from(
              JSON.stringify(
                sealBytes(dek, audio, {
                  uid: 'u',
                  scope: `recording/r/segment/${path.split('-').at(-1)}`,
                  field: 'audio',
                }),
              ),
            ),
          ],
        }),
      }) as unknown as Bucket,
  );
}

test('a blocked long-form batch is rescued window by window on the fallback model', async (t) => {
  const f = fixture(),
    dek = generateDek();
  t.after(() => db.setFirestoreForTest(null));
  frozenClock(t, 0);
  storage(t, dek);

  let models: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: any) => {
    const request = JSON.parse(String(init?.body));
    models.push(request.model);
    // The dedicated model is blocked for the rest of the day; the fallback is not.
    if (request.model === config.gemini.transcribeModel) return quotaExhausted();
    return new Response(
      JSON.stringify({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Keep every word.' }] }],
      }),
    );
  });

  await blockDedicatedModel();
  models = [];

  const reported: number[] = [];
  const pass = await rescueBatchDuringCooldown(
    'u',
    'r',
    f.batch,
    dek,
    DAY_MS,
    Date.now() + 240_000,
    async (finished: SegmentDoc[]) => {
      reported.push(finished.length);
    },
  );
  const completed = pass.completed;

  assert.equal(pass.failure, undefined);
  assert.equal(completed.length, WINDOWS, 'every window in the batch is transcribed');
  for (const segment of completed) {
    assert.equal(segment.state, 'transcribed');
    assert.match(
      openText(dek, segment.sealedTranscript!, {
        uid: 'u',
        scope: `recording/r/segment/${segment.index}`,
        field: 'transcript',
      }),
      /Keep every word\./,
    );
    assert.equal(f.rows.get(`${f.parent}/segments/${segment.index}`).transcriptionLease, null);
  }
  assert.ok(
    models.every((model) => model === config.gemini.transcribeFallbackModel),
    'a model already known to be cooled down is never called again over the network',
  );
  assert.equal(models.length, WINDOWS, 'one fallback request per window, and no retries');
  assert.ok(reported.every((count) => count <= WINDOWS));
});

test('a second cooldown keeps the windows already sealed and asks for a prompt continuation', async (t) => {
  const f = fixture(),
    dek = generateDek();
  t.after(() => db.setFirestoreForTest(null));
  frozenClock(t, 24);
  storage(t, dek);

  let fallbackCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: any) => {
    const request = JSON.parse(String(init?.body));
    if (request.model === config.gemini.transcribeModel) return quotaExhausted();
    fallbackCalls++;
    // The fallback model runs out too, partway through the batch.
    if (fallbackCalls > 1)
      return new Response(
        JSON.stringify({
          error: {
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '90s' }],
          },
        }),
        { status: 429 },
      );
    return new Response(
      JSON.stringify({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Partial rescue.' }] }],
      }),
    );
  });

  const cause = await blockDedicatedModel();

  const pass = await rescueBatchDuringCooldown(
    'u',
    'r',
    f.batch,
    dek,
    DAY_MS,
    Date.now() + 240_000,
    async () => {},
  );
  assert.ok(pass.completed.length > 0 && pass.completed.length < WINDOWS);

  const continuation = cooldownContinuation(pass.completed.length, pass.failure, cause);
  // Not the twelve-hour deadline of the model that is no longer being used.
  assert.ok(continuation instanceof db.TranscriptionBusyError);
  assert.ok(continuation.retryAfterMs > 0 && continuation.retryAfterMs < DAY_MS / 2);
  assert.equal(continuation.retryable, true);

  const sealed = [...Array(WINDOWS).keys()].filter(
    (index) => f.rows.get(`${f.parent}/segments/${index}`).state === 'transcribed',
  );
  assert.ok(sealed.length > 0, 'work already paid for is never thrown away');
  assert.ok(sealed.length < WINDOWS, 'the rest is left for the continuation');
  for (let index = 0; index < WINDOWS; index++)
    assert.equal(
      f.rows.get(`${f.parent}/segments/${index}`).transcriptionLease,
      null,
      'no window is left leased behind a failed pass',
    );
});

test('a rescue that salvages nothing reports the original blockage, not a shorter one', async (t) => {
  const f = fixture(),
    dek = generateDek();
  t.after(() => db.setFirestoreForTest(null));
  frozenClock(t, 48);
  storage(t, dek);

  t.mock.method(globalThis, 'fetch', async () => quotaExhausted());

  const cause = await blockDedicatedModel();

  const pass = await rescueBatchDuringCooldown(
    'u',
    'r',
    f.batch,
    dek,
    DAY_MS,
    Date.now() + 240_000,
    async () => {},
  );
  assert.equal(pass.completed.length, 0);

  // Both models are out. The caller must inherit a real quota deadline, so the
  // deferred retry lands after the reset rather than burning deliveries against
  // a wall.
  const continuation = cooldownContinuation(0, pass.failure, cause);
  assert.ok(continuation instanceof GeminiError);
  assert.ok(Number(continuation.rateLimit?.retryAfterMs) >= DAY_MS - 60_000);
  assert.ok(!(continuation instanceof db.TranscriptionBusyError));
  for (let index = 0; index < WINDOWS; index++)
    assert.notEqual(f.rows.get(`${f.parent}/segments/${index}`).state, 'transcribed');
});
