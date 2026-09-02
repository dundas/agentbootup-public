import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPolicy,
  validateArtifactDirectory,
  validatePolicy,
  validateTrackedRepository,
} from '../../scripts/runtime-adapters/check-hermes-m0h-evidence.mjs';

const roots: string[] = [];

function validArtifacts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-m0h-policy-'));
  roots.push(root);
  const policy = loadPolicy();
  for (const member of policy.artifacts.members) {
    fs.writeFileSync(
      path.join(root, member.name),
      `${JSON.stringify({ schema: member.schema, status: true })}\n`,
      { mode: 0o600 },
    );
  }
  return { root, policy };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Hermes M0-H evidence policy', () => {
  test('has exact sorted tracked and artifact allowlists', () => {
    const policy = loadPolicy();
    expect(policy.schema).toBe('agentbootup.hermes-m0h-evidence-policy/v1');
    expect(policy.retentionMaxDays).toBe(7);
    expect(policy.tracked.members.length).toBeGreaterThan(0);
    expect(policy.tracked.members.filter(
      (row: { redistribution: string }) => row.redistribution === 'npm_package_metadata',
    )).toEqual([{ path: 'package.json', redistribution: 'npm_package_metadata' }]);
    expect(policy.artifacts.members.length).toBeGreaterThan(0);
    expect(validatePolicy(structuredClone(policy))).toEqual(policy);
  });

  test('accepts the exact tracked, non-ignored redistribution closure', () => {
    const result = validateTrackedRepository(process.cwd(), loadPolicy());
    expect(result.files).toBe(loadPolicy().tracked.members.length);
    expect(result.totalBytes).toBeLessThanOrEqual(loadPolicy().tracked.maxTotalBytes);
  });

  test('accepts only the exact schemas and returns deterministic accounting', () => {
    const { root, policy } = validArtifacts();
    const first = validateArtifactDirectory(root, policy);
    const second = validateArtifactDirectory(root, policy);
    expect(first).toEqual(second);
    expect(first.files).toBe(policy.artifacts.members.length);

    fs.writeFileSync(path.join(root, 'runner-context.json'), '{"schema":"wrong"}\n');
    expect(() => validateArtifactDirectory(root, policy)).toThrow(/schema drifted/i);
  });

  test('rejects additions, links, secret material, host paths, and byte-budget drift', () => {
    const { root, policy } = validArtifacts();
    fs.writeFileSync(path.join(root, 'extra.json'), '{}\n');
    expect(() => validateArtifactDirectory(root, policy)).toThrow(/allowlist/i);
    fs.unlinkSync(path.join(root, 'extra.json'));

    const runner = path.join(root, 'runner-context.json');
    fs.writeFileSync(runner, JSON.stringify({
      schema: 'agentbootup.hermes-m0h-runner-context/v1',
      value: '/home/runner/private',
    }));
    expect(() => validateArtifactDirectory(root, policy)).toThrow(/absolute host path/i);

    fs.writeFileSync(runner, JSON.stringify({
      schema: 'agentbootup.hermes-m0h-runner-context/v1',
      value: 'auth.json',
    }));
    expect(() => validateArtifactDirectory(root, policy)).toThrow(/secret or host-path/i);

    fs.writeFileSync(runner, Buffer.alloc(policy.artifacts.maxFileBytes + 1));
    expect(() => validateArtifactDirectory(root, policy)).toThrow(/byte budget/i);

    fs.unlinkSync(runner);
    fs.symlinkSync(path.join(root, 'synthetic-report.json'), runner);
    expect(() => validateArtifactDirectory(root, policy)).toThrow(/regular, non-linked/i);
  });

  test('rejects forbidden magic and malformed policy shape', () => {
    const { root, policy } = validArtifacts();
    fs.writeFileSync(path.join(root, 'runner-context.json'), Buffer.from('504b0304', 'hex'));
    expect(() => validateArtifactDirectory(root, policy)).toThrow(/binary\/archive magic/i);

    fs.writeFileSync(
      path.join(root, 'runner-context.json'),
      '{"schema":"agentbootup.hermes-m0h-runner-context/v1","schema":"duplicate"}\n',
      { mode: 0o600 },
    );
    expect(() => validateArtifactDirectory(root, policy)).toThrow(/duplicate object key/i);

    const malformed = structuredClone(policy);
    malformed.artifacts.members[0].schema = '';
    expect(() => validatePolicy(malformed)).toThrow(/schema/i);
  });

  test('pins the final workflow to manual dispatch and minimal clean-room inputs', () => {
    const workflow = fs.readFileSync('.github/workflows/hermes-m0h-qualification.yml', 'utf8');
    expect(workflow).toMatch(/^on:\n  workflow_dispatch:\n/m);
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(() => validateTrackedRepository(process.cwd(), loadPolicy())).not.toThrow();
  });
});
