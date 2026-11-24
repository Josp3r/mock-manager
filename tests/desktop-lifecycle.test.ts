import { describe, expect, it, vi } from 'vitest';
import { singleFlight } from '../src/shared/single-flight';
import { QuitCoordinator } from '../src/main/quit-coordinator';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

describe('slow status polling', () => {
  it('shares one pending operation and delivers its result instead of superseding it', async () => {
    const gate = deferred();
    let calls = 0;
    const refresh = singleFlight(async () => { calls++; await gate.promise; return 'updated'; });
    const waiting = Array.from({ length: 6 }, () => refresh());
    expect(calls).toBe(1);
    gate.resolve();
    expect(await Promise.all(waiting)).toEqual(Array(6).fill('updated'));
    await refresh();
    expect(calls).toBe(2);
  });
  it('allows recovery after a failed read without leaving a rejected operation cached', async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue('recovered');
    const refresh = singleFlight(operation);
    await expect(refresh()).rejects.toThrow('unavailable');
    expect(await refresh()).toBe('recovered');
  });
});

describe('normal quit and Windows session end', () => {
  it('blocks both events while drafts and proxy restoration finish before exiting', async () => {
    const restore = deferred();
    const events: string[] = [];
    const quit = new QuitCoordinator(async () => {
      events.push('save');
      await restore.promise;
      events.push('restore');
      events.push('stop-engine');
    }, () => { events.push('exit'); }, () => { events.push('error'); });
    const session = { preventDefault: vi.fn() };
    const normal = { preventDefault: vi.fn() };
    const pending = quit.request(session);
    void quit.request(normal);
    expect(session.preventDefault).toHaveBeenCalledOnce();
    expect(normal.preventDefault).toHaveBeenCalledOnce();
    expect(events).toEqual(['save']);
    restore.resolve();
    await pending;
    expect(events).toEqual(['save', 'restore', 'stop-engine', 'exit']);
    const finalQuit = { preventDefault: vi.fn() };
    await quit.request(finalQuit);
    expect(finalQuit.preventDefault).not.toHaveBeenCalled();
  });
  it('keeps the app alive after restoration fails and permits an explicit retry', async () => {
    const prepare = vi.fn().mockRejectedValueOnce(new Error('conflict')).mockResolvedValue(undefined);
    const exit = vi.fn();
    const failed = vi.fn();
    const quit = new QuitCoordinator(prepare, exit, failed);
    await quit.request({ preventDefault: vi.fn() });
    expect(exit).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'conflict' }));
    await quit.request({ preventDefault: vi.fn() });
    expect(exit).toHaveBeenCalledOnce();
  });
});
