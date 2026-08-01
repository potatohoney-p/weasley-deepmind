const DEFAULT_AVAILABILITY_TIMEOUT_MS = 5_000;

export function clampAvailabilityTimeoutMs(timeoutMs, defaultMs = DEFAULT_AVAILABILITY_TIMEOUT_MS) {
  if (timeoutMs === null || timeoutMs === undefined) return defaultMs;

  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;

  return Math.max(1, Math.min(defaultMs, Math.floor(parsed)));
}

export function shouldCacheAvailabilityFailure(timeoutMs, defaultMs = DEFAULT_AVAILABILITY_TIMEOUT_MS) {
  return timeoutMs >= defaultMs;
}
