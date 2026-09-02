import { expect, mock, test } from 'bun:test';
import { MechSqlClient } from 'clearauth';

test('ClearAuth preserves canonical app_ IDs in Mech Storage SQL URLs', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl: string | undefined;
  let requestHeaders: Headers | undefined;
  globalThis.fetch = mock(async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ success: true, rows: [], rowCount: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const client = new MechSqlClient({
      baseUrl: 'https://storage.example.test',
      appId: 'app_87afb6cf-0ebc-46f5-b922-c4ee28b3f8fc',
      apiKey: 'test-api-key',
    });

    await expect(client.execute('SELECT 1')).resolves.toEqual({ rows: [], rowCount: 0 });
    expect(requestUrl).toBe('https://storage.example.test/api/apps/app_87afb6cf-0ebc-46f5-b922-c4ee28b3f8fc/postgresql/query');
    expect(requestHeaders?.get('x-api-key')).toBe('test-api-key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
