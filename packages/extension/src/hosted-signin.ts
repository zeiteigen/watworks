/** Runs one account check at a time; a signal arriving mid-check earns one more pass with fresher cookies. */
export function createAccountSync(check: () => Promise<void>, debounceMs = 1000): { run(): Promise<void>; schedule(): void; stop(): void } {
  let active: Promise<void> | undefined, again = false, timer: ReturnType<typeof setTimeout> | undefined;
  function run(): Promise<void> {
    if (active) { again = true; return active; }
    active = (async () => {
      try { do { again = false; await check(); } while (again); }
      finally { active = undefined; }
    })();
    return active;
  }
  return {
    run,
    // The SSO redirect chain writes several cookies; check after they settle.
    schedule() { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = undefined; void run().catch(() => undefined); }, debounceMs); },
    stop() { if (timer) clearTimeout(timer); timer = undefined; },
  };
}
