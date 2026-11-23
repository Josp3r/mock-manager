# Mock Manager Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver the selected three-column, cool-white/cobalt design as Mock Manager 0.1.3.

**Architecture:** Keep the existing Electron, React, store and embedded proxy architecture. Renderer markup and tokens change in place; branding preserves storage identity. Delegate independent renderer and packaging changes while the root owns styling, assets, visual validation and delivery.

**Tech Stack:** Electron, React, TypeScript, Vite, Lucide, Whistle 2.10.15.

**Spec:** `../specs/2026-11-23-mock-manager-design.md`

## Global Constraints
- Brand Mock Manager, version 0.1.3, bundled engine only.
- Preserve draft/apply semantics, proxy recovery and persistent data path.
- Keep current app ID; never alter user's actual proxy/trust during tests.
- No new framework, server or runtime dependencies.

## Review Focus
- Managed proxy whose settings changed or engine failed: toolbar provides recovery, not a false healthy status.
- Rename: default data path, explicit CLI profile, and development data override remain correct.
- Narrow viewport and long project/endpoint names: no hidden persistent controls or adjacent-column overlap.
- List row switch: no nested buttons; mouse and keyboard change only intended endpoint without accidental selection.
- Invalid JSON / immediate quit: existing validation and draft flush remain intact.

### Task 1: Renderer structure and actions
**Files:** `src/renderer/App.tsx`, `EndpointEditor.tsx`, `ui.tsx` if needed.
**Interface:** Existing workspace and IPC APIs only. Add `.topbar__proxy`, list switch and selection-row classes; communicate exact new classes to root.
- [x] Add toolbar system-proxy control with existing busy/error/managed gating.
- [x] Simplify list and scene/editor headers toward target, preserving all CRUD and presets.
- [x] Add accessible per-row enable switches; update copy to user-facing local-engine wording.
- [x] Check typecheck and existing behavior coverage after integration.

### Task 2: Brand and compatibility
**Files:** `package.json`, lockfile, `src/main/main.ts`, settings and packaging/test scripts; notices assets.
- [x] Pin legacy storage path when changing display name; preserve explicit profiles.
- [x] Set productName/window/menu to Mock Manager, update release metadata and packaging paths.
- [x] Add readable bundled-license notices accessible from About/help; retain original dependency LICENSE.
- [x] Update existing integration script selectors/copy assertions; verify name/profile behavior and existing scenarios.

### Task 3: Visual implementation
**Files:** tokens/base/styles, generated logo and icon assets, target reference.
- [x] Generate selected M asset in blue, inspect, copy into project; prepare desktop icon using permitted asset tools.
- [x] Map typography, palette, layout, spacing, selection states and editor styling to target.
- [x] Capture actual rendered application at reference and minimum viewport.
- [x] Compare reference and capture together, fix P0/P1/P2 differences, record `design-qa.md`.

### Task 4: Verification and delivery
- [x] Run `npm run typecheck`, `npm test`, `npm run build`, existing Electron desktop and fixture proxy tests.
- [x] Review combined diff independently and fix actionable findings.
- [x] Package/sign macOS arm64 app; run packaged fresh-profile/HTTPS/restart checks.
- [x] Export source/app archives and preview under outputs, verify archives, report concrete results.

Execution is already authorized by the user's visual selection; proceed without an additional plan approval.
