'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = path => fs.readFileSync(path, 'utf8');
const runtime = read('experience-recovery.js');
const shell = read('index.html');
const sw = read('sw.js');
const app = read('backend/src/http/app.ts');
const source = read('backend/src/http/routes/source.ts');
const materialize = read('backend/src/pipeline/source-materialize.ts');
const ask = read('backend/src/http/routes/ask-v3.ts');

// Playback must prefer preserved local PCM, then recover the same recording's
// authenticated cloud source when local storage is missing/evicted.
assert.match(runtime, /localAudio\(id\)/);
assert.match(runtime, /cloudAudio\(id\)/);
assert.match(runtime, /\/audio/);
assert.match(runtime, /SynapAuth\.authedFetch/);
assert.match(source, /openBytes/);
assert.match(source, /X-Synap-Audio-Gaps/);

// A stale/revoked blob URL is still a non-empty src, so loading logic alone
// cannot detect it. A media decode/load error must explicitly fall through to
// the authenticated cloud copy and must not loop if cloud decoding also fails.
assert.match(runtime, /addEventListener\('error'[\s\S]*recoverMediaError\(audio\)/);
assert.match(runtime, /function recoverMediaError\(audio\)/);
assert.match(runtime, /audio\.dataset\.synapAudioSource === 'cloud'/);
assert.match(runtime, /cloudFallback\(audio, id\)/);

// Opening a recording must hydrate from the authoritative source, not treat any
// non-empty local transcript as proof that the transcript is complete.
assert.match(runtime, /\/source/);
assert.match(runtime, /transcriptComplete/);
assert.match(materialize, /coversEveryWindow/);
assert.match(materialize, /source: 'segments'/);

// Ask must remain usable when summary/indexing failed by searching durable
// transcript windows directly; it may not require recording.state === ready.
assert.match(ask, /materializeTranscript/);
assert.match(ask, /transcriptEvidence/);
assert.doesNotMatch(ask, /recording\.state !== 'ready'/);
assert.match(ask, /groundedFallback/);

// Route-scoped source + Ask must be mounted before the blanket recordings router.
assert(app.indexOf("app.use('/v1', sourceRoutes())") < app.indexOf("app.use('/v1', recordingRoutes())"));
assert(app.indexOf("app.use('/v1', askV3Routes())") < app.indexOf("app.use('/v1', recordingRoutes())"));

// The recovery runtime must ship in both online and installed-PWA paths. The
// transcripts1 cache-buster ships visible transcript recovery and preserves the media fallback.
assert.match(shell, /experience-recovery\.js\?v=1\.0\.0-maintenance1/);
assert.match(sw, /\.\/experience-recovery\.js/);

console.log('PASS: source recovery keeps playback, media-error fallback, full transcript hydration and Ask on one durable evidence path.');
