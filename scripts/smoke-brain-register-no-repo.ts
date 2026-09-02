#!/usr/bin/env bun
/**
 * Smoke: repo-less brain registration end-to-end against LIVE mech-storage
 * (PRD-0045). Proves a brain can be provisioned with no repo_url, that the
 * default branch still provisions, and that a repo can be attached later.
 *
 * Requires MECH_APP_ID / MECH_API_KEY / MECH_API_SECRET (Fly secrets). Run on
 * the deployed machine: fly ssh console -a agentbootup -C "bun /app/scripts/<this>.ts"
 *
 * Exit 0 = PASS, 1 = FAIL. Cleans up the throwaway brain + branches.
 */

import { MechClient } from '../src/server/lib/mech-client';
import { BrainStore } from '../src/server/lib/brain-store';
import { BrainBranchStore, DEFAULT_BRAIN_BRANCH_ID } from '../src/server/lib/brain-branch-store';
import type { CreateBrainRequest } from '../src/server/types';

function die(msg: string): never {
  console.error(`[smoke-brain-register-no-repo] FAIL: ${msg}`);
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

const brainId = `smoke-norepo-${Date.now()}`;
const req: CreateBrainRequest = {
  id: brainId,
  // No repo_url — the whole point.
  vault_namespace: `vault-${brainId}`,
  skills: [],
  parent_brain: null,
  trust_level: 'standard',
  metadata: {},
};

let created = false;
try {
  const brain = await brainStore.create(req);
  created = true;
  if (brain.repo_url !== null) die(`expected repo_url=null, got ${JSON.stringify(brain.repo_url)}`);
  if (brain.repo_branch !== null) die(`expected repo_branch=null, got ${JSON.stringify(brain.repo_branch)}`);

  // Default branch must still provision without a repo.
  const branch = await branchStore.ensureDefaultBranch(brain);
  if (branch.branch_id !== DEFAULT_BRAIN_BRANCH_ID) die(`ensureDefaultBranch returned '${branch.branch_id}'`);

  const readBack = await brainStore.get(brainId);
  if (!readBack) die('repo-less brain not found after create');
  if (readBack.repo_url !== null) die('read-back repo_url is not null');

  // Attach a repo later (the `brain update` path).
  const updated = await brainStore.update(brainId, { repo_url: 'https://github.com/dundas/attached-later.git' });
  if (updated.repo_url !== 'https://github.com/dundas/attached-later.git') {
    die(`attach-repo update did not persist: ${JSON.stringify(updated.repo_url)}`);
  }

  console.log(`[smoke-brain-register-no-repo] PASS — repo-less brain '${brainId}' registered + default branch provisioned + repo attached via update`);
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
