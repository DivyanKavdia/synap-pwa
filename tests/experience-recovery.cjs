'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = path => fs.readFileSync(path, 'utf8');
const runtime = read('experience-recovery.js');
const theme = read('theme.js');
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

// The recovery runtime must actually ship in both online and installed-PWA paths.
assert.match(theme, /experience-recovery\.js\?v=1\.0\.0-source-recovery1/);
assert.match(sw, /\.\/experience-recovery\.js/);

console.log('PASS: source recovery keeps playback, full transcript hydration and Ask on one durable evidence path.');
