# Mock Manager · cool white / cobalt

The user selected the first three-column layout, then the second palette in the 2026-11-23 refinement set. Implement in the existing Electron application, not a new website.

Visual source: `../../../assets/design-target.png` (original generated result `exec-b1528844-58dc-43fc-a398-58e226704850.png`).

- Display brand: **Mock Manager**. Release: **0.1.3**.
- Preserve projects → interface list → response editor, about 15% / 21% / remaining width at the reference viewport. Keep a usable 1080 × 720 minimum window.
- Pure white main/editor; cool gray-blue navigation; cobalt primary actions/selection. No cream or yellow background. System Chinese font and mono code, 14–15px normal text.
- Use the selected blue M mark for header and a matching desktop icon. Keep existing Lucide icons, which match the reference's outline style.
- Expose a labeled system-proxy switch in the top toolbar using the existing ownership/restoration logic. A managed but changed/failed proxy must remain recoverable and must not appear healthy.
- Per-interface switches in the list are real independent controls, with valid keyboard/accessibility structure. Editor's switch remains available.
- Draft autosave and applied rules remain distinct. Primary action is **应用更改**, scene help **应用后生效**. Mock edits continue to require explicit Apply.
- Keep project CRUD, modules, endpoint CRUD, presets, conditions, status, delay, JSON editing/import/format, response headers, backup, certificate export, connection checks, recovery and quit safeguards.
- Main UI speaks of local engine / Mock rules, rather than Whistle. Acknowledge bundled Whistle 2.10.15 and its MIT license in accessible third-party notices; retain dependency licenses.
- Keep the established app ID and legacy userData location to preserve data, proxy journal, CA and single-instance ownership. Respect explicit isolated-profile/test overrides.
- No actual system-proxy or system-trust writes during validation. Use the existing fixture helper for toggle/recovery tests.

Deliverable: updated source, tested macOS arm64 app archive, preview and QA evidence in outputs. No external publication.
