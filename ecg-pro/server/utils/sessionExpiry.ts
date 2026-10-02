// Node clamps timeout delays above this limit to 1ms. Re-arm long sessions.
const MAX_TIMEOUT_MS = 2_147_483_647;

export function scheduleSessionExpiry(expiresAt: number, expire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let cancelled = false;
  const schedule = () => {
    if (cancelled) return;
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT_MS));
    timer.unref();
  };
  schedule();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
