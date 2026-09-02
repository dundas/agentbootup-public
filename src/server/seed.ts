/**
 * Agentbootup Server — Brain Registry Seed Script
 *
 * Seeds the brain registry from the existing hardcoded maps in brain-server.
 * Run once after first deploy to populate the registry.
 *
 * Note: brain IDs use bare names (e.g. "bootup", "decisive") without ".gm" suffix.
 * The ".gm" suffix is an ADMP transport detail only — canonical identity is the bare name.
 * If re-seeding an existing database, DELETE the old rows with stale ".gm" IDs first.
 *
 * Usage:
 *   MECH_APP_ID=... MECH_API_KEY=... MECH_API_SECRET=... AGENTBOOTUP_API_KEY=... \
 *     bun src/server/seed.ts
 *
 * Or against a running server:
 *   AGENTBOOTUP_SERVER_URL=https://agentbootup.fly.dev \
 *   AGENTBOOTUP_API_KEY=... \
 *     bun src/server/seed.ts
 */

import { MechClient } from './lib/mech-client';
import { BrainStore } from './lib/brain-store';
import { ExternalApiKeyStore } from './lib/external-api-key-store';
import type { CreateBrainRequest } from './types';

// ── Known Portfolio Brains ────────────────────────────────────────────────────
// Source: decisive_redux/memory/portfolio-registry.md + brain-server BRAIN_REPO_MAP
// vault_namespace: verify against Mech Vault before running in production

const BRAINS: CreateBrainRequest[] = [
  // ── GM Brains (orchestrators) ──────────────────────────────────────────────
  {
    id: 'decisive-gm',
    repo_url: 'https://github.com/dundas/decisive-redux.git',
    repo_branch: 'main',
    vault_namespace: 'brain-server-prod',
    skills: [],
    parent_brain: null,
    trust_level: 'full',
    metadata: { description: 'Portfolio General Manager', category: 'gm' },
  },
  {
    id: 'liveport-gm',
    repo_url: 'https://github.com/dundas/liveport-private.git',
    repo_branch: 'main',
    vault_namespace: 'liveport-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'LivePort tunnel service GM', category: 'gm' },
  },
  {
    id: 'bootup',
    repo_url: 'https://github.com/dundas/agentbootup.git',
    repo_branch: 'main',
    vault_namespace: 'agentbootup-prod',
    skills: [],
    parent_brain: 'decisive',
    trust_level: 'standard',
    metadata: { description: 'AgentBootup capability bootstrapper GM', category: 'gm' },
  },
  {
    id: 'clearauth-gm',
    repo_url: 'https://github.com/dundas/clearauth.git',
    repo_branch: 'main',
    vault_namespace: 'clearauth-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'ClearAuth drop-in auth GM', category: 'gm' },
  },
  {
    id: 'blankpost-gm',
    repo_url: 'https://github.com/dundas/blankpost.git',
    repo_branch: 'main',
    vault_namespace: 'blankpost-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'BlankPost content infrastructure GM', category: 'gm' },
  },
  {
    id: 'circleinbox-gm',
    repo_url: 'https://github.com/dundas/circleinbox.git',
    repo_branch: 'main',
    vault_namespace: 'circleinbox-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'CircleInbox group email GM', category: 'gm' },
  },
  {
    id: 'mech-vault-gm',
    repo_url: 'https://github.com/dundas/mech-vault.git',
    repo_branch: 'main',
    vault_namespace: 'mech-vault-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'Mech Vault secrets management GM', category: 'mech' },
  },
  {
    id: 'mech-run-gm',
    repo_url: 'https://github.com/dundas/mech-run.git',
    repo_branch: 'main',
    vault_namespace: 'mech-run-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'Mech Run CLI orchestration GM', category: 'mech' },
  },
  {
    id: 'mech-client-gm',
    repo_url: 'https://github.com/dundas/mech-client.git',
    repo_branch: 'main',
    vault_namespace: 'mech-client-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'Mech Client TypeScript SDK GM', category: 'mech' },
  },
  {
    id: 'derivative-labs-gm',
    repo_url: 'https://github.com/dundas/derivative-labs.git',
    repo_branch: 'main',
    vault_namespace: 'derivative-labs-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'Derivative Labs website GM', category: 'gm' },
  },

  // ── Worker Brains (specialists) ────────────────────────────────────────────
  {
    id: 'mech-browse-001',
    repo_url: 'https://github.com/dundas/mech-browse.git',
    repo_branch: 'main',
    vault_namespace: 'mech-browse-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'ThinkBrowse browser automation worker', category: 'worker' },
  },
  {
    id: 'mech-storage-001',
    repo_url: 'https://github.com/dundas/mech-storage.git',
    repo_branch: 'main',
    vault_namespace: 'mech-storage-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'Mech Storage R2+PG+NoSQL worker', category: 'worker' },
  },
  {
    id: 'mech-reader-001',
    repo_url: 'https://github.com/dundas/mech-reader.git',
    repo_branch: 'main',
    vault_namespace: 'mech-reader-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'Mech Reader content processing worker', category: 'worker' },
  },
  {
    id: 'mech-search-001',
    repo_url: 'https://github.com/dundas/mech-search.git',
    repo_branch: 'main',
    vault_namespace: 'mech-search-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'Mech Search Google+social worker', category: 'worker' },
  },
  {
    id: 'agentdispatch-gm',
    repo_url: 'https://github.com/dundas/agentdispatch.git',
    repo_branch: 'main',
    vault_namespace: 'agentdispatch-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'AgentDispatch ADMP protocol GM', category: 'gm' },
  },
  {
    id: 'helloconvo-gm',
    repo_url: 'https://github.com/dundas/helloconvo-agents.git',
    repo_branch: 'main',
    vault_namespace: 'helloconvo-prod',
    skills: [],
    parent_brain: 'decisive-gm',
    trust_level: 'standard',
    metadata: { description: 'HelloConvo AI content creation GM', category: 'gm' },
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function seedExternalApiKeyFixture(mech: MechClient): Promise<void> {
  const secret = process.env.AGENTBOOTUP_SEED_EXTERNAL_API_KEY?.trim();
  if (!secret) return;

  const store = new ExternalApiKeyStore(mech);
  const userId = process.env.AGENTBOOTUP_SEED_EXTERNAL_USER_ID?.trim() || 'seed-external-user';
  const keyId = process.env.AGENTBOOTUP_SEED_EXTERNAL_API_KEY_ID?.trim() || 'key_seed_external';
  const label = process.env.AGENTBOOTUP_SEED_EXTERNAL_API_KEY_LABEL?.trim() || 'seed-external-key';

  const { created } = await store.ensureFixture({ id: keyId, user_id: userId, label, secret });
  if (created) {
    console.log(`  OK    external api key ${keyId} for user ${userId}`);
  } else {
    console.log(`  SKIP  external api key ${keyId} (already seeded)`);
  }
}

async function seed(): Promise<void> {
  const mechUrl = process.env.MECH_STORAGE_URL || 'https://storage.mechdna.net';
  const mechAppId = process.env.MECH_APP_ID;
  const mechApiKey = process.env.MECH_API_KEY;
  const mechApiSecret = process.env.MECH_API_SECRET;

  if (!mechAppId || !mechApiKey || !mechApiSecret) {
    console.error('Missing required env vars: MECH_APP_ID, MECH_API_KEY, MECH_API_SECRET');
    process.exit(1);
  }

  const mech = new MechClient({ baseUrl: mechUrl, appId: mechAppId, apiKey: mechApiKey, apiSecret: mechApiSecret });
  const store = new BrainStore(mech);

  console.log(`Seeding ${BRAINS.length} brains into registry...\n`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const req of BRAINS) {
    try {
      const existing = await store.get(req.id);
      if (existing) {
        console.log(`  SKIP  ${req.id} (already registered)`);
        skipped++;
        continue;
      }
      await store.create(req);
      console.log(`  OK    ${req.id}`);
      created++;
    } catch (err) {
      console.error(`  FAIL  ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\nDone: ${created} created, ${skipped} skipped, ${failed} failed`);

  if (process.env.AGENTBOOTUP_SEED_EXTERNAL_API_KEY?.trim()) {
    console.log('\nSeeding optional external API key fixture...');
    await seedExternalApiKeyFixture(mech);
  }

  if (failed > 0) process.exit(1);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
