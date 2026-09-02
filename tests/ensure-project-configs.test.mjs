import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts', 'ensure-project-configs.mjs');

const tempRoots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-backfill-'));
  tempRoots.push(root);
  return root;
}

/**
 * Build a fixture network root with one brain per classification branch.
 *
 * Network-root agentbootup.json lists projects; each targetable brain's repo
 * dir is set up (or omitted) to exercise a specific branch of the backfill
 * script's classification + exit-code logic:
 *
 *   create  — repo exists, no repo-root agentbootup.json  → created++
 *   ensure  — repo exists, agentbootup.json without projects:[self] → ensured++
 *   ok      — repo exists, agentbootup.json already has projects:[self] → skipped++
 *   skip    — targetable brain whose repo path does not exist → missing++
 *   nopath  — brain:true but no path field → pathless++ (exit 1 contributor)
 *   corrupt — repo exists, agentbootup.json is corrupt JSON → corrupt++ (exit 1 contributor)
 */
function buildFixture(branches) {
  const networkRoot = makeTempRoot();
  const projects = [];

  for (const branch of branches) {
    const agentId = branch.id;
    // Both id and agent_id are required by validateNetworkConfig.
    const entry = { id: agentId, agent_id: agentId, brain: true };
    if (branch.kind === 'nopath') {
      // no path → pathless branch
    } else {
      // absolute path inside the temp network root
      const repo = path.join(networkRoot, 'repos', agentId);
      entry.path = repo;
      fs.mkdirSync(repo, { recursive: true });
      if (branch.kind === 'create') {
        // no repo-root agentbootup.json
      } else if (branch.kind === 'ensure') {
        fs.writeFileSync(path.join(repo, 'agentbootup.json'), JSON.stringify({ agent_id: agentId }, null, 2));
      } else if (branch.kind === 'ok') {
        fs.writeFileSync(
          path.join(repo, 'agentbootup.json'),
          JSON.stringify({ agent_id: agentId, projects: [{ id: agentId, agent_id: agentId, path: '.', brain: true }] }, null, 2),
        );
      } else if (branch.kind === 'corrupt') {
        fs.writeFileSync(path.join(repo, 'agentbootup.json'), '{ not valid json,,,');
      } else if (branch.kind === 'stale') {
        // repo-root agentbootup.json with a DIFFERENT agent_id than the network entry → staleAgentId
        fs.writeFileSync(path.join(repo, 'agentbootup.json'), JSON.stringify({ agent_id: branch.staleAs, projects: [{ id: branch.staleAs, agent_id: branch.staleAs, path: '.', brain: true }] }, null, 2));
      } else if (branch.kind === 'skip') {
        // repo path listed but does NOT exist on disk
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
    projects.push(entry);
  }

  // Network-root agentbootup.json. Minimal valid shape for loadNetworkConfig +
  // validateNetworkConfig: role:"network", a version, and a projects array.
  // (hub/skills_source are optional; machine_id/UUID only checked if present.)
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'network', projects }, null, 2),
  );
  return networkRoot;
}

function runScript(networkRoot) {
  const res = spawnSync(process.execPath, [SCRIPT, networkRoot], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ensure-project-configs backfill script — classification + exit code', () => {
  test('classifies each brain branch and exits 0 when nothing failed/corrupt/pathless', () => {
    const root = buildFixture([
      { id: 'create-brain', kind: 'create' },
      { id: 'ensure-brain', kind: 'ensure' },
      { id: 'ok-brain', kind: 'ok' },
      { id: 'skip-brain', kind: 'skip' },
    ]);
    const { code, stdout, stderr } = runScript(root);
    expect(stderr).toBe('');

    expect(stdout).toContain('CREATE create-brain');
    expect(stdout).toContain('ENSURE ensure-brain');
    expect(stdout).toContain('OK     ok-brain');
    expect(stdout).toContain('SKIP  skip-brain');

    // created=1 ensured=1 skipped=1, corrupt=0 stale=0 failed=0 no-path=0 → exit 0
    expect(stdout).toMatch(/created=1 ensured=1 corrupt=0 stale=0 skipped=1 missing-repo=1 failed=0 no-path=0/);
    expect(code).toBe(0);
  });

  test('surfaces NOPATH brains and exits 1 (pathless contributes to non-zero)', () => {
    const root = buildFixture([
      { id: 'nopath-brain', kind: 'nopath' },
      { id: 'ok-brain', kind: 'ok' },
    ]);
    const { code, stdout } = runScript(root);

    expect(stdout).toContain('NOPATH nopath-brain');
    expect(stdout).toContain('OK     ok-brain');
    expect(stdout).toMatch(/no-path=1/);
    // pathless.length > 0 → exit 1
    expect(code).toBe(1);
  });

  test('detects corrupt configs, reports CORRUPT line + backup status, and exits 1', () => {
    const root = buildFixture([{ id: 'corrupt-brain', kind: 'corrupt' }]);
    const { code, stdout, stderr } = runScript(root);

    expect(stderr).toBe('');
    expect(stdout).toContain('CORRUPT corrupt-brain');
    // ensureProjectConfig backs up the corrupt file before rebuilding → reports backup status
    expect(stdout).toMatch(/rebuilt \(backup saved to \.corrupt\)/);
    expect(stdout).toMatch(/corrupt=1/);
    // corrupt > 0 → exit 1
    expect(code).toBe(1);

    // The corrupt repo now has a rebuilt agentbootup.json (idempotency on re-run)
    const rebuilt = fs.readFileSync(path.join(root, 'repos', 'corrupt-brain', 'agentbootup.json'), 'utf8');
    const parsed = JSON.parse(rebuilt);
    expect(parsed.agent_id).toBe('corrupt-brain');
    expect(parsed.projects).toContainEqual({ id: 'corrupt-brain', agent_id: 'corrupt-brain', path: '.', brain: true });
  });

  test('surfaces stale agent_id as BROKEN identity on stderr, counts stale, and exits 1', () => {
    // A repo whose existing agent_id disagrees with the network entry is a broken
    // identity (resolveProjectAgentId fails closed on conflict). The backfill must
    // NOT report success: the STALE line goes to stderr, `stale` appears in the
    // summary, and the exit code is 1 (roborev medium — staleAgentId was previously
    // printed to stdout and excluded from the summary + exit status).
    const root = buildFixture([{ id: 'stale-brain', kind: 'stale', staleAs: 'someone-else' }]);
    const { code, stdout, stderr } = runScript(root);

    expect(stderr).toContain('STALE  stale-brain');
    expect(stderr).toContain('BROKEN identity');
    // routine stdout must NOT contain the STALE line (it moved to stderr)
    expect(stdout).not.toContain('STALE');
    expect(stdout).toMatch(/stale=1/);
    expect(code).toBe(1);
  });

  test('a failing ensure (write throws) counts as failed and exits 1', () => {
    // Make the repo a regular FILE, not a directory. ensureProjectConfig resolves
    // configPath = <repo>/agentbootup.json; existsSync is false (a file has no
    // child entries), so it skips the corrupt branch and tries to write — but
    // writeFileAtomic throws ENOTDIR (parent is a file), which is the only throw
    // that escapes ensureProjectConfig into the script's catch → failed++.
    const networkRoot = makeTempRoot();
    const repo = path.join(networkRoot, 'repos', 'fail-brain');
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    fs.writeFileSync(repo, 'i am a file not a directory');
    fs.writeFileSync(
      path.join(networkRoot, 'agentbootup.json'),
      JSON.stringify({ version: '2.0', role: 'network', projects: [{ id: 'fail-brain', agent_id: 'fail-brain', brain: true, path: repo }] }, null, 2),
    );

    const { code, stdout, stderr } = runScript(networkRoot);
    expect(stderr).toContain('FAIL   fail-brain');
    expect(stdout).toMatch(/failed=1/);
    expect(code).toBe(1);
    // failure is reported on stderr (console.error), not stdout
    expect(stdout).not.toContain('FAIL');
  });
});
