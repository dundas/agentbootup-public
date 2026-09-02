import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureBrainLayout, mergeBrainGitignore } from '../../lib/brain/layout-contract.js';

function tmp(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('ensureBrainLayout creates brain/tools, memory/daily, and .brain subtree', () => {
  const root = tmp('layout-0014-');
  const { createdDirs, gitignoreUpdated } = ensureBrainLayout(root);

  assert.ok(fs.existsSync(path.join(root, 'brain', 'tools')));
  assert.ok(fs.existsSync(path.join(root, 'memory', 'daily')));
  assert.ok(fs.existsSync(path.join(root, '.brain', 'collab', 'sessions')));
  assert.ok(fs.existsSync(path.join(root, '.brain', 'roundtable', 'checkpoints')));
  assert.ok(fs.existsSync(path.join(root, '.brain', 'skills', 'state')));
  assert.ok(fs.existsSync(path.join(root, '.brain', 'skills', 'backups')));
  assert.ok(fs.existsSync(path.join(root, '.brain', '.gitkeep')));
  assert.ok(fs.existsSync(path.join(root, '.brain', 'brain.db')));
  assert.equal(fs.statSync(path.join(root, '.brain', 'brain.db')).size, 0);
  assert.equal(gitignoreUpdated, true);
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8');
  assert.match(gi, /\.brain\/\*/);
  assert.match(gi, /!\.brain\/\.gitkeep/);
  assert.ok(createdDirs.length > 0);
});

test('ensureBrainLayout is idempotent on second run', () => {
  const root = tmp('layout-idem-');
  ensureBrainLayout(root);
  const { createdDirs, gitignoreUpdated } = ensureBrainLayout(root);
  assert.equal(createdDirs.length, 0);
  assert.equal(gitignoreUpdated, false);
});

test('ensureBrainLayout with portfolioProtocols creates brain/protocols', () => {
  const root = tmp('layout-proto-');
  ensureBrainLayout(root, { portfolioProtocols: true });
  assert.ok(fs.existsSync(path.join(root, 'brain', 'protocols')));
});

test('ensureBrainLayout dryRun does not write', () => {
  const root = tmp('layout-dry-');
  ensureBrainLayout(root, { dryRun: true });
  assert.equal(fs.existsSync(path.join(root, '.brain')), false);
});

test('ensureBrainLayout dryRun lists only dirs that would be created', () => {
  const root = tmp('layout-dry-plan-');
  const first = ensureBrainLayout(root, { dryRun: true });
  assert.ok(first.createdDirs.length > 0);
  ensureBrainLayout(root);
  const second = ensureBrainLayout(root, { dryRun: true });
  assert.equal(second.createdDirs.length, 0);
});

test('ensureBrainLayout dryRun on partial layout lists only missing dirs', () => {
  const root = tmp('layout-dry-partial-');
  fs.mkdirSync(path.join(root, 'brain', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory', 'daily'), { recursive: true });
  const { createdDirs } = ensureBrainLayout(root, { dryRun: true });
  const rel = new Set(createdDirs);
  assert.equal(rel.has('brain/tools'), false);
  assert.equal(rel.has('memory/daily'), false);
  assert.ok(rel.has(path.join('.brain', 'collab', 'sessions')));
});

test('mergeBrainGitignore no-op when rules already present', () => {
  const root = tmp('layout-gi-');
  fs.writeFileSync(
    path.join(root, '.gitignore'),
    '.brain/*\n!.brain/.gitkeep\n',
    'utf-8'
  );
  const updated = mergeBrainGitignore(root);
  assert.equal(updated, false);
});
