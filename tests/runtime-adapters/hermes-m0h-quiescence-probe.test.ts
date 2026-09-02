import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const probe = path.join(process.cwd(), 'scripts/runtime-adapters/hermes-m0h-quiescence-probe.py');

async function loadModel() {
  const python = Bun.which('python3');
  if (!python) throw new Error('python3 is required for the quiescence model tests');
  const code = [
    'import importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("q",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(json.dumps({"writers":module.writer_matrix(),"scenarios":module.lifecycle_scenarios(),"oracles":module.oracle_extensions()}))',
  ].join(';');
  const child = Bun.spawn([python, '-I', '-B', '-c', code, probe], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  return JSON.parse(stdout);
}

async function runCli(requestPath: string) {
  const python = Bun.which('python3');
  if (!python) throw new Error('python3 is required for the quiescence CLI tests');
  const child = Bun.spawn([python, '-I', '-B', probe, '--request', requestPath], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('Hermes M0-H quiescence evidence model', () => {
  test('accounts for every captured store and append-only oracle extension', async () => {
    const model = await loadModel();
    expect(model.writers).toHaveLength(14);
    expect(new Set(model.writers.map((row: any) => row.storeId)).size).toBe(14);
    expect(model.oracles).toHaveLength(11);
    expect(new Set(model.oracles.map((row: any) => row.checkId)).size).toBe(11);
    expect(model.oracles.every((row: any) => ['pass', 'blocked'].includes(row.status))).toBe(true);
    expect(model.oracles.filter((row: any) => row.status === 'blocked')
      .every((row: any) => row.dependency === 'task_4')).toBe(true);
  });

  test('blocks unsupported writers and never starts originally stopped owners', async () => {
    const { scenarios } = await loadModel();
    expect(scenarios).toHaveLength(23);
    expect(scenarios.every((row: any) => row.originallyStoppedStartTripwireClear)).toBe(true);
    expect(scenarios.filter((row: any) => row.outcome === 'writer_busy_unsupported')
      .every((row: any) => row.authorizedStartCount === 0)).toBe(true);
    expect(scenarios.find((row: any) => row.scenarioId === 'one_running_gateway')).toMatchObject({
      outcome: 'resume_original_owner',
      authorizedStartCount: 1,
      cronStartIssued: false,
      ownerStartIssued: true,
    });
    expect(scenarios.find((row: any) => row.scenarioId === 'resume_failure')).toMatchObject({
      outcome: 'safe_stopped',
      partialResumeFailureRecorded: true,
    });
  });

  test('contains only pinned logical evidence, not local paths or secret-shaped fixtures', async () => {
    const source = await fs.readFile(probe, 'utf8');
    const model = JSON.stringify(await loadModel());
    expect(model).not.toContain('/Users/');
    expect(model).not.toContain('/home/');
    expect(model).not.toContain('gateway.pid');
    expect(model).not.toContain('active_sessions.json');
    expect(source).not.toContain('/Users/kefentse');
    expect(source).not.toContain('/home/runner');
    expect(source).not.toContain('SYNTHETIC_SECRET_DO_NOT_USE_default');
    expect(source).toContain('installation_wide_quiescence_required');
    expect(source).toContain('nativeLifecycleActuationTested');
  });

  test('CLI fails closed on malformed requests without creating partial output', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-quiescence-cli-')),
    );
    await fs.chmod(root, 0o700);
    const request = path.join(root, 'request.json');
    const output = path.join(root, 'quiescence-report.json');
    try {
      await fs.writeFile(request, '{}\n', { mode: 0o600 });
      const result = await runCli(request);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/request schema mismatch/i);
      expect(await fs.lstat(output).catch(() => null)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('CLI refuses a symlinked source before reading runtime evidence or writing output', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-quiescence-link-')),
    );
    await fs.chmod(root, 0o700);
    const realSource = path.join(root, 'real-source');
    const sourceLink = path.join(root, 'source-link');
    const work = path.join(root, 'work');
    const wheel = path.join(root, 'hermes.whl');
    const request = path.join(root, 'request.json');
    const output = path.join(work, 'quiescence-report.json');
    try {
      await fs.mkdir(realSource, { mode: 0o700 });
      await fs.mkdir(work, { mode: 0o700 });
      await fs.symlink(realSource, sourceLink);
      await fs.writeFile(wheel, 'synthetic-not-a-wheel\n', { mode: 0o600 });
      await fs.writeFile(request, `${JSON.stringify({
        sourceHome: sourceLink,
        workRoot: work,
        hermesWheel: wheel,
        outputPath: output,
        executionClass: 'local_discovery_nonclosing',
      })}\n`, { mode: 0o600 });
      const result = await runCli(request);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/source home|symlink|canonical/i);
      expect(await fs.lstat(output).catch(() => null)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
