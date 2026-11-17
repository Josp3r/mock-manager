# Bundled engine implementation plan

> Use subagent-driven-development for isolated tasks and root integration.

**Goal:** Ship a desktop that starts its own npm Whistle without global Node/w2.
**Architecture:** Private Electron utility process, narrow authenticated HTTP API, mode-aware sync controller, existing reversible native system proxy.
**Tech Stack:** Electron 45, Whistle 2.10.15, React, TypeScript.
**Spec:** docs/superpowers/specs/2026-11-17-bundled-engine-design.md

## Global Constraints
Loopback only; independent profile data/plugins/CA; preserve external mode for legacy profiles; never kill external w2; no real system proxy or trust changes during tests; preserve own-rule and journal guards.

## Review Focus
Port collision must not attach to another proxy. Switching after interrupted sync must not strand active rules. Quit after restore failure must keep engine alive. Fresh packaged profile must need no external Node/w2. Certificate export must only expose public certificate.

### Task 1: Mode-aware persisted model and sync
Files: src/shared/types.ts, src/core/model.ts, src/main/sync.ts, tests/core.test.ts, tests/sync.test.ts. Interfaces: EngineMode='builtin'|'external'; optional settings.engineMode (normalized legacy external); fresh builtin; ConnectionStatus.engineMode optional; bridge setEngineMode(mode):Promise<ApplyResult>, testConnection():Promise<{ok:boolean;message:string}>, exportCertificate():Promise<boolean>. Access selector string '@builtin' routes builtin; original w2Path stays external. Controller.setEngineMode serializes recovery/unselect/ownership validation before persistence; snapshots remain for explicit restore. updateW2Path preserves settings. Test defaults/migration, stale renderer cannot set mode, active own rule deactivation, pending/conflict/offline refusal, and selector identity.
- [ ] Add focused failing tests, implement, run suite/typecheck, commit.

### Task 2: Embedded engine and packaging
Files: new src/main/embedded-whistle.ts, src/main/whistle-worker.cjs, scripts/build-electron.mjs, package.json/package-lock.json, new engine tests/script. Interfaces: EmbeddedWhistle implements WhistleAccess; constructor(dataRoot:string, workerPath:string); start, find, resolve, endpoint, stop():Promise<void>, certificate():Promise<Buffer>. EngineRouter(builtin,external) implements WhistleAccess routes '@builtin'. Main starts only after Electron ready. Worker/manager isolate data, loopback + persisted port and authenticated API. No external global binary. Include npm dependencies and worker in packaged app. Test actual lifecycle and mock/management behavior with isolated profiles; port collision explicit failure. Root owns main.ts/preload.ts integration.
- [ ] Verify source options, tests before implementation, implement, actual Electron smoke, commit.

### Task 3: Desktop integration and onboarding
Files: main.ts/preload.ts, renderer Settings/workspace/App/styles, new proxy self-test and quit coordinator tests. Connect mode switching to restored system proxy; automatic builtin startup; quit waits for restoration and keeps process on failure. Settings actionable setup steps and public certificate export; self-test not misrepresented as browser/TLS test. Existing external paths work.
- [ ] Add behavior checks; implement; build and run desktop scenarios with fixture native proxy only.

### Task 4: Review and release
- [ ] Independent final review and focused fixes.
- [ ] Unit suite/typecheck/build, existing real isolated proxy integration, desktop regressions, packaged PATH-sanitized builtin scenario, bundle/signature/archive checks.
- [ ] README/versioned output delivery and git clean source snapshot.

## User correction (binding, supersedes conflicting task text)
All profiles use builtin; remove external connection/mode UI and chooseW2/setEngineMode bridge. Core task implements local migration and legacy pending journal archival; no external side effects. Engine task needs no router. Desktop always starts builtin; existing external-mode test scripts will be adapted for their new scope.
