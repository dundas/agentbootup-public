import { test, expect, describe } from 'bun:test';
import path from 'path';
import { buildLiveDoctorRunners } from '../../lib/doctor/live-runners.js';

// readCredentials() returns { apiKey, serverUrl } flat (or null) — match that shape.
const noopReadCreds = async () => ({ serverUrl: 'https://test.example.com', apiKey: 'test-key' });

describe('buildLiveDoctorRunners — identity_materializes fallback', () => {
  test('agentId set but registryRootUrl missing → distinct unknown result, not "check source not available"', async () => {
    // brain/config.json has agent_id but no registry.root_url.
    const runners = await buildLiveDoctorRunners({
      agentId: 'test-agent.gm',
      readCredentialsFn: noopReadCreds,
      readFile: async (p) => {
        if (p.endsWith(path.join('brain', 'config.json'))) {
          return JSON.stringify({ agent_id: 'test-agent.gm' }); // no registry block
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });

    expect(typeof runners.identity_materializes).toBe('function');
    const result = await runners.identity_materializes();
    expect(result.state).toBe('unknown');
    expect(result.message).toMatch(/registry.*not configured/i);
    // Must be distinct from the generic aggregate "check source not available" message.
    expect(result.message).not.toContain('check source not available');
  });

  test('registryRootUrl set but no public key → real runner built, fails with clear key_fingerprint message', async () => {
    // localIdentity is always at least { id } when agentId is set, so the real runner
    // is built. The runner fetches from the registry first, then checks localFp.
    // Provide a mock fetch that returns a registry record so the localFp check is reached.
    const runners = await buildLiveDoctorRunners({
      agentId: 'test-agent.gm',
      readCredentialsFn: noopReadCreds,
      fetch: async () => new Response(
        JSON.stringify({ id: 'test-agent.gm', key_fingerprint: 'registry-fp-123' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
      readFile: async (p) => {
        if (p.endsWith(path.join('brain', 'config.json'))) {
          return JSON.stringify({
            agent_id: 'test-agent.gm',
            registry: { root_url: 'https://registry.example.com' },
            // no registry.identity block → local key_fingerprint is missing
          });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });

    expect(typeof runners.identity_materializes).toBe('function');
    const result = await runners.identity_materializes();
    // checkIdentityMaterializes returns fail when local key_fingerprint is absent.
    expect(result.state).toBe('fail');
    expect(result.message).toMatch(/no key_fingerprint/i);
    expect(result.message).not.toContain('check source not available');
  });

});
