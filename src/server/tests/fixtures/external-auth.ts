/**
 * Shared external-auth fixtures for server tests and optional seed runs.
 */

import { EXTERNAL_API_KEY_PREFIX } from '../../config';

export const FIXTURE_ADMIN_API_KEY = 'test-admin-secret-key-0041';

export const FIXTURE_EXTERNAL_USER_ID = 'seed-external-user-0041';

export const FIXTURE_EXTERNAL_API_KEY_ID = 'key_seed_external_0041';

export const FIXTURE_EXTERNAL_API_KEY_SECRET = `${EXTERNAL_API_KEY_PREFIX}seed_fixture_secret_0041`;

export const FIXTURE_EXTERNAL_API_KEY_LABEL = 'seed-smoke-external-key';
