/* Synap backend provider and Google Sign-In regressions.
 *
 * These run in the same dependency-free style as the rest of tests/: the module
 * source is evaluated in a VM with a hand-built browser surface, so there is no
 * network, no real Google and no real backend involved.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const authSource = fs.readFileSync(path.join(root, 'google-auth.js'), 'utf8');
const backendSource = fs.readFileSync(path.join(root, 'synap-backend.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'synap-account-ui.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

function storage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _map: map,
  };
}

/** Minimal browser context: no document, so the DOM-binding paths stay inert. */
function load(source, overrides) {
  const context = Object.assign(
    {
      console,
      Date,
      JSON,
      Error,
      Set,
      Map,
      Promise,
      URL,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Math,
      Intl,
      setTimeout,
      clearTimeout,
      AbortController,
      localStorage: storage(),
    },
    overrides || {},
  );
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'processing-queue.js'), 'utf8'), context);
  vm.runInContext(source, context);
  return context;
}

test('the shell loads auth and the backend provider, and caches them offline', () => {
  assert.match(html, /src="google-auth\.js/);
  assert.match(html, /src="synap-backend\.js/);
  assert.match(html, /src="synap-account-ui\.js/);
  assert.match(sw, /\.\/google-auth\.js/);
  assert.match(sw, /\.\/synap-backend\.js/);
  assert.match(sw, /\.\/synap-account-ui\.js/);
  assert.match(html, /src="people-confirm-ui\.js/);
  assert.match(sw, /\.\/people-confirm-ui\.js/);
  // Bumping the shell revision is what actually ships the new files to
  // installed clients; forgetting it is the classic silent no-op deploy.
  assert.match(sw, /CACHE_REVISION='1\.0\.0-shell79-ble-stability'/);
});

test('the settings form offers the encrypted cloud provider and a sign-in control', () => {
  assert.match(html, /id="providerInput"/);
  assert.match(html, /value="synap"/);
  assert.match(html, /id="synapSignInButton"/);
  assert.match(html, /id="synapBackendUrlInput"/);
  assert.match(html, /id="synapClientIdInput"/);
});

test('no provider API key is ever requested for the cloud path', () => {
  // The whole point of the backend is that the model key lives in Secret
  // Manager. If a Gemini key appears in a browser file, that has been undone.
  for (const source of [authSource, backendSource, uiSource]) {
    assert.doesNotMatch(source, /generativelanguage\.googleapis\.com/);
    assert.doesNotMatch(source, /x-goog-api-key/i);
    assert.doesNotMatch(source, /AIza/);
  }
});

test('auth exposes the session surface the processor depends on', () => {
  const context = load(authSource);
  const auth = context.SynapAuth;
  assert.ok(auth, 'SynapAuth export');
  for (const method of ['signIn', 'signOut', 'refresh', 'accessToken', 'authedFetch', 'session']) {
    assert.equal(typeof auth[method], 'function', `${method} is exported`);
  }
});

test('no stored session means not signed in', () => {
  const context = load(authSource);
  assert.equal(context.SynapAuth.isSignedIn(), false);
});

test('a stored refresh token counts as signed in', () => {
  const context = load(authSource, {
    localStorage: storage({
      'synap-auth-session-v1': JSON.stringify({
        refreshToken: 'r',
        accessToken: 'a',
        expiresAt: 0,
      }),
    }),
  });
  assert.equal(context.SynapAuth.isSignedIn(), true);
});

test('a plaintext backend URL is refused', () => {
  const context = load(authSource);
  assert.throws(
    () => context.SynapAuth.saveConfig({ backendUrl: 'http://example.test', clientId: 'x' }),
    /HTTPS/,
  );
});

test('a trailing slash on the backend URL is normalized away', () => {
  const context = load(authSource);
  const saved = context.SynapAuth.saveConfig({
    backendUrl: 'https://api.example.test/',
    clientId: 'abc.apps.googleusercontent.com',
  });
  assert.equal(saved.backendUrl, 'https://api.example.test');
});

test('a valid access token is reused rather than refreshed on every call', async () => {
  const context = load(authSource, {
    localStorage: storage({
      'synap-auth-session-v1': JSON.stringify({
        refreshToken: 'r',
        accessToken: 'still-good',
        expiresAt: Date.now() + 600000,
      }),
    }),
    fetch: () => {
      throw new Error('must not call the network for a live token');
    },
  });
  assert.equal(await context.SynapAuth.accessToken(), 'still-good');
});

test('an expired access token triggers a refresh', async () => {
  let refreshed = 0;
  const context = load(authSource, {
    localStorage: storage({
      'synap-auth-session-v1': JSON.stringify({
        refreshToken: 'r',
        accessToken: 'stale',
        expiresAt: Date.now() - 1000,
      }),
      'synap-backend-config-v1': JSON.stringify({
        backendUrl: 'https://api.example.test',
        clientId: 'abc',
      }),
    }),
    fetch: (url) => {
      assert.match(String(url), /\/v1\/auth\/refresh$/);
      refreshed += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 }),
          ),
      });
    },
  });

  assert.equal(await context.SynapAuth.accessToken(), 'fresh');
  assert.equal(refreshed, 1);
});

test('concurrent refreshes collapse into one network call', async () => {
  let calls = 0;
  const context = load(authSource, {
    localStorage: storage({
      'synap-auth-session-v1': JSON.stringify({
        refreshToken: 'r',
        accessToken: 'stale',
        expiresAt: Date.now() - 1000,
      }),
      'synap-backend-config-v1': JSON.stringify({ backendUrl: 'https://api.example.test' }),
    }),
    fetch: () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 }),
          ),
      });
    },
  });

  // The queue runs several jobs at once; a burst of refreshes would otherwise
  // rotate refresh tokens out from under each other.
  await Promise.all([
    context.SynapAuth.refresh(),
    context.SynapAuth.refresh(),
    context.SynapAuth.refresh(),
  ]);
  assert.equal(calls, 1);
});

test('a revoked refresh token clears the session instead of retrying forever', async () => {
  const store = storage({
    'synap-auth-session-v1': JSON.stringify({ refreshToken: 'revoked', expiresAt: 0 }),
    'synap-backend-config-v1': JSON.stringify({ backendUrl: 'https://api.example.test' }),
  });
  const context = load(authSource, {
    localStorage: store,
    fetch: () =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve(JSON.stringify({ error: { code: 'token_revoked' } })),
      }),
  });

  await assert.rejects(() => context.SynapAuth.refresh());
  assert.equal(store.getItem('synap-auth-session-v1'), null);
  assert.equal(context.SynapAuth.isSignedIn(), false);
});

test('provider registration leaves custom and other provider dispatch intact', async () => {
  const context = load(backendSource);
  context.DKFIFOProcessor.registerProvider('fixture', {
    process: async () => ({ from: 'fixture' }),
  });
  const processor = new context.DKFIFOProcessor({}, { provider: () => 'fixture' });
  processor.paused = false;
  const result = await processor.process({ id: 1, kind: 'transcribe' }, {}, '');
  assert.deepEqual(result, { from: 'fixture' });
});

test('the provider refuses to run while signed out, and does not retry', async () => {
  const context = load(backendSource, {
    SynapAuth: { isSignedIn: () => false, config: () => ({ backendUrl: '' }) },
  });
  const processor = new context.DKFIFOProcessor({}, { provider: () => 'synap' });
  processor.paused = false;
  await assert.rejects(
    () => processor.process({ kind: 'transcribe', id: 1 }, {}, ''),
    (error) => {
      assert.match(error.message, /Sign in/);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('loading a provider never replaces queue methods', () => {
  const context = load('');
  const { process, run, execute } = context.DKFIFOProcessor.prototype;
  vm.runInContext(backendSource, context);
  vm.runInContext(backendSource, context);
  assert.equal(context.DKFIFOProcessor.prototype.process, process);
  assert.equal(context.DKFIFOProcessor.prototype.run, run);
  assert.equal(context.DKFIFOProcessor.prototype.execute, execute);
});

test('structured memory maps onto the fields the library already renders', () => {
  const context = load(backendSource, { localStorage: storage() });
  const fields = context.SynapBackend.toRecordingFields({
    title: 'Launch planning',
    executive_summary: 'The team settled the launch date.',
    key_points: ['Launch moves to Friday'],
    people: [{ name: 'Ankit', role: 'colleague' }],
    conversations: [
      {
        title: 'Launch planning',
        decisions: [{ text: 'Launch on Friday' }],
        action_items: [{ task: 'Send the deck', owner: 'self', due_date: '2026-09-05' }],
        follow_ups: [{ text: 'Check legal approval' }],
      },
    ],
  });

  assert.equal(fields.name, 'Launch planning');
  assert.equal(fields.processingState, 'done');
  assert.equal(fields.provider, 'synap');
  assert.match(fields.summary, /The team settled the launch date\./);
  assert.match(fields.summary, /Decisions/);
  assert.match(fields.summary, /• Launch on Friday/);
  assert.match(fields.summary, /• Send the deck — self · 2026-09-05/);
  assert.match(fields.summary, /Check legal approval/);
  assert.equal(fields.people.length, 1);
});

test('a memory with no conversations still produces a usable summary', () => {
  const context = load(backendSource, { localStorage: storage() });
  const fields = context.SynapBackend.toRecordingFields({
    title: 'Quiet morning',
    executive_summary: 'Nothing was decided.',
    key_points: [],
    people: [],
    conversations: [],
  });
  assert.equal(fields.summary, 'Nothing was decided.');
});

test('managed configuration is prepared without changing stored custom endpoints', async () => {
  const store = storage({
    'dk-pendant-settings': JSON.stringify({
      endpoint: 'https://mine.example.test',
      autoProcess: true,
    }),
  });
  const context = load(backendSource, {
    localStorage: store,
    SynapAuth: {
      isSignedIn: () => true,
      config: () => ({ backendUrl: 'https://api.example.test' }),
    },
  });
  const original = JSON.parse(store.getItem('dk-pendant-settings'));
  const processor = new context.DKFIFOProcessor({}, { settings: () => original });
  const settings = await context.DKFIFOProcessor.provider('synap').prepare(processor, original);
  assert.equal(settings.endpoint, 'https://api.example.test/v1/recordings');
  assert.equal(settings.llmEndpoint, 'https://api.example.test/v1/recordings');
  assert.equal(settings.autoProcess, true);
  assert.deepEqual(JSON.parse(store.getItem('dk-pendant-settings')), original);
  assert.equal(processor.settings(), original);
});

test('an unconfigured managed provider leaves work pending', async () => {
  const context = load(backendSource, {
    SynapAuth: { isSignedIn: () => true, config: () => ({ backendUrl: '' }) },
  });
  const messages = [];
  const processor = new context.DKFIFOProcessor(
    {},
    { onChange: (message) => messages.push(message) },
  );
  assert.equal(await context.DKFIFOProcessor.provider('synap').prepare(processor, {}), null);
  assert.match(messages.join(' '), /not configured/);
});

test('the backend read helpers cover the second-brain surface', () => {
  const context = load(backendSource, { localStorage: storage() });
  for (const method of [
    'ask',
    'dailyBrief',
    'people',
    'followUps',
    'resolveFollowUp',
    'confirmPerson',
  ]) {
    assert.equal(typeof context.SynapBackend[method], 'function', `${method} is exported`);
  }
});

test('a recording is created once, not once per segment', () => {
  // ensureRecording ran for every 30s chunk. The endpoint is idempotent, but
  // repeating it multiplied requests by capture length and widened the window
  // in which the recording's own metadata could shift between calls.
  assert.match(backendSource, /var createdRecordings = Object\.create\(null\)/);
  assert.match(
    backendSource,
    /if \(createdRecordings\[recordingId\]\) return createdRecordings\[recordingId\]/,
  );
});

test('a failed create is evicted so the recording is not stuck for the session', () => {
  assert.match(
    backendSource,
    /pending\.catch\(function \(\) \{ delete createdRecordings\[recordingId\]; \}\)/,
  );
});

test('creating a recording does not depend on an idempotency ledger', () => {
  // POST /v1/recordings is idempotent on recording_id: it returns the existing
  // recording. A body-fingerprint guard there could only reject a valid retry,
  // which is exactly what stalled every capture at its second segment.
  const routes = fs.readFileSync(path.join(root, 'backend/src/http/routes/recordings.ts'), 'utf8');
  const create = routes.slice(
    routes.indexOf("'/recordings',"),
    routes.indexOf("'/recordings/:recordingId/segments/:index'"),
  );
  assert.doesNotMatch(create, /claimIdempotencyKey/);
  assert.doesNotMatch(create, /completeIdempotencyKey/);
});

test('a changed body under a known idempotency key replays instead of failing', () => {
  // Synap's keys derive from a recording, and a recording's metadata moves
  // while it is captured. A mismatch means newer truth, not abuse.
  const store = fs.readFileSync(path.join(root, 'backend/src/store/firestore.ts'), 'utf8');
  assert.doesNotMatch(store, /Idempotency-Key reused with a different request body/);
  assert.match(store, /return \{ fresh: true, response: null \}/);
});

test('pairing claims are serialized so one cannot consume the other', () => {
  // Claiming is a one-time consume. Returning from Safari fires
  // visibilitychange, which polls at the exact moment a claim is usually
  // outstanding — the first wins, the second is told the pairing was already
  // used, and a successful sign-in renders as a red error.
  assert.match(authSource, /var inFlight = false;/);
  assert.match(authSource, /if \(inFlight\) \{/);
  assert.match(authSource, /if \(stopped\) return;\s*\n\s*timer = null;/);
});

test('a pairing we consumed ourselves resolves instead of reporting failure', () => {
  assert.match(authSource, /error\.status === 409 && isSignedIn\(\)/);
  assert.match(authSource, /resolve\(readSession\(\)\)/);
});

test('other terminal pairing failures still reject', () => {
  // 404 gone, 410 expired and 401 bad secret are real failures and must not be
  // swallowed by the 409 special case.
  assert.match(
    authSource,
    /error\.status === 404 \|\| error\.status === 409 \|\| error\.status === 410 \|\| error\.status === 401/,
  );
});

test('consolidate is given a longer budget than an upload', () => {
  // A 45-minute capture takes minutes to transcribe and understand; the queue's
  // own 120s ceiling is right for an upload and would abort every consolidation.
  assert.match(backendSource, /PROCESSING_TIMEOUT_MS\s*=\s*900000/);
  assert.match(backendSource, /UPLOAD_TIMEOUT_MS\s*=\s*120000/);
  assert.match(
    backendSource,
    /job\.kind === 'consolidate' \? PROCESSING_TIMEOUT_MS : UPLOAD_TIMEOUT_MS/,
  );
});

test('uploads are idempotent and finalize retries use deterministic metadata', () => {
  assert.match(backendSource, /X-Synap-Sha256/);
  assert.match(backendSource, /'Idempotency-Key': 'create:'/);
  assert.match(backendSource, /idempotencyKey\(job, 'finalize-v2'\)/);
  assert.match(backendSource, /stableFinalizeEndedAt\(recording\)/);
  assert.match(backendSource, /started\.getTime\(\) \+ duration/);
  assert.doesNotMatch(backendSource, /ended_at:new Date\([^\n]*Date\.now\(\)/);
});

test('the v2 finalize request body is identical across retries', async () => {
  const finalizeCalls = [];
  const recording = {
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-06T03:11:00.000Z',
    durationMs: 20000,
    rememberMarkers: [],
  };
  const store = {
    get: async (name) => (name === 'recordings' ? recording : null),
    all: async (name) => (name === 'segments' ? [{ frameCount: 400 }] : []),
    atomic: async () => undefined,
  };
  const response = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  });
  const context = load(backendSource, {
    localStorage: storage({ 'synap-ai-provider-settings': JSON.stringify({ provider: 'synap' }) }),
    SynapAuth: {
      isSignedIn: () => true,
      config: () => ({ backendUrl: 'https://api.example.test' }),
      authedFetch: async (url, init = {}) => {
        if (String(url).endsWith('/finalize')) {
          finalizeCalls.push({ body: init.body, key: init.headers['Idempotency-Key'] });
          return response({ state: 'uploaded' }, 202);
        }
        if (String(url).endsWith('/processing'))
          return response({ state: 'ready', progress: 1, retryable: false });
        if (String(url).endsWith('/memory'))
          return response({
            title: 'Done',
            executive_summary: 'Done',
            key_points: [],
            people: [],
            conversations: [],
            transcript: 'hello',
          });
        throw new Error('Unexpected URL ' + url);
      },
    },
  });
  const processor = new context.DKFIFOProcessor({}, { provider: () => 'synap' });
  processor.store = store;
  processor.controllers = new Map();
  processor.paused = false;
  processor.canRun = () => true;
  processor.onChange = () => {};
  const job = {
    id: 7,
    recordingId: recording.id,
    kind: 'consolidate',
    dedupe: recording.id + ':consolidate',
  };

  await processor.process(job, {}, '');
  await processor.process(job, {}, '');

  assert.equal(finalizeCalls.length, 2);
  assert.equal(finalizeCalls[0].key, recording.id + ':consolidate:finalize-v2');
  assert.equal(finalizeCalls[0].key, finalizeCalls[1].key);
  assert.equal(finalizeCalls[0].body, finalizeCalls[1].body);
  assert.equal(JSON.parse(finalizeCalls[0].body).ended_at, '2026-09-06T03:11:20.000Z');
});

test('legacy idempotency failures self-heal once without resetting unrelated failed work', async () => {
  const patched = [];
  const context = load(backendSource, {
    SynapAuth: {
      isSignedIn: () => true,
      config: () => ({ backendUrl: 'https://api.example.test' }),
    },
  });
  const processor = new context.DKFIFOProcessor({
    all: async () => [
      {
        id: 9,
        kind: 'consolidate',
        state: 'failed',
        lastError: 'Error: Idempotency-Key reused with a different request body',
      },
      { id: 10, kind: 'transcribe', state: 'failed', lastError: 'HTTP 400' },
    ],
    patchJob: async (id, fields) => patched.push({ id, fields }),
  });
  const provider = context.DKFIFOProcessor.provider('synap');
  processor.recordingScope = new Set(['selected']);
  await provider.prepare(processor, {});
  assert.equal(patched.length, 0, 'a selected retry must not repair unrelated jobs');
  processor.recordingScope = null;
  await provider.prepare(processor, {});
  await provider.prepare(processor, {});
  assert.equal(patched.length, 1);
  assert.equal(patched[0].id, 9);
  assert.equal(patched[0].fields.state, 'pending');
  assert.equal(patched[0].fields.attempts, 0);
  assert.equal(patched[0].fields.nextAt, 0);
});

test('a paused queue aborts polling instead of holding a job open', () => {
  assert.match(backendSource, /processor\.paused \|\| !processor\.canRun\(\)/);
  assert.match(backendSource, /aborted\.name = 'AbortError'/);
});

test('deployment configuration is hidden from users when the build ships defaults', () => {
  // A backend URL and an OAuth client ID are deployment configuration. Asking a
  // person to paste them is a setup bug, not a setting.
  assert.match(uiSource, /connection\.hidden = configured && !force/);
  assert.match(uiSource, /Boolean\(settings\.backendUrl && settings\.clientId\)/);
  assert.match(html, /id="synapConnectionDetails"/);
});

test('the connection panel reappears when sign-in fails or config is missing', () => {
  // Hiding it must not strand a fork or a self-hosted backend with no way in.
  assert.match(uiSource, /revealConnection\(true\)/);
});

test('an unset provider preference is written down as the cloud default', () => {
  // ai-providers.js defaults an unset preference to 'openai' and would then
  // intercept every job looking for a key this build no longer asks for.
  assert.match(uiSource, /stored !== 'synap' && stored !== 'openai' && stored !== 'custom'/);
  assert.match(uiSource, /stored = 'synap';\s*\n\s*savePrefs\(\{ provider: stored \}\);/);
});

test('marked moments reach the cloud before finalization; upload failures block summary creation', async () => {
  for (const fail of [false, true]) {
    const calls = [],
      recording = {
        id: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-09-12T00:00:00.000Z',
        durationMs: 20000,
        rememberMarkers: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            offsetMs: 1250,
            source: 'pwa',
            createdAt: '2026-09-12T00:00:01.250Z',
          },
        ],
      };
    const response = (data, status = 200) => ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(data),
    });
    const context = load(
      fs.readFileSync(path.join(root, 'moments.js'), 'utf8') + '\n' + backendSource,
      {
        localStorage: storage({
          'synap-ai-provider-settings': JSON.stringify({ provider: 'synap' }),
        }),
        SynapAuth: {
          isSignedIn: () => true,
          config: () => ({ backendUrl: 'https://api.example.test' }),
          authedFetch: async (url, init = {}) => {
            const endpoint = new URL(url, 'https://api.example.test').pathname.split('/').pop();
            calls.push({ endpoint, body: init.body ? JSON.parse(init.body) : null });
            if (endpoint === 'highlights')
              return response(fail ? { error: 'temporary failure' } : {}, fail ? 503 : 201);
            if (endpoint === 'finalize') return response({ state: 'uploaded' }, 202);
            if (endpoint === 'processing')
              return response({ state: 'ready', progress: 1, retryable: false });
            if (endpoint === 'memory')
              return response({
                title: 'Done',
                transcript: 'hello',
                people: [],
                conversations: [],
                key_points: [],
              });
            throw Error('Unexpected request ' + url);
          },
        },
      },
    );
    const processor = new context.DKFIFOProcessor({}, { provider: () => 'synap' });
    Object.assign(processor, {
      store: {
        get: async () => recording,
        all: async () => [{ frameCount: 400 }],
        atomic: async () => {},
      },
      controllers: new Map(),
      paused: false,
      canRun: () => true,
      onChange() {},
    });
    const operation = processor.process(
      {
        id: 1,
        recordingId: recording.id,
        kind: 'consolidate',
        dedupe: recording.id + ':consolidate',
      },
      {},
      '',
    );
    if (fail) {
      await assert.rejects(operation);
      assert(!calls.some((c) => c.endpoint === 'finalize'));
    } else {
      await operation;
      assert.deepEqual(
        calls.map((c) => c.endpoint),
        ['highlights', 'finalize', 'processing', 'memory'],
      );
    }
    assert.equal(calls[0].body.offset_ms, 1250);
    assert.equal(calls[0].body.source, 'pwa');
    assert.equal(calls[0].body.highlight_id, recording.rememberMarkers[0].id);
  }
});

test('Actions requests release controls even when authentication ignores abort', async () => {
  let deadline, budget, signal;
  const context = load(backendSource, {
    setTimeout(fn, ms) {
      deadline = fn;
      budget = ms;
      return 1;
    },
    clearTimeout() {},
    SynapAuth: {
      authedFetch(_path, options) {
        signal = options.signal;
        return new Promise(() => {});
      },
    },
  });
  const pending = context.SynapBackend.people();
  await Promise.resolve();
  assert.equal(budget, 15000);
  deadline();
  await assert.rejects(
    pending,
    (error) => error.name === 'TimeoutError' && error.retryable === true,
  );
  assert.equal(signal.aborted, true);
});

test('Actions request deadlines include a stalled response body', async () => {
  let deadline;
  const context = load(backendSource, {
    setTimeout(fn) {
      deadline = fn;
      return 1;
    },
    clearTimeout() {},
    SynapAuth: { authedFetch: async () => ({ ok: true, text: () => new Promise(() => {}) }) },
  });
  const pending = context.SynapBackend.followUps('open', 'all');
  await Promise.resolve();
  deadline();
  await assert.rejects(pending, /timed out/);
});
