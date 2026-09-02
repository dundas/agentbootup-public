#!/usr/bin/env bun
/**
 * Smoke: brain registration end-to-end against LIVE mech-storage.
 *
 * Reproduces the fleet-blocking bug (bug_report msg-1783273471308-1bj5g1):
 * `POST /v1/brains` 500s with "Failed to provision default branch" because the
 * deterministic-doc-id write contract was wrong. Exercises the real path —
 * BrainStore.create + BrainBranchStore.ensureDefaultBranch through a real
 * MechClient — so a mock cannot mask the storage contract (a mock is what let
 * the original bug ship green).
 *
 * Requires MECH_APP_ID / MECH_API_KEY / MECH_API_SECRET (Fly secrets). Run on
 * the deployed machine:  fly ssh console -a agentbootup -C "bun /tmp/<this>.ts"
 *
 * Exit 0 = PASS, 1 = FAIL. Cleans up the throwaway brain + branches.
 */

import { MechClient } from '../src/server/lib/mech-client';
import { BrainStore } from '../src/server/lib/brain-store';
import { BrainBranchStore, DEFAULT_BRAIN_BRANCH_ID } from '../src/server/lib/brain-branch-store';
import type { CreateBrainRequest } from '../src/server/types';

function die(msg: string): never {
  console.error(`[smoke-brain-register-deterministic-id] FAIL: ${msg}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) die(`missing required env ${name}`);
  return v;
}

const mech = new MechClient({
  baseUrl: process.env.MECH_STORAGE_URL || 'https://storage.mechdna.net',
  appId: requireEnv('MECH_APP_ID'),
  apiKey: requireEnv('MECH_API_KEY'),
  apiSecret: requireEnv('MECH_API_SECRET'),
});

const brainStore = new BrainStore(mech);
const branchStore = new BrainBranchStore(mech);

const brainId = `smoke-detid-${Date.now()}`;
const req: CreateBrainRequest = {
  id: brainId,
  repo_url: 'https://github.com/dundas/smoke-detid.git',
  repo_branch: 'main',
  vault_namespace: `vault-${brainId}`,
  skills: [],
  memory_collection: `agent_memory_${brainId.replace(/-/g, '_')}`,
  parent_brain: null,
  trust_level: 'standard',
  metadata: {},
};

let created = false;
try {
  await brainStore.create(req);
  created = true;
  const brain = await brainStore.get(brainId);
  if (!brain) die('brain not found immediately after create');

  // The exact call that 500'd fleet-wide before the fix.
  const branch = await branchStore.ensureDefaultBranch(brain);
  if (branch.branch_id !== DEFAULT_BRAIN_BRANCH_ID) {
    die(`ensureDefaultBranch returned branch_id '${branch.branch_id}'`);
  }

  // Round-trip read via deterministic key (GET-by-id path + unwrap).
  const roundTrip = await branchStore.get(brainId, DEFAULT_BRAIN_BRANCH_ID);
  if (!roundTrip) die('default branch not readable after provisioning');
  if (roundTrip.brain_id !== brainId || roundTrip.status !== 'active') {
    die(`round-trip branch mismatch: ${JSON.stringify(roundTrip)}`);
  }

  // Idempotency: a second ensureDefaultBranch must return the existing row, not conflict.
  const again = await branchStore.ensureDefaultBranch(brain);
  if (again.branch_id !== DEFAULT_BRAIN_BRANCH_ID) die('second ensureDefaultBranch diverged');

  // Exactly one default branch row survives (no duplicate from the deterministic key).
  const forBrain = await branchStore.listForBrain(brainId);
  const defaults = forBrain.filter((b) => b.branch_id === DEFAULT_BRAIN_BRANCH_ID);
  if (defaults.length !== 1) die(`expected 1 default branch, found ${defaults.length}`);

  console.log(`[smoke-brain-register-deterministic-id] PASS — brain '${brainId}' registered + default branch provisioned end-to-end`);
} finally {
  try {
    await branchStore.deleteForBrain(brainId);
  } catch (err) {
    console.warn(`[smoke] branch cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (created) {
    try {
      await brainStore.delete(brainId);
    } catch (err) {
      console.warn(`[smoke] brain cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
