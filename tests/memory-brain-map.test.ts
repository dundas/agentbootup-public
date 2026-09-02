// PRD-0051: committed presence manifest (brain-map/1) + map-aware verify/refresh.
import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateBrainMap, loadBrainMap, verifyAgainstMap, writeBrainMap, BRAIN_MAP_SCHEMA } from '../lib/memory/brain-map.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const r of tempRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
function tempDir(prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(d);
  return d;
}
function checkout(agentId: string, pages: Record<string, string>) {
  const root = tempDir('ab-map-');
  fs.writeFileSync(path.join(root, 'agentbootup.json'), JSON.stringify({ agent_id: agentId }));
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: agentId,
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  fs.writeFileSync(path.join(root, '.brainignore'), 'memory/**/.gitkeep\nmemory/**/.sources/**\n');
  for (const [rel, content] of Object.entries(pages)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

test('generateBrainMap: presence-oriented, typed, sorted; skips ephemeral .sources + .gitkeep', () => {
  const root = checkout('bootup', {
    'memory/MEMORY.md': '# idx\n',
    'memory/feedback_x.md': 'fb\n',
    'memory/daily/2026-07-12.md': 'log\n',
    'memory/narratives/2026-07-11.md': 'story\n',
    'memory/daily/.gitkeep': '',
    'memory/narratives/.sources/2026-07-11.source.md': 'RAW — must be excluded\n',
  });
  const doc = generateBrainMap(root);
  expect(doc.schema).toBe(BRAIN_MAP_SCHEMA);
  expect(doc.brain).toBe('bootup');
  const paths = doc.pages.map((p) => p.path);
  expect(paths).toEqual(['MEMORY.md', 'daily/2026-07-12.md', 'feedback_x.md', 'narratives/2026-07-11.md']);
  const typeOf = (p: string) => doc.pages.find((e) => e.path === p)!.type;
  expect(typeOf('MEMORY.md')).toBe('index');
  expect(typeOf('feedback_x.md')).toBe('feedback');
  expect(typeOf('daily/2026-07-12.md')).toBe('daily');
  expect(typeOf('narratives/2026-07-11.md')).toBe('narratives');
  // No content, no hashes, no timestamps -> low churn.
  expect(JSON.stringify(doc)).not.toMatch(/sha256|generated_at|content/);
});

test('writeBrainMap writes brain-map.json at the repo root (outside gitignored memory/)', () => {
  const root = checkout('bootup', { 'memory/MEMORY.md': '# idx\n' });
  const { path: dest } = writeBrainMap(root);
  expect(dest).toBe(path.join(root, 'brain-map.json'));
  expect(loadBrainMap(root)!.page_count).toBe(1);
});

test('writeBrainMap fails closed without a manifest and reports classified proposal counts', () => {
  const root = checkout('bootup', {
    'memory/MEMORY.md': '# idx\n',
    'memory/attachment.docx': 'binary-ish',
  });
  fs.rmSync(path.join(root, 'brain-backup.json'));
  expect(() => writeBrainMap(root)).toThrow(
    /requires brain-backup\.json.*SELECTED=0.*UNSELECTED=2/i,
  );
  expect(fs.existsSync(path.join(root, 'brain-map.json'))).toBe(false);
});

test('brain map contains only selected paths relative to memory and verify classifies excluded files', () => {
  const root = checkout('bootup', {
    'memory/MEMORY.md': '# idx\n',
    'memory/selected/report.xlsx': 'sheet-bytes',
    'memory/ignored.md': 'ignore me\n',
    'memory/unselected.docx': 'not selected',
  });
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'bootup',
    include: [
      { path: 'memory/MEMORY.md', class: 'canonical' },
      { path: 'memory/selected/**', class: 'attachment' },
      { path: 'memory/ignored.md', class: 'canonical' },
    ],
  }));
  fs.writeFileSync(path.join(root, '.brainignore'), 'memory/ignored.md\n');

  const { doc } = writeBrainMap(root);
  expect(doc.pages.map((page) => page.path)).toEqual(['MEMORY.md', 'selected/report.xlsx']);
  const verified = verifyAgainstMap(root, doc);
  expect(verified.counts).toEqual({
    SELECTED: 2,
    IGNORED: 1,
    SECRET_BLOCKED: 0,
    UNSELECTED: 1,
  });
  expect(verified.ignored).toEqual(['ignored.md']);
  expect(verified.unselected).toEqual(['unselected.docx']);
});

test('loadBrainMap rejects a bad schema, non-string path, and paths escaping memory/', () => {
  const root = checkout('bootup', { 'memory/MEMORY.md': '# idx\n' });
  const mapPath = path.join(root, 'brain-map.json');
  fs.writeFileSync(mapPath, JSON.stringify({ schema: 'wrong', brain: 'bootup', page_count: 0, pages: [] }));
  expect(() => loadBrainMap(root)).toThrow(/schema check/);
  fs.writeFileSync(mapPath, JSON.stringify({ schema: BRAIN_MAP_SCHEMA, brain: 'bootup', page_count: 1, pages: [{ path: 42, type: 'index' }] }));
  expect(() => loadBrainMap(root)).toThrow(/non-string/);
  fs.writeFileSync(
    mapPath,
    JSON.stringify({ schema: BRAIN_MAP_SCHEMA, brain: 'bootup', page_count: 1, pages: [{ path: '../../etc/passwd', type: 'index' }] }),
  );
  expect(() => loadBrainMap(root)).toThrow(/traversal|contained|relative/i);
});

test('loadBrainMap rejects missing type, mismatched page_count, and duplicate paths', () => {
  const root = checkout('bootup', { 'memory/MEMORY.md': '# idx\n' });
  const mapPath = path.join(root, 'brain-map.json');
  fs.writeFileSync(
    mapPath,
    JSON.stringify({ schema: BRAIN_MAP_SCHEMA, brain: 'bootup', page_count: 1, pages: [{ path: 'MEMORY.md' }] }),
  );
  expect(() => loadBrainMap(root)).toThrow(/page type/);

  fs.writeFileSync(
    mapPath,
    JSON.stringify({
      schema: BRAIN_MAP_SCHEMA,
      brain: 'bootup',
      page_count: 2,
      pages: [{ path: 'MEMORY.md', type: 'index' }],
    }),
  );
  expect(() => loadBrainMap(root)).toThrow(/page_count/);

  fs.writeFileSync(
    mapPath,
    JSON.stringify({
      schema: BRAIN_MAP_SCHEMA,
      brain: 'bootup',
      page_count: 2,
      pages: [
        { path: 'MEMORY.md', type: 'index' },
        { path: 'MEMORY.md', type: 'index' },
      ],
    }),
  );
  expect(() => loadBrainMap(root)).toThrow(/duplicate/);
});

test('loadBrainMap normalizes canonical-equivalent paths before verify uses them', () => {
  const root = checkout('bootup', { 'memory/MEMORY.md': '# idx\n' });
  const mapPath = path.join(root, 'brain-map.json');
  fs.writeFileSync(
    mapPath,
    JSON.stringify({
      schema: BRAIN_MAP_SCHEMA,
      brain: ' bootup ',
      page_count: 1,
      pages: [{ path: './MEMORY.md', type: ' index ' }],
    }),
  );
  const doc = loadBrainMap(root);
  expect(doc!.brain).toBe('bootup');
  expect(doc!.pages).toEqual([{ path: 'MEMORY.md', type: 'index' }]);
  const v = verifyAgainstMap(root, doc!);
  expect(v.present).toEqual(['MEMORY.md']);
  expect(v.extra).toEqual([]);
});

test('verifyAgainstMap reports present / missing / extra', () => {
  const root = checkout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/feedback_here.md': 'x\n' });
  const doc = {
    schema: BRAIN_MAP_SCHEMA,
    brain: 'bootup',
    page_count: 2,
    pages: [
      { path: 'MEMORY.md', type: 'index' },
      { path: 'feedback_gone.md', type: 'feedback' }, // expected but not on disk -> missing
    ],
  };
  const v = verifyAgainstMap(root, doc);
  expect(v.present).toEqual(['MEMORY.md']);
  expect(v.missing).toEqual(['feedback_gone.md']);
  expect(v.extra).toEqual(['feedback_here.md']); // on disk, not in map
});

test('verifyAgainstMap classifies a missing policy-selected map path as presence missing', () => {
  const root = checkout('bootup', { 'memory/MEMORY.md': '# idx\n' });
  const doc = {
    schema: BRAIN_MAP_SCHEMA,
    brain: 'bootup',
    page_count: 2,
    pages: [
      { path: 'MEMORY.md', type: 'index' },
      { path: 'daily/deleted.md', type: 'daily' },
    ],
  };
  const v = verifyAgainstMap(root, doc);
  expect(v.missing).toEqual(['daily/deleted.md']);
  expect(v.selectionMissing).toEqual([]);
});

test('verifyAgainstMap treats directories as missing and rejects symlinks fail-closed', () => {
  const root = checkout('bootup', { 'memory/MEMORY.md': '# idx\n' });
  fs.rmSync(path.join(root, 'memory', 'MEMORY.md'));
  fs.mkdirSync(path.join(root, 'memory', 'MEMORY.md'));

  const doc = {
    schema: BRAIN_MAP_SCHEMA,
    brain: 'bootup',
    page_count: 1,
    pages: [{ path: 'MEMORY.md', type: 'index' }],
  };
  const dirResult = verifyAgainstMap(root, doc);
  expect(dirResult.present).toEqual([]);
  expect(dirResult.missing).toEqual(['MEMORY.md']);

  fs.rmSync(path.join(root, 'memory', 'MEMORY.md'), { recursive: true, force: true });
  fs.symlinkSync(path.join(root, 'memory'), path.join(root, 'memory', 'MEMORY.md'));
  expect(() => verifyAgainstMap(root, doc)).toThrow(/symlink is not allowed/i);
});
