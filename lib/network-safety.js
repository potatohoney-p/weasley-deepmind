/**
 * Network-boundary checks for deliberately unauthenticated local development.
 */

export function isLoopbackHost(host) {
  const normalized = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function assertSafeAuthBinding({ host, accessKey, authDisabled }) {
  if (authDisabled && !accessKey && !isLoopbackHost(host)) {
    throw new Error(
      "WEASLEY_DEEPMIND_AUTH_DISABLED=true is allowed only on a loopback listener. "
      + "Set WEASLEY_DEEPMIND_HOST=127.0.0.1 or configure WEASLEY_DEEPMIND_ACCESS_KEY."
    );
  }
}
