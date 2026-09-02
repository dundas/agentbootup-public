/**
 * Error types for skill-projection backends.
 * Kept in a separate file so callers can import error types without
 * pulling in the full backend implementation.
 */

/**
 * Thrown by MechStorageBackend when the remote store is unreachable or rejects auth.
 * Catch with: `err instanceof MechStorageError`
 */
export class MechStorageError extends Error {
  /**
   * @param {string} message
   * @param {'UNAVAILABLE'|'UNAUTHORIZED'} code
   * @param {unknown} [cause]
   */
  constructor(message, code, cause) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'MechStorageError';
    this.code = code;
  }
}
