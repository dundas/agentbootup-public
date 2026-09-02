import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  rejectMemoryPushIfDemoted,
  isMemoryDemotionEnabled,
  isBrainOptedIn,
  getClientVersion,
  isRawMemoryFile,
  findRawMemoryFiles,
  isClientBelowFloor,
  MEMORY_DEMOTION_FLOOR_VERSION,
} from '../lib/memory-demotion-floor';
import type { Brain } from '../types';

// PRD-0054 PR-5 / B-8 — contract test for the server-side demotion-floor
// rejection. The single load-bearing invariant: the snapshot convergence
// transport (paths under memory-store/) is NEVER rejected, even when raw
// memory/** IS. Rejecting memory-store/ would break convergence itself.

const ENV_FLAG = 'AGENTBOOTUP_MEMORY_DEMOTION_ENABLED';
const ENV_FLOOR = 'AGENTBOOTUP_MEMORY_DEMOTION_FLOOR';

let savedFlag: string | undefined;
let savedFloor: string | undefined;

beforeEach(() => {
  savedFlag = process.env[ENV_FLAG];
  savedFloor = process.env[ENV_FLOOR];
  delete process.env[ENV_FLAG];
  delete process.env[ENV_FLOOR];
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[ENV_FLAG];
  else process.env[ENV_FLAG] = savedFlag;
  if (savedFloor === undefined) delete process.env[ENV_FLOOR];
  else process.env[ENV_FLOOR] = savedFloor;
});

function brain(id: string, opts: { optedIn?: boolean } = {}): Brain {
  return {
    id,
    repo_url: null,
    repo_branch: null,
    vault_namespace: 'ns',
    skills: [],
    memory_collection: 'c',
    parent_brain: null,
    trust_level: 'full',
    metadata: opts.optedIn ? { memory_demotion_enabled: true } : {},
    registered_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function file(path: string) {
  return { path, asset_type: path.startsWith('memory') ? 'memory' : 'skill' };
}

async function bodyOf(res: Response): Promise<unknown> {
  return res.json();
}

describe('memory demotion-floor — kill switch (default OFF = inert)', () => {
  test('flag off: never rejects, even for a below-floor raw memory push', () => {
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [file('memory/MEMORY.md')],
      clientVersionHeader: '0.8.10',
    });
    expect(res).toBeNull();
    expect(isMemoryDemotionEnabled()).toBe(false);
  });

  test('flag on but brain not opted-in: never rejects', () => {
    process.env[ENV_FLAG] = '1';
    expect(isBrainOptedIn(brain('cc'))).toBe(false);
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: false }),
      files: [file('memory/MEMORY.md')],
      clientVersionHeader: '0.8.10',
    });
    expect(res).toBeNull();
  });

  test('brain null: never rejects', () => {
    process.env[ENV_FLAG] = '1';
    const res = rejectMemoryPushIfDemoted({
      brain: null,
      files: [file('memory/MEMORY.md')],
      clientVersionHeader: '0.8.10',
    });
    expect(res).toBeNull();
  });
});

describe('memory demotion-floor — version gate', () => {
  beforeEach(() => { process.env[ENV_FLAG] = '1'; });

  test('client at the floor: allowed (floor is inclusive lower bound)', () => {
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [file('memory/MEMORY.md')],
      clientVersionHeader: MEMORY_DEMOTION_FLOOR_VERSION,
    });
    expect(res).toBeNull();
  });

  test('client above the floor: allowed', () => {
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [file('memory/MEMORY.md')],
      clientVersionHeader: '0.9.0',
    });
    expect(res).toBeNull();
  });

  test('client below the floor with raw memory/**: REJECTED (426)', async () => {
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [file('memory/MEMORY.md'), file('memory/daily/2026-07-22.md')],
      clientVersionHeader: '0.8.10',
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(426);
    const b = (await bodyOf(res!)) as { error: { code: string; message: string } };
    expect(b.error.code).toBe('client_version_below_demotion_floor');
    expect(b.error.message).toContain(MEMORY_DEMOTION_FLOOR_VERSION);
  });

  test('missing version header with raw memory/**: REJECTED (old-client backstop)', async () => {
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [file('memory/MEMORY.md')],
      clientVersionHeader: null,
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(426);
    const b = (await bodyOf(res!)) as { error: { code: string } };
    expect(b.error.code).toBe('client_version_below_demotion_floor');
  });

  test('override floor via env is respected', async () => {
    process.env[ENV_FLOOR] = '0.9.0';
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [file('memory/MEMORY.md')],
      clientVersionHeader: '0.8.28', // above the *default* floor, below the override
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(426);
  });

  test('INVALID floor override fails CLOSED (rejects, not fail-open)', async () => {
    process.env[ENV_FLOOR] = 'not-a-version';
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [file('memory/MEMORY.md')],
      clientVersionHeader: '0.8.28', // a current client — must still be rejected because the floor is misconfigured
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    const b = (await bodyOf(res!)) as { error: { code: string; message: string } };
    expect(b.error.code).toBe('server_misconfigured_floor');
    expect(b.error.message).toContain('not-a-version');
  });

  test('invalid floor override does NOT affect skills-only pushes', () => {
    process.env[ENV_FLOOR] = 'not-a-version';
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [file('skills/x.json')], // no raw memory → floor never resolved
      clientVersionHeader: '0.8.10',
    });
    expect(res).toBeNull();
  });
});

describe('memory demotion-floor — path targeting (the load-bearing invariant)', () => {
  beforeEach(() => { process.env[ENV_FLAG] = '1'; });

  test('snapshot transport (memory-store/**) is NEVER rejected, even below floor', () => {
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [
        file('memory-store/heads/abc.json'),
        file('memory-store/snapshots/sha256:xyz/manifest.json'),
        file('memory-store/latest.json'),
      ],
      clientVersionHeader: '0.8.10',
    });
    expect(res).toBeNull();
  });

  test('mixed push: raw memory/** present alongside memory-store/** → rejected (raw memory is the trigger)', async () => {
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [
        file('memory-store/heads/abc.json'),
        file('memory/MEMORY.md'), // raw page — triggers rejection
        file('skills/x.json'),
      ],
      clientVersionHeader: '0.8.10',
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(426);
  });

  test('skills-only push (no memory paths at all): allowed', () => {
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [file('skills/x.json'), file('commands/y.json')],
      clientVersionHeader: '0.8.10',
    });
    expect(res).toBeNull();
  });
});

describe('memory demotion-floor — version compare (semver, prerelease-aware)', () => {
  beforeEach(() => { process.env[ENV_FLAG] = '1'; });

  test('isClientBelowFloor: below / at / above', () => {
    expect(isClientBelowFloor('0.8.10', '0.8.26')).toBe(true);
    expect(isClientBelowFloor('0.8.26', '0.8.26')).toBe(false); // at floor = allowed
    expect(isClientBelowFloor('0.9.0', '0.8.26')).toBe(false);
    expect(isClientBelowFloor('1.0.0', '0.9.9')).toBe(false);
  });

  test('isClientBelowFloor: prerelease of the floor is BELOW the floor (0.8.26-beta.1 < 0.8.26)', () => {
    expect(isClientBelowFloor('0.8.26-beta.1', '0.8.26')).toBe(true);
    expect(isClientBelowFloor('0.8.26-alpha', '0.8.26')).toBe(true);
  });

  test('isClientBelowFloor: prerelease above the floor is allowed (0.9.0-beta.1 > 0.8.26)', () => {
    expect(isClientBelowFloor('0.9.0-beta.1', '0.8.26')).toBe(false);
  });

  test('isClientBelowFloor: missing/malformed client = below floor (old-client backstop)', () => {
    expect(isClientBelowFloor(null, '0.8.26')).toBe(true);
    expect(isClientBelowFloor('', '0.8.26')).toBe(true);
    expect(isClientBelowFloor('garbage', '0.8.26')).toBe(true);
    expect(isClientBelowFloor('not.a.version.really', '0.8.26')).toBe(true);
  });
});

describe('memory demotion-floor — legacy /v1/memory/ route (allMemory=true)', () => {
  beforeEach(() => { process.env[ENV_FLAG] = '1'; });

  test('below-floor client pushing paths WITHOUT memory/ prefix is still rejected', async () => {
    // The legacy route is memory-by-definition; paths may be 'MEMORY.md' not 'memory/MEMORY.md'.
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [{ path: 'MEMORY.md' }, { path: 'daily/2026-07-22.md' }],
      clientVersionHeader: '0.8.10',
      allMemory: true,
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(426);
  });

  test('at-floor client on the legacy route is allowed', () => {
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [{ path: 'MEMORY.md' }],
      clientVersionHeader: MEMORY_DEMOTION_FLOOR_VERSION,
      allMemory: true,
    });
    expect(res).toBeNull();
  });

  test('invalid floor override fails closed on the legacy route too', async () => {
    process.env[ENV_FLOOR] = 'nope';
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [{ path: 'MEMORY.md' }],
      clientVersionHeader: '0.8.28',
      allMemory: true,
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
  });

  test('allMemory=false (default) does NOT reject non-memory-prefixed paths', () => {
    // Proves the flag matters: same files without the flag are allowed (not memory/).
    const res = rejectMemoryPushIfDemoted({
      brain: brain('cc', { optedIn: true }),
      files: [{ path: 'MEMORY.md' }],
      clientVersionHeader: '0.8.10',
      allMemory: false,
    });
    expect(res).toBeNull();
  });
});

describe('memory demotion-floor — unit helpers', () => {
  test('isRawMemoryFile: memory/ yes, memory-store/ no, skills no', () => {
    expect(isRawMemoryFile(file('memory/MEMORY.md'))).toBe(true);
    expect(isRawMemoryFile(file('memory/daily/2026-07-22.md'))).toBe(true);
    expect(isRawMemoryFile(file('memory-store/heads/abc.json'))).toBe(false);
    expect(isRawMemoryFile(file('memory-store/latest.json'))).toBe(false);
    expect(isRawMemoryFile(file('skills/x.json'))).toBe(false);
  });

  test('findRawMemoryFiles returns only raw memory pages', () => {
    const out = findRawMemoryFiles([
      file('memory/MEMORY.md'),
      file('memory-store/heads/abc.json'),
      file('skills/x.json'),
      file('memory/daily/2026-07-22.md'),
    ]);
    expect(out.map((f) => f.path).sort()).toEqual(['memory/MEMORY.md', 'memory/daily/2026-07-22.md']);
  });

  test('getClientVersion trims and rejects empty', () => {
    expect(getClientVersion('  0.8.28  ')).toBe('0.8.28');
    expect(getClientVersion('')).toBeNull();
    expect(getClientVersion(null)).toBeNull();
    expect(getClientVersion(undefined)).toBeNull();
  });
});
