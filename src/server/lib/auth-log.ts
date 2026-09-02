/**
 * Auth failure log labels for server request logging.
 */

export function authFailureEvent(status: number): string {
  if (status === 429) return 'rate_limited';
  if (status === 403) return 'auth_forbidden';
  return 'auth_failed';
}
