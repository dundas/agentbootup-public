import { describe, expect, test } from 'bun:test';
import {
  ASSET_TYPES,
  SECRET_ASSET_TYPE,
  SECRET_CAPABILITY_POLICY,
  SECRET_REL_PATHS,
  SECRET_TTL_MAX_SECONDS,
  SECRET_TTL_MIN_SECONDS,
  isCanonicalUtcIsoTimestamp,
  isAssetType,
  isSecretAssetPath,
} from '../lib/brain/asset-contract.js';
import { ASSET_TYPES as SERVER_ASSET_TYPES } from '../src/server/lib/brain-asset-store';

describe('shared brain asset contract', () => {
  test('client and server use the same asset type enum including secret', () => {
    expect(SERVER_ASSET_TYPES).toBe(ASSET_TYPES);
    expect(ASSET_TYPES).toContain(SECRET_ASSET_TYPE);
    expect(isAssetType('secret')).toBe(true);
    expect(isAssetType('configuration')).toBe(false);
  });

  test('the secret path contract is exact and rejects config disguises', () => {
    expect(SECRET_REL_PATHS).toEqual([
      '.env',
      '.dev.vars',
      'brain/config.secret.json',
    ]);
    for (const source of SECRET_REL_PATHS) {
      expect(isSecretAssetPath(source)).toBe(true);
    }
    expect(isSecretAssetPath('brain/config.json')).toBe(false);
    expect(isSecretAssetPath('nested/.env')).toBe(false);
  });

  test('secret paths, TTL, and capability policy have one canonical source', () => {
    expect(SECRET_CAPABILITY_POLICY).toEqual({
      supported: true,
      asset_type: 'secret',
      manual_only: true,
      exact_bytes: true,
      paths: SECRET_REL_PATHS,
      max_file_bytes: 1_048_576,
      retention: {
        without_ttl: 'until_overwritten',
        expired_assets_restorable: false,
      },
      ttl: {
        supported: true,
        optional: true,
        min_seconds: SECRET_TTL_MIN_SECONDS,
        max_seconds: SECRET_TTL_MAX_SECONDS,
      },
      authorization: {
        principal: 'admin',
        bearer_required: true,
      },
      logging: {
        payload_logged: false,
        metadata_only: true,
      },
      restore: {
        explicit_pull_only: true,
        method: 'GET',
      },
      cleanup: {
        supported: true,
        method: 'DELETE',
        exact_brain_id_confirmation_required: true,
      },
    });
  });

  test('expiry timestamps must be canonical UTC ISO strings', () => {
    expect(isCanonicalUtcIsoTimestamp('2026-07-29T12:34:56.789Z')).toBe(true);
    for (const value of [
      '2026-07-29T12:34:56Z',
      '2026-07-29T07:34:56.789-05:00',
      '2026-07-29 12:34:56.789Z',
      'not-a-date',
      123,
    ]) {
      expect(isCanonicalUtcIsoTimestamp(value)).toBe(false);
    }
  });
});
