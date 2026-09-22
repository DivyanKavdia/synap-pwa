# Synap development and codebase guide

**Reviewed: 22 September 2026**

## Repository map

### Browser/PWA
- `index.html` — production shell and UI structure.
- `app.js` — core application/recording orchestration.
- `recording/` — journal, timeline, Bluetooth session and wake-lock helpers.
- `devices/` — capability, module, power and device-specific adapters.
- `devices/chakshu/` — camera/media/SD/voice client implementation.
- `memory-*.js`, `brain-ui.js`, `my-actions.js`, `people-confirm-ui.js`, `ask-synap.js` — memory product surfaces.
- `sw.js` — offline shell/update behavior.
- `vendor/` — pinned third-party runtime with retained licenses.

### Backend
- `backend/src/http/` — app, auth, route modules and error/rate limiting.
- `backend/src/pipeline/` — transcription, understanding, indexing, merge, brief and action projection.
- `backend/src/gemini/` — provider contracts, schemas, transcription/memory/Ask.
- `backend/src/speaker/` — diarization, embeddings, known voices, names and self profile.
- `backend/src/store/` — Firestore/GCS and persistent data shapes.
- `backend/src/ops/` — deploy/readiness verification.

### Infrastructure/tests
- `infra/` — deploy/readiness scripts and Terraform.
- `tests/*.cjs` — PWA/source contract tests; all run under `npm test`.
- `backend/test/*.ts` — backend unit/integration tests.
- `tools/browser-tests.cjs` — the canonical browser-smoke suite orchestrator.
- `tools/*-smoke.cjs` — browser journeys called by the orchestrator.
- `tools/repair-pcm-alignment.cjs` — explicit manual recovery utility; intentionally not part of normal CI.

## Device catalog workflow

The firmware repository is canonical. After a catalog change:
1. update firmware `devices/catalog.json`;
2. copy/sync it to this repo's `devices/catalog.json`;
3. run `node tools/device-catalog.cjs`;
4. run `npm test`;
5. confirm target IDs, module IDs, markers and manifest paths did not change unintentionally.

Product-name edits must not rename compatibility identifiers.

## Browser module rule

A production browser script/style must be reachable from `index.html`, the service-worker shell, a worker import, or an intentionally documented dynamic load.

Do not keep an old implementation beside a replacement “just in case.” Git is the rollback store.

## Backend module rule

A production TypeScript module must be reachable from `backend/src/index.ts` through the HTTP app, route graph, pipeline, store or provider graph. Tests may import additional exported helpers, but a test-only production file should be moved under tests/tools instead of being left as dormant runtime code.

At this review all backend source modules are reachable; no backend production file was removed.

## Cleanup performed in this review

The retired full-wordmark PNG system was no longer referenced by the live theme, manifest, service worker or production tests. The active brand uses `synap-mark-<palette>-<mode>.svg` plus text in the shell.

Removed:
- obsolete `synap-logo*.png` wordmarks;
- obsolete `synap-logo.svg` and original `logo.webp` source;
- the stale rasterizer that generated those retired wordmarks;
- an old compact-layout browser smoke script that asserted the retired PNG system and was not called by the canonical browser suite;
- unused Chakshu `settleAudio()` code left behind after connected/offline capture ownership was separated;
- the superseded `media.js` SD-delete helper chain. Verified SD deletion now has one owner: `devices/chakshu/capture-preview.js`.

The launcher icons `icon.svg`, `icon-192.png` and `icon-512.png` remain live. The SD cleanup is guarded by a source contract that rejects direct operation-17 deletion from `devices/chakshu/media.js`.

## Versioning

Keep these concepts separate:
- firmware build/protocol;
- backend API behavior;
- PWA shell/cache generation;
- individual static asset query revision.

Bump shell/cache generation when installed clients must discard an old shell. Bump a specific asset query when that file needs deterministic refresh. Do not bump BLE/audio protocol compatibility for UI-only changes.

## Tests

Fast/source contracts:
```sh
npm test
```

Backend:
```sh
npm run typecheck
npm run test:backend
```

Browser:
```sh
npm run test:browser
```

The browser suite list lives in `tools/browser-tests.cjs`; standalone smoke files not listed there must have an explicit documented manual purpose or be removed.

## Source preservation rules

- Never mutate raw audio to improve transcription.
- Never overwrite source transcript words/timestamps when editing speaker identity.
- Never delete SD source before verified import.
- Never delete source recordings when creating/uncreating a unified memory.
- Never turn a user name correction into implicit voice-profile enrollment.

## Documentation policy

Keep this document and the architecture/operations guides about the **current contract**. Put historical build narratives in Git/release history. When a doc names a current build, verify it from the authoritative release feed.
