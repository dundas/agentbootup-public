/**
 * Tests for src/server/lib/brain-db-jwt.ts
 */

import { test, expect, beforeAll } from 'bun:test';
import { generateBrainDbToken, buildBrainDbUrl } from '../lib/brain-db-jwt';

// Generate a real Ed25519 keypair for testing
let privateKeyBase64: string;
let publicKey: CryptoKey;

beforeAll(async () => {
  const keypair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const privateDer = await crypto.subtle.exportKey('pkcs8', keypair.privateKey);
  privateKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(privateDer)));
  publicKey = keypair.publicKey;
});

// ── buildBrainDbUrl ───────────────────────────────────────────────────────────

test('buildBrainDbUrl: constructs correct URL', () => {
  expect(buildBrainDbUrl('https://brain-sqld.fly.dev', 'decisive')).toBe(
    'https://brain-sqld.fly.dev/decisive',
  );
});

test('buildBrainDbUrl: strips trailing slash from server', () => {
  expect(buildBrainDbUrl('https://brain-sqld.fly.dev/', 'bootup')).toBe(
    'https://brain-sqld.fly.dev/bootup',
  );
});

// ── generateBrainDbToken ──────────────────────────────────────────────────────

test('token has three base64url parts (header.payload.signature)', async () => {
  const token = await generateBrainDbToken(privateKeyBase64);
  const parts = token.split('.');
  expect(parts).toHaveLength(3);
  // Each part must be non-empty base64url (no standard base64 padding chars)
  for (const part of parts) {
    expect(part.length).toBeGreaterThan(0);
    expect(part).not.toContain('+');
    expect(part).not.toContain('/');
    expect(part).not.toContain('=');
  }
});

test('header declares EdDSA algorithm', async () => {
  const token = await generateBrainDbToken(privateKeyBase64);
  const headerJson = atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'));
  const header = JSON.parse(headerJson);
  expect(header.alg).toBe('EdDSA');
  expect(header.typ).toBe('JWT');
});

test('payload contains required a:rw claim', async () => {
  const token = await generateBrainDbToken(privateKeyBase64);
  const payloadB64 = token.split('.')[1];
  const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
  const payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  expect(payload.a).toBe('rw');
});

test('payload exp is within 90 days', async () => {
  const token = await generateBrainDbToken(privateKeyBase64);
  const payloadB64 = token.split('.')[1];
  const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
  const payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  const now = Math.floor(Date.now() / 1000);
  const ninetyDays = 90 * 24 * 60 * 60;
  expect(payload.exp).toBeGreaterThan(now);
  expect(payload.exp).toBeLessThanOrEqual(now + ninetyDays + 5); // 5s tolerance
});

test('payload has no sub claim (not validated by libsql)', async () => {
  const token = await generateBrainDbToken(privateKeyBase64);
  const payloadB64 = token.split('.')[1];
  const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
  const payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  expect(payload.sub).toBeUndefined();
});

test('signature verifies against the public key', async () => {
  const token = await generateBrainDbToken(privateKeyBase64);
  const [header, payload, sig] = token.split('.');

  const sigBytes = Uint8Array.from(
    atob(sig.replace(/-/g, '+').replace(/_/g, '/') + '=='),
    (c) => c.charCodeAt(0),
  );

  const valid = await crypto.subtle.verify(
    'Ed25519',
    publicKey,
    sigBytes,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  expect(valid).toBe(true);
});
