import { expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  __withBrainBackupSelectionIdentityReadTestHook,
  assertBrainBackupSelectionReady,
  resolveBrainBackupSelection,
} from '../lib/memory/brain-backup-selection.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-backup-selection-'));
  fs.mkdirSync(path.join(root, 'memory', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agentbootup.json'), '{"agent_id":"decisive"}\n');
  return root;
}

function writeManifest(root: string, include: Array<{ path: string; class: string }>) {
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'decisive',
    include,
  }, null, 2));
}

test('missing manifest reports unselected binary types without content fingerprints', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), '# memory\n');
  for (const name of ['notes.docx', 'sheet.xlsx', 'voice.m4a']) {
    fs.writeFileSync(path.join(root, 'memory', name), Buffer.from([0, 1, 2]));
  }

  const result = resolveBrainBackupSelection(root);
  expect(result.state).toBe('MISSING_MANIFEST');
  expect(result.selected).toEqual([]);
  expect(result.records.map((record) => [record.path, record.status])).toEqual([
    ['memory/MEMORY.md', 'UNSELECTED'],
    ['memory/notes.docx', 'UNSELECTED'],
    ['memory/sheet.xlsx', 'UNSELECTED'],
    ['memory/voice.m4a', 'UNSELECTED'],
  ]);
  for (const record of result.records) {
    expect(record).not.toHaveProperty('sha256');
    expect(record).not.toHaveProperty('size');
  }
  expect(() => assertBrainBackupSelectionReady(result, 'memory snapshot')).toThrow(/brain-backup\.json.*proposal/i);
});

test('positive selection returns exact hashes and sizes for arbitrary binary types', () => {
  const root = fixture();
  const binaries = new Map([
    ['document.docx', Buffer.from([0, 255, 10, 20, 30])],
    ['sheet.xlsx', Buffer.from([7, 6, 5, 4])],
    ['voice.m4a', Buffer.from([128, 0, 64])],
  ]);
  for (const [name, bytes] of binaries) {
    fs.writeFileSync(path.join(root, 'memory', name), bytes);
  }
  writeManifest(root, [...binaries.keys()].map((name) => ({
    path: `memory/${name}`,
    class: 'attachment',
  })));

  const result = resolveBrainBackupSelection(root);
  expect(result.state).toBe('READY');
  for (const record of result.selected) {
    const bytes = binaries.get(path.basename(record.path))!;
    expect(record.size).toBe(bytes.length);
    expect(record.sha256).toBe(`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`);
    expect(fs.readFileSync(path.join(root, record.path))).toEqual(bytes);
  }
});

test('selected canonical pages include MEMORY.md, SCHEMA.md, wiki manifest, and nested markdown', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'memory', 'wiki', 'nested'), { recursive: true });
  for (const relative of ['MEMORY.md', 'SCHEMA.md', 'wiki-manifest.json', 'wiki/index.md', 'wiki/nested/page.md']) {
    fs.writeFileSync(path.join(root, 'memory', relative), `${relative}\n`);
  }
  writeManifest(root, [
    { path: 'memory/MEMORY.md', class: 'canonical' },
    { path: 'memory/SCHEMA.md', class: 'canonical' },
    { path: 'memory/wiki-manifest.json', class: 'configuration' },
    { path: 'memory/wiki/**', class: 'canonical' },
  ]);

  expect(resolveBrainBackupSelection(root).selected.map((record) => record.path)).toEqual([
    'memory/MEMORY.md',
    'memory/SCHEMA.md',
    'memory/wiki-manifest.json',
    'memory/wiki/index.md',
    'memory/wiki/nested/page.md',
  ]);
});

test('glob ** matches zero and multiple path segments', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'memory', 'one', 'two'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), 'root\n');
  fs.writeFileSync(path.join(root, 'memory', 'one', 'MEMORY.md'), 'one\n');
  fs.writeFileSync(path.join(root, 'memory', 'one', 'two', 'MEMORY.md'), 'two\n');
  fs.writeFileSync(path.join(root, 'memory', 'one', 'two', 'other.md'), 'other\n');
  writeManifest(root, [{ path: 'memory/**/MEMORY.md', class: 'canonical' }]);

  const result = resolveBrainBackupSelection(root);
  expect(result.selected.map((record) => record.path)).toEqual([
    'memory/MEMORY.md',
    'memory/one/MEMORY.md',
    'memory/one/two/MEMORY.md',
  ]);
  expect(result.unselected.map((record) => record.path)).toEqual(['memory/one/two/other.md']);
});

test('unselected secret-shaped files remain unselected and do not block publication', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), '# memory\n');
  fs.writeFileSync(path.join(root, 'memory', 'api-secret.md'), 'not inspected\n');
  writeManifest(root, [{ path: 'memory/MEMORY.md', class: 'canonical' }]);
  fs.writeFileSync(path.join(root, '.brainignore'), 'memory/api-secret.md\n');

  const result = resolveBrainBackupSelection(root);
  expect(result.state).toBe('READY');
  expect(result.secretBlocked).toEqual([]);
  expect(result.unselected).toEqual([{ path: 'memory/api-secret.md', status: 'UNSELECTED' }]);
  expect(assertBrainBackupSelectionReady(result, 'brain push')).toBe(result);
});

test('unselected and ignored unreadable files are not read or fingerprinted', () => {
  const root = fixture();
  const selectedPath = path.join(root, 'memory', 'MEMORY.md');
  const unselectedPath = path.join(root, 'memory', 'unselected.docx');
  const ignoredPath = path.join(root, 'memory', 'ignored.xlsx');
  fs.writeFileSync(selectedPath, '# memory\n');
  fs.writeFileSync(unselectedPath, Buffer.from([1, 2, 3]));
  fs.writeFileSync(ignoredPath, Buffer.from([4, 5, 6]));
  fs.chmodSync(unselectedPath, 0o000);
  fs.chmodSync(ignoredPath, 0o000);
  writeManifest(root, [
    { path: 'memory/MEMORY.md', class: 'canonical' },
    { path: 'memory/ignored.xlsx', class: 'attachment' },
  ]);
  fs.writeFileSync(path.join(root, '.brainignore'), 'memory/ignored.xlsx\n');

  try {
    const result = resolveBrainBackupSelection(root);
    expect(result.unselected).toEqual([{ path: 'memory/unselected.docx', status: 'UNSELECTED' }]);
    expect(result.ignored).toEqual([{
      path: 'memory/ignored.xlsx',
      status: 'IGNORED',
      class: 'attachment',
      selector: 'memory/ignored.xlsx',
    }]);
  } finally {
    fs.chmodSync(unselectedPath, 0o600);
    fs.chmodSync(ignoredPath, 0o600);
  }
});

test('.brainignore is deny-only and secret blocking overrides ignore for selected paths', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), '# memory\n');
  fs.writeFileSync(path.join(root, 'memory', 'daily', 'ignored.md'), 'ignored\n');
  fs.writeFileSync(path.join(root, 'memory', 'daily', 'api-secret.md'), 'secret\n');
  writeManifest(root, [{ path: 'memory/**', class: 'canonical' }]);
  fs.writeFileSync(path.join(root, '.brainignore'), '# local deny\nmemory/daily/**\n');

  const result = resolveBrainBackupSelection(root);
  expect(result.selected.map((record) => record.path)).toEqual(['memory/MEMORY.md']);
  expect(result.ignored).toEqual([{
    path: 'memory/daily/ignored.md',
    status: 'IGNORED',
    class: 'canonical',
    selector: 'memory/**',
  }]);
  expect(result.secretBlocked.map((record) => record.path)).toEqual(['memory/daily/api-secret.md']);
  expect(result.ignored[0]).not.toHaveProperty('sha256');
  expect(result.secretBlocked[0]).not.toHaveProperty('sha256');
  expect(() => assertBrainBackupSelectionReady(result, 'brain push')).toThrow(
    /memory\/daily\/api-secret\.md.*remove the matching selector.*encrypted secret store/i,
  );
});

test('.brainignore negation is rejected and cannot re-include a path', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), '# memory\n');
  writeManifest(root, [{ path: 'memory/**', class: 'canonical' }]);
  fs.writeFileSync(path.join(root, '.brainignore'), 'memory/**\n!memory/MEMORY.md\n');
  expect(() => resolveBrainBackupSelection(root)).toThrow(/negation.*not allowed/i);
});

test.each([
  '../memory/MEMORY.md',
  '/memory/MEMORY.md',
  'memory\\MEMORY.md',
  'memory//MEMORY.md',
  'memory/./MEMORY.md',
  '!memory/MEMORY.md',
])('unsafe selector %s fails closed', (selector) => {
  const root = fixture();
  writeManifest(root, [{ path: selector, class: 'canonical' }]);
  expect(() => resolveBrainBackupSelection(root)).toThrow(/selector path/i);
});

test.each([
  [{}, /schema/i],
  [{ schema: 'brain-backup/1', brain_id: 7, include: [] }, /brain_id/i],
  [{ schema: 'brain-backup/1', brain_id: 'decisive', include: null }, /include array/i],
  [{ schema: 'brain-backup/1', brain_id: 'decisive', include: ['memory/MEMORY.md'] }, /include\[0\].*object/i],
  [{ schema: 'brain-backup/1', brain_id: 'decisive', include: [{ path: 7, class: 'canonical' }] }, /selector path/i],
  [{ schema: 'brain-backup/1', brain_id: 'decisive', include: [{ path: 'memory/MEMORY.md', class: 7 }] }, /class/i],
  [{ schema: 'brain-backup/1', brain_id: 'decisive', include: [], extra: true }, /unsupported field "extra"/i],
  [{
    schema: 'brain-backup/1',
    brain_id: 'decisive',
    include: [{ path: 'memory/MEMORY.md', class: 'canonical', extra: true }],
  }, /include\[0\].*unsupported field "extra"/i],
])('malformed manifest fields and types fail closed: %j', (manifest, expected) => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify(manifest));
  expect(() => resolveBrainBackupSelection(root)).toThrow(expected);
});

test('duplicate selectors and empty selection are explicit failures', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), '# memory\n');
  writeManifest(root, [
    { path: 'memory/MEMORY.md', class: 'canonical' },
    { path: 'memory/MEMORY.md', class: 'attachment' },
  ]);
  expect(() => resolveBrainBackupSelection(root)).toThrow(/duplicate selector/i);

  writeManifest(root, []);
  const empty = resolveBrainBackupSelection(root);
  expect(empty.state).toBe('EMPTY_SELECTION');
  expect(() => assertBrainBackupSelectionReady(empty)).toThrow(/non-empty brain-backup\.json include policy/i);
});

test('selector wildcard count is bounded before matching inventory paths', () => {
  const root = fixture();
  writeManifest(root, [{ path: `memory/${'*'.repeat(65)}.md`, class: 'canonical' }]);
  expect(() => resolveBrainBackupSelection(root)).toThrow(/exceeds 64 wildcard characters/);
});

test('manifest brain_id must use the canonical project identifier grammar', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'agentbootup.json'), JSON.stringify({ agent_id: '../../unsafe' }));
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: '../../unsafe',
    include: [{ path: 'memory/MEMORY.md', class: 'canonical' }],
  }));
  expect(() => resolveBrainBackupSelection(root)).toThrow(/not a valid project brain identifier/);
});

test.each(['brain-backup.json', '.brainignore'])('%s policy symlink fails closed', (policyName) => {
  const root = fixture();
  const target = path.join(root, `${policyName}.target`);
  if (policyName === 'brain-backup.json') {
    fs.writeFileSync(target, JSON.stringify({
      schema: 'brain-backup/1',
      brain_id: 'decisive',
      include: [],
    }));
  } else {
    fs.writeFileSync(target, 'memory/**\n');
  }
  fs.symlinkSync(target, path.join(root, policyName));
  expect(() => resolveBrainBackupSelection(root)).toThrow(/non-symlink/i);
});

test('memory symlinks fail closed before selection', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), '# memory\n');
  writeManifest(root, [{ path: 'memory/**', class: 'canonical' }]);
  fs.symlinkSync(path.join(root, 'memory', 'MEMORY.md'), path.join(root, 'memory', 'linked.md'));
  expect(() => resolveBrainBackupSelection(root)).toThrow(/symlink/i);
});

test('identity-read test seam executes only in an explicitly allowed test session', () => {
  const root = fixture();
  const selectedPath = path.join(root, 'memory', 'MEMORY.md');
  fs.writeFileSync(selectedPath, '# memory\n');
  writeManifest(root, [{ path: 'memory/MEMORY.md', class: 'canonical' }]);

  let executed = false;
  const selection = __withBrainBackupSelectionIdentityReadTestHook({
    kind: 'selected',
    phase: 'afterRead',
    path: selectedPath,
    run: () => {
      executed = true;
    },
  }, () => resolveBrainBackupSelection(root));

  expect(executed).toBe(true);
  expect(selection.selected.map((record) => record.path)).toEqual(['memory/MEMORY.md']);
});

test('production rejects the test seam and selected same-inode rewrites are never hashed', () => {
  const productionProbe = spawnSync(process.execPath, ['-e', `
    import { __withBrainBackupSelectionIdentityReadTestHook as withHook }
      from './lib/memory/brain-backup-selection.js';
    try {
      withHook(
        { kind: 'policy', phase: 'beforeOpen', path: '/unused', run() {} },
        () => {},
      );
      process.exit(2);
    } catch (error) {
      if (!String(error?.message).includes(
        'requires NODE_ENV=test and AGENTBOOTUP_ALLOW_TEST_SESSION=1'
      )) throw error;
    }
  `], {
    cwd: path.resolve(import.meta.dir, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AGENTBOOTUP_ALLOW_TEST_SESSION: '0',
    },
    encoding: 'utf8',
  });
  expect(productionProbe.status).toBe(0);

  const root = fixture();
  const selectedPath = path.join(root, 'memory', 'MEMORY.md');
  const originalBytes = '# trusted memory\n';
  const replacementBytes = 'external replacement bytes must not be hashed\n';
  fs.writeFileSync(selectedPath, originalBytes);
  writeManifest(root, [{ path: 'memory/MEMORY.md', class: 'canonical' }]);
  const originalInode = fs.statSync(selectedPath, { bigint: true }).ino;

  let hashCalls = 0;
  const originalCreateHash = crypto.createHash;
  crypto.createHash = ((...args: Parameters<typeof crypto.createHash>) => {
    hashCalls += 1;
    return originalCreateHash(...args);
  }) as typeof crypto.createHash;

  try {
    expect(() => __withBrainBackupSelectionIdentityReadTestHook({
      kind: 'selected',
      phase: 'beforeOpen',
      path: selectedPath,
      run: () => {
        fs.writeFileSync(selectedPath, replacementBytes);
        expect(fs.statSync(selectedPath, { bigint: true }).ino).toBe(originalInode);
      },
    }, () => resolveBrainBackupSelection(root))).toThrow(/MEMORY\.md changed identity/i);
    expect(hashCalls).toBe(0);
  } finally {
    crypto.createHash = originalCreateHash;
  }
});

test('brain-backup.json same-inode rewrite during read fails before replacement policy is applied', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), '# memory\n');
  fs.writeFileSync(path.join(root, 'memory', 'external.md'), 'must remain unselected\n');
  writeManifest(root, [{ path: 'memory/MEMORY.md', class: 'canonical' }]);
  const manifestPath = path.join(root, 'brain-backup.json');
  const originalInode = fs.statSync(manifestPath, { bigint: true }).ino;

  let policyParseCalls = 0;
  const originalJsonParse = JSON.parse;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    if (typeof args[0] === 'string' && args[0].includes('"schema": "brain-backup/1"')) {
      policyParseCalls += 1;
    }
    return originalJsonParse(...args);
  }) as typeof JSON.parse;

  try {
    expect(() => __withBrainBackupSelectionIdentityReadTestHook({
      kind: 'policy',
      phase: 'afterRead',
      path: manifestPath,
      run: () => {
        writeManifest(root, [{ path: 'memory/**', class: 'private' }]);
        expect(fs.statSync(manifestPath, { bigint: true }).ino).toBe(originalInode);
      },
    }, () => resolveBrainBackupSelection(root))).toThrow(/brain-backup\.json changed identity/i);
    expect(policyParseCalls).toBe(0);
  } finally {
    JSON.parse = originalJsonParse;
  }
});

test('selected file ancestor swap after inventory fails closed', () => {
  const root = fixture();
  const dailyPath = path.join(root, 'memory', 'daily');
  const selectedPath = path.join(dailyPath, 'entry.md');
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-backup-external-'));
  fs.writeFileSync(selectedPath, 'trusted daily entry\n');
  fs.writeFileSync(path.join(externalDirectory, 'entry.md'), 'external daily entry\n');
  writeManifest(root, [{ path: 'memory/daily/entry.md', class: 'canonical' }]);

  expect(() => __withBrainBackupSelectionIdentityReadTestHook({
    kind: 'selected',
    phase: 'beforeOpen',
    path: selectedPath,
    run: () => {
      fs.renameSync(dailyPath, `${dailyPath}.inventoried`);
      fs.symlinkSync(externalDirectory, dailyPath, 'dir');
    },
  }, () => resolveBrainBackupSelection(root))).toThrow(/entry\.md changed identity/i);
});

test('record ordering uses code units and never localeCompare', () => {
  const root = fixture();
  for (const name of ['Ä.md', 'a.md', 'Z.md']) {
    fs.writeFileSync(path.join(root, 'memory', name), name);
  }
  writeManifest(root, [{ path: 'memory/**', class: 'canonical' }]);

  const originalLocaleCompare = String.prototype.localeCompare;
  String.prototype.localeCompare = () => {
    throw new Error('localeCompare must not be called');
  };
  try {
    expect(resolveBrainBackupSelection(root).selected.map((record) => record.path)).toEqual([
      'memory/Z.md',
      'memory/a.md',
      'memory/Ä.md',
    ]);
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
});
