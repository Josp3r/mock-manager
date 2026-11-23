# Version 0.1.4 verification

Verified on macOS Apple Silicon, 2026-11-23.

## Automated checks

| Command | Result |
| --- | --- |
| `npm test` | 114 tests passed across 11 files |
| `npm run build` | TypeScript, renderer, Electron and native helper built successfully |
| `npm run test:integration` | Real Whistle success/empty/error/delay, exact matching, conditions, draft isolation and passthrough passed |
| `npm run test:desktop` | Chinese desktop CRUD, scenarios, presets, Apply and persistence passed |
| `npm run test:system-proxy:desktop` | Enable, restore, restart, cancellation and conflict handling passed with an isolated fixture helper |
| `npm run test:engine` | Bundled engine storage, restart and parent/worker shutdown checks passed |
| `npm run test:i18n:desktop` | Live language changes, native menus/dialogs, preserved data and restart preference passed |
| `npm run package:mac` | Version 0.1.4 packaged; local ad-hoc signature verified |
| `node scripts/packaged-test.mjs` | Packaged startup without Node/w2 in PATH, HTTPS mock, certificate export, language switch and restart passed |

All desktop runs used isolated application profiles. Proxy mutation flows used a fixture helper; the packaged test only read real system-proxy status. No test changed OS proxy settings or certificate trust.

## Language and visual checks

- System preference, explicit Simplified Chinese/English, and unsupported-language fallback are covered.
- Invalid preferences are rejected; malformed preference files do not block workspace startup.
- Language changes leave project data, user text, JSON, pending drafts and applied responses unchanged.
- Successful connection results and transient notices follow live language changes.
- App-owned worker startup/save-timeout and quit errors are translated at the main-process boundary. External diagnostic details remain intact.
- English screenshots were inspected at 1440 × 940 and 1080 × 720. The compact sidebar was widened to display “All endpoints”; the desktop test checks for clipping.
- Desktop page and console error collections were empty.

Independent review found two language omissions (worker errors and a retained connection success message). Both were reproduced with failing tests, fixed, and verified by the checks above.

## Publication preparation

English and Chinese README files, screenshots, the project MIT license, and Whistle attribution are included. Source/history screening found no private keys, runtime profiles or known credential patterns. Generated profiles, dependencies and app builds are ignored by Git. The local build is ad-hoc signed and is not Apple-notarized.
