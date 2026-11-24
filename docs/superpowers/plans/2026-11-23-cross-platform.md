# Cross-platform Implementation Plan

> **For agentic workers:** Use scoped parallel tasks and test-driven implementation. Root integrates, validates and publishes the combined changes.

**Goal:** Deliver Mock Manager 0.2.0 for macOS 13+ arm64, macOS 13+ x64 and Windows 10/11 x64 with platform-specific system proxy management.

**Architecture:** Platform-specific proxy adapter and build targets around the existing journal/controller and Electron app. Shared filesystem and file-rule compatibility. Native CI jobs produce checked artifacts.

**Tech Stack:** Electron, React, TypeScript, Swift on macOS, Windows PowerShell/WinINet, Vitest and Playwright.

**Spec:** [Cross-platform design](../specs/2026-11-23-cross-platform-design.md)

**Status:** Implementation and native verification are complete at `0cbf28d`. All three jobs passed in [run 45319826675](https://github.com/Josp3r/mock-manager/actions/runs/45319826675). See the [verification record](../verification/2026-11-24-cross-platform.md).

## Global Constraints

- Retain bundled Whistle 2.10.15, legacy data root and application ID.
- Preserve Chinese/English, existing user data, mock Apply boundary and macOS recovery compatibility.
- No real local OS proxy or trust writes. Windows mutation tests only on disposable CI with restoration.
- Version 0.2.0; source and app artifacts exclude runtime profiles/private keys.
- macOS uses ad-hoc signing without Developer ID/notarization; Windows packages remain Authenticode-unsigned.

## Review Focus

- Interrupted proxy writes, external edits, malformed journals and denied policy settings do not clobber unrelated settings or lose recovery data.
- Windows drive/Unicode/space/percent/hash paths are encoded once and load the real JSON file through Whistle.
- Windows permissions/rename/link/fsync differences do not break first launch, save or quit.
- Every packaged runtime and helper matches its target architecture; current macOS builds remain functional.
- CI artifacts correspond to tested code; release creation waits for all targets and remains a draft.

### Task 1: Windows proxy (agent)

- [x] Add failing tests for Windows state mapping, takeover/restore/conflict and journal compatibility.
- [x] Implement Windows adapter and native helper, controller strategy and platform-aware journal validation.
- [x] Verify initial unit tests and provide disposable Windows native test script for CI.
- [x] Pass the real Windows helper and change/restore tests on the final CI revision.

Files: system-proxy controller/types, new Windows adapter/helper/tests. Interface: WindowsSystemProxy(helperPath) implements SystemProxyAdapter; existing macOS adapter remains usable.

### Task 2: Filesystem and rules (agent)

- [x] Reproduce Windows drive path rejection and directory sync/mode portability failures with targeted tests.
- [x] Implement verified drive file rules and shared durable file helper; preserve POSIX semantics.
- [x] Verify real Whistle decoding and initial tests; communicate shared syncDirectory(path) helper to Task 1.
- [x] Verify real Windows fixture loading on the final native CI revision.

Files: compiler, store, new filesystem helper and tests; no system-proxy.ts edits (coordinate with Task 1).

### Task 3: Build/distribution (agent)

- [x] Add architecture-aware native build and macOS signing scripts, Windows packaging, runtime architecture safeguards.
- [x] Add CI matrix for native macOS arm64/x64 and Windows x64, artifact archives/checksums and tag-triggered draft release.
- [x] Validate local scripts/configuration and report required CI commands.

Files: package metadata, build/sign/package scripts, workflow. Root owns packaged smoke test and app integration.

### Task 4: Integration and target verification (root)

- [x] Wire adapter selection, narrow platform bridge, platform menus/window/certificate instructions.
- [x] Make packaged smoke test portable; cover real HTTPS mock, draft persistence, language and native helper reads.
- [x] Push the initial implementation and complete the first Mac arm64/x64 CI jobs.
- [x] Implement the Windows worker-cleanup fix for the first CI `EBUSY` failure.
- [x] Update bilingual README with platform-specific build/test commands and verification limits.
- [x] Finish validating review corrections with unit/build/integration/desktop tests.
- [x] Push the corrected revision, pass all three native CI jobs, and record that exact revision and its artifacts/checksums.
- [x] Prepare final delivery copies and source archives; confirm they exclude runtime profiles/private keys.
