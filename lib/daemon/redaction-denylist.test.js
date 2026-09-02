import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildDenylist,
  createDenylistManager,
  encodeExplicitDenylistRecord,
  loadExplicitDenylist,
  loadExplicitDenylistAsync,
  loadEnvDenylist,
  loadEnvDenylistAsync,
  parseDotEnv,
  REDACT_DENYLIST_LOCK_OPTIONS,
} from './redaction-denylist.js';
import { withFileLock } from '../util/file-lock.js';
import { normalizeProjectPath } from './transcript-brain-routing.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'redaction-denylist-')));
  roots.push(root);
  const explicitPath = path.join(root, 'redact-denylist');
  return { root, explicitPath };
}

function write(filePath, content, mode = 0o600) {
  fs.writeFileSync(filePath, content, { mode });
  fs.chmodSync(filePath, mode);
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for asynchronous denylist state');
}

describe('parseDotEnv', () => {
  test('matches quoted, multiline, CRLF, export, comment, duplicate, and ordered expansion semantics', () => {
    const parsed = parseDotEnv([
      'export BASE=synthetic-first-value',
      'DERIVED="${BASE}-suffix"',
      'BASE=synthetic-second-value # current value',
      'AFTER=${BASE}-suffix',
      'PLAIN=$BASE-plain',
      'FORWARD=${LATER}-forward',
      'LATER=synthetic-later-value',
      "SINGLE='${BASE}-literal'",
      'MULTI="line-one',
      'line-two"',
      'BACKTICK=`tick-one',
      '${BASE}-tick-two`',
      'ESCAPED="line\\nnext"',
      'EMPTY=""',
    ].join('\r\n'), { environment: {} });
    expect(parsed).toEqual({
      BASE: 'synthetic-second-value',
      DERIVED: 'synthetic-second-value-suffix',
      AFTER: 'synthetic-second-value-suffix',
      PLAIN: 'synthetic-second-value-plain',
      FORWARD: 'synthetic-later-value-forward',
      LATER: 'synthetic-later-value',
      SINGLE: 'synthetic-second-value-literal',
      MULTI: 'line-one\nline-two',
      BACKTICK: 'tick-one\nsynthetic-second-value-tick-two',
      ESCAPED: 'line\nnext',
      EMPTY: '',
    });
  });

  test('fails on an unterminated quote', () => {
    expect(() => parseDotEnv('KEY="unterminated', { environment: {} })).toThrow('unterminated');
  });

  test('matches runtime comment and escaped-expansion behavior', () => {
    expect(parseDotEnv('BASE=synthetic-base\nCOMMENTED=synthetic-value#comment\nESCAPED=\\${BASE}\n', { environment: {} }))
      .toEqual({ BASE: 'synthetic-base', COMMENTED: 'synthetic-value', ESCAPED: '${BASE}' });
  });

  test('existing process environment values win over file values and all references use them', () => {
    expect(parseDotEnv("BASE=file-value\nBRACED=${BASE}-braced\nPLAIN=$BASE-plain\nSINGLE='${BASE}-single'\n", {
      environment: { BASE: 'synthetic-runtime-value' },
    })).toEqual({
      BASE: 'synthetic-runtime-value',
      BRACED: 'synthetic-runtime-value-braced',
      PLAIN: 'synthetic-runtime-value-plain',
      SINGLE: 'synthetic-runtime-value-single',
    });
  });

  test('matches Bun executable env-file expansion on synthetic runtime fixtures', () => {
    const { root } = fixture();
    const envPath = path.join(root, 'runtime.env');
    const text = [
      'BASE=synthetic-first',
      'BRACED=${BASE}-braced',
      'PLAIN=$BASE-plain',
      'FORWARD=${LATER}-forward',
      'SINGLE=\'${BASE}-single\'',
      'ESCAPED=\\${BASE}',
      'COMMENTED=synthetic-comment#ignored',
      'BASE=synthetic-final',
      'LATER=synthetic-later',
      'OVERRIDE=file-value',
      'OVERRIDE_REF=$OVERRIDE-ref',
    ].join('\n');
    write(envPath, text);
    const keys = ['BASE', 'BRACED', 'PLAIN', 'FORWARD', 'SINGLE', 'ESCAPED', 'COMMENTED', 'LATER', 'OVERRIDE', 'OVERRIDE_REF'];
    const runtime = spawnSync(process.execPath, [
      '--env-file', envPath, '-e',
      `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((key) => [key, process.env[key]]))))`,
    ], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, OVERRIDE: 'synthetic-runtime-override' },
    });
    expect(runtime.status).toBe(0);
    const parsed = parseDotEnv(text, { environment: { OVERRIDE: 'synthetic-runtime-override' } });
    expect(parsed).toEqual(JSON.parse(runtime.stdout.trim()));
  });
});

describe('denylist sources', () => {
  test('loads only sufficiently long expanded dotenv values', () => {
    const { root } = fixture();
    write(path.join(root, '.env'), 'BASE=synthetic-secret-value\nEXPANDED=${BASE}-tail\nSHORT=tiny\n');
    expect([...loadEnvDenylist([root], { environment: {}, minLength: 12, agentbootupRoot: null })]).toEqual([
      'synthetic-secret-value', 'synthetic-secret-value-tail',
    ]);
  });

  test('collects file-resolved and runtime-effective values when ambient names collide across projects', () => {
    const first = fixture();
    const second = fixture();
    write(path.join(first.root, '.env'), 'TOKEN=synthetic-project-a-secret\nDERIVED=$TOKEN-a\n');
    write(path.join(second.root, '.env'), 'TOKEN=synthetic-project-b-secret\nDERIVED=$TOKEN-b\n');
    const values = loadEnvDenylist([first.root, second.root], {
      environment: { TOKEN: 'synthetic-daemon-secret' }, minLength: 12, agentbootupRoot: null,
    });
    expect(values).toEqual(new Set([
      'synthetic-daemon-secret', 'synthetic-daemon-secret-a',
      'synthetic-project-a-secret', 'synthetic-project-a-secret-a',
      'synthetic-daemon-secret-b', 'synthetic-project-b-secret',
      'synthetic-project-b-secret-b',
    ]));
  });

  test('does not import ambient values for names the env file does not declare', () => {
    const project = fixture();
    write(path.join(project.root, '.env'), 'DERIVED=$UNDECLARED_HOST_VALUE-suffix\n');
    const values = loadEnvDenylist([project.root], {
      environment: { UNDECLARED_HOST_VALUE: 'synthetic-unrelated-host-value' },
      minLength: 12,
      agentbootupRoot: null,
    });
    expect(values.has('synthetic-unrelated-host-value')).toBe(false);
    expect(values.has('synthetic-unrelated-host-value-suffix')).toBe(false);
  });

  test('refuses a symlinked project .env without reading its target', () => {
    const project = fixture();
    const outside = fixture();
    const target = path.join(outside.root, 'outside-env');
    write(target, 'TOKEN=synthetic-outside-secret\n');
    fs.symlinkSync(target, path.join(project.root, '.env'));
    expect(() => loadEnvDenylist([project.root], {
      environment: {}, minLength: 12, agentbootupRoot: null,
    })).toThrow();
  });

  test('refuses a symlinked configured project root', () => {
    const approvedParent = fixture();
    const outside = fixture();
    write(path.join(outside.root, '.env'), 'TOKEN=synthetic-outside-root-secret\n');
    const linkedRoot = path.join(approvedParent.root, 'approved-project');
    fs.symlinkSync(outside.root, linkedRoot);
    expect(() => loadEnvDenylist([linkedRoot], {
      environment: {}, minLength: 12, agentbootupRoot: null,
    })).toThrow('configured project root must contain only regular non-symlink directories');
  });

  test('refuses a configured project root with an intermediate symlink', () => {
    const approvedParent = fixture();
    const outside = fixture();
    const outsideProject = path.join(outside.root, 'project');
    fs.mkdirSync(outsideProject, { mode: 0o700 });
    write(path.join(outsideProject, '.env'), 'TOKEN=synthetic-intermediate-link-secret\n');
    const link = path.join(approvedParent.root, 'linked-parent');
    fs.symlinkSync(outside.root, link);
    expect(() => loadEnvDenylist([path.join(link, 'project')], {
      environment: {}, minLength: 12, agentbootupRoot: null,
    })).toThrow('configured project root must contain only regular non-symlink directories');
  });

  test('refuses a hard-linked project .env in sync and async loaders', async () => {
    const project = fixture();
    const outside = fixture();
    const outsideFile = path.join(outside.root, 'outside.env');
    write(outsideFile, 'TOKEN=synthetic-outside-hardlink-secret\n');
    fs.linkSync(outsideFile, path.join(project.root, '.env'));
    const options = { environment: {}, minLength: 12, agentbootupRoot: null };
    expect(() => loadEnvDenylist([project.root], options)).toThrow('must not be hard linked');
    await expect(loadEnvDenylistAsync([project.root], options)).rejects.toThrow('must not be hard linked');
  });

  test('allows a configured project root beneath a read-only shared-owner ancestor', async () => {
    const outer = fixture();
    const sharedAncestor = path.join(outer.root, 'shared');
    const projectRoot = path.join(sharedAncestor, 'project');
    fs.mkdirSync(projectRoot, { recursive: true, mode: 0o755 });
    fs.chmodSync(sharedAncestor, 0o755);
    write(path.join(projectRoot, '.env'), 'TOKEN=synthetic-shared-owner-secret\n');
    const foreignUid = (process.getuid?.() ?? 0) + 1;
    const fsImpl = Object.create(fs);
    fsImpl.lstatSync = (target) => {
      const stat = fs.lstatSync(target);
      return path.resolve(target) === sharedAncestor
        ? new Proxy(stat, { get: (object, property) => property === 'uid' ? foreignUid : object[property] })
        : stat;
    };
    const fspImpl = Object.create(fs.promises);
    fspImpl.lstat = async (target) => {
      const stat = await fs.promises.lstat(target);
      return path.resolve(target) === sharedAncestor
        ? new Proxy(stat, { get: (object, property) => property === 'uid' ? foreignUid : object[property] })
        : stat;
    };
    const options = { environment: {}, minLength: 12, agentbootupRoot: null };
    expect([...loadEnvDenylist([projectRoot], { ...options, fsImpl })]).toEqual([
      'synthetic-shared-owner-secret',
    ]);
    expect([...await loadEnvDenylistAsync([projectRoot], { ...options, fspImpl })]).toEqual([
      'synthetic-shared-owner-secret',
    ]);
  });

  test('fails closed on invalid UTF-8 in project .env and explicit history', () => {
    const project = fixture();
    fs.writeFileSync(path.join(project.root, '.env'), Buffer.from([0xff, 0xfe]));
    expect(() => loadEnvDenylist([project.root], {
      environment: {}, minLength: 12, agentbootupRoot: null,
    })).toThrow('valid UTF-8');
    fs.writeFileSync(project.explicitPath, Buffer.from([0xff, 0xfe]), { mode: 0o600 });
    expect(() => loadExplicitDenylist({ filePath: project.explicitPath })).toThrow('valid UTF-8');
  });

  test('bounds explicit history bytes before synchronous parsing', () => {
    const { explicitPath } = fixture();
    write(explicitPath, 'synthetic-oversized-history');
    expect(() => loadExplicitDenylist({ filePath: explicitPath, maxExplicitBytes: 8 })).toThrow(
      'AGENTBOOTUP_REDACT_DENYLIST_MAX_BYTES',
    );
  });

  test('requires an explicit regular 0600 file and ignores comments', () => {
    const { explicitPath } = fixture();
    write(explicitPath, '# retired value\nsynthetic-retired-value\nshort\n  whitespace-is-exact  \n');
    expect([...loadExplicitDenylist({ filePath: explicitPath })]).toEqual([
      'synthetic-retired-value', 'short', '  whitespace-is-exact  ',
    ]);
    fs.chmodSync(explicitPath, 0o644);
    expect(() => loadExplicitDenylist({ filePath: explicitPath, environment: {} })).toThrow('0600');
    fs.chmodSync(explicitPath, 0o400);
    expect(() => loadExplicitDenylist({ filePath: explicitPath, environment: {} })).toThrow('0600');
    fs.chmodSync(explicitPath, 0o700);
    expect(() => loadExplicitDenylist({ filePath: explicitPath, environment: {} })).toThrow('0600');
  });

  test('rejects explicit history under an insecure parent directory', () => {
    const { root, explicitPath } = fixture();
    write(explicitPath, 'synthetic-retired-value\n');
    fs.chmodSync(root, 0o755);
    expect(() => loadExplicitDenylist({ filePath: explicitPath })).toThrow('parent permissions');
  });

  test('rejects explicit history beneath a non-sticky writable ancestor', () => {
    const outer = fixture();
    const writableAncestor = path.join(outer.root, 'shared');
    const protectedParent = path.join(writableAncestor, 'agentbootup');
    fs.mkdirSync(writableAncestor, { mode: 0o770 });
    fs.chmodSync(writableAncestor, 0o770);
    fs.mkdirSync(protectedParent, { mode: 0o700 });
    const explicitPath = path.join(protectedParent, 'redact-denylist');
    write(explicitPath, 'synthetic-writable-ancestor-secret\n');
    expect(() => loadExplicitDenylist({ filePath: explicitPath })).toThrow(
      'ancestor must not be writable by group or other',
    );
  });

  test('rejects protected history owned by another account or carrying an ACL', () => {
    const { root, explicitPath } = fixture();
    write(explicitPath, 'synthetic-owner-only-secret\n');
    const uid = fs.statSync(explicitPath).uid;
    expect(() => loadExplicitDenylist({ filePath: explicitPath, expectedUid: uid + 1 })).toThrow(
      'owned by the current operating account',
    );
    const aclInspector = (_command, _args, _options) => ({
      status: 0, error: null, stdout: '-rw-------+ 1 owner group 1 Jul 31 00:00 protected\n', stderr: '',
    });
    expect(() => loadExplicitDenylist({
      filePath: explicitPath, expectedUid: uid, spawnSyncImpl: aclInspector,
    })).toThrow('extended ACL');
    expect(() => loadExplicitDenylist({
      filePath: explicitPath, expectedUid: uid, existsSyncImpl: () => false,
    })).toThrow('ACL validation tool is unavailable');
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  });

  test('fails closed on Windows until owner-only ACL validation exists', () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-windows-secret\n');
    write(explicitPath, 'synthetic-windows-acl-secret\n');
    expect(() => loadEnvDenylist([root], { platform: 'win32', agentbootupRoot: null })).toThrow(
      'unsupported on Windows',
    );
    expect(() => loadExplicitDenylist({ filePath: explicitPath, platform: 'win32' })).toThrow(
      'unsupported on Windows',
    );
  });

  test('async explicit loader fails closed on Windows before missing-parent handling', async () => {
    const { root } = fixture();
    const missingPath = path.join(root, 'missing-parent', 'redact-denylist');
    await expect(loadExplicitDenylistAsync({ filePath: missingPath, platform: 'win32' })).rejects.toThrow(
      'unsupported on Windows',
    );
    expect(fs.existsSync(path.dirname(missingPath))).toBe(false);
  });

  test('round-trips multiline rotated values through tagged explicit history', () => {
    const { explicitPath } = fixture();
    const multiline = 'synthetic-line-one\nsynthetic-line-two\n';
    write(explicitPath, `${encodeExplicitDenylistRecord(multiline)}\n`);
    expect(loadExplicitDenylist({ filePath: explicitPath })).toEqual(new Set([multiline]));
    write(explicitPath, 'base64-v1:not-canonical***\n');
    expect(loadExplicitDenylist({ filePath: explicitPath })).toEqual(new Set(['base64-v1:not-canonical***']));
  });

  test('preserves unframed literals that collide with the tagged prefix', () => {
    const { explicitPath } = fixture();
    const literal = 'base64-v1:c3ludGhldGljLXNlY3JldA==';
    write(explicitPath, `${literal}\n`);
    expect(loadExplicitDenylist({ filePath: explicitPath })).toEqual(new Set([literal]));
    const malformedLiteral = 'base64-v1:not-canonical***';
    write(explicitPath, `${encodeExplicitDenylistRecord(malformedLiteral)}\n`);
    expect(loadExplicitDenylist({ filePath: explicitPath }).has(malformedLiteral)).toBe(true);
  });

  test('counts one framed history record as one source value', () => {
    const { explicitPath } = fixture();
    const value = 'synthetic-single-source-secret';
    write(explicitPath, `${encodeExplicitDenylistRecord(value)}\n`);
    const result = buildDenylist([], {
      filePath: explicitPath, environment: {}, maxSourceValues: 1, agentbootupRoot: null,
    });
    expect(result.state).toBe('loaded');
    expect(result.values).toEqual(new Set([value]));
  });

  test('rejects explicit denylist symlinks', () => {
    const { root, explicitPath } = fixture();
    const target = path.join(root, 'target');
    write(target, 'synthetic-retired-value\n');
    fs.symlinkSync(target, explicitPath);
    expect(() => loadExplicitDenylist({ filePath: explicitPath })).toThrow();
  });

  test('rejects a hard-linked explicit denylist', () => {
    const source = fixture();
    const target = fixture();
    write(source.explicitPath, 'synthetic-hard-linked-history\n');
    fs.linkSync(source.explicitPath, target.explicitPath);
    expect(() => loadExplicitDenylist({ filePath: target.explicitPath })).toThrow('must not be hard linked');
  });

  test('waits for a locked writer instead of ingesting its partial record', async () => {
    const { explicitPath } = fixture();
    const value = 'synthetic-locked-writer-secret';
    const record = encodeExplicitDenylistRecord(value);
    const lockModule = pathToFileURL(path.resolve(import.meta.dir, '../util/file-lock.js')).href;
    const child = spawn('node', ['--input-type=module', '-e', `
      import fsp from 'node:fs/promises';
      import { withFileLock } from ${JSON.stringify(lockModule)};
      const [target, record] = process.argv.slice(1);
      await withFileLock(target, async () => {
        await fsp.writeFile(target, record.split('\\n')[0] + '\\nbase64-v1:', { mode: 0o600 });
        process.stdout.write('locked\\n');
        await new Promise((resolve) => setTimeout(resolve, 120));
        await fsp.writeFile(target, record + '\\n', { mode: 0o600 });
      });
    `, explicitPath, record], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { if (chunk.includes('locked')) resolve(); });
      child.on('error', reject);
    });
    const started = Date.now();
    const loaded = loadExplicitDenylist({ filePath: explicitPath });
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    expect(loaded.has(value)).toBe(true);
    const status = await new Promise((resolve) => child.on('close', resolve));
    expect(status).toBe(0);
  });

  test('separates source values from uncapped derived variants and preserves category metadata', () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic/env?secret\n');
    write(explicitPath, 'synthetic-retired-secret\n');
    const result = buildDenylist([root], { filePath: explicitPath, environment: {}, maxSourceValues: 2, agentbootupRoot: null });
    expect(result.state).toBe('loaded');
    expect(result.values.size).toBe(2);
    expect(result.derivedValues.size).toBeGreaterThanOrEqual(2);
    expect(result.sourceMap.get('synthetic/env?secret')).toBe('env');
    expect(result.sourceMap.get('synthetic-retired-secret')).toBe('denylist');
    expect(result.derivedSourceMap.get(Buffer.from('synthetic/env?secret').toString('base64'))).toBe('env');
    expect(result.derivedSourceMap.get('synthetic%2Fenv%3Fsecret')).toBe('env');
  });

  test('source cap fails closed while derived values do not consume the cap', () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'A=synthetic-value-one\nB=synthetic-value-two\n');
    write(explicitPath, 'synthetic-value-three\n');
    expect(() => buildDenylist([root], { filePath: explicitPath, environment: {}, maxSourceValues: 2, agentbootupRoot: null }))
      .toThrow('cap exceeded');
    expect(buildDenylist([root], { filePath: explicitPath, environment: {}, maxSourceValues: 3, agentbootupRoot: null }).values.size).toBe(3);
  });

  test('a legitimately empty configuration is distinct from failure', () => {
    const { root, explicitPath } = fixture();
    expect(buildDenylist([root], { filePath: explicitPath, environment: {}, agentbootupRoot: null }).state).toBe('empty-by-config');
  });

  test('always includes the configured agentbootup repository root', () => {
    const project = fixture();
    const agentbootup = fixture();
    write(path.join(project.root, '.env'), 'PROJECT=synthetic-project-secret\n');
    write(path.join(agentbootup.root, '.env'), 'BOOTUP=synthetic-bootup-secret\n');
    const values = loadEnvDenylist([project.root], { environment: {}, agentbootupRoot: agentbootup.root });
    expect([...values].sort()).toEqual(['synthetic-bootup-secret', 'synthetic-project-secret']);
  });

  test('loads env secrets from a tilde-expanded routing project root', async () => {
    const { root } = fixture();
    const syntheticHome = path.join(root, 'home');
    const projectRoot = path.join(syntheticHome, 'project');
    fs.mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
    write(path.join(projectRoot, '.env'), 'TOKEN=synthetic-tilde-project-secret\n');
    const normalizedRoot = normalizeProjectPath('~/project', { homeDir: syntheticHome });
    const manager = createDenylistManager({
      projectRoots: [normalizedRoot], agentbootupRoot: null,
      filePath: path.join(root, 'redact-denylist'), environment: {}, manageProcessSignals: false,
    });
    try {
      const snapshot = await manager.start();
      expect(snapshot.state).toBe('loaded');
      expect(snapshot.values.has('synthetic-tilde-project-secret')).toBe(true);
    } finally {
      manager.stop();
    }
  });
});

describe('denylist manager lifecycle', () => {
  test('keeps last known good on recoverable reload failure and snapshots are read-only', async () => {
    const { root, explicitPath } = fixture();
    const secret = 'synthetic-manager-secret';
    write(path.join(root, '.env'), `TOKEN=${secret}\n`);
    const logs = [];
    const manager = createDenylistManager({ projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null, logger: (entry) => logs.push(entry) });
    expect((await manager.reload()).state).toBe('loaded');
    const snapshot = manager.snapshot();
    expect(() => snapshot.values.clear()).toThrow('read-only');
    expect(() => snapshot.values.add('synthetic-injected-secret')).toThrow('read-only');
    expect(() => snapshot.sourceMap.set('synthetic-injected-secret', 'env')).toThrow('read-only');
    expect(() => snapshot.values.forEach((_value, _again, collection) => collection.clear())).toThrow('read-only');
    expect(() => snapshot.values.valueOf().clear()).toThrow('read-only');
    expect(() => { snapshot.state = 'failed'; }).toThrow();
    expect(() => { snapshot.health.redaction_denylist_stale = false; }).toThrow();
    expect(snapshot.state).toBe('loaded');
    expect(manager.snapshot().values.has(secret)).toBe(true);
    write(path.join(root, '.env'), 'BROKEN="unterminated\n');
    const stale = await manager.reload();
    expect(stale.state).toBe('loaded');
    expect(stale.values.has(secret)).toBe(true);
    expect(stale.health.redaction_denylist_stale).toBe(true);
    expect(manager.isUsable()).toBe(false);
    expect(manager.isSnapshotCurrent(snapshot)).toBe(false);
    expect(JSON.stringify(logs)).not.toContain(secret);
    manager.stop();
    expect(manager.health().denylist_size).toBe(0);
  });

  test('a successful load followed by source-cap overflow becomes globally blockable', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-overflow-env-secret\n');
    write(explicitPath, 'synthetic-overflow-history-one\n');
    const managerOptions = {
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      maxSourceValues: 2,
    };
    const manager = createDenylistManager(managerOptions);
    const loaded = await manager.reload();
    expect(loaded.state).toBe('loaded');
    expect(manager.isSnapshotCurrent(loaded)).toBe(true);
    write(explicitPath, 'synthetic-overflow-history-one\nsynthetic-overflow-history-two\n');
    const blocked = await manager.reload();
    expect(blocked.state).toBe('failed');
    expect(blocked.errorCode).toBe('redaction_denylist_overflow');
    expect(blocked.health.redaction_denylist_overflow).toBe(true);
    expect(blocked.health.redaction_denylist_file_too_large).toBe(false);
    expect(blocked.values.size).toBe(0);
    expect(manager.isSnapshotCurrent(loaded)).toBe(false);
    fs.writeFileSync(explicitPath, Buffer.from([0xff, 0xfe]), { mode: 0o600 });
    const stillBlocked = await manager.reload();
    expect(stillBlocked.state).toBe('failed');
    expect(stillBlocked.errorCode).toBe('redaction_denylist_overflow');
    expect(stillBlocked.values.size).toBe(0);
    managerOptions.maxSourceValues = 3;
    write(explicitPath, '');
    const recovered = await manager.reload();
    expect(recovered.state).toBe('loaded');
    expect(recovered.values.has('synthetic-overflow-history-one')).toBe(true);
    expect(recovered.values.has('synthetic-overflow-history-two')).toBe(true);
    manager.stop();
  });

  test('a byte-cap breach stays globally blocked until a complete reload succeeds', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-byte-cap-env-secret\n');
    write(explicitPath, 'synthetic-byte-cap-history\n');
    const managerOptions = {
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      maxExplicitBytes: 64,
    };
    const manager = createDenylistManager(managerOptions);
    expect((await manager.reload()).state).toBe('loaded');

    managerOptions.maxExplicitBytes = 8;
    const blocked = await manager.reload();
    expect(blocked.state).toBe('failed');
    expect(blocked.errorCode).toBe('redaction_denylist_file_too_large');
    expect(blocked.health.redaction_denylist_overflow).toBe(false);
    expect(blocked.health.redaction_denylist_file_too_large).toBe(true);
    expect(blocked.values.size).toBe(0);

    managerOptions.maxExplicitBytes = 64;
    write(path.join(root, '.env'), 'BROKEN="unterminated\n');
    const stillBlocked = await manager.reload();
    expect(stillBlocked.state).toBe('failed');
    expect(stillBlocked.errorCode).toBe('redaction_denylist_file_too_large');
    expect(stillBlocked.health.redaction_denylist_overflow).toBe(false);
    expect(stillBlocked.health.redaction_denylist_file_too_large).toBe(true);

    write(path.join(root, '.env'), 'TOKEN=synthetic-byte-cap-env-secret\n');
    const recovered = await manager.reload();
    expect(recovered.state).toBe('loaded');
    expect(recovered.health.redaction_denylist_overflow).toBe(false);
    expect(recovered.health.redaction_denylist_file_too_large).toBe(false);
    expect(recovered.values.has('synthetic-byte-cap-history')).toBe(true);
    manager.stop();
  });

  test('corrupted tagged history blocks after a last-known-good until repaired', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-tagged-history-env-secret\n');
    const validRecord = encodeExplicitDenylistRecord('synthetic-retired-tagged-secret');
    write(explicitPath, `${validRecord}\n`);
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
    });
    expect((await manager.reload()).state).toBe('loaded');
    write(explicitPath, `${validRecord.split('\n')[0]}\nbase64-v1:truncated***\n`);
    const blocked = await manager.reload();
    expect(blocked.state).toBe('failed');
    expect(blocked.errorCode).toBe('redaction_denylist_record_invalid');
    expect(blocked.values.size).toBe(0);
    write(explicitPath, `${validRecord}\n`);
    expect((await manager.reload()).state).toBe('loaded');
    manager.stop();
  });

  test('initial loader failure is discriminated and globally blockable', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'BROKEN="unterminated\n');
    const manager = createDenylistManager({ projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null });
    const result = await manager.reload();
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('redaction_denylist_load_failed');
    expect(result.values.size).toBe(0);
    manager.stop();
  });

  test('async manager treats a never-created explicit parent as empty-by-config', async () => {
    const { root } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-fresh-host-secret\n');
    const missingParent = path.join(root, 'not-created-agentbootup');
    const explicitPath = path.join(missingParent, 'redact-denylist');
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
    });
    const result = await manager.reload();
    expect(result.state).toBe('loaded');
    expect(result.values.has('synthetic-fresh-host-secret')).toBe(true);
    expect(fs.existsSync(missingParent)).toBe(false);
    manager.stop();
  });

  test('daemon-owned reload refresh installs the explicit watcher after its parent is created', async () => {
    const { root } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-late-watcher-secret\n');
    const missingParent = path.join(root, 'late-agentbootup');
    const explicitPath = path.join(missingParent, 'redact-denylist');
    const watchedTargets = [];
    const fsImpl = Object.create(fs);
    fsImpl.watch = (target) => {
      if (!fs.existsSync(target)) {
        const error = new Error('missing watch target');
        error.code = 'ENOENT';
        throw error;
      }
      watchedTargets.push(target);
      return { close() {} };
    };
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      fsImpl, processImpl: new EventEmitter(), pollMs: 60_000, debounceMs: 5,
    });
    await manager.start();
    expect(watchedTargets).not.toContain(missingParent);
    fs.mkdirSync(missingParent, { mode: 0o700 });
    await manager.reloadAndRefreshWatchers();
    expect(watchedTargets.filter((target) => target === missingParent)).toHaveLength(1);
    manager.stop();
  });

  test('rebuild replaces and clears old internal collections without mutating a prior snapshot', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-before-secret\n');
    const retireEvents = [];
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      onCollectionsRetired: (event) => retireEvents.push(event),
    });
    await manager.reload();
    const before = manager.snapshot();
    write(path.join(root, '.env'), 'TOKEN=synthetic-after-secret\n');
    const after = await manager.reload();
    expect(before.values.has('synthetic-before-secret')).toBe(true);
    expect(after.values.has('synthetic-before-secret')).toBe(false);
    expect(after.values.has('synthetic-after-secret')).toBe(true);
    expect(retireEvents).toContainEqual({ allCleared: true });
    manager.stop();
  });

  test('explicit retired-secret history is monotonic for the daemon lifetime', async () => {
    const { root, explicitPath } = fixture();
    write(explicitPath, 'synthetic-retired-history\n');
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
    });
    expect((await manager.reload()).values.has('synthetic-retired-history')).toBe(true);
    write(explicitPath, '');
    const afterTruncate = await manager.reload();
    expect(afterTruncate.state).toBe('loaded');
    expect(afterTruncate.values.has('synthetic-retired-history')).toBe(true);
    manager.stop();
  });

  test('manager preserves one source-cap slot for a tagged record across reloads', async () => {
    const { root, explicitPath } = fixture();
    const value = 'synthetic-manager-tagged-secret';
    write(explicitPath, `${encodeExplicitDenylistRecord(value)}\n`);
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      maxSourceValues: 1, pollMs: 60_000, debounceMs: 2_000,
    });
    try {
      const first = await manager.start();
      expect(first.state).toBe('loaded');
      expect(first.values.has(value)).toBe(true);
      expect(manager.health().denylist_size).toBe(1);
      expect((await manager.reload()).state).toBe('loaded');
    } finally {
      manager.stop();
    }
  });

  test('manager can restart cleanly after stop', async () => {
    const { root, explicitPath } = fixture();
    write(explicitPath, 'synthetic-before-manager-restart\n');
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      processImpl: new EventEmitter(), pollMs: 60_000, debounceMs: 2_000,
    });
    expect((await manager.start()).values.has('synthetic-before-manager-restart')).toBe(true);
    manager.stop();
    write(explicitPath, 'synthetic-after-manager-restart\n');
    expect((await manager.start()).values.has('synthetic-after-manager-restart')).toBe(true);
    expect(manager.snapshot().values.has('synthetic-before-manager-restart')).toBe(false);
    manager.stop();
  });

  test('manager reload lock contention does not block the daemon event loop', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-nonblocking-reload-secret\n');
    let releaseHolder;
    let reportEntered;
    const entered = new Promise((resolve) => { reportEntered = resolve; });
    const release = new Promise((resolve) => { releaseHolder = resolve; });
    const holder = withFileLock(explicitPath, async () => {
      reportEntered();
      await release;
    }, REDACT_DENYLIST_LOCK_OPTIONS);
    await entered;
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
    });
    const pendingReload = manager.reload();
    let timerFired = false;
    await new Promise((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 25));
    expect(timerFired).toBe(true);
    expect(manager.snapshot().state).toBe('failed');
    releaseHolder();
    await holder;
    expect((await pendingReload).state).toBe('loaded');
    manager.stop();
  });

  test('slow asynchronous ACL inspection does not block the daemon event loop', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-slow-acl-secret\n');
    write(explicitPath, 'synthetic-slow-acl-history\n');
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      execFileAsyncImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { stdout: '-rw------- 1 owner group 1 Jul 31 00:00 protected\n', stderr: '' };
      },
    });
    const pendingReload = manager.reload();
    let timerFired = false;
    await new Promise((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 10));
    expect(timerFired).toBe(true);
    expect(manager.snapshot().state).toBe('failed');
    expect((await pendingReload).state).toBe('loaded');
    manager.stop();
  });

  test('stop during a lock-contended start cannot resurrect manager resources', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-aborted-start-secret\n');
    let releaseHolder;
    let reportEntered;
    const entered = new Promise((resolve) => { reportEntered = resolve; });
    const release = new Promise((resolve) => { releaseHolder = resolve; });
    const holder = withFileLock(explicitPath, async () => {
      reportEntered();
      await release;
    }, REDACT_DENYLIST_LOCK_OPTIONS);
    await entered;
    const signals = new EventEmitter();
    let watchCount = 0;
    const fsImpl = Object.create(fs);
    fsImpl.watch = () => { watchCount += 1; return { close() {} }; };
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      fsImpl, processImpl: signals,
    });
    const pendingStart = manager.start();
    manager.stop();
    releaseHolder();
    await holder;
    await pendingStart;
    expect(manager.snapshot().state).toBe('failed');
    expect(manager.health().denylist_size).toBe(0);
    expect(watchCount).toBe(0);
    expect(signals.listenerCount('SIGHUP')).toBe(0);
  });

  test('stop after the initial generation gate prevents a successful reload from publishing', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-cancel-before-publish-secret\n');
    const managerOptions = {
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
    };
    let manager;
    Object.defineProperty(managerOptions, 'maxSourceValues', {
      enumerable: false,
      get() {
        manager.stop();
        return 500;
      },
    });
    manager = createDenylistManager(managerOptions);
    const result = await manager.reload();
    expect(result.state).toBe('failed');
    expect(result.values.size).toBe(0);
    expect(manager.health().denylist_size).toBe(0);
  });

  test('concurrent starts share one lifecycle and install one resource set', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-concurrent-start-secret\n');
    const signals = new EventEmitter();
    let watchCount = 0;
    const fsImpl = Object.create(fs);
    fsImpl.watch = () => { watchCount += 1; return { close() {} }; };
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      fsImpl, processImpl: signals,
    });
    const [first, second] = await Promise.all([manager.start(), manager.start()]);
    expect(first.state).toBe('loaded');
    expect(second.state).toBe('loaded');
    expect(watchCount).toBe(2);
    expect(signals.listenerCount('SIGHUP')).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    manager.stop();
  });

  test('allows an owning daemon to manage process signals without duplicate listeners', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-daemon-owned-signal-secret\n');
    const signals = new EventEmitter();
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      processImpl: signals, manageProcessSignals: false,
    });
    expect(manager.isUsable()).toBe(false);
    expect((await manager.start()).state).toBe('loaded');
    expect(manager.isUsable()).toBe(true);
    expect(signals.listenerCount('SIGHUP')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    manager.stop();
    expect(manager.isUsable()).toBe(false);
  });

  test('invalidates captured snapshots after a successful reload or stop', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-revision-before\n');
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
    });
    const first = await manager.start();
    expect(manager.isSnapshotCurrent(first)).toBe(true);

    write(path.join(root, '.env'), 'TOKEN=synthetic-revision-after\n');
    const second = await manager.reload();
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(manager.isSnapshotCurrent(first)).toBe(false);
    expect(manager.isSnapshotCurrent(second)).toBe(true);

    manager.stop();
    expect(manager.isSnapshotCurrent(second)).toBe(false);
  });

  test('watch debounce and SIGHUP each rebuild without polling masking the watcher', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-watch-before\n');
    const callbacks = [];
    const fsImpl = Object.create(fs);
    fsImpl.watch = (_target, callback) => {
      callbacks.push(callback);
      return { close() {} };
    };
    const signals = new EventEmitter();
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      fsImpl, processImpl: signals, debounceMs: 5, pollMs: 1_000,
    });
    await manager.start();
    write(path.join(root, '.env'), 'TOKEN=synthetic-watch-after\n');
    callbacks[0]('change', '.env');
    await waitFor(() => manager.snapshot().values.has('synthetic-watch-after'));
    expect(manager.snapshot().values.has('synthetic-watch-after')).toBe(true);

    write(explicitPath, 'synthetic-explicit-watch\n');
    callbacks[1]('change', path.basename(explicitPath));
    await waitFor(() => manager.snapshot().values.has('synthetic-explicit-watch'));
    expect(manager.snapshot().values.has('synthetic-explicit-watch')).toBe(true);

    signals.emit('SIGHUP');
    await manager.reload();
    expect(manager.snapshot().state).toBe('loaded');
    expect(manager.health()).toEqual({
      denylist_size: 2,
      redaction_denylist_stale: false,
      redaction_denylist_overflow: false,
      redaction_denylist_file_too_large: false,
    });
    manager.stop();
  });

  test('polling rebuilds without a watcher event', async () => {
    const { root, explicitPath } = fixture();
    write(path.join(root, '.env'), 'TOKEN=synthetic-poll-before\n');
    const fsImpl = Object.create(fs);
    fsImpl.watch = () => ({ close() {} });
    const manager = createDenylistManager({
      projectRoots: [root], filePath: explicitPath, environment: {}, agentbootupRoot: null,
      fsImpl, processImpl: new EventEmitter(), debounceMs: 5, pollMs: 10,
    });
    await manager.start();
    write(path.join(root, '.env'), 'TOKEN=synthetic-poll-after\n');
    await waitFor(() => manager.snapshot().values.has('synthetic-poll-after'));
    expect(manager.snapshot().values.has('synthetic-poll-after')).toBe(true);
    manager.stop();
  });
});
