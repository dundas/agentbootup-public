import { describe, test, expect } from 'bun:test';
import { handleAuthStatus, handleAuthStatusRoute } from '../routes/auth-status';

const ADMIN = { kind: 'admin', credential_id: 'admin_test' } as const;

describe('handleAuthStatusRoute', () => {
  test('GET returns principal summary', async () => {
    const res = handleAuthStatusRoute('GET', ADMIN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.allowed_surface).toBe('admin');
  });

  test('POST returns 405 Method Not Allowed', async () => {
    const res = handleAuthStatusRoute('POST', ADMIN);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});

describe('handleAuthStatus', () => {
  test('returns admin surface for admin principal', async () => {
    const res = handleAuthStatus(ADMIN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.allowed_surface).toBe('admin');
    expect(body.data.principal.kind).toBe('admin');
    expect(body.data.principal).not.toHaveProperty('credential_id');
  });

  test('returns external surface for external principal', async () => {
    const res = handleAuthStatus({
      kind: 'external',
      user_id: 'user-1',
      key_id: 'key-1',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.allowed_surface).toBe('external');
    expect(body.data.principal.key_id).toBe('key-1');
  });
});
