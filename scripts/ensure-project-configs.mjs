#!/usr/bin/env node
/**
 * scripts/ensure-project-configs.mjs
 *
 * Backfill the canonical repo-root agentbootup.json (with `projects:[self]`) on
 * every brain registered in the network root that is missing it. This is the
 * one-time fleet backfill counterpart to provision.js's ensureProjectConfig
 * call: new provisions get the file automatically; this script catches the
 * brains provisioned before that step existed.
 *
 * Idempotent: brains that already have agentbootup.json + a self-target are
 * left unchanged. Uses the SAME helper as provision (lib/project-config.js
 * ensureProjectConfig) so there is one code path for the contract.
 *
 * Usage:
 *   node scripts/ensure-project-configs.mjs [network-root-path]
 *       (network-root-path defaults to the configured network root, else
 *        ~/dev_env/decisive_redux)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadNetworkConfig } from '../lib/network/config.js';
import { ensureProjectConfig } from '../lib/project-config.js';

function resolveNetworkRoot(arg) {
  if (arg) return path.resolve(arg);
  // Fall back to the canonical decisive path (the portfolio network root).
  return path.join(os.homedir(), 'dev_env', 'decisive_redux');
}

const networkRoot = resolveNetworkRoot(process.argv[2]);
if (!fs.existsSync(path.join(networkRoot, 'agentbootup.json'))) {
  console.error(`No agentbootup.json at network root ${networkRoot}`);
  console.error('Pass the network root path as the first argument.');
  process.exit(1);
}

const { config } = loadNetworkConfig(networkRoot);
const projects = Array.isArray(config.projects) ? config.projects : [];
const brains = projects.filter((p) => p && p.brain === true);
const pathless = brains.filter((p) => !p.path);
for (const p of pathless) {
  console.log(`  NOPATH ${String(p.agent_id || p.id).padEnd(20)} brain:true but no path — skipped`);
}
const targetable = brains.filter((p) => p.path);

let created = 0;
let ensured = 0;
let skipped = 0;
let missing = 0;
let failed = 0;
let corrupt = 0;
let stale = 0;
for (const p of targetable) {
  const agentId = p.agent_id || p.id;
  // loadNetworkConfig already resolves each project path to an absolute form
  // (expandPath expands ~), so p.path never starts with ~ here.
  const repo = p.path;
  if (!fs.existsSync(repo)) {
    console.log(`  SKIP  ${agentId.padEnd(20)} repo missing: ${repo}`);
    missing++;
    continue;
  }
  try {
    const result = ensureProjectConfig(repo, { agentId, projectId: p.id || agentId });
    if (result.wipedCorrupt) {
      console.log(`  CORRUPT ${agentId.padEnd(20)} ${result.backedUp ? 'rebuilt (backup saved to .corrupt)' : 'NOT rebuilt (backup FAILED; left in place)'}  ${repo}`);
      corrupt++;
    } else if (result.created) {
      console.log(`  CREATE ${agentId.padEnd(20)} ${repo}`);
      created++;
    } else if (result.changed) {
      console.log(`  ENSURE ${agentId.padEnd(20)} projects:[self] added  ${repo}`);
      ensured++;
    } else {
      console.log(`  OK     ${agentId.padEnd(20)} ${repo}`);
      skipped++;
    }
    if (result.staleAgentId) {
      // A stale repo-root agent_id is a broken identity: resolveProjectAgentId fails
      // closed on disagreement between agentbootup.json and brain/config.json, so this
      // brain cannot resolve its own identity. Surface it on stderr (separable from
      // routine stdout) and count it so the exit status reflects partial failure.
      console.error(`  STALE  ${agentId.padEnd(20)} existing agent_id differs from ${agentId} — left in place (BROKEN identity)`);
      stale++;
    }
  } catch (e) {
    console.error(`  FAIL   ${agentId.padEnd(20)} ${e.message}`);
    failed++;
  }
}

console.log(
  `\nensure-project-configs: created=${created} ensured=${ensured} corrupt=${corrupt} stale=${stale} skipped=${skipped} missing-repo=${missing} failed=${failed} no-path=${pathless.length} (of ${brains.length} brains)`,
);

// Reflect partial failure in the exit status so the backfill is safe to automate.
// A stale/corrupt/failed brain or any pathless brain means the backfill is NOT clean.
process.exit(failed > 0 || corrupt > 0 || stale > 0 || pathless.length > 0 ? 1 : 0);
