import { test, expect, beforeEach, afterAll } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'agentbootup-config-cli-test-')
);

const { runConfigCommand } = await import('../../lib/config/config-cli.js');

function configFile() {
  return process.env.AGENTBOOTUP_CONFIG_FILE!;
}

function captureOutput(): { logs: string[]; errs: string[]; restore: () => void } {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  console.error = (...args: unknown[]) => errs.push(args.join(' '));
  return {
    logs,
    errs,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

async function expectCommandExit(argv: string[]): Promise<{ errs: string[]; exited: boolean }> {
  const { errs, restore } = captureOutput();
  let exited = false;
  const origExit = process.exit;
  process.exit = ((code?: number | undefined) => {
    exited = true;
    throw new Error(`exit:${code ?? ''}`);
  }) as typeof process.exit;

  try {
    await runConfigCommand(argv).catch((err: Error) => {
      if (!err.message.startsWith('exit:')) throw err;
    });
  } finally {
    restore();
    process.exit = origExit;
  }

  return { errs, exited };
}

beforeEach(async () => {
  const f = path.join(tmpDir, `config-cli-${Date.now()}.json`);
  process.env.AGENTBOOTUP_CONFIG_FILE = f;
  await fsp.unlink(f).catch(() => {});
});

afterAll(async () => {
  delete process.env.AGENTBOOTUP_CONFIG_FILE;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── set-brain ─────────────────────────────────────────────────────────────────

test('set-brain persists the brain ID', async () => {
  const { restore } = captureOutput();
  try {
    await runConfigCommand(['config', 'set-brain', 'my-brain-01']);
  } finally {
    restore();
  }
  const raw = JSON.parse(await fsp.readFile(configFile(), 'utf-8'));
  expect(raw.brainId).toBe('my-brain-01');
});

test('set-brain accepts dotted brain IDs used by portfolio agents', async () => {
  const { restore } = captureOutput();
  try {
    await runConfigCommand(['config', 'set-brain', 'mech-plane.gm']);
  } finally {
    restore();
  }
  const raw = JSON.parse(await fsp.readFile(configFile(), 'utf-8'));
  expect(raw.brainId).toBe('mech-plane.gm');
});

test('set-brain prints confirmation message', async () => {
  const { logs, restore } = captureOutput();
  try {
    await runConfigCommand(['config', 'set-brain', 'brain-xyz']);
  } finally {
    restore();
  }
  expect(logs.some((l) => l.includes('brain-xyz'))).toBe(true);
});

test('set-brain rejects invalid brain ID with special chars', async () => {
  const { errs, exited } = await expectCommandExit(['config', 'set-brain', 'bad id!']);
  expect(exited).toBe(true);
  expect(errs.some((e) => e.includes('Invalid'))).toBe(true);
});

test('set-brain rejects malformed dotted brain IDs', async () => {
  const { errs, exited } = await expectCommandExit(['config', 'set-brain', 'bad..brain']);
  expect(exited).toBe(true);
  expect(errs.some((e) => e.includes('Invalid'))).toBe(true);
});

test('set-brain rejects unsupported brain ID punctuation', async () => {
  const { errs, exited } = await expectCommandExit(['config', 'set-brain', 'brain:v2']);
  expect(exited).toBe(true);
  expect(errs.some((e) => e.includes('Invalid'))).toBe(true);
});

test('set-brain exits if brain ID is missing', async () => {
  const { exited } = await expectCommandExit(['config', 'set-brain']);
  expect(exited).toBe(true);
});

// ── set-converge ─────────────────────────────────────────────────────────────

test('set-converge persists on and off values', async () => {
  const { logs, restore } = captureOutput();
  try {
    await runConfigCommand(['config', 'set-converge', 'off']);
    expect(JSON.parse(await fsp.readFile(configFile(), 'utf-8')).memoryConvergeEnabled).toBe(false);
    await runConfigCommand(['config', 'set-converge', 'on']);
    expect(JSON.parse(await fsp.readFile(configFile(), 'utf-8')).memoryConvergeEnabled).toBe(true);
  } finally {
    restore();
  }
  expect(logs.join('\n')).toContain('Memory converge set: off');
  expect(logs.join('\n')).toContain('Memory converge set: on');
});

test('set-converge rejects values other than on or off', async () => {
  const { errs, exited } = await expectCommandExit(['config', 'set-converge', 'maybe']);
  expect(exited).toBe(true);
  expect(errs.join('\n')).toContain('set-converge <on|off>');
});

// ── show ──────────────────────────────────────────────────────────────────────

test('show prints a message when no config exists', async () => {
  const { logs, restore } = captureOutput();
  try {
    await runConfigCommand(['config', 'show']);
  } finally {
    restore();
  }
  expect(logs.length).toBeGreaterThan(0);
});

test('show prints configured brain ID', async () => {
  const { restore: r1 } = captureOutput();
  try { await runConfigCommand(['config', 'set-brain', 'show-test-brain']); } finally { r1(); }
  const { logs, restore } = captureOutput();
  try {
    await runConfigCommand(['config', 'show']);
  } finally {
    restore();
  }
  expect(logs.some((l) => l.includes('show-test-brain'))).toBe(true);
});

// ── set-network-root ─────────────────────────────────────────────────────────

test('set-network-root creates agentbootup.json when none exists (no creds)', async () => {
  const networkDir = path.join(tmpDir, `network-${Date.now()}`);
  const { logs, restore } = captureOutput();
  try {
    await runConfigCommand(['config', 'set-network-root', networkDir]);
  } finally {
    restore();
  }
  const configPath = path.join(networkDir, 'agentbootup.json');
  expect(fs.existsSync(configPath)).toBe(true);
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  expect(parsed.version).toBe('2.0');
  expect(parsed.role).toBe('network');
  expect(parsed.projects).toEqual([]);
  expect(logs.some((l) => l.includes('Network root set'))).toBe(true);
});

test('set-network-root uses existing config when file already exists', async () => {
  const networkDir = path.join(tmpDir, `network-existing-${Date.now()}`);
  const configPath = path.join(networkDir, 'agentbootup.json');
  fs.mkdirSync(networkDir, { recursive: true });
  const existingConfig = { version: '2.0', role: 'network', projects: [{ id: 'p1', agent_id: 'a1.gm' }] };
  fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2) + '\n');

  const { logs, restore } = captureOutput();
  try {
    await runConfigCommand(['config', 'set-network-root', networkDir]);
  } finally {
    restore();
  }
  // Should NOT overwrite
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  expect(parsed.projects).toHaveLength(1);
  expect(logs.some((l) => l.includes('Using existing config'))).toBe(true);
});

test('set-network-root --force overwrites existing config', async () => {
  const networkDir = path.join(tmpDir, `network-force-${Date.now()}`);
  const configPath = path.join(networkDir, 'agentbootup.json');
  fs.mkdirSync(networkDir, { recursive: true });
  const existingConfig = { version: '2.0', role: 'network', projects: [{ id: 'p1', agent_id: 'a1.gm' }] };
  fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2) + '\n');

  const { logs, restore } = captureOutput();
  try {
    await runConfigCommand(['config', 'set-network-root', networkDir, '--force']);
  } finally {
    restore();
  }
  // Should overwrite with empty (no creds available → falls back to empty)
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  expect(parsed.projects).toEqual([]);
  expect(logs.some((l) => l.includes('Created'))).toBe(true);
});

// ── dispatch ──────────────────────────────────────────────────────────────────

test('unknown sub-command prints usage to stderr and exits', async () => {
  const { errs, exited } = await expectCommandExit(['config', 'unknown']);
  expect(exited).toBe(true);
  expect(errs.some((e) => e.includes('Usage:'))).toBe(true);
});
