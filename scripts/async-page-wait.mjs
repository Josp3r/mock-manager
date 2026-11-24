// Playwright's waitForFunction treats a returned Promise as truthy before it
// resolves. Poll page.evaluate here so asynchronous IPC results are awaited.
export async function waitForPageCondition(page, predicate, {
  description = 'page condition', timeout = 30_000, interval = 100,
} = {}) {
  let finished = false;
  let deadlineTimer;
  let intervalTimer;
  let wake;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      finished = true;
      reject(new Error(`Timed out after ${timeout} ms waiting for ${description}.`));
    }, timeout);
  });
  const poll = async () => {
    while (!finished) {
      const result = await page.evaluate(predicate);
      if (finished) return;
      if (result === true) return true;
      await new Promise(resolve => {
        wake = resolve;
        intervalTimer = setTimeout(resolve, interval);
      });
    }
  };
  try {
    // The timeout also bounds a hung page.evaluate, not just the retry loop.
    return await Promise.race([poll(), deadline]);
  } finally {
    finished = true;
    clearTimeout(deadlineTimer);
    clearTimeout(intervalTimer);
    wake?.();
  }
}
