/**
 * MVP policy for the credential created after device enrollment. The enrollment
 * secret is deliberately short-lived and has its own independent lifetime.
 */
export const REMOTE_LOCAL_ENROLLMENT_TTL_MS = 5 * 60_000;
export const DEFAULT_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS = 24 * 60 * 60_000;
export const MIN_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS = 60 * 60_000;
export const MAX_REMOTE_LOCAL_INITIAL_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60_000;
