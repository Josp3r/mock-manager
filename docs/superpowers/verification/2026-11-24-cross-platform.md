# Mock Manager 0.2.0 verification record

Status snapshot: 2026-11-24. This record separates the first CI attempt from verification of the final delivery revision.

## Confirmed first run

Revision: `d98299e`. [GitHub Actions run 45173653510](https://github.com/Josp3r/mock-manager/actions/runs/45173653510).

| Target | Native runner | First-run result |
|---|---|---|
| macOS arm64 | `macos-15` | Passed |
| macOS x64 | `macos-15-intel` | Passed |
| Windows x64 | `windows-2025` | Failed in unit-test worker cleanup with `EBUSY`; later package/runtime/archive steps were not reached |

The [Windows job](https://github.com/Josp3r/mock-manager/actions/runs/45173653510/job/137689233291) exposed a cleanup race. The working-tree fix waits for child-process `close` and retries transient Windows directory locks. That fix and subsequent review corrections still require another CI run. The Mac results above apply to `d98299e`, not to uncommitted changes.

## Final revision checklist

- [ ] Record the final source commit and CI run URL: _pending_.
- [ ] Pass macOS arm64 unit, build, real Whistle integration, development-helper and packaged-runtime checks.
- [ ] Pass macOS x64 unit, build, real Whistle integration, development-helper and packaged-runtime checks.
- [ ] Pass Windows x64 unit, build, real Whistle integration, development-helper and packaged-runtime checks.
- [ ] Pass Windows native proxy change/conflict/restart-recovery checks and verify original settings were restored in `finally` on the disposable runner.
- [ ] Collect all four artifacts below from the same verified revision and check their SHA-256 manifests.
- [ ] Prepare local delivery copies and source archives without runtime profiles or generated CA private keys.

Expected artifacts:

```text
Mock-Manager-0.2.0-mac-arm64.zip
Mock-Manager-0.2.0-mac-x64.zip
Mock-Manager-0.2.0-win-x64.zip
Mock-Manager-0.2.0-win-x64-setup.exe
SHA256SUMS-mac-arm64.txt
SHA256SUMS-mac-x64.txt
SHA256SUMS-win-x64.txt
```

Fill in final evidence after the new run completes:

| Target | Verified commit / run | Artifact location | SHA-256 check | Remaining limits |
|---|---|---|---|---|
| macOS arm64 | Pending | Pending | Pending | Ad-hoc signed; no Developer ID/notarization |
| macOS x64 | Pending | Pending | Pending | Ad-hoc signed; no Developer ID/notarization |
| Windows x64 | Pending | Pending | Pending | Authenticode-unsigned; hosted CI uses Windows Server 2025 |

## Scope and publication limits

The application targets macOS 13+ on arm64/x64 and Windows 10/11 x64. Hosted-runner checks establish evidence for the runner OS versions used; they do not by themselves prove execution on macOS 13 or Windows 10/11 desktop machines. Manual results on those versions, if obtained, should identify the OS version and tested commit here.

Whistle 2.10.15 is bundled. Packaged smoke tests use isolated profiles and real helper reads without changing the local OS proxy or certificate trust. Only the explicitly gated disposable Windows CI test changes WinINet preferences. Windows proxy management covers the current user's LAN settings, not WinHTTP, VPN-specific or application-specific settings.

Normal branch builds do not create a Release. A matching version tag may create or update a draft only after every native job succeeds; it never publishes automatically. If a draft is created, record its URL and review the attached artifacts and aggregate `SHA256SUMS.txt` before publication.
