/**
 * Shared auth/URL validation helpers.
 * Extracted so all callers (daemon, CLI pull, brains discovery) apply the same
 * rules — keeping security checks DRY and avoiding silent bypasses via
 * file:// or other non-HTTP schemes.
 */

/**
 * Returns true if `url` is a valid http or https URL.
 * Rejects file://, data://, and other non-HTTP schemes that could be used to
 * read local files or send data to unexpected destinations.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isValidServerUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Returns true if `url` is a plausible server target (valid scheme and not
 * port 0). Used at daemon start and doctor to reject stale dev configs like
 * http://localhost:0 that would cause silent failure.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isPlausibleServerUrl(url) {
  if (!isValidServerUrl(url)) return false;
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return port !== '0';
  } catch {
    return false;
  }
}

/**
 * Build an API endpoint URL by appending `endpoint` to `baseUrl`.
 *
 * Uses string concatenation rather than `new URL(endpoint, baseUrl)` because
 * the URL constructor treats `endpoint` as an absolute path when it starts
 * with `/`, silently discarding any subpath in `baseUrl`.  For example:
 *   new URL('/v1/brains', 'https://host/api/v2/') → 'https://host/v1/brains'
 * Using concatenation preserves the subpath for proxied deployments.
 *
 * @param {string} baseUrl    e.g. "https://agentbootup.fly.dev" or "https://myproxy.example.com/agentbootup"
 * @param {string} endpoint   e.g. "/v1/brains"
 * @returns {string}
 */
export function apiUrl(baseUrl, endpoint) {
  if (!endpoint.startsWith('/')) {
    throw new Error(`apiUrl: endpoint must start with '/': ${endpoint}`);
  }
  return baseUrl.replace(/\/+$/, '') + endpoint;
}
