import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessDaemonFreshness,
  checkObservedConfigIntegrity,
  resolveCommittedExpectation,
  resolveFreshnessCeiling,
} from '../../lib/doctor/reconciliation-health.js';

function fixture({ projectAgent = 'circle-computer', networkAgent = projectAgent, networkRole = 'network' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconciliation-health-'));
  const network = path.join(root, 'network');
  const project = path.join(root, 'project');
  fs.mkdirSync(network); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'agentbootup.json'), JSON.stringify({
    version: '2.0', role: 'project', agent_id: projectAgent, network,
  }));
  fs.writeFileSync(path.join(network, 'agentbootup.json'), JSON.stringify({
    version: '2.0', role: networkRole, projects: [{ id: 'circle-computer', agent_id: networkAgent, path: project }],
  }));
  return { root, network, project };
}

describe('PRD-0028 committed config expectation', () => {
  test('uses matching network/project declarations as the expectation source', () => {
    const f = fixture();
    try {
      const expected = resolveCommittedExpectation({ cwd: f.project });
      expect(expected).toMatchObject({ state: 'pass', expectedBrainId: 'circle-computer', expectedNetworkRoot: fs.realpathSync(f.network) });
      expect(checkObservedConfigIntegrity(expected, { brainId: 'circle-computer', networkRoot: f.network })).toMatchObject({ state: 'pass' });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  test('fails identity split-brain instead of choosing one declaration', () => {
    const f = fixture({ networkAgent: 'other-brain' });
    try { expect(resolveCommittedExpectation({ cwd: f.project })).toMatchObject({ state: 'fail', reason: 'identity_split_brain' }); }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  test('accepts camelCase project identity without classifying the declaration as incomplete', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.project, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'project', agentId: 'circle-computer', network: f.network,
    }));
    try {
      expect(resolveCommittedExpectation({ cwd: f.project }))
        .toMatchObject({ state: 'pass', expectedBrainId: 'circle-computer' });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  test('reports conflicting casing as ambiguous rather than incomplete', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.project, 'agentbootup.json'), JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'snake-brain',
      agentId: 'camel-brain',
      network: f.network,
    }));
    try {
      const result = resolveCommittedExpectation({ cwd: f.project });
      expect(result).toMatchObject({ state: 'fail', reason: 'ambiguous_project_identity' });
      expect(result.reason).not.toBe('incomplete_project_declaration');
      expect(result.detail).toContain('agent_id');
      expect(result.detail).toContain('agentId');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  test('fails when networkRoot exists but is not a network declaration', () => {
    const f = fixture({ networkRole: 'project' });
    try { expect(resolveCommittedExpectation({ cwd: f.project })).toMatchObject({ state: 'fail', reason: 'invalid_network_marker' }); }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  test('resolves an explicit agent through the committed network from another project cwd', () => {
    const f = fixture();
    const secondProject = path.join(f.root, 'second-project');
    fs.mkdirSync(secondProject);
    fs.writeFileSync(path.join(secondProject, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'project', agent_id: 'second-brain', network: f.network,
    }));
    fs.writeFileSync(path.join(f.network, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'network', projects: [
        { id: 'circle-computer', agent_id: 'circle-computer', path: f.project },
        { id: 'second', agent_id: 'second-brain', path: secondProject },
      ],
    }));
    try {
      expect(resolveCommittedExpectation({ cwd: f.project, agentId: 'second-brain' }))
        .toMatchObject({ state: 'pass', expectedBrainId: 'second-brain', projectId: 'second' });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('PRD-0028 freshness policy', () => {
  test('committed per-project policy wins over environment', () => {
    expect(resolveFreshnessCeiling('brainAsset', { freshness: { brainAssetMs: 99 } }, { AGENTBOOTUP_DOCTOR_FRESHNESS_BRAIN_ASSET_MS: '88' }))
      .toEqual({ ms: 99, source: 'committed_project_declaration' });
  });

  test('stale by one millisecond fails with the applied ceiling', () => {
    const result = assessDaemonFreshness({ component: 'brain_asset', active: true, completedAt: new Date(899).toISOString(), ceiling: { ms: 100, source: 'built_in_default' }, now: 1000 });
    expect(result).toMatchObject({ state: 'fail', ageMs: 101, ceilingMs: 100 });
  });

  test('absent component is unknown and never passes', () => {
    expect(assessDaemonFreshness({ component: 'brain_db', active: false, completedAt: null, ceiling: { ms: 100, source: 'built_in_default' } }))
      .toMatchObject({ state: 'unknown' });
  });
});
