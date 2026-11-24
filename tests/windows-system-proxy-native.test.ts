import { execFile } from 'node:child_process';
import { resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// This test executes only the production input parser and C# types. It never
// reads or writes native settings, so it is safe on a developer's Windows PC.
describe.skipIf(process.platform !== 'win32')('Windows native input contract', () => {
  it('preserves null distinctly from empty and Unicode strings across PowerShell and C#', async () => {
    const executable = win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await promisify(execFile)(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', resolve('tests/native/windows-system-proxy-test.ps1'),
    ], { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    expect(stdout).toContain('input contracts passed');
  }, 35_000);
});
