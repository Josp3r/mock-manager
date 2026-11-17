# Whistle Mock Manager — approved first version

User approved November 17, 2026: an independent desktop app, for personal use, with configuration stored internally, controlling installed Whistle to mock production-domain requests through a local proxy. The app manages projects, modules, endpoint methods/URLs and optional Query/Header equals conditions, multiple named JSON responses, HTTP codes/delays/headers, endpoint toggles and project scene presets. It imports JSON into internal storage and imports/exports a backup. The user approved draft autosave and explicit Apply; closing the window preserves already applied rules and the app master switch disables only its own rules.

## Chosen approach
The user chose a desktop app over an independent local web app or a Whistle plugin. Proposed implementation: Electron + React + TypeScript, initially macOS arm64 on this machine. Electron's main process loads the official Whistle Node API via `w2 root bin/api`; an isolated renderer uses narrow preload IPC. Tauri would need an extra Node sidecar for the same API, so Electron is the default implementation choice. Installed Whistle 2.10.12 meets the API minimum 2.10.7. At discovery it was not running.

## Behavior and scope
- Projects contain modules (endpoint grouping strings), endpoints and named project presets. At most one response per endpoint is active. A preset stores every endpoint's selected response and enabled state.
- Exact scheme/domain/port/path/method matching; query is ignored by default, optional query/header equals conditions restrict it. URL query input is explicitly represented as conditions. Advanced scripts, arbitrary regex and body matching are outside this first version.
- User data is versioned JSON with atomic writes, recovery backup and independent response fixture files. Invalid JSON can be saved as a draft but cannot be applied. Imports are validated and default disabled.
- One stable uniquely named managed Whistle rule file. The local model is authoritative; external modifications to that file produce a conflict rather than an overwrite. Existing Whistle rules are preserved. Global single-selection mode requires explicit UI setup of multiple selection. Never turn on the global engine silently or use global disable/unselect-all. Ordering remains as configured in Whistle; synchronized configuration is not a claim of actual traffic interception.
- The app detects w2 path and supports manual selection for Finder PATH differences. It displays running/HTTPS/multiselect/global rules state and offers a start button. Proxy and certificates remain standard Whistle setup, with help links/status.
- Apply operations are serialized. Fixtures use unique content/version paths so applying or autosaving cannot silently alter a previously active response. Write fixtures, compile, set/select only managed rule file, verify readback, then save the applied snapshot. Failure is visible and a last-successful snapshot can be restored.
- Backups contain projects/responses, not machine path or activation. Import is additive with fresh IDs and disabled endpoints.

## UI
Chinese developer workbench: project/module navigation, searchable endpoint list and response editor. Warm neutral surfaces, restrained green signal, legible monospace JSON. Show loading, empty, error, draft and synchronization states. Full keyboard focus and descriptive controls. Scope is a working desktop tool, without marketing sections.

## Acceptance
Unit tests pin matching/compilation, persistence/import, concurrency/conflicts/failures. An isolated Whistle instance with a local upstream proves normal/empty/500/delay responses and passthrough after disable. No test sends requests to production. Desktop smoke test exercises real preload/UI editing and persistence. Deliver source, instructions and a local unsigned macOS .app. No remote repository is required; user asked whether to create one and was told local version control can be prepared here.
