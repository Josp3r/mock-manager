# System Proxy Implementation Plan

> **For agentic workers:** use subagent-driven-development for exclusive file scopes and a scoped final review.

**Goal:** Add a reversible macOS system HTTP/HTTPS proxy switch and ship v0.1.1.
**Architecture:** Renderer calls narrow preload methods; a main-process controller journals before/installed snapshots and talks to a bundled Swift SystemConfiguration helper. Helper holds the preference lock across compare/write and uses native authorization.
**Tech Stack:** existing Electron/React/TypeScript, Swift/SystemConfiguration, Vitest/Playwright.
**Spec:** docs/superpowers/specs/2026-11-17-system-proxy-design.md

## Global Constraints
- Preserve original proxy dictionaries, protocol flags, bypasses and Keychain credentials; external edits are not overwritten.
- Only enable using verified running Whistle; disable/recovery works without Whistle.
- No generic renderer command/path/host input; no testing that changes the user's live network proxies.
- Backup before mutation, serialized operations, native cancellation/error/readback feedback.

## Review Focus
- Cancelled/failed authorization must not turn the switch on or discard recovery state.
- PAC, SOCKS and exceptions must survive a full enable/disable cycle.
- Restart, partial native failure, renamed/missing services and external changes must not cause destructive recovery.
- Packaged helper path/permissions/signature and dev path must both work.
- Existing Mock switch, saved projects, proxy-independent UI errors and narrow IPC must remain intact.

## Tasks
- [ ] Native helper + Node adapter: src/native/system-proxy.swift, src/main/native-system-proxy.ts, scripts/build-native.mjs. Read all proxy-capable services with active membership, preserve protocol flags; write strict bounded changes with expected/next configuration and native lock+authorization. Read-only real OS probe and isolated fixture tests. No live writes.
- [ ] Controller + tests: src/main/system-proxy.ts, tests/system-proxy.test.ts. Methods status(), enable({host,port}), disable(); persist root/system-proxy.json before write; restore full snapshots with CAS; conflict release archives the backup; meaningful failure/restart/conflict tests first.
- [ ] Integration + UI: shared contract, main/preload/workspace/Settings; disabled/loading/cancelled/changed/error states; only explicit switch click changes system settings. Build configuration includes native helper, update README and version.
- [ ] Verification/delivery: unit/typecheck, native helper compile/read-only, real Electron toggle tests with isolated adapter process, regression desktop/Whistle, independent review, package/signature/resources. Publish versioned output without replacing the user's running app.
