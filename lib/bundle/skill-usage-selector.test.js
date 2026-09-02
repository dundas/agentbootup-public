import { test, expect } from 'bun:test';
import { resolveTelemetrySkills, filterManifestsBySkillNames, CORE_SKILLS } from './skill-usage-selector.js';

// Mock fetch for testing — simulates the hosted brain-assets server
function mockFetch(responseMap) {
  return async (url, opts) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const match = responseMap[urlStr];
    if (match) {
      return {
        ok: true,
        json: async () => match,
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'not found' } }),
    };
  };
}

// Mock readCredentials — simulates having valid server credentials
// We need to mock the module-level import, which is tricky. Instead, we test
// filterManifestsBySkillNames (pure) and test resolveTelemetrySkills with
// a mock fetch that intercepts before credentials are needed.

test('CORE_SKILLS is frozen and contains critical infra', () => {
  expect(Object.isFrozen(CORE_SKILLS)).toBe(true);
  expect(CORE_SKILLS).toContain('cross-brain-message');
  expect(CORE_SKILLS).toContain('brain-message-inbox');
  expect(CORE_SKILLS).toContain('memory-manager');
  expect(CORE_SKILLS.length).toBeGreaterThan(0);
});

test('filterManifestsBySkillNames: returns only manifests matching skill names', () => {
  const manifestPaths = [
    '/fake/cross-brain-message/skill-bundle-manifest.json',
    '/fake/narrative-generator/skill-bundle-manifest.json',
    '/fake/unused-skill/skill-bundle-manifest.json',
  ];
  const skillNames = new Set(['cross-brain-message', 'narrative-generator']);
  const mockLoader = (path) => ({
    manifest: { bundle_name: path.split('/').slice(-2, -1)[0] },
    raw: '{}',
  });
  const filtered = filterManifestsBySkillNames(manifestPaths, skillNames, mockLoader);
  expect(filtered.length).toBe(2);
  expect(filtered[0]).toContain('cross-brain-message');
  expect(filtered[1]).toContain('narrative-generator');
});

test('filterManifestsBySkillNames: empty skill set returns nothing', () => {
  const manifestPaths = ['/fake/some-skill/skill-bundle-manifest.json'];
  const skillNames = new Set();
  const mockLoader = (path) => ({ manifest: { bundle_name: 'some-skill' }, raw: '{}' });
  const filtered = filterManifestsBySkillNames(manifestPaths, skillNames, mockLoader);
  expect(filtered.length).toBe(0);
});

test('filterManifestsBySkillNames: core skills are included when passed', () => {
  const manifestPaths = [
    '/fake/cross-brain-message/skill-bundle-manifest.json',
    '/fake/brain-message-inbox/skill-bundle-manifest.json',
    '/fake/unused/skill-bundle-manifest.json',
  ];
  const skillNames = new Set(CORE_SKILLS);
  const mockLoader = (path) => ({
    manifest: { bundle_name: path.split('/').slice(-2, -1)[0] },
    raw: '{}',
  });
  const filtered = filterManifestsBySkillNames(manifestPaths, skillNames, mockLoader);
  expect(filtered.length).toBe(2);
});

test('resolveTelemetrySkills: happy path — parses usage and unions with CORE_SKILLS', async () => {
  const fakeCreds = { apiKey: 'test-key', serverUrl: 'http://test-server' };
  const mockUsageData = {
    schema_version: 'v1',
    brain: 'test-brain',
    generated_at: '2026-07-21T00:00:00Z',
    skills: {
      'narrative-generator': { use_count: 5, last_activity_at: '2026-07-20T10:00:00Z', first_seen_at: '2026-07-15T10:00:00Z', created_by: 'agent', state: 'active', patch_count: 0 },
      'unused-skill': { use_count: 0, last_activity_at: null, first_seen_at: null, created_by: 'unknown', state: 'stale', patch_count: 0 },
      'pairing-session': { use_count: 3, last_activity_at: '2026-07-19T10:00:00Z', first_seen_at: '2026-07-18T10:00:00Z', created_by: 'bundle', state: 'active', patch_count: 0 },
    },
  };
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        files: [{
          content_base64: Buffer.from(JSON.stringify(mockUsageData)).toString('base64'),
        }],
      },
    }),
  });
  const result = await resolveTelemetrySkills('test-brain', {
    fetchFn: mockFetch,
    readCredentialsFn: async () => fakeCreds,
  });
  expect(result.skills.has('cross-brain-message')).toBe(true);
  expect(result.skills.has('narrative-generator')).toBe(true);
  expect(result.skills.has('pairing-session')).toBe(true);
  expect(result.skills.has('unused-skill')).toBe(false);
  expect(result.source).toContain('telemetry');
  expect(result.usageData).not.toBeNull();
});

test('resolveTelemetrySkills: falls back to core-only when credentials missing', async () => {
  // This will fail to read credentials in a test environment → core-only fallback
  const result = await resolveTelemetrySkills('test-brain');
  expect(result.source).toContain('core-only');
  expect(result.skills.size).toBe(CORE_SKILLS.length);
  expect(result.usageData).toBeNull();
  // Core skills should be present
  for (const name of CORE_SKILLS) {
    expect(result.skills.has(name)).toBe(true);
  }
});
