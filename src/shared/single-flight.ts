/** Share an in-flight read so polling cannot queue or supersede slow responses. */
export function singleFlight<T>(work: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending) return pending;
    const task = work();
    pending = task;
    const clear = () => { if (pending === task) pending = undefined; };
    void task.then(clear, clear);
    return task;
  };
}
