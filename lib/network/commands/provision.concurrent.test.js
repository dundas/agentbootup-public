/**
 * Atomic writes + concurrent provision smoke (PRD-0016 FR-5–FR-7).
 * Run: bun test lib/network/commands/provision.concurrent.test.js
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { writeFileAtomic } from './provision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const BOOTUP = path.join(REPO_ROOT, 'bootup.mjs');

function tmpId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function mkNetworkFixture(projectId) {
  const networkRoot = fs.mkdtempSync(path.join(os.tmpdir(), `prov-net-${tmpId()}-`));
  const projectPath = path.join(networkRoot, projectId);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'package.json'),
    JSON.stringify({ name: projectId }, null, 2),
  );
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify(
      {
        version: '2.0',
        role: 'network',
        projects: [
          {
            id: projectId,
            path: projectPath,
            agent_id: `${projectId}-gm`,
            type: 'service',
          },
        ],
      },
      null,
      2,
    ),
  );
  return { networkRoot, projectPath };
}

describe('writeFileAtomic', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `atomic-unit-${tmpId()}-`));
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('writes content and leaves no .tmp.* file', () => {
    const filePath = path.join(dir, 'config.json');
    writeFileAtomic(filePath, '{"ok":true}\n');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"ok":true}\n');
    const names = fs.readdirSync(dir);
    expect(names.some((n) => n.includes('.tmp.'))).toBe(false);
  });

  test('failure leaves target unchanged and removes temp file', () => {
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o444);
    const filePath = path.join(locked, 'config.json');
    expect(() => writeFileAtomic(filePath, '{}')).toThrow();
    fs.chmodSync(locked, 0o755);
    expect(fs.existsSync(filePath)).toBe(false);
    const names = fs.readdirSync(locked);
    expect(names.some((n) => n.includes('.tmp.'))).toBe(false);
  });
});

describe('provision concurrent subprocesses (Mode B)', () => {
  test(
    'two OS-level provision runs: both exit 0; brain/config.json parses',
    async () => {
      const projectId = `cc-${tmpId()}`;
      const { networkRoot, projectPath } = mkNetworkFixture(projectId);
      const brainConfig = path.join(projectPath, 'brain', 'config.json');

      const runtime = process.execPath;
      const args = [BOOTUP, 'provision', projectId, '--cwd', networkRoot];

      for (let round = 0; round < 3; round++) {
        const a = Bun.spawn([runtime, ...args], {
          cwd: REPO_ROOT,
          stdout: 'ignore',
          stderr: 'pipe',
          env: { ...process.env, AGENTBOOTUP_TEMPLATES_ROOT: path.join(REPO_ROOT, 'templates') },
        });
        const b = Bun.spawn([runtime, ...args], {
          cwd: REPO_ROOT,
          stdout: 'ignore',
          stderr: 'pipe',
          env: { ...process.env, AGENTBOOTUP_TEMPLATES_ROOT: path.join(REPO_ROOT, 'templates') },
        });

        const [ea, eb] = await Promise.all([a.exited, b.exited]);
        const errA = await new Response(a.stderr).text();
        const errB = await new Response(b.stderr).text();

        expect(ea, `round ${round} proc A: ${errA}`).toBe(0);
        expect(eb, `round ${round} proc B: ${errB}`).toBe(0);

        const raw = fs.readFileSync(brainConfig, 'utf-8');
        expect(() => JSON.parse(raw)).not.toThrow();
      }

      fs.rmSync(networkRoot, { recursive: true, force: true });
    },
    { timeout: 120_000 },
  );
});
