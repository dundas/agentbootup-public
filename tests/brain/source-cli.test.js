import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { runBrainSource } from '../../lib/brain/source-cli.js';
import { runBrainCommand } from '../../lib/network/commands/brain.js';
import { descriptorPath, evaluateDaemonSource } from '../../lib/brain/source-migration.js';

function git(args, cwd) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function repo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'source-cli-')); const bare = path.join(base, 'origin.git'); const work = path.join(base, 'work');
  git(['init', '--bare', '--initial-branch=trunk', bare], base); git(['init', '--initial-branch=trunk', work], base);
  git(['config', 'user.email', 'test@example.test'], work); git(['config', 'user.name', 'Test'], work); fs.writeFileSync(path.join(work, 'a.md'), 'a'); git(['add', '.'], work); git(['commit', '-m', 'init'], work); git(['remote', 'add', 'origin', bare], work); git(['push', '-u', 'origin', 'trunk'], work); git(['remote', 'set-head', 'origin', '--auto'], work);
  return { base, work, ref: 'refs/heads/trunk' };
}
function invoke(args) { const out = []; const err = []; const rc = runBrainSource(args, { stdout: x => out.push(x), stderr: x => err.push(x) }); return { rc, out: out.join('\n'), err: err.join('\n') }; }

test('brain source select writes only the owned state root and status never trusts a repository descriptor', () => {
  const prior = process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT; const state = fs.mkdtempSync(path.join(os.tmpdir(), 'source-state-')); process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = state;
  const { base, work, ref } = repo();
  try {
    fs.mkdirSync(path.join(work, '.brain'), { recursive: true });
    fs.writeFileSync(path.join(work, '.brain', 'source-descriptor.json'), '{"attacker":"controlled"}');
    const selected = invoke(['select', '--source', work, '--kind', 'git', '--brain', 'brain-a', '--ref', ref, '--selected-by', 'operator', '--selected-at', '2026-08-13T12:00:00Z', '--json']);
    assert.equal(selected.rc, 0, selected.err); assert.ok(fs.existsSync(descriptorPath(work)));
    assert.equal(fs.readFileSync(path.join(work, '.brain', 'source-descriptor.json'), 'utf8'), '{"attacker":"controlled"}');
    assert.equal(fs.statSync(descriptorPath(work)).mode & 0o777, 0o600);
    const status = invoke(['status', '--source', work, '--json']); assert.equal(status.rc, 0); assert.match(status.out, /"legacy_descriptor": "present"/); assert.doesNotMatch(status.out, new RegExp(work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(evaluateDaemonSource(work).may_publish, true);
  } finally { if (prior == null) delete process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT; else process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = prior; fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test('legacy repository descriptor is only evidence and cannot authorize a daemon', () => {
  const prior = process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT; const state = fs.mkdtempSync(path.join(os.tmpdir(), 'source-state-')); process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = state;
  const { base, work } = repo();
  try { fs.mkdirSync(path.join(work, '.brain')); fs.writeFileSync(path.join(work, '.brain', 'source-descriptor.json'), '{"source_kind":"directory"}'); const result = invoke(['status', '--source', work, '--json']); assert.equal(result.rc, 1); assert.match(result.out, /no_source_descriptor/); assert.match(result.out, /"legacy_descriptor": "present"/); }
  finally { if (prior == null) delete process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT; else process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = prior; fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test('brain source report is redacted and calls a symlinked legacy descriptor unsafe', () => {
  const prior = process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT; const state = fs.mkdtempSync(path.join(os.tmpdir(), 'source-state-')); process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = state;
  const { base, work } = repo(); const outside = path.join(base, 'outside');
  try {
    fs.mkdirSync(path.join(work, '.brain')); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(work, '.brain', 'source-descriptor.json'));
    const result = invoke(['report', '--source', work, '--json']);
    assert.equal(result.rc, 0); assert.match(result.out, /"legacy_descriptor": "unsafe"/); assert.match(result.out, /"operation": "report"/);
    assert.doesNotMatch(result.out, new RegExp(work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { if (prior == null) delete process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT; else process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = prior; fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test('brain source selects an explicit directory source without a Git ref', () => {
  const prior = process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT; const state = fs.mkdtempSync(path.join(os.tmpdir(), 'source-state-')); process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = state;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-directory-'));
  try {
    const result = invoke(['select', '--source', root, '--kind', 'directory', '--brain', 'brain-dir', '--selected-by', 'operator', '--selected-at', '2026-08-13T12:00:00Z', '--json']);
    assert.equal(result.rc, 0, result.err); assert.match(result.out, /"state": "ready"/); assert.equal(evaluateDaemonSource(root).may_publish, true);
  } finally { if (prior == null) delete process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT; else process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = prior; fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test('brain source select redacts a descriptor validation pathname', () => {
  const prior = process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT; const state = fs.mkdtempSync(path.join(os.tmpdir(), 'source-state-')); process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = state;
  const rootBase = fs.mkdtempSync(path.join(os.tmpdir(), 'source-path-')); const root = `${rootBase}\\private`; fs.mkdirSync(root);
  try {
    const result = invoke(['select', '--source', root, '--kind', 'directory', '--brain', 'brain-dir', '--selected-by', 'operator', '--selected-at', '2026-08-13T12:00:00Z', '--json']);
    assert.equal(result.rc, 1); assert.match(result.out, /source_operation_failed/); assert.doesNotMatch(result.out, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { if (prior == null) delete process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT; else process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = prior; fs.rmSync(rootBase, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test('brain command dispatches source without implicitly selecting cwd', async () => {
  const out = []; const err = [];
  const rc = await runBrainCommand(['source', 'status', '--json'], { stdout: x => out.push(x), stderr: x => err.push(x) });
  assert.equal(rc, 2); assert.match(err.join('\n'), /--source/); assert.equal(out.length, 0);
});
