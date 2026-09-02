import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeBundleHash,
  installBundle,
  normalizeBundleManifest,
  rollbackBundle,
} from '../lib/bundle/installer.js';
import { planStructuralBackupCopy } from '../lib/bundle/backup-containment.js';

const originalHome = process.env.AGENTBOOTUP_HOME;
const roots = [];

afterEach(() => {
  if (originalHome == null) delete process.env.AGENTBOOTUP_HOME;
  else process.env.AGENTBOOTUP_HOME = originalHome;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(root, relative, bytes, mode) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
  if (mode != null) fs.chmodSync(absolute, mode);
  return absolute;
}

function manifest(sourceRoot, overrides = {}) {
  const raw = {
    bundle_type: 'skill_bundle',
    bundle_name: 'containment-fixture',
    bundle_version: '1.0.0',
    version_id: 'containment-fixture@1.0.0+sha256_pending',
    bundle_hash: 'sha256:pending',
    source: { repo: 'local-test' },
    distribution: { mode: 'self_apply' },
    install: { state_file: 'skills/state/containment.json', backup_root: 'skills/containment' },
    validation: { commands: [] },
    files: [{ source: 'payload/SKILL.md', target: 'managed/SKILL.md', required: true, role: 'entrypoint' }],
    ...overrides,
  };
  const pending = normalizeBundleManifest(raw);
  const hash = computeBundleHash(pending, sourceRoot);
  return normalizeBundleManifest({
    ...raw,
    bundle_hash: hash,
    version_id: `containment-fixture@1.0.0+${hash.slice(7, 15)}`,
  });
}

function metadataFor(result) {
  return JSON.parse(fs.readFileSync(path.join(result.backup_path, 'backup-metadata.json'), 'utf8'));
}

function mode(absolute) {
  return fs.statSync(absolute).mode & 0o777;
}

test('structural planner rejects equality and both source/destination ancestor directions without writes', () => {
  for (const relation of ['equal', 'source-parent', 'destination-parent']) {
    const target = temp(`ab-backup-${relation}-target-`);
    const home = target;
    const backups = path.join(home, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    const source = relation === 'equal'
      ? backups
      : relation === 'source-parent'
        ? target
        : path.join(backups, 'generation', 'managed');
    fs.mkdirSync(source, { recursive: true });
    const destination = relation === 'equal'
      ? source
      : relation === 'source-parent'
        ? path.join(backups, 'generation', 'managed')
        : path.join(backups, 'generation');
    const before = fs.statSync(backups).mtimeMs;
    const beforeEntries = fs.readdirSync(backups).sort();
    expect(() => planStructuralBackupCopy({
      sourcePath: source,
      destinationPath: destination,
      targetRoot: target,
      backupHome: home,
      backupsRoot: backups,
    })).toThrow('backup source and destination overlap');
    expect(fs.statSync(backups).mtimeMs).toBe(before);
    expect(fs.readdirSync(backups).sort()).toEqual(beforeEntries);
  }
});

test('structural planner rejects managed and backup symlinks, nested managed links, and exact inode aliases', () => {
  const target = temp('ab-backup-alias-target-');
  const home = temp('ab-backup-alias-home-');
  const realBackups = path.join(home, 'real-backups');
  fs.mkdirSync(realBackups);
  const backupsLink = path.join(home, 'backups');
  fs.symlinkSync(realBackups, backupsLink);
  const managed = path.join(target, 'managed');
  fs.mkdirSync(managed);
  expect(() => planStructuralBackupCopy({
    sourcePath: managed,
    destinationPath: path.join(backupsLink, 'generation'),
    targetRoot: target,
    backupHome: home,
    backupsRoot: backupsLink,
  })).toThrow('symbolic links are not permitted');

  const backups = path.join(home, 'safe-backups');
  fs.mkdirSync(backups);
  const outside = write(target, 'outside.txt', 'outside');
  fs.symlinkSync(outside, path.join(managed, 'nested-link'));
  expect(() => planStructuralBackupCopy({
    sourcePath: managed,
    destinationPath: path.join(backups, 'generation'),
    targetRoot: target,
    backupHome: home,
    backupsRoot: backups,
  })).toThrow('symbolic links are not permitted');

  fs.rmSync(path.join(managed, 'nested-link'));
  const source = write(target, 'managed/file.txt', 'same inode');
  const destination = path.join(backups, 'existing-file');
  fs.linkSync(source, destination);
  expect(() => planStructuralBackupCopy({
    sourcePath: source,
    destinationPath: destination,
    targetRoot: target,
    backupHome: home,
    backupsRoot: backups,
  })).toThrow('aliases protected storage');
});

test('install rejects a broad inventory containing its backup root before creating a generation', () => {
  const source = temp('ab-backup-broad-src-');
  const target = temp('ab-backup-broad-target-');
  process.env.AGENTBOOTUP_HOME = path.join(target, '.agentbootup');
  write(source, 'payload/file.txt', 'new');
  fs.mkdirSync(process.env.AGENTBOOTUP_HOME);
  const broad = manifest(source, {
    files: [{ source: 'payload/file.txt', target: '.agentbootup', required: true, role: 'entrypoint' }],
  });
  expect(() => installBundle({ manifest: broad, sourceRoot: source, targetRoot: target, agentId: 'agent' }))
    .toThrow('backup source and destination overlap');
  expect(fs.existsSync(path.join(process.env.AGENTBOOTUP_HOME, 'brains', 'agent', 'backups'))).toBe(false);
  expect(fs.readdirSync(process.env.AGENTBOOTUP_HOME)).toEqual([]);
});

test('backup bytes are owner-only and failed install restores exact file and directory modes', () => {
  if (process.platform === 'win32') return;
  const source = temp('ab-backup-mode-src-');
  const target = temp('ab-backup-mode-target-');
  process.env.AGENTBOOTUP_HOME = temp('ab-backup-mode-home-');
  write(source, 'payload/SKILL.md', 'new');
  write(source, 'scripts/init.js', 'export default true;\n');
  write(target, 'managed/SKILL.md', 'old', 0o754);
  fs.chmodSync(path.join(target, 'managed'), 0o751);
  const failing = manifest(source, { validation: { commands: ['false'] } });
  expect(() => installBundle({ manifest: failing, sourceRoot: source, targetRoot: target, agentId: 'agent' }))
    .toThrow('Validation failed');
  expect(fs.readFileSync(path.join(target, 'managed/SKILL.md'), 'utf8')).toBe('old');
  expect(mode(path.join(target, 'managed/SKILL.md'))).toBe(0o754);
  expect(mode(path.join(target, 'managed'))).toBe(0o751);
  const state = JSON.parse(fs.readFileSync(path.join(process.env.AGENTBOOTUP_HOME, 'brains/agent/installed/skills/state/containment.json'), 'utf8'));
  expect(mode(state.backup_path)).toBe(0o700);
  expect(mode(path.join(state.backup_path, 'managed/SKILL.md')) & 0o077).toBe(0);
  expect(mode(path.join(state.backup_path, 'backup-metadata.json'))).toBe(0o600);
  expect(metadataFor({ backup_path: state.backup_path }).entries[0].modes).toEqual([
    { path: '', kind: 'file', mode: 0o754 },
  ]);
});

test('mutation, initializer, and materialized targets all participate in the structural backup plan', () => {
  const source = temp('ab-backup-inventory-src-');
  const target = temp('ab-backup-inventory-target-');
  process.env.AGENTBOOTUP_HOME = temp('ab-backup-inventory-home-');
  write(source, 'payload/SKILL.md', 'new');
  write(source, 'scripts/init.js', 'export default true;\n');
  write(target, 'managed/SKILL.md', 'old');
  write(target, 'config/settings.json', '{}\n');
  write(target, 'memory/state.json', '{}\n');
  write(target, '.agents/skills/containment-fixture/SKILL.md', 'local mirror');
  fs.rmSync(path.join(target, 'config/settings.json'));
  fs.symlinkSync(path.join(target, 'managed/SKILL.md'), path.join(target, 'config/settings.json'));
  const fixture = manifest(source, {
    files: [
      { source: 'payload/SKILL.md', target: '.claude/skills/containment-fixture/SKILL.md', required: true, role: 'entrypoint' },
      { source: 'scripts/init.js', target: 'scripts/init.js', required: true, role: 'runtime' },
      { source: 'memory/state.json', target: 'memory/state.json', required: true, role: 'required_data', initializer: 'scripts/init.js' },
    ],
    mutations: [{ type: 'json_set', path: 'config/settings.json', key_path: ['enabled'], value: true }],
  });
  const backupRoot = path.join(process.env.AGENTBOOTUP_HOME, 'brains/agent/backups');
  expect(() => installBundle({
    manifest: fixture,
    sourceRoot: source,
    targetRoot: target,
    agentId: 'agent',
    materializeAgents: true,
  })).toThrow('symbolic links are not permitted');
  expect(fs.existsSync(backupRoot)).toBe(false);
  expect(fs.readFileSync(path.join(target, 'memory/state.json'), 'utf8')).toBe('{}\n');
  expect(fs.readFileSync(path.join(target, '.agents/skills/containment-fixture/SKILL.md'), 'utf8')).toBe('local mirror');
});

test('dependency roots are fully planned before any backup directory is written', () => {
  const source = temp('ab-backup-dependency-src-');
  const target = temp('ab-backup-dependency-target-');
  process.env.AGENTBOOTUP_HOME = temp('ab-backup-dependency-home-');
  write(source, 'payload/SKILL.md', 'new');
  write(target, 'managed/SKILL.md', 'old');
  write(target, 'package.json', '{"name":"fixture","private":true}\n');
  const outside = write(target, 'outside.lock', 'lock');
  fs.symlinkSync(outside, path.join(target, 'bun.lock'));
  const fixture = manifest(source, { dependencies: { '@agentdispatch/cli': '^0.2.0' } });
  expect(() => installBundle({ manifest: fixture, sourceRoot: source, targetRoot: target, agentId: 'agent' }))
    .toThrow('symbolic links are not permitted');
  expect(fs.existsSync(path.join(process.env.AGENTBOOTUP_HOME, 'brains/agent/backups'))).toBe(false);
  expect(fs.readFileSync(path.join(target, 'managed/SKILL.md'), 'utf8')).toBe('old');
});

test('a mid-copy failure removes a newly-created incomplete backup generation', () => {
  const source = temp('ab-backup-partial-src-');
  const target = temp('ab-backup-partial-target-');
  process.env.AGENTBOOTUP_HOME = temp('ab-backup-partial-home-');
  write(source, 'payload/SKILL.md', 'new skill');
  write(source, 'payload/config.json', '{"new":true}\n');
  write(target, 'managed/SKILL.md', 'old skill');
  write(target, 'managed/config.json', '{"old":true}\n');
  const fixture = manifest(source, {
    files: [
      { source: 'payload/SKILL.md', target: 'managed/SKILL.md', required: true, role: 'entrypoint' },
      { source: 'payload/config.json', target: 'managed/config.json', required: true, role: 'runtime' },
    ],
  });
  const originalCopy = fs.cpSync;
  let copies = 0;
  fs.cpSync = (...args) => {
    copies += 1;
    if (copies === 2) throw new Error('synthetic copy failure with private path');
    return originalCopy(...args);
  };
  try {
    expect(() => installBundle({ manifest: fixture, sourceRoot: source, targetRoot: target, agentId: 'agent' }))
      .toThrow('bundle backup structural preflight failed: filesystem operation failed');
  } finally {
    fs.cpSync = originalCopy;
  }
  const backupsRoot = path.join(process.env.AGENTBOOTUP_HOME, 'brains/agent/backups/skills/containment');
  expect(fs.existsSync(backupsRoot) ? fs.readdirSync(backupsRoot) : []).toEqual([]);
  expect(fs.readFileSync(path.join(target, 'managed/SKILL.md'), 'utf8')).toBe('old skill');
  expect(fs.readFileSync(path.join(target, 'managed/config.json'), 'utf8')).toBe('{"old":true}\n');
});

test('a generation-directory failure removes its partially-created generation', () => {
  const source = temp('ab-backup-mkdir-src-');
  const target = temp('ab-backup-mkdir-target-');
  process.env.AGENTBOOTUP_HOME = temp('ab-backup-mkdir-home-');
  write(source, 'payload/SKILL.md', 'new skill');
  write(target, 'managed/SKILL.md', 'old skill');
  const fixture = manifest(source);
  const originalChmod = fs.chmodSync;
  let generationSeen = false;
  fs.chmodSync = (absolute, requestedMode) => {
    if (String(absolute).includes('preinstall-')) {
      generationSeen = true;
      throw new Error('synthetic generation chmod failure');
    }
    return originalChmod(absolute, requestedMode);
  };
  try {
    expect(() => installBundle({ manifest: fixture, sourceRoot: source, targetRoot: target, agentId: 'agent' }))
      .toThrow('bundle backup structural preflight failed: filesystem operation failed');
  } finally {
    fs.chmodSync = originalChmod;
  }
  expect(generationSeen).toBe(true);
  const backupsRoot = path.join(process.env.AGENTBOOTUP_HOME, 'brains/agent/backups/skills/containment');
  expect(fs.existsSync(backupsRoot) ? fs.readdirSync(backupsRoot) : []).toEqual([]);
});

test('a failed same-version reinstall preserves its prior generation and a later success rolls back exactly', () => {
  const source = temp('ab-backup-reinstall-src-');
  const target = temp('ab-backup-reinstall-target-');
  process.env.AGENTBOOTUP_HOME = temp('ab-backup-reinstall-home-');
  write(source, 'payload/SKILL.md', 'upstream skill');
  write(source, 'payload/config.json', '{"upstream":true}\n');
  write(target, 'managed/SKILL.md', 'original skill');
  write(target, 'managed/config.json', '{"original":true}\n');
  const fixture = manifest(source, {
    files: [
      { source: 'payload/SKILL.md', target: 'managed/SKILL.md', required: true, role: 'entrypoint' },
      { source: 'payload/config.json', target: 'managed/config.json', required: true, role: 'runtime' },
    ],
  });
  const installed = installBundle({ manifest: fixture, sourceRoot: source, targetRoot: target, agentId: 'agent' });
  const fingerprint = (directory) => {
    const records = [];
    const visit = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const absolute = path.join(current, entry.name);
        const relative = path.relative(directory, absolute);
        if (entry.isDirectory()) visit(absolute);
        else records.push([relative, fs.readFileSync(absolute, 'base64'), fs.statSync(absolute).mode & 0o7777]);
      }
    };
    visit(directory);
    return records;
  };
  const priorFingerprint = fingerprint(installed.backup_path);
  fs.writeFileSync(path.join(target, 'managed/SKILL.md'), 'local skill');
  fs.writeFileSync(path.join(target, 'managed/config.json'), '{"local":true}\n');
  const originalCopy = fs.cpSync;
  let backupCopies = 0;
  fs.cpSync = (...args) => {
    if (String(args[1]).includes(`${path.sep}backups${path.sep}`)) {
      backupCopies += 1;
      if (backupCopies === 2) throw new Error('synthetic reinstall copy failure');
    }
    return originalCopy(...args);
  };
  try {
    expect(() => installBundle({ manifest: fixture, sourceRoot: source, targetRoot: target, agentId: 'agent', force: true }))
      .toThrow('bundle backup structural preflight failed: filesystem operation failed');
  } finally {
    fs.cpSync = originalCopy;
  }
  expect(fingerprint(installed.backup_path)).toEqual(priorFingerprint);
  expect(fs.readFileSync(path.join(target, 'managed/SKILL.md'), 'utf8')).toBe('local skill');
  expect(fs.readFileSync(path.join(target, 'managed/config.json'), 'utf8')).toBe('{"local":true}\n');
  const generationRoot = path.dirname(installed.backup_path);
  expect(fs.readdirSync(generationRoot)).toEqual([path.basename(installed.backup_path)]);

  const reinstalled = installBundle({ manifest: fixture, sourceRoot: source, targetRoot: target, agentId: 'agent', force: true });
  expect(reinstalled.backup_path).not.toBe(installed.backup_path);
  rollbackBundle({ manifest: fixture, targetRoot: target, agentId: 'agent' });
  expect(fs.readFileSync(path.join(target, 'managed/SKILL.md'), 'utf8')).toBe('local skill');
  expect(fs.readFileSync(path.join(target, 'managed/config.json'), 'utf8')).toBe('{"local":true}\n');
});

test('unreadable structural identity fails closed without backup writes', () => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() === 0) return;
  const target = temp('ab-backup-unreadable-target-');
  const home = temp('ab-backup-unreadable-home-');
  const backups = path.join(home, 'backups');
  const managed = path.join(target, 'managed');
  fs.mkdirSync(backups);
  fs.mkdirSync(managed);
  write(managed, 'file.txt', 'private');
  fs.chmodSync(managed, 0o000);
  try {
    expect(() => planStructuralBackupCopy({
      sourcePath: managed,
      destinationPath: path.join(backups, 'generation'),
      targetRoot: target,
      backupHome: home,
      backupsRoot: backups,
    })).toThrow(/(?:backup source is unreadable|filesystem identity is unavailable)/);
    expect(fs.readdirSync(backups)).toEqual([]);
  } finally {
    fs.chmodSync(managed, 0o700);
  }
});

test('secret-denied declarations fail before backup writes without exposing content', () => {
  for (const [declaredTarget, denied] of [
    ['.env', '.env'],
    ['.dev.vars', '.dev.vars'],
    ['brain/config.secret.json', 'brain/config.secret.json'],
    ['brain', 'brain/config.secret.json'],
  ]) {
    const source = temp('ab-backup-secret-src-');
    const target = temp('ab-backup-secret-target-');
    process.env.AGENTBOOTUP_HOME = temp('ab-backup-secret-home-');
    write(source, 'payload/SKILL.md', 'synthetic fixture');
    write(target, denied, 'SYNTHETIC_SECRET_MARKER');
    const fixture = manifest(source, {
      files: [{ source: 'payload/SKILL.md', target: declaredTarget, required: true, role: 'entrypoint' }],
    });
    let failure;
    try {
      installBundle({ manifest: fixture, sourceRoot: source, targetRoot: target, agentId: 'agent' });
    } catch (error) {
      failure = error;
    }
    expect(failure?.message).toContain('secret-denied inventory path');
    expect(failure?.message).not.toContain('SYNTHETIC_SECRET_MARKER');
    expect(failure?.message).not.toContain(target);
    expect(fs.existsSync(path.join(process.env.AGENTBOOTUP_HOME, 'brains/agent/backups'))).toBe(false);
  }
});

test('special mode bits are recorded and restored exactly', () => {
  if (process.platform === 'win32') return;
  const source = temp('ab-backup-special-mode-src-');
  const target = temp('ab-backup-special-mode-target-');
  process.env.AGENTBOOTUP_HOME = temp('ab-backup-special-mode-home-');
  write(source, 'payload/SKILL.md', 'new');
  write(target, 'managed/SKILL.md', 'old', 0o4754);
  const supportedMode = fs.statSync(path.join(target, 'managed/SKILL.md')).mode & 0o7777;
  const failing = manifest(source, { validation: { commands: ['false'] } });
  expect(() => installBundle({ manifest: failing, sourceRoot: source, targetRoot: target, agentId: 'agent' }))
    .toThrow('Validation failed');
  expect(fs.statSync(path.join(target, 'managed/SKILL.md')).mode & 0o7777).toBe(supportedMode);
});

test('legacy metadata without modes remains readable while new metadata restores modes on rollback', () => {
  if (process.platform === 'win32') return;
  const source = temp('ab-backup-legacy-src-');
  const target = temp('ab-backup-legacy-target-');
  process.env.AGENTBOOTUP_HOME = temp('ab-backup-legacy-home-');
  write(source, 'payload/SKILL.md', 'new');
  write(target, 'managed/SKILL.md', 'old', 0o744);
  const installed = installBundle({ manifest: manifest(source), sourceRoot: source, targetRoot: target, agentId: 'agent' });
  fs.writeFileSync(path.join(target, 'managed/SKILL.md'), 'local drift');
  rollbackBundle({ manifest: manifest(source), targetRoot: target, agentId: 'agent' });
  expect(fs.readFileSync(path.join(target, 'managed/SKILL.md'), 'utf8')).toBe('old');
  expect(mode(path.join(target, 'managed/SKILL.md'))).toBe(0o744);

  const metadataPath = path.join(installed.backup_path, 'backup-metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  for (const entry of metadata.entries) delete entry.modes;
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  expect(() => rollbackBundle({ manifest: manifest(source), targetRoot: target, agentId: 'agent' })).not.toThrow();
});

test('ten forced installs do not copy prior backup generations into later generations', () => {
  const source = temp('ab-backup-soak-src-');
  const target = temp('ab-backup-soak-target-');
  process.env.AGENTBOOTUP_HOME = temp('ab-backup-soak-home-');
  write(source, 'payload/SKILL.md', 'new');
  write(target, 'managed/SKILL.md', 'old');
  const fixture = manifest(source);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    fs.writeFileSync(path.join(target, 'managed/SKILL.md'), `local-${attempt}`);
    installBundle({ manifest: fixture, sourceRoot: source, targetRoot: target, agentId: 'agent', force: true });
  }
  const backups = path.join(process.env.AGENTBOOTUP_HOME, 'brains/agent/backups');
  const nested = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      if (absolute.slice(backups.length + 1).split(path.sep).filter((part) => part === 'backups').length > 0) nested.push(absolute);
    }
  };
  visit(backups);
  expect(nested).toEqual([]);
  expect(fs.readdirSync(path.join(backups, 'skills/containment')).length).toBe(10);
});
