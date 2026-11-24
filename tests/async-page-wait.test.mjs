import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForPageCondition } from '../scripts/async-page-wait.mjs';

// The evaluator boundary executes the real async predicate. No browser or
// Electron instance is needed to test the host-side polling contract.
const page = { evaluate: predicate => predicate() };
afterEach(() => { vi.useRealTimers(); });

describe('asynchronous page conditions', () => {
  it('keeps waiting after async false and succeeds only after a resolved true', async () => {
    vi.useFakeTimers();
    let ready = false;
    let settled = false;
    const waiting = waitForPageCondition(page, async () => {
      await Promise.resolve();
      return ready;
    }, { description: 'engine readiness', timeout: 100, interval: 10 });
    void waiting.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(30);
    expect(settled).toBe(false);
    ready = true;
    await vi.advanceTimersByTimeAsync(10);
    await expect(waiting).resolves.toBe(true);
  });

  it('rejects an always-false asynchronous condition at the stated timeout', async () => {
    vi.useFakeTimers();
    const waiting = waitForPageCondition(page, async () => false,
      { description: 'proxy restoration', timeout: 40, interval: 10 });
    const result = waiting.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(40);
    expect(await result).toMatchObject({ error: { message: expect.stringMatching(/Timed out after 40 ms waiting for proxy restoration/) } });
  });

  it('bounds a page evaluation that never settles', async () => {
    vi.useFakeTimers();
    const waiting = waitForPageCondition(page, () => new Promise(() => {}),
      { description: 'unresponsive status IPC', timeout: 40, interval: 10 });
    const result = waiting.then(() => 'resolved', error => error.message);
    await vi.advanceTimersByTimeAsync(40);
    expect(await Promise.race([result, Promise.resolve('still pending')]))
      .toMatch(/Timed out after 40 ms waiting for unresponsive status IPC/);
  });

  it('retains evaluation errors instead of polling past a broken IPC call', async () => {
    const error = new Error('status IPC rejected');
    await expect(waitForPageCondition(page, async () => { throw error; }, { description: 'engine status' }))
      .rejects.toBe(error);
  });
});
