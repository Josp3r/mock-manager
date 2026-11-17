# Bundled Whistle engine

User chose npm-bundled Whistle to remove first-time Node/w2 installation. Existing Electron/macOS app and visual rule workflow remain.

## Approach
Bundle the pinned npm dependency and run it in an Electron utility process (Electron supplies Node). All users use builtin; remove external w2 connection and mode-switch UI. A separately downloaded engine adds first-run network failure; in-process Whistle shares global state and failure with the desktop, so neither is selected.

## Behavior and constraints
- New and legacy profiles use builtin. Preserve project data; never discover, modify or stop external w2. Archive any legacy interrupted sync journal locally; no automatic activation in the new engine.
- Builtin binds only 127.0.0.1, uses a private profile directory and persistent port, never reads global Whistle data/plugins/certificates. No external Node or npm at runtime.
- On startup start builtin automatically. Failure is visible with retry; never silently attach to a port's existing listener. Restart reuses its own saved rules and certificate.
- No mode switch exists. Legacy external processes and rules remain untouched; UI explains that existing system proxy must be restored and re-enabled if its address differs from builtin.
- Window close on macOS keeps engine running. Actual quit restores app-managed system proxy before stopping builtin. If restoration fails, keep application and engine alive and show a concrete error. Never stop externally managed w2.
- Settings show builtin source, version/address, retry, certificate export with macOS Keychain trust instructions, system proxy, and a real isolated HTTP proxy self-test. Certificate trust/system proxy require user actions; no automatic OS trust changes.
- Self-test serves only a random local endpoint, explicitly requests through selected proxy, checks nonce, closes its temporary server, and reports that it checks proxy transport, not browser system routing or certificate trust.
- Keep existing rule ownership, journal, fixture safety, native proxy safeguards, and UI command serialization.
- Ship macOS arm64 v0.1.2 locally signed app, source and zipped deliverables. Verify a packaged fresh profile with PATH lacking Node/w2 and no external engine dependency.

## Builder calls
Whistle 2.10.15 pinned; Electron utilityProcess; random management auth secret; explicit narrow internal HTTP API. User correction: use builtin for every user, with no external connection option. This implements the user's accepted npm-bundled approach; no further design approval required under session authorization and developer autonomy rules.
