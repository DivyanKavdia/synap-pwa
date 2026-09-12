# Working on Synap

Start with [the architecture map](docs/ARCHITECTURE.md) and the
[recording lifecycle](docs/RECORDING_LIFECYCLE.md). The PWA is served directly from
this repository. There is no frontend compilation step or framework to install.

## Local setup

Use Node.js 22 or later. From the repository root:

```sh
npm ci
npm ci --prefix backend
npx playwright install chromium
npm run dev
```

Open `http://localhost:4173`. Set `SYNAP_PORT` to choose another port. The local
server binds to this machine; a phone needs a separately served HTTPS origin for
Web Bluetooth. Browser tests use isolated profiles and simulated services.

The backend reads deployment settings from its environment. Copy
`backend/.env.example` to `backend/.env` and follow the
[deployment guide](docs/GCP_DEPLOYMENT.md) for required services and credentials.
Do not use production credentials for fixture tests.

```sh
npm run dev --prefix backend
# Production-style local start:
npm run build --prefix backend
npm start --prefix backend
```

The build output is `backend/dist/src/index.js`. The development command watches
TypeScript directly; it does not depend on a parallel compiler finishing first.
Builds remove stale output before compiling.

## Checks

| Command                                         | What it checks                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `npm test`                                      | Browser module logic, storage/queue rules and shell contracts            |
| `npm run typecheck`                             | Strict backend TypeScript, including unused code checks                  |
| `npm run test:backend`                          | Backend behavior, encryption, grounding and HTTP guards                  |
| `npm run test:browser`                          | The same browser workflow sequence used in CI                            |
| `npm run test:browser -- processing connection` | Only those workflows, including buffered connection recovery             |
| `npm run test:browser -- ui`                    | Populated layouts, date navigation and reading across screen sizes and themes |
| `npm run format -- processing-queue.js`         | Format the specified files                                               |
| `npm run format:check -- processing-queue.js`   | Check formatting without editing                                         |

`SYNAP_CHROMIUM_PATH` can select an already installed Chromium executable.
Browser screenshots from the CI sequence go to `artifacts/workflows/`.
Dependencies are pinned in the lockfiles; use `npm ci` for repeatable checks.

Prefer behavior tests over matching source text. For storage changes, assert
rollback and saved state. For UI changes, complete the relevant user workflow
with a real page and IndexedDB. Use the shared localhost/browser fixture in
`tools/support/browser-fixture.cjs` and the pendant fixture next to it. Keep
network routing and fault injection visible in the individual test.

Some older tests still extract functions or match source formatting. Update those
checks when editing their modules; formatting differences should not decide
whether a behavior is correct. Apply Prettier to the files being maintained,
with formatting changes kept separate from functional edits when practical.

## Extending the code

- Edit the existing owner listed in the architecture map. Use exported APIs and
  explicit events to connect modules. Avoid another prototype wrapper, dynamic
  script injector, or document observer for data refresh.
- Preserve recording IDs, source words, timestamps, notes and original audio.
  Emit completion only after the associated durable write succeeds.
- A new browser module needs a literal script entry in `index.html`, its offline
  entry in `sw.js`, and the appropriate dependency position.
- Advance changed script query versions and `CACHE_REVISION` in `sw.js`. Keep
  `enhancements.js`'s `SHELL_REVISION` equal to that cache revision. Advance
  `UI_RECOVERY_REVISION` for a changed shell; change the BLE client compatibility
  revision only when its contract actually changes.
- Update the current guide for a changed behavior. Keep historical fix reports
  and generated screenshots in Git history or CI artifacts.

## Release evidence

CI checks the PWA, simulated browser workflows and backend. It does not establish
physical Bluetooth endurance, OS notification presentation, speech accuracy,
private-account configuration or a successful pendant flash. Changes at those
boundaries need the corresponding device/service check. See the recording and
notification guides for the supported limits.
