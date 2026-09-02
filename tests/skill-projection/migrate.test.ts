/**
 * Phase 5 — skills migrate command tests.
 *
 * Tests the handleSkillsMigrate handler directly with mock backends.
 * No real file system or network access.
 */

import { test, expect, describe, beforeEach } from 'bun:test';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Skill {
  id: string;
  name: string;
  content: string;
  scope: 'master' | 'tenant';
  tenantId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MockIo {
  out: string[];
  err: string[];
  io: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  };
}

function makeIo(): MockIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSkills(count: number): Skill[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `skill-id-${i + 1}`,
    name: `skill-${i + 1}`,
    content: `# Skill ${i + 1}\nContent here.`,
    scope: 'master' as const,
    tenantId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
}

// ── Mock backend factories ────────────────────────────────────────────────────

function mockStaticBackend(skills: Skill[]) {
  return {
    async loadSkills(_scope: string, _tenantId?: string | null) {
      return skills;
    },
    async saveSkill(_skill: Skill) {
      throw new Error('StaticBackend is read-only');
    },
  };
}

function mockMechStorageBackend(onSave?: (skill: Skill) => Promise<void> | void) {
  const saved: Skill[] = [];
  return {
    saved,
    backend: {
      async saveSkill(skill: Skill) {
        if (onSave) await onSave(skill);
        saved.push(skill);
        return { ...skill };
      },
    },
  };
}

// ── Import handler ────────────────────────────────────────────────────────────

// Lazy import so we can inspect the module after writing it.
async function getHandler() {
  const { handleSkillsMigrate } = await import('../../lib/network/commands/skills.js');
  return handleSkillsMigrate;
}

// ── Mock injection helpers ────────────────────────────────────────────────────
// handleSkillsMigrate accepts optional 4th parameter `_backends` for testability.

describe('skills migrate — dry-run', () => {
  test('dry-run prints skill list without calling saveSkill', async () => {
    const handler = await getHandler();
    const skills = makeSkills(3);
    const staticB = mockStaticBackend(skills);
    const spy = { called: false };
    const mechSpy = {
      async saveSkill(skill: Skill) {
        spy.called = true;
        return skill;
      },
    };
    const { io } = makeIo();
    const result = await handler(
      ['migrate', '--from', 'static', '--to', 'mech-storage', '--dry-run'],
      io,
      { staticBackend: staticB, mechBackend: mechSpy, agentId: 'test.gm' },
    );
    expect(spy.called).toBe(false);
    expect(result).toBe(0);
  });

  test('dry-run returns exit code 0', async () => {
    const handler = await getHandler();
    const skills = makeSkills(2);
    const staticB = mockStaticBackend(skills);
    const mechB = mockMechStorageBackend();
    const { io } = makeIo();
    const result = await handler(
      ['migrate', '--from', 'static', '--to', 'mech-storage', '--dry-run'],
      io,
      { staticBackend: staticB, mechBackend: mechB.backend, agentId: 'test.gm' },
    );
    expect(result).toBe(0);
  });

  test('dry-run prints "Would migrate N skills from static to mech-storage:"', async () => {
    const handler = await getHandler();
    const skills = makeSkills(2);
    const staticB = mockStaticBackend(skills);
    const mechB = mockMechStorageBackend();
    const { out, io } = makeIo();
    await handler(
      ['migrate', '--from', 'static', '--to', 'mech-storage', '--dry-run'],
      io,
      { staticBackend: staticB, mechBackend: mechB.backend, agentId: 'test.gm' },
    );
    const joined = out.join('\n');
    expect(joined).toContain('Would migrate 2 skills from static to mech-storage');
  });

  test('dry-run prints each skill name', async () => {
    const handler = await getHandler();
    const skills = makeSkills(2);
    const staticB = mockStaticBackend(skills);
    const mechB = mockMechStorageBackend();
    const { out, io } = makeIo();
    await handler(
      ['migrate', '--from', 'static', '--to', 'mech-storage', '--dry-run'],
      io,
      { staticBackend: staticB, mechBackend: mechB.backend, agentId: 'test.gm' },
    );
    const joined = out.join('\n');
    expect(joined).toContain('skill-1');
    expect(joined).toContain('skill-2');
  });
});

describe('skills migrate — live run', () => {
  test('live run calls saveSkill for each discovered skill', async () => {
    const handler = await getHandler();
    const skills = makeSkills(3);
    const staticB = mockStaticBackend(skills);
    const mechB = mockMechStorageBackend();
    const { io } = makeIo();
    await handler(
      ['migrate', '--from', 'static', '--to', 'mech-storage'],
      io,
      { staticBackend: staticB, mechBackend: mechB.backend, agentId: 'test.gm' },
    );
    expect(mechB.saved.length).toBe(3);
    expect(mechB.saved.map((s: Skill) => s.name).sort()).toEqual(['skill-1', 'skill-2', 'skill-3']);
  });

  test('live run returns exit code 0 on success', async () => {
    const handler = await getHandler();
    const skills = makeSkills(2);
    const staticB = mockStaticBackend(skills);
    const mechB = mockMechStorageBackend();
    const { io } = makeIo();
    const result = await handler(
      ['migrate', '--from', 'static', '--to', 'mech-storage'],
      io,
      { staticBackend: staticB, mechBackend: mechB.backend, agentId: 'test.gm' },
    );
    expect(result).toBe(0);
  });

  test('live run prints "Migrated N skills successfully"', async () => {
    const handler = await getHandler();
    const skills = makeSkills(2);
    const staticB = mockStaticBackend(skills);
    const mechB = mockMechStorageBackend();
    const { out, io } = makeIo();
    await handler(
      ['migrate', '--from', 'static', '--to', 'mech-storage'],
      io,
      { staticBackend: staticB, mechBackend: mechB.backend, agentId: 'test.gm' },
    );
    const joined = out.join('\n');
    expect(joined).toContain('Migrated 2 skills successfully');
  });

  test('empty static dir migrates 0 skills — not an error (exit 0)', async () => {
    const handler = await getHandler();
    const staticB = mockStaticBackend([]);
    const mechB = mockMechStorageBackend();
    const { io } = makeIo();
    const result = await handler(
      ['migrate', '--from', 'static', '--to', 'mech-storage'],
      io,
      { staticBackend: staticB, mechBackend: mechB.backend, agentId: 'test.gm' },
    );
    expect(result).toBe(0);
    expect(mechB.saved.length).toBe(0);
  });
});

describe('skills migrate — argument validation', () => {
  test('missing --from outputs error message and returns exit 1', async () => {
    const handler = await getHandler();
    const mechB = mockMechStorageBackend();
    const { err, io } = makeIo();
    const result = await handler(
      ['migrate', '--to', 'mech-storage'],
      io,
      { staticBackend: mockStaticBackend([]), mechBackend: mechB.backend, agentId: 'test.gm' },
    );
    expect(result).toBe(1);
    expect(err.join('\n')).toMatch(/--from/);
  });

  test('missing --to outputs error message and returns exit 1', async () => {
    const handler = await getHandler();
    const mechB = mockMechStorageBackend();
    const { err, io } = makeIo();
    const result = await handler(
      ['migrate', '--from', 'static'],
      io,
      { staticBackend: mockStaticBackend([]), mechBackend: mechB.backend, agentId: 'test.gm' },
    );
    expect(result).toBe(1);
    expect(err.join('\n')).toMatch(/--to/);
  });

  test('invalid --from value outputs error and returns exit 1', async () => {
    const handler = await getHandler();
    const mechB = mockMechStorageBackend();
    const { err, io } = makeIo();
    const result = await handler(
      ['migrate', '--from', 'invalid', '--to', 'mech-storage'],
      io,
      { staticBackend: mockStaticBackend([]), mechBackend: mechB.backend, agentId: 'test.gm' },
    );
    expect(result).toBe(1);
    expect(err.join('\n')).toMatch(/--from/);
  });

  test('invalid --to value outputs error and returns exit 1', async () => {
    const handler = await getHandler();
    const mechB = mockMechStorageBackend();
    const { err, io } = makeIo();
    const result = await handler(
      ['migrate', '--from', 'static', '--to', 'unknown-backend'],
      io,
      { staticBackend: mockStaticBackend([]), mechBackend: mechB.backend, agentId: 'test.gm' },
    );
    expect(result).toBe(1);
    expect(err.join('\n')).toMatch(/--to/);
  });
});

describe('skills migrate — error handling', () => {
  test('saveSkill error logs to stderr and returns exit 1', async () => {
    const handler = await getHandler();
    const skills = makeSkills(2);
    const staticB = mockStaticBackend(skills);
    const failingBackend = {
      async saveSkill(_skill: Skill) {
        throw new Error('network failure');
      },
    };
    const { err, io } = makeIo();
    const result = await handler(
      ['migrate', '--from', 'static', '--to', 'mech-storage'],
      io,
      { staticBackend: staticB, mechBackend: failingBackend, agentId: 'test.gm' },
    );
    expect(result).toBe(1);
    expect(err.join('\n')).toContain('network failure');
  });
});
