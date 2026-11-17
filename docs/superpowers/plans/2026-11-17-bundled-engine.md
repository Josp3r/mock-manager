# Bundled engine implementation plan

**Goal:** Ship a desktop that starts its own npm Whistle without global Node/w2.
**Architecture:** Private Electron utility process, authenticated HTTP API, existing rule synchronization and reversible native system proxy.
**Tech Stack:** Electron 45, Whistle 2.10.15, React, TypeScript.
**Spec:** docs/superpowers/specs/2026-11-17-bundled-engine-design.md

## Global Constraints

All users use builtin only, per the user's explicit correction. Loopback only; independent profile data/plugins/CA; never discover, modify, or stop external w2. No real system proxy or trust changes during tests. Preserve own-rule and journal guards.

## Review Focus

Port collision must not attach to another proxy. Migration must preserve projects without replaying external pending writes. Quit after restoration or persistence failure must keep the engine alive. Fresh packaged profile must need no external Node/w2. Certificate export exposes only the public certificate.

### Task 1: Persisted model and migration

Files: shared/types, core/model, main/sync/store and relevant tests. All settings normalize builtin; old projects and snapshots remain available. Legacy interrupted sync journals are archived locally. Controller always selects the builtin adapter. Remove external mode/path selection from bridge. Add certificate export, proxy self-test, and quit coordination interfaces.

- [x] Test fresh/legacy data, stale renderer saves, journal migration and absence of external access.
- [x] Implement and verify migration with existing synchronization suite.

### Task 2: Embedded engine and packaging

Files: embedded-whistle.ts, whistle-worker.cjs, build-electron.mjs, package/lock and real engine test. Electron utilityProcess owns an authenticated loopback listener, private data/certificate directory and persisted port. Bundle pinned npm runtime modules and assets. Explicit startup, stop and public certificate APIs. No external runtime discovery.

- [x] Verify source options; implement engine and actual Electron smoke.
- [x] Cover collision, management authentication, mock, certificate, persistence and parent crash cleanup.
- [x] Include dependencies and worker in the locally signed package.

### Task 3: Desktop onboarding and lifecycle

Files: main/preload, renderer settings/workspace/App/styles, self-test and shutdown coordinator. Start builtin automatically. Settings show readiness/retry, macOS certificate export instructions, system proxy and narrowly described HTTP transport self-test. Window close keeps engine; actual quit flushes drafts, restores owned proxy, then stops engine. Failures keep application usable.

- [x] Add behavior checks and implement.
- [x] Verify CRUD/fixtures/scenarios, self-test, certificate export, layout and quit cancellation using isolated native fixture.
- [ ] Final review fixes: keep renderer frozen throughout quit; require explicit engine persistence barrier before stopping.

### Task 4: Review and release

- [x] Independent review; two lifecycle findings routed to one fix wave.
- [x] Package fresh profile with PATH lacking Node/w2: HTTPS CONNECT with exported CA, mock and restart persistence.
- [ ] Scoped re-review of fixes; affected checks and final package rebuild.
- [ ] Signature/archive integrity; versioned output app, source and verification note.
