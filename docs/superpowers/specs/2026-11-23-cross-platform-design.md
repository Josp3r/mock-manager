# Intel Mac and Windows x64 distribution

The user approved adding Intel Mac and Windows x64 after discussion of their current blockers. Keep macOS Apple Silicon support. Deliver real build artifacts where target execution is available, with precise verification evidence. Preserve the established app identity, data directory and bundled Whistle 2.10.15 engine. Version this platform expansion as 0.2.0.

## Approach

Use separate native builds for macOS arm64, macOS x64 and Windows x64. GitHub Actions runs build/test jobs on matching hosted runners and retains their artifacts. Tag releases may create a draft with artifacts after all jobs pass; do not publish an unverified release automatically. A universal Mac binary adds download size and another merge step without improving feature coverage. A Windows build with only manual proxy setup misses the selected one-switch workflow, so implement Windows proxy management first.

## Behavior

- macOS helpers compile for the target architecture; packaging must never silently reuse an Electron runtime of a different architecture.
- Windows manages the current user's system Internet/WinINet LAN proxy. Preserve the original proxy server, bypass list, PAC and detection flags. Use supported Windows APIs, avoid credentials and system certificate writes, and decline unsupported managed/policy configurations. WinHTTP and application-specific proxies are outside this scope.
- Keep journal-before-write, compare-before-change, conflict detection, recovery after restart, and restore-before-quit behavior. macOS journals remain compatible. Windows state must not be interpreted as macOS state.
- Windows paths, including spaces, Unicode, percent/hash characters, must produce valid Whistle file rules. Reject relative paths and device/network paths unless explicitly supported and tested.
- Durable files and recovery journals work on Windows without relying on POSIX directory fsync or mode bits. Preserve symlink protections where supported and never hide arbitrary filesystem errors.
- Windows window controls, menus, certificate guidance and proxy help match the platform; Chinese/English remain supported.

## Verification and publication

Meaningful failing tests precede behavioral changes. Run real proxy requests, draft/apply/restart checks and packaged smoke tests on target systems. Local tests never change the user's OS proxy or certificate trust. A real Windows proxy mutation smoke test may run only on disposable CI runners and must restore settings in finally. CI retains logs and checksums; a passing cross-build alone is not target runtime validation. User authorized updating/pushing this repository; retain history and never force-push. Local artifact delivery remains available independently of GitHub Releases.
