/** Normal quits and Windows session-end queries must share the same recovery gate. */
export class QuitCoordinator {
  private permitted = false;
  private pending?: Promise<void>;
  constructor(
    private readonly prepare: () => Promise<void>,
    private readonly complete: () => void,
    private readonly failed: (error: unknown) => void | Promise<void>,
  ) {}

  request(event: { preventDefault(): void }): Promise<void> {
    if (this.permitted) return Promise.resolve();
    event.preventDefault();
    if (this.pending) return this.pending;
    const task = (async () => {
      try {
        await this.prepare();
        this.permitted = true;
        this.complete();
      } catch (error) {
        await this.failed(error);
      } finally { this.pending = undefined; }
    })();
    this.pending = task;
    return task;
  }
}
