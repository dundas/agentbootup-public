/**
 * brain-db-jwt.ts — Ed25519 JWT helper for sqld brain-db auth.
 *
 * libsql-server only supports Ed25519 (EdDSA) JWT authentication.
 * HS256/RS256/ES256 are NOT supported.
 *
 * Env vars required on the agentbootup server:
 *   SQLD_JWT_PRIVATE_KEY — base64-encoded Ed25519 private key DER bytes
 *   SQLD_SERVER          — sqld server URL (default: https://brain-sqld.fly.dev)
 *
 * JWT claims:
 *   { "a": "rw", "iat": <now>, "exp": <now + 90d> }
 *   "a": "rw" is required by libsql for read-write access.
 *   "sub" is not validated by libsql — not included.
 *
 * Sources:
 *   https://github.com/tursodatabase/libsql/blob/main/docs/DOCKER.md
 *   https://docs.studiocms.dev/en/guides/database/sqld-server/
 */

const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

/**
 * Build the sqld database URL for a given brain.
 * @param sqldServer  e.g. "https://brain-sqld.fly.dev"
 * @param brainId     e.g. "decisive" (without ".gm" suffix)
 */
export function buildBrainDbUrl(sqldServer: string, brainId: string): string {
  return `${sqldServer.replace(/\/$/, '')}/${brainId}`;
}

/**
 * Base64url encode a Uint8Array (no padding).
 */
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Import an Ed25519 private key from raw DER bytes (base64-encoded).
 * The DER bytes are the 64-byte PKCS#8 private key as output by:
 *   openssl pkey -in private.pem -outform DER | base64
 */
async function importPrivateKey(base64Der: string): Promise<CryptoKey> {
  const der = Uint8Array.from(atob(base64Der), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
}

/**
 * Generate a per-brain Ed25519 JWT for sqld authentication.
 *
 * @param privateKeyBase64  Base64-encoded PKCS#8 Ed25519 private key DER bytes
 *                          (from SQLD_JWT_PRIVATE_KEY env var)
 * @returns Signed JWT string
 */
export async function generateBrainDbToken(privateKeyBase64: string): Promise<string> {
  const key = await importPrivateKey(privateKeyBase64);

  const header = base64url(
    new TextEncoder().encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })),
  );

  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({ a: 'rw', iat: now, exp: now + TOKEN_TTL_SECONDS }),
    ),
  );

  const signingInput = `${header}.${payload}`;
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign(
      'Ed25519',
      key,
      new TextEncoder().encode(signingInput),
    ),
  );

  return `${signingInput}.${base64url(signatureBytes)}`;
}
