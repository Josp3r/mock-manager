# Mock Manager 0.2.0 verification record

Verified implementation: `0cbf28d0de15f1347d3fa067c0027fae670a7091`.
[Complete native CI run](https://github.com/Josp3r/mock-manager/actions/runs/45319826675).
Subsequent release-preparation documentation changes do not change the application.

| Target | Native runner | Unit tests | Build, integration, development app, packaged app and archive |
|---|---|---|---|
| macOS arm64 | `macos-15` | 189 passed, 1 platform-specific skip | Passed |
| macOS x64 | `macos-15-intel` | 189 passed, 1 platform-specific skip | Passed |
| Windows x64 | `windows-2025` | 180 passed, 10 platform-specific skips | Passed |

Windows additionally passed actual WinINet read/write, stale-state conflict, restart recovery and exact restoration of the runner's original settings. These changes ran only on a disposable GitHub-hosted Windows runner.

Packaged smoke tests cover empty PATH (no external Node or w2), real HTTPS Mock with exported public CA verification, Unicode/space/percent/hash profile paths, persistent rules/port/CA, language/menu changes, restart and coordinated exit. Windows also exercises the session-end query through the real app's event handler. This is not a full Windows logoff test.

Local macOS validation also passed type checking, production build, desktop editing and persistence, fixture-based proxy lifecycle, bilingual menus/dialogs and packaged arm64 runtime. No local OS proxy or certificate trust settings were changed.

## Distribution

The CI run provides these artifacts and platform-specific SHA-256 manifests:

```text
Mock-Manager-0.2.0-mac-arm64.zip
Mock-Manager-0.2.0-mac-x64.zip
Mock-Manager-0.2.0-win-x64.zip
Mock-Manager-0.2.0-win-x64-setup.exe
```

The tag workflow rebuilds all three native targets and verifies every downloaded artifact against its manifest before attaching all four files and an aggregate `SHA256SUMS.txt` to a draft Release. It does not publish automatically.

Local Mac copies were built from `b09c91e`; the only subsequent implementation-branch change (`0cbf28d`) selects the Windows system archive tool. Application sources are identical. Local ZIP checksums were verified:

```text
f7394995861782e257a574bcf7464ae3847805e1a4af89ec86909b339c99ad6d  Mock-Manager-0.2.0-mac-arm64.zip
097f4d6eea3ca6ea6e5ade7495f28b4cf8e0015edffb6c938dae1897de4f33a0  Mock-Manager-0.2.0-mac-x64.zip
```

These local hashes are distinct from CI-built archives, whose manifests travel with those artifacts. Source archives contain tracked files only; runtime profiles, generated CA private keys, node_modules and test-results are excluded.

## Problems found and resolved

- Windows worker cleanup exposed Whistle's detached background service outliving its parent. Both normal stop and parent-close now terminate that service through pfork; real child-process regressions failed before the fix and passed afterward.
- Windows Electron utility processes replace the inherited environment. The worker now preserves only the essential Windows SystemRoot alongside its isolated Whistle path, fixing Winsock initialization without importing external Node/Whistle configuration.
- Async IPC predicates were incorrectly used with Playwright waitForFunction. All desktop harnesses now await actual results with a bounded polling helper, backed by regression tests.
- Native proxy parsing now preserves null versus empty strings. Windows session shutdown uses the same recovery gate as normal quit; slow polling shares an in-flight read; external policy/credential changes retain an explicit recovery path.
- Git Bash's tar treated drive-qualified ZIP paths as remote destinations. Windows archives now explicitly use the system bsdtar.

## Limits

The application targets macOS 13+ on arm64/x64 and Windows 10/11 x64. Hosted CI verifies its actual runner OS versions; it does not replace manual testing on macOS 13 or Windows 10/11 desktop machines. The NSIS installer is built from the tested app tree; installer UI and uninstall were not separately exercised.

macOS apps are ad-hoc signed without Developer ID or Apple notarization. Windows packages are Authenticode-unsigned. Whistle 2.10.15 is bundled. Windows proxy management covers current-user LAN/WinINet settings; WinHTTP, VPN-specific and app-specific proxy settings are outside this scope.
