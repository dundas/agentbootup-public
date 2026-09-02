import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat as fsStat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  checkRuntimeSourceMatches,
  safeCommandRunner,
  isPermittedReadCommand,
  isWithin,
  runtimeSourceRunner,
} from '../../lib/doctor/runtime-source-check.js';
import { parsePlistXml, readLaunchAgentPlist } from '../../lib/doctor/plist-reader.js';

/**
 * Hermetic fixture builder (PRD-0063 Task 2.4 / 5.1). Creates a temp tree on disk so
 * realpath/stat/resolveAgentbootupRoot exercise real files (incl. a symlink and the
 * agentbootup vs agentbootup-2 prefix collision), with NO access to the live machine's
 * ~/Library/LaunchAgents or ~/.agentbootup. The suite never reads gitignored files.
 */
async function buildFixture(declaration) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rt-src-'));

  const makeRoot = async (rel, pkgName = 'agentbootup') => {
    const root = path.join(tmp, rel);
    await mkdir(path.join(root, 'lib', 'daemon'), { recursive: true });
    await mkdir(path.join(root, 'lib', 'brain'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: pkgName, version: '9.9.9' }));
    await writeFile(path.join(root, 'lib', 'daemon', 'brain-asset-sync.mjs'), '// daemon');
    await writeFile(path.join(root, 'lib', 'daemon', 'inbox-daemon.mjs'), '// daemon');
    await writeFile(path.join(root, 'lib', 'brain', 'mount-watcher.mjs'), '// daemon');
    return root;
  };

  const packageRoot = await makeRoot(path.join('pkg', 'agentbootup'));
  const devRoot = await makeRoot(path.join('dev', 'agentbootup'));
  // prefix-collision sibling: SAME parent as the package root so a naive startsWith would
  // wrongly treat agentbootup-2 as contained by agentbootup (the AC-7 collision).
  const collRoot = await makeRoot(path.join('pkg', 'agentbootup-2'));
  const linkParent = path.join(tmp, 'link');
  await mkdir(linkParent, { recursive: true });
  const symlinkRoot = path.join(linkParent, 'agentbootup');
  await symlink(packageRoot, symlinkRoot);

  const plistDir = path.join(tmp, 'LaunchAgents');
  await mkdir(plistDir, { recursive: true });

  const declarationFile = path.join(tmp, 'runtime-source.json');
  await writeFile(declarationFile, JSON.stringify(declaration));

  return { tmp, packageRoot, devRoot, collRoot, symlinkRoot, plistDir, declarationFile };
}

/** Write a minimal but valid XML LaunchAgent plist. */
async function writePlist(plistDir, label, programArguments, env = {}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const argsXml = programArguments.map((a) => `    <string>${esc(a)}</string>`).join('\n');
  const envEntries = Object.entries(env);
  const envXml = envEntries.length
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries.map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`).join('\n')}\n  </dict>\n`
    : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  ${envXml}<key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
  await writeFile(path.join(plistDir, `${label}.plist`), xml);
}

const BUN = '/usr/local/bin/bun';

/** Injectable runCommand returning canned launchctl list + ps output for the given label→process map. */
function fakeRunner(processes) {
  // processes: [{ label, pid, script }]
  const lcLines = ['PID\tStatus\tLabel', ...processes.map((p) => `${p.pid}\t0\t${p.label}`)];
  const psLines = processes.map((p) => `${p.pid} ${BUN} ${p.script}`);
  return async (command, args) => {
    if (command === 'launchctl') return lcLines.join('\n');
    if (command === 'ps') return psLines.join('\n');
    throw new Error(`unexpected ${command}`);
  };
}

async function run(fixture, deps = {}) {
  return checkRuntimeSourceMatches({
    plistDir: fixture.plistDir,
    declarationFile: fixture.declarationFile,
    machineId: 'machine-fixed-uuid',
    deps,
  });
}

let tmpRoots = [];

afterEach(async () => {
  await Promise.all(tmpRoots.map((t) => rm(t, { recursive: true, force: true })));
  tmpRoots = [];
});

describe('runtime_source_matches — plist XML parser', () => {
  test('parsePlistXml parses dict/array/string/true/false/integer', () => {
    const v = parsePlistXml(`<?xml version="1.0"?><plist version="1.0"><dict>
      <key>Label</key><string>com.example.x</string>
      <key>ProgramArguments</key><array><string>a</string><string>b</string></array>
      <key>Count</key><integer>7</integer>
      <key>Flag</key><true/>
      <key>Off</key><false/>
    </dict></plist>`);
    expect(v.Label).toBe('com.example.x');
    expect(v.ProgramArguments).toEqual(['a', 'b']);
    expect(v.Count).toBe(7);
    expect(v.Flag).toBe(true);
    expect(v.Off).toBe(false);
  });

  test('parsePlistXml decodes entities', () => {
    const v = parsePlistXml(`<plist version="1.0"><dict><key>K</key><string>a &amp; b &lt;tag&gt; &#65;</string></dict></plist>`);
    expect(v.K).toBe('a & b <tag> A');
  });
});

describe('runtime_source_matches — path normalization contract (AC-7)', () => {
  test('isWithin compares by segments, never startsWith (agentbootup vs agentbootup-2)', () => {
    expect(isWithin('/x/agentbootup', '/x/agentbootup')).toBe(true);
    expect(isWithin('/x/agentbootup', '/x/agentbootup/lib/daemon')).toBe(true);
    // THE collision: must NOT match by prefix.
    expect(isWithin('/x/agentbootup', '/x/agentbootup-2')).toBe(false);
    expect(isWithin('/x/agentbootup', '/x/agentbootup-2/lib/daemon')).toBe(false);
  });

  test('root-shaped and file-shaped plists resolve to the SAME root under a package declaration', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    // point declaration at the package root (set after buildFixture created it)
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-root-shaped', [BUN, f.packageRoot]);
    await writePlist(f.plistDir, 'com.dundas.agentbootup-file-shaped', [BUN, path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.state).toBe('pass');
    expect(r.counts.ok).toBe(2);
    const pkgReal = await realpath(f.packageRoot);
    expect(r.labels.map((l) => l.runtimeRoot)).toEqual([pkgReal, pkgReal]);
    tmpRoots.push(f.tmp);
  });

  test('agentbootup-2 prefix collision reports source_mismatch, not ok', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-collision', [BUN, path.join(f.collRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.state).toBe('fail');
    expect(r.counts.source_mismatch).toBe(1);
    expect(r.counts.ok).toBe(0);
    tmpRoots.push(f.tmp);
  });

  test('a symlinked declared root collapses to its realpath target', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.symlinkRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-via-symlink', [BUN, path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.state).toBe('pass');
    expect(r.counts.ok).toBe(1);
    // the declared root in the result is the realpath (symlink collapsed), matching both the
    // symlink target and the realpath of the package root (on macOS /var -> /private/var too).
    const pkgReal = await realpath(f.packageRoot);
    expect(r.declaration.root).toBe(await realpath(f.symlinkRoot));
    expect(r.declaration.root).toBe(pkgReal);
    tmpRoots.push(f.tmp);
  });
});

describe('runtime_source_matches — discrimination (AC-1 / 5.1, BLOCKING)', () => {
  test('package-shaped plist under a package declaration reports ok', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-pkg', [BUN, path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.state).toBe('pass');
    expect(r.counts.ok).toBe(1);
    tmpRoots.push(f.tmp);
  });

  test('dev-checkout-shaped plist under the SAME declaration reports source_mismatch', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-dev', [BUN, path.join(f.devRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.state).toBe('fail');
    expect(r.counts.source_mismatch).toBe(1);
    tmpRoots.push(f.tmp);
  });
});

describe('runtime_source_matches — verdict precedence (AC-4 / 3.6)', () => {
  test('a label that is BOTH path_missing AND would-be source_mismatch resolves to path_missing', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    // Points at a dev-checkout script that does NOT exist (path missing) — if it existed it would be source_mismatch.
    await writePlist(f.plistDir, 'com.dundas.agentbootup-dead-and-dev', [BUN, path.join(f.devRoot, 'lib', 'daemon', 'never-existed.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.counts.path_missing).toBe(1);
    expect(r.counts.source_mismatch).toBe(0);
    expect(r.labels[0].verdict).toBe('path_missing');
    tmpRoots.push(f.tmp);
  });
});

describe('runtime_source_matches — every verdict has a negative fixture that fires (AC-4)', () => {
  test('plist_invalid: malformed XML', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writeFile(path.join(f.plistDir, 'com.dundas.agentbootup-broken.plist'), '<plist version="1.0"><dict><key>Label</key><string>com.dundas.agentbootup-broken</string><key>ProgramArguments</key><array><string>');
    const r = await run(f, { includeLiveProcess: false });
    expect(r.counts.plist_invalid).toBe(1);
    expect(r.offending_labels.plist_invalid).toContain('com.dundas.agentbootup-broken.plist');
    tmpRoots.push(f.tmp);
  });

  test('plist_invalid: missing ProgramArguments', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writeFile(
      path.join(f.plistDir, 'com.dundas.agentbootup-noargs.plist'),
      `<plist version="1.0"><dict><key>Label</key><string>com.dundas.agentbootup-noargs</string></dict></plist>`,
    );
    const r = await run(f, { includeLiveProcess: false });
    expect(r.counts.plist_invalid).toBe(1);
    tmpRoots.push(f.tmp);
  });

  test('path_missing: script path does not exist on disk', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-dead', [BUN, '/nonexistent/agentbootup/lib/daemon/brain-asset-sync.mjs']);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.counts.path_missing).toBe(1);
    tmpRoots.push(f.tmp);
  });

  test('source_mismatch: exists but not within the declared root', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-dev', [BUN, path.join(f.devRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.counts.source_mismatch).toBe(1);
    tmpRoots.push(f.tmp);
  });

  test('process_mismatch: live process root differs from plist root (mid-rollout)', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    const label = 'com.dundas.agentbootup-repointed';
    // plist now points at the package (no source_mismatch), but the still-running process is on the dev checkout.
    await writePlist(f.plistDir, label, [BUN, path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const r = await run(f, {
      runCommand: fakeRunner([{ label, pid: 4242, script: path.join(f.devRoot, 'lib', 'daemon', 'brain-asset-sync.mjs') }]),
    });
    expect(r.counts.process_mismatch).toBe(1);
    expect(r.labels[0].verdict).toBe('process_mismatch');
    expect(r.labels[0].plistRoot).toBe(await realpath(f.packageRoot));
    expect(r.labels[0].liveRoot).toBe(await realpath(f.devRoot));
    tmpRoots.push(f.tmp);
  });

  test('ok: package plist with a matching live process', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    const label = 'com.dundas.agentbootup-healthy';
    await writePlist(f.plistDir, label, [BUN, path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const r = await run(f, {
      runCommand: fakeRunner([{ label, pid: 4243, script: path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs') }]),
    });
    expect(r.counts.ok).toBe(1);
    expect(r.state).toBe('pass');
    tmpRoots.push(f.tmp);
  });
});

describe('runtime_source_matches — unknown daemon kinds are classified, not skipped (AC-6)', () => {
  test('mount-watcher.mjs (not in DAEMON_NAMES) under the package reports ok', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-mount', [BUN, path.join(f.packageRoot, 'lib', 'brain', 'mount-watcher.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.total_labels).toBe(1);
    expect(r.counts.ok).toBe(1);
    expect(r.labels[0].verdict).toBe('ok');
    tmpRoots.push(f.tmp);
  });

  test('inbox-daemon.mjs (not in DAEMON_NAMES) on a dev checkout reports source_mismatch', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-inbox', [BUN, path.join(f.devRoot, 'lib', 'daemon', 'inbox-daemon.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.counts.source_mismatch).toBe(1);
    tmpRoots.push(f.tmp);
  });
});

describe('runtime_source_matches — declaration (AC-5): absent / malformed ⇒ unknown, never pass', () => {
  test('no declaration file ⇒ unknown', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await rm(f.declarationFile);
    await writePlist(f.plistDir, 'com.dundas.agentbootup-x', [BUN, path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.state).toBe('unknown');
    expect(r.declaration.state).toBe('unknown');
    expect(r.message).toContain('no runtime-source declaration');
    tmpRoots.push(f.tmp);
  });

  test('malformed JSON ⇒ unknown', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, '{ not json');
    const r = await run(f, { includeLiveProcess: false });
    expect(r.state).toBe('unknown');
    expect(r.message).toContain('invalid JSON');
    tmpRoots.push(f.tmp);
  });

  test('valid JSON, bad schema (missing kind) ⇒ unknown', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ path: f.packageRoot }));
    const r = await run(f, { includeLiveProcess: false });
    expect(r.state).toBe('unknown');
    expect(r.message).toContain("kind must be 'package' or 'pinned_checkout'");
    tmpRoots.push(f.tmp);
  });

  test('non-absolute path ⇒ unknown', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: 'relative/agentbootup', commit: null }));
    const r = await run(f, { includeLiveProcess: false });
    expect(r.state).toBe('unknown');
    expect(r.message).toContain('absolute');
    tmpRoots.push(f.tmp);
  });

  test('declared path does not exist ⇒ unknown', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: path.join(f.tmp, 'nope', 'agentbootup'), commit: null }));
    const r = await run(f, { includeLiveProcess: false });
    expect(r.state).toBe('unknown');
    expect(r.message).toContain('does not exist');
    tmpRoots.push(f.tmp);
  });

  test('pinned_checkout with a valid path and commit resolves ok', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'pinned_checkout', path: f.devRoot, commit: 'abc123' }));
    // declaring the dev checkout as the intended pinned root makes dev plists ok (intentional)
    await writePlist(f.plistDir, 'com.dundas.agentbootup-pinned', [BUN, path.join(f.devRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.state).toBe('pass');
    expect(r.declaration.kind).toBe('pinned_checkout');
    expect(r.declaration.commit).toBe('abc123');
    tmpRoots.push(f.tmp);
  });
});

describe('runtime_source_matches — count invariant (AC-2): sum(verdicts) == total_labels', () => {
  test('a mixed fleet mirrors the main-machine shape and nothing is skipped', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    const pkgScript = path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs');
    const devScript = path.join(f.devRoot, 'lib', 'daemon', 'brain-asset-sync.mjs');
    // 5 dev-checkout agents (source_mismatch), 1 package agent (ok), 1 dead path (path_missing), 1 broken plist (plist_invalid)
    for (let i = 0; i < 5; i++) await writePlist(f.plistDir, `com.dundas.agentbootup-dev-${i}`, [BUN, devScript]);
    await writePlist(f.plistDir, 'com.dundas.agentbootup-pkg', [BUN, pkgScript]);
    await writePlist(f.plistDir, 'com.dundas.agentbootup-dead', [BUN, '/nope/agentbootup/lib/daemon/brain-asset-sync.mjs']);
    await writeFile(path.join(f.plistDir, 'com.dundas.agentbootup-broken.plist'), '<plist><dict><key>Label</key><string>x</string>');
    const r = await run(f, { includeLiveProcess: false });
    const sum = r.counts.ok + r.counts.source_mismatch + r.counts.path_missing + r.counts.plist_invalid + r.counts.process_mismatch;
    expect(sum).toBe(r.total_labels);
    expect(r.counts.source_mismatch).toBe(5);
    expect(r.counts.ok).toBe(1);
    expect(r.counts.path_missing).toBe(1);
    expect(r.counts.plist_invalid).toBe(1);
    expect(r.state).toBe('fail');
    tmpRoots.push(f.tmp);
  });
});

describe('runtime_source_matches — read-only command allowlist (Task 4.5)', () => {
  test('isPermittedReadCommand: ps and read-only launchctl are permitted; everything else refused (hermetic, no shell-out)', () => {
    // Permitted reads.
    expect(isPermittedReadCommand('ps', ['-axo', 'pid=,command='])).toBe(true);
    expect(isPermittedReadCommand('/usr/bin/ps', ['aux'])).toBe(true); // basename match
    expect(isPermittedReadCommand('launchctl', ['list'])).toBe(true);
    expect(isPermittedReadCommand('launchctl', ['print'])).toBe(true);
    expect(isPermittedReadCommand('launchctl', ['plist'])).toBe(true);
    // Refused: mutating launchctl subcommands.
    expect(isPermittedReadCommand('launchctl', ['bootout', 'gui/501/x'])).toBe(false);
    expect(isPermittedReadCommand('launchctl', ['kickstart', 'x'])).toBe(false);
    expect(isPermittedReadCommand('launchctl', ['load', 'x'])).toBe(false);
    expect(isPermittedReadCommand('launchctl', ['unload', 'x'])).toBe(false);
    expect(isPermittedReadCommand('launchctl', ['bootstrap', 'x'])).toBe(false);
    expect(isPermittedReadCommand('launchctl', ['enable', 'x'])).toBe(false);
    expect(isPermittedReadCommand('launchctl', ['disable', 'x'])).toBe(false);
    // Refused: plist writers / other binaries.
    expect(isPermittedReadCommand('plutil', ['-insert', 'k', 'x.plist'])).toBe(false);
    expect(isPermittedReadCommand('defaults', ['write', 'x', 'k', 'v'])).toBe(false);
    expect(isPermittedReadCommand('rm', ['-rf', '~/Library/LaunchAgents'])).toBe(false);
    expect(isPermittedReadCommand('kill', ['-9', '1234'])).toBe(false);
  });

  test('safeCommandRunner refuses launchctl bootout/kickstart (never executes)', async () => {
    await expect(safeCommandRunner('launchctl', ['bootout', 'gui/501/com.dundas.agentbootup-x'])).rejects.toThrow(/refused command/);
    await expect(safeCommandRunner('launchctl', ['kickstart', 'com.dundas.agentbootup-x'])).rejects.toThrow(/refused command/);
  });

  test('safeCommandRunner refuses launchctl load / unload / bootstrap / enable / disable', async () => {
    for (const sub of ['load', 'unload', 'bootstrap', 'enable', 'disable']) {
      await expect(safeCommandRunner('launchctl', [sub, 'x'])).rejects.toThrow(/refused command/);
    }
  });

  test('safeCommandRunner refuses a plist write (plutil -insert / defaults write)', async () => {
    await expect(safeCommandRunner('plutil', ['-insert', 'key', 'x.plist'])).rejects.toThrow(/refused command/);
    await expect(safeCommandRunner('defaults', ['write', 'x', 'k', 'v'])).rejects.toThrow(/refused command/);
  });
});

describe('runtime_source_matches — machine-tier shape (AC machine_id)', () => {
  test('the result carries the injected machine_id, never os.hostname', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-x', [BUN, path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const r = await run(f, { includeLiveProcess: false });
    expect(r.machine_id).toBe('machine-fixed-uuid');
    expect(r).not.toHaveProperty('hostname');
    tmpRoots.push(f.tmp);
  });
});

describe('runtime_source_matches — per-label isolation (robustness: one bad label must not crash the check)', () => {
  test('a stat EACCES on ONE label demotes just that label (could-not-resolve reason); the check does not crash', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    // Two DIFFERENT scripts under the package root so only the bad one hits the injected EACCES.
    const okScript = path.join(f.packageRoot, 'lib', 'daemon', 'inbox-daemon.mjs');
    const badScript = path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs');
    const okLabel = 'com.dundas.agentbootup-ok';
    const badLabel = 'com.dundas.agentbootup-eacces';
    await writePlist(f.plistDir, okLabel, [BUN, okScript]);
    await writePlist(f.plistDir, badLabel, [BUN, badScript]);
    // stat throws EACCES ONLY for the bad label's script path; the ok label resolves normally.
    const r = await checkRuntimeSourceMatches({
      plistDir: f.plistDir,
      declarationFile: f.declarationFile,
      machineId: 'machine-fixed-uuid',
      deps: {
        includeLiveProcess: false,
        stat: async (p) => {
          if (p === badScript) {
            const e = new Error('permission denied');
            e.code = 'EACCES';
            throw e;
          }
          return fsStat(p);
        },
      },
    });
    // The check did NOT crash (no throw) — both labels got a verdict.
    expect(r.total_labels).toBe(2);
    const sum = r.counts.ok + r.counts.plist_invalid + r.counts.source_mismatch + r.counts.path_missing + r.counts.process_mismatch;
    expect(sum).toBe(2);
    // The bad label was demoted to plist_invalid (could-not-resolve) naming EACCES; the ok label stayed ok.
    const byLabel = Object.fromEntries(r.labels.map((l) => [l.label, l.verdict]));
    expect(byLabel[`${okLabel}.plist`]).toBe('ok');
    expect(byLabel[`${badLabel}.plist`]).toBe('plist_invalid');
    const bad = r.labels.find((l) => l.label === `${badLabel}.plist`);
    expect(bad.reason).toContain('EACCES');
    expect(r.state).toBe('fail');
    tmpRoots.push(f.tmp);
  });

  test('an unexpected throw inside the per-label loop body (e.g. readPlistFile) is caught by the outer guard, not a crash', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    const okScript = path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs');
    const okLabel = 'com.dundas.agentbootup-healthy';
    const throwLabel = 'com.dundas.agentbootup-read-throws';
    await writePlist(f.plistDir, okLabel, [BUN, okScript]);
    await writePlist(f.plistDir, throwLabel, [BUN, okScript]);
    const throwPath = path.join(f.plistDir, `${throwLabel}.plist`);
    // readPlistFile THROWS (not returns invalid) for one label — simulates an unexpected error
    // in the per-label body that the outer guard must catch, not let crash the whole check.
    const defaultReadPlist = (filePath) => readLaunchAgentPlist(filePath);
    const r = await checkRuntimeSourceMatches({
      plistDir: f.plistDir,
      declarationFile: f.declarationFile,
      machineId: 'machine-fixed-uuid',
      deps: {
        includeLiveProcess: false,
        readPlistFile: async (filePath) => {
          if (filePath === throwPath) throw new Error('transient read explosion');
          return defaultReadPlist(filePath);
        },
      },
    });
    expect(r.total_labels).toBe(2);
    const byLabel = Object.fromEntries(r.labels.map((l) => [l.label, l.verdict]));
    expect(byLabel[`${okLabel}.plist`]).toBe('ok');
    expect(byLabel[`${throwLabel}.plist`]).toBe('plist_invalid');
    const thrown = r.labels.find((l) => l.label === `${throwLabel}.plist`);
    expect(thrown.reason).toContain('unexpected error');
    expect(thrown.reason).toContain('transient read explosion');
    tmpRoots.push(f.tmp);
  });

  test('one unreadable label among healthy ones does not take down the others', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    const okScript = path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs');
    const badScript = path.join(f.devRoot, 'lib', 'daemon', 'brain-asset-sync.mjs');
    await writePlist(f.plistDir, 'com.dundas.agentbootup-healthy-a', [BUN, okScript]);
    await writePlist(f.plistDir, 'com.dundas.agentbootup-healthy-b', [BUN, okScript]);
    await writePlist(f.plistDir, 'com.dundas.agentbootup-sick', [BUN, badScript]);
    // stat throws ELOOP ONLY for the sick label's (dev) script; the two ok labels resolve.
    const r = await checkRuntimeSourceMatches({
      plistDir: f.plistDir,
      declarationFile: f.declarationFile,
      machineId: 'machine-fixed-uuid',
      deps: {
        includeLiveProcess: false,
        stat: async (p) => {
          if (p === badScript) {
            const e = new Error('too many levels of symbolic links');
            e.code = 'ELOOP';
            throw e;
          }
          return fsStat(p);
        },
      },
    });
    expect(r.total_labels).toBe(3);
    const byLabel = Object.fromEntries(r.labels.map((l) => [l.label, l.verdict]));
    // The two healthy labels report ok; the sick one is demoted (plist_invalid), not crashing.
    expect(byLabel['com.dundas.agentbootup-healthy-a.plist']).toBe('ok');
    expect(byLabel['com.dundas.agentbootup-healthy-b.plist']).toBe('ok');
    expect(byLabel['com.dundas.agentbootup-sick.plist']).toBe('plist_invalid');
    expect(r.counts.ok).toBe(2);
    expect(r.counts.plist_invalid).toBe(1);
    tmpRoots.push(f.tmp);
  });
});

describe('runtime_source_matches — read-only contract (FR-5)', () => {
  test('does NOT mint a machine-id when absent (readMachineIdState, never getMachineId)', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-x', [BUN, path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    // Point machine-id at a nonexistent temp path and do NOT inject machineId, so the
    // default resolver runs. A read-only check must not create this file.
    const savedFile = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    const fakeIdFile = path.join(f.tmp, 'machine-id-absent');
    process.env.AGENTBOOTUP_MACHINE_ID_FILE = fakeIdFile;
    try {
      const r = await checkRuntimeSourceMatches({
        plistDir: f.plistDir,
        declarationFile: f.declarationFile,
        deps: { includeLiveProcess: false },
      });
      expect(r.state).toBe('pass');
      expect(r.machine_id).toBe(null); // absent -> honest null, never minted
      expect(existsSync(fakeIdFile)).toBe(false); // no file created — read-only held
    } finally {
      if (savedFile === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
      else process.env.AGENTBOOTUP_MACHINE_ID_FILE = savedFile;
    }
    tmpRoots.push(f.tmp);
  });

  test('readdir EACCES (not ENOENT) -> unknown, never a false pass', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    const r = await checkRuntimeSourceMatches({
      plistDir: f.plistDir,
      declarationFile: f.declarationFile,
      machineId: 'machine-fixed-uuid',
      deps: {
        includeLiveProcess: false,
        readdir: async () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; },
      },
    });
    expect(r.state).toBe('unknown');
    expect(r.message).toContain('could not enumerate');
    expect(r.message).toContain('permission denied');
    tmpRoots.push(f.tmp);
  });

  test('readdir ENOENT with a valid declaration -> vacuous pass (no LaunchAgents dir)', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    const r = await checkRuntimeSourceMatches({
      plistDir: path.join(f.tmp, 'does-not-exist'),
      declarationFile: f.declarationFile,
      machineId: 'machine-fixed-uuid',
      deps: { includeLiveProcess: false },
    });
    expect(r.state).toBe('pass');
    expect(r.total_labels).toBe(0);
    tmpRoots.push(f.tmp);
  });
});

describe('runtime_source_matches — runner registration (Task 4.3, no CHECK_NAMES change)', () => {
  test('runtimeSourceRunner produces an aggregate-compatible runner', async () => {
    const f = await buildFixture({ kind: 'package', path: null, commit: null });
    await writeFile(f.declarationFile, JSON.stringify({ kind: 'package', path: f.packageRoot, commit: null }));
    await writePlist(f.plistDir, 'com.dundas.agentbootup-x', [BUN, path.join(f.packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')]);
    const runner = runtimeSourceRunner({
      plistDir: f.plistDir,
      declarationFile: f.declarationFile,
      machineId: 'machine-fixed-uuid',
      deps: { includeLiveProcess: false },
    });
    const result = await runner();
    expect(result.category).toBe('runtime_source');
    expect(result.state).toBe('pass');
    tmpRoots.push(f.tmp);
  });
});