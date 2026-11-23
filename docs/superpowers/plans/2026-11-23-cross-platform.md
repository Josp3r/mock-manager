# Cross-platform Implementation Plan

> **For agentic workers:** Use scoped parallel tasks and test-driven implementation. Root integrates, validates and publishes the combined changes.

**Goal:** Deliver Mock Manager 0.2.0 for macOS arm64, macOS x64 and Windows x64 with matching system proxy behavior.

**Architecture:** Platform-specific proxy adapter and build targets around the existing journal/controller and Electron app. Shared filesystem and file-rule compatibility. Native CI jobs produce checked artifacts.

**Tech Stack:** Electron, React, TypeScript, Swift on macOS, Windows PowerShell/WinINet, Vitest and Playwright.

**Spec:** ../specs/2026-11-23-cross-platform-design.md

## Global Constraints
- Retain bundled Whistle 2.10.15, legacy data root and application ID.
- Preserve Chinese/English, existing user data, mock Apply boundary and macOS recovery compatibility.
- No real local OS proxy or trust writes. Windows mutation tests only on disposable CI with restoration.
- Version 0.2.0; source and app artifacts exclude runtime profiles/private keys.

## Review Focus
- Interrupted proxy writes, external edits, malformed journals and denied policy settings do not clobber unrelated settings or lose recovery data.
- Windows drive/Unicode/space/percent/hash paths are encoded once and load the real JSON file through Whistle.
- Windows permissions/rename/link/fsync differences do not break first launch, save or quit.
- Every packaged runtime and helper matches its target architecture; current macOS builds remain functional.
- CI artifacts correspond to tested code; release creation waits for all targets and remains a draft.

### Task 1: Windows proxy (agent)
- [ ] Add failing tests for Windows state mapping, takeover/restore/conflict and journal compatibility.
- [ ] Implement Windows adapter and native helper, controller strategy and platform-aware journal validation.
- [ ] Verify unit tests and provide disposable Windows native test script for CI.
Files: system-proxy controller/types, new Windows adapter/helper/tests. Interface: WindowsSystemProxy(helperPath) implements SystemProxyAdapter; existing macOS adapter remains usable.

### Task 2: Filesystem and rules (agent)
- [ ] Reproduce Windows drive path rejection and directory sync/mode portability failures with targeted tests.
- [ ] Implement verified drive file rules and shared durable file helper; preserve POSIX semantics.
- [ ] Verify real Whistle decoding and tests; communicate shared syncDirectory(path) helper to Task 1.
Files: compiler, store, new filesystem helper and tests; no system-proxy.ts edits (coordinate with Task 1).

### Task 3: Build/distribution (agent)
- [ ] Add architecture-aware native build and macOS signing scripts, Windows packaging, runtime architecture safeguards.
- [ ] Add CI matrix for native macOS arm64/x64 and Windows x64, artifact archives/checksums and tag-triggered draft release.
- [ ] Validate local scripts/configuration and report required CI commands.
Files: package metadata, build/sign/package scripts, workflow. Root owns packaged smoke test and app integration.

### Task 4: Integration and target verification (root)
- [ ] Wire adapter selection, narrow platform bridge, platform menus/window/certificate instructions.
- [ ] Make packaged smoke test portable; exercise real HTTPS mock, draft persistence, language and native helper reads.
- [ ] Run unit/build/integration/desktop tests; independently review and fix important findings.
- [ ] Push, follow native CI to completion, collect artifacts and document exact platform evidence/limits.
- [ ] Update bilingual README, delivery copies and source archives.
