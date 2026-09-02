/**
 * Agentbootup Server — Boot Bundle Builder
 *
 * Assembles everything an ephemeral worker needs to boot a brain:
 *   - Brain identity from registry
 *   - Repo URL + branch from brain record
 *   - Credentials proxied from Mech Vault (never stored)
 *   - Skills + memory (Phase 3/4 — empty arrays for now)
 *
 * CRITICAL: Bundles have a TTL. Credentials are ephemeral by design.
 * Boot bundle does NOT include repo contents — only the URL for git clone.
 */

import type { Brain, BundleTranscript, TranscriptMeta, TranscriptStoreAdapter, TranscriptsError } from '../types';
import { VaultClient } from './vault-client';
import { SkillStore } from './skill-store';
import { MemoryStore } from './memory-store';
import { RegistryStore } from './registry-store';
import { TRANSCRIPT_INLINE_THRESHOLD } from './transcript-store';
import { BrainAssetStore, BRAIN_DB_BACKUP_PATH_PREFIX } from './brain-asset-store';
import type { AssetType, AssetCli } from './brain-asset-store';
import type { ToolsetConfig } from './toolsets';

export const DEFAULT_CLONE_DEPTH = 1;
export const DEFAULT_TTL_SECONDS = 300; // 5 minutes — enough for worker to start
export const DEFAULT_SKILL_LIMIT = 3;

export interface BootBundle {
  brain: Brain;
  repo: {
    // null when the brain has no repo — the consumer must treat this as
    // "no clone" and skip any git checkout.
    url: string | null;
    branch: string | null;
    clone_depth: number;
  };
  credentials: Record<string, string>;
  skills: Array<{
    id: string;
    files: Array<{ path: string; content: string }>;
  }>;
  memory: Array<{ path: string; content: string }>;
  registry_snapshot: Array<{
    id: string;
    name: string;
    baseUrl: string;
    endpoints: Array<{
      method: string;
      path: string;
      description: string;
      status: string;
    }>;
  }> | null;
  /** Recent transcript files for the brain — empty array when include_transcripts=false (default) */
  transcripts: BundleTranscript[];
  /**
   * Brain assets (skills, agents, commands, memory, protocols, config) —
   * null when include_brain_assets=false (default) or brainAssetStore not injected.
   */
  brain_assets: Array<{ path: string; content_base64: string; asset_type: AssetType; cli: AssetCli }> | null;
  /**
   * Set when include_transcripts=true but the transcript fetch failed.
   * Allows callers to distinguish a genuine empty set from a storage error.
   * Absent when transcripts were fetched successfully (even if the array is empty).
   *
   * - `'no_transcript_store'` — server has no TranscriptStore injected
   * - `'fetch_failed'`        — list() threw (storage unavailable, etc.)
   */
  transcripts_error?: TranscriptsError;
  env_vars: Record<string, string>;
  /**
   * Environment-scoped toolset capability contract, keyed by environment id
   * (circle_computer, mac-mini, macbook-pro-5, …). What an agent may do depends
   * on where it runs. Optional. NOTE: pi-package selection (harness tuning per
   * model) is a mech-plane routing concern, not carried in the bundle.
   */
  toolsets?: ToolsetConfig;
  ttl_seconds: number;
  assembled_at: string;
}

export interface BuildBundleOptions {
  branch_id?: string;
  include_credentials?: boolean;
  include_skills?: boolean;
  include_memory?: boolean;
  include_registry_snapshot?: boolean;
  /**
   * When true, attaches the {@link BUNDLE_TRANSCRIPT_LIMIT} most-recently-updated
   * transcripts to the bundle. Files below {@link TRANSCRIPT_INLINE_THRESHOLD}
   * are base64-inlined; larger files carry only their storage key.
   *
   * Worst-case bundle size impact: ~2.7 MB
   * (20 files × 100 KB each, ~33% base64 overhead)
   */
  include_transcripts?: boolean;
  /**
   * When true, fetches all brain assets (skills, agents, commands, memory, protocols, config)
   * from the BrainAssetStore and includes them as base64-encoded files in the bundle.
   * Gracefully degrades to null if no brainAssetStore was injected.
   */
  include_brain_assets?: boolean;
  clone_depth?: number;
  ttl_seconds?: number;
  skill_limit?: number;
  toolsets?: ToolsetConfig;
}

/** Max transcripts inlined into a boot bundle to limit payload size */
export const BUNDLE_TRANSCRIPT_LIMIT = 20;
/** Per-file download timeout in ms — hung downloads fall back to key-only */
export const BUNDLE_DOWNLOAD_TIMEOUT_MS = 5_000;

export interface BundleBuilderOptions {
  skillStore?: SkillStore;
  memoryStore?: MemoryStore;
  registryStore?: RegistryStore;
  transcriptStore?: TranscriptStoreAdapter;
  brainAssetStore?: BrainAssetStore;
}

export class BundleBuilder {
  private skillStore?: SkillStore;
  private memoryStore?: MemoryStore;
  private registryStore?: RegistryStore;
  private transcriptStore?: TranscriptStoreAdapter;
  private brainAssetStore?: BrainAssetStore;

  constructor(
    private vault: VaultClient,
    opts: BundleBuilderOptions = {},
  ) {
    this.skillStore = opts.skillStore;
    this.memoryStore = opts.memoryStore;
    this.registryStore = opts.registryStore;
    this.transcriptStore = opts.transcriptStore;
    this.brainAssetStore = opts.brainAssetStore;
  }

  async build(brain: Brain, opts: BuildBundleOptions = {}): Promise<BootBundle> {
    const {
      include_credentials = true,
      branch_id,
      include_skills = true,    // Phase 3 — default on
      include_memory = false,   // Phase 4
      include_registry_snapshot = false,
      include_transcripts = false,
      include_brain_assets = false,
      clone_depth = DEFAULT_CLONE_DEPTH,
      ttl_seconds = DEFAULT_TTL_SECONDS,
      skill_limit = DEFAULT_SKILL_LIMIT,
      toolsets,
    } = opts;

    // ── Credentials (vault proxy) ─────────────────────────────────────
    let credentials: Record<string, string> = {};
    if (include_credentials && brain.vault_namespace) {
      credentials = await this.vault.getDeploymentBundle(brain.vault_namespace);
    }

    // ── Skills ────────────────────────────────────────────────────────
    const skills: BootBundle['skills'] = [];
    if (include_skills && brain.skills.length > 0 && this.skillStore) {
      const capped = Number.isInteger(skill_limit) && skill_limit > 0
        ? brain.skills.slice(0, skill_limit)
        : brain.skills;
      const fetched = await Promise.all(
        capped.map((id) => this.skillStore!.get(id)),
      );
      for (const skill of fetched) {
        if (skill) {
          skills.push({ id: skill.id, files: skill.files });
        }
        // Missing skills are silently skipped — non-fatal
      }
    }

    // ── Memory ────────────────────────────────────────────────────────
    const memory: BootBundle['memory'] = [];
    if (include_memory && brain.memory_collection && this.memoryStore) {
      const files = await this.memoryStore.pull(brain.memory_collection);
      memory.push(...files);
    }

    // ── Registry snapshot ─────────────────────────────────────────────
    let registry_snapshot: BootBundle['registry_snapshot'] = null;
    if (include_registry_snapshot && this.registryStore) {
      const registry = await this.registryStore.getRegistry();
      if (registry) {
        registry_snapshot = registry.services.map((svc) => ({
          id: svc.id,
          name: svc.name,
          baseUrl: svc.baseUrl,
          endpoints: svc.endpoints.map((ep) => ({
            method: ep.method,
            path: ep.path,
            description: ep.description,
            status: ep.status,
          })),
        }));
      }
    }

    // ── Transcripts ───────────────────────────────────────────────────
    // Access policy: holding a valid brain session implies transcript read permission.
    // All routes are already gated by isAuthorized() + brain existence check before
    // build() is called — no additional transcript-specific auth is required.
    //
    // Promise.all preserves input order regardless of resolution timing,
    // so the sorted `recent` order is maintained in the bundle.
    let transcripts: BundleTranscript[] = [];
    let transcripts_error: TranscriptsError | undefined;
    if (include_transcripts) {
      if (!this.transcriptStore) {
        console.warn('[BundleBuilder] include_transcripts=true but no transcriptStore injected — transcripts will be empty');
        transcripts_error = 'no_transcript_store';
      } else {
        // Capture in local const: TypeScript cannot re-narrow mutable class properties
        // inside async callbacks — the local captures the narrowed non-null reference.
        const transcriptStore = this.transcriptStore;

        // Only list() is wrapped: storage I/O can legitimately fail.
        // sort() and Promise.all() are not caught — a failure there would be a
        // bug (malformed meta, assertion failure) that should surface, not be hidden.
        // Explicit null type makes the "list failed" path unambiguous vs. undefined.
        let metas: TranscriptMeta[] | null = null;
        try {
          metas = await transcriptStore.list(brain.id);
        } catch {
          console.warn('[BundleBuilder] transcriptStore.list() failed — transcripts will be empty');
          transcripts_error = 'fetch_failed';
        }

        if (metas !== null) {
          // Most-recently-updated first, capped to prevent oversized bundles.
          // TODO: if list() returns unbounded results for high-volume brains, consider
          // a server-side limit on the list() call to avoid O(n log n) sort overhead.
          // String comparison on ISO-8601 is locale-independent and correct provided
          // all timestamps are UTC (ending in 'Z') — TranscriptStore always writes UTC.
          const recent = metas
            .slice()
            .sort((a, b) => (b.updated_at > a.updated_at ? 1 : b.updated_at < a.updated_at ? -1 : 0))
            .slice(0, BUNDLE_TRANSCRIPT_LIMIT);

          // Up to BUNDLE_TRANSCRIPT_LIMIT downloads run concurrently — intentionally
          // unbounded since the cap keeps the fan-out small (max 20 requests).
          transcripts = await Promise.all(
            recent.map(async (meta): Promise<BundleTranscript> => {
              const base = {
                filename: meta.filename,
                cli: meta.cli,
                machine_id: meta.machine_id,
                updated_at: meta.updated_at,
                size: meta.size,
              };
              // Uses TRANSCRIPT_INLINE_THRESHOLD — shared with the pull route so
              // bundle and pull responses agree on what "small" means.
              // meta.size comes from storage metadata and is trusted as-is.
              // If metadata is stale (file appended after listing), a larger-than-threshold
              // file may appear small — but the download fallback handles it gracefully.
              if (meta.size < TRANSCRIPT_INLINE_THRESHOLD) {
                // Clear the timer on both paths:
                //   success path — prevents the timer from firing after the download wins
                //   timeout/error path — clearTimeout on an already-fired timer is a no-op (safe)
                // Also suppress any trailing rejection from the download promise in case the
                // timeout wins first but the download later rejects (avoids unhandledRejection).
                // clearTimeout(undefined) is a spec-defined no-op, so | undefined is safe
                // and avoids a definite-assignment assertion.
                let timerId: ReturnType<typeof setTimeout> | undefined;
                const timeout = new Promise<never>((_, reject) => {
                  timerId = setTimeout(
                    () => reject(new Error('download timeout')),
                    BUNDLE_DOWNLOAD_TIMEOUT_MS,
                  );
                });
                const downloadPromise = transcriptStore.download(meta.key);
                downloadPromise.catch(() => {}); // suppress late rejection after timeout wins
                try {
                  const buf = await Promise.race([downloadPromise, timeout]);
                  clearTimeout(timerId);
                  // Guard against stale metadata: if the file grew since list(), don't
                  // silently inline a buffer above the threshold and bloat the bundle.
                  if (buf.byteLength >= TRANSCRIPT_INLINE_THRESHOLD) {
                    console.warn(`[BundleBuilder] ${meta.key} (${buf.byteLength}b) exceeds threshold after download — key-only fallback`);
                    return { ...base, key: meta.key };
                  }
                  return { ...base, content: buf.toString('base64') };
                } catch {
                  clearTimeout(timerId);
                  console.warn(`[BundleBuilder] download failed for ${meta.key} — falling back to key-only`);
                  return { ...base, key: meta.key };
                }
              }
              return { ...base, key: meta.key };
            }),
          );
        }
      }
    }

    // ── Brain assets ──────────────────────────────────────────────────
    let brain_assets: BootBundle['brain_assets'] = null;
    if (include_brain_assets) {
      if (!this.brainAssetStore) {
        console.warn('[BundleBuilder] include_brain_assets=true but no brainAssetStore injected — brain_assets will be null');
      } else {
        // Capture in local const so TypeScript narrows the non-null reference inside async context
        const brainAssetStore = this.brainAssetStore;
        // brain-db-backup/* is a recovery archive, not a live runtime asset.
        // Keeping it out of boot bundles also prevents large SQLite backups from
        // being needlessly hydrated and materialized into fresh workspaces.
        const storedDocs = await brainAssetStore.pull(brain.id, {
          excludePathPrefixes: [BRAIN_DB_BACKUP_PATH_PREFIX],
        }, branch_id);
        const docs = storedDocs.filter((doc) => doc.asset_type !== 'secret');
        brain_assets = docs.map((doc) => ({
          path: doc.path,
          content_base64: doc.content,  // stored as raw base64 — return as-is
          asset_type: doc.asset_type,
          cli: doc.cli,
        }));
      }
    }

    // ── Env vars (base set for any brain worker) ──────────────────────
    const env_vars: Record<string, string> = {
      BRAIN_ID: brain.id,
      BRANCH_ID: branch_id ?? 'default',
    };
    // Repo-less brains expose no repo env vars — there is nothing to clone.
    if (brain.repo_url) {
      env_vars.BRAIN_REPO_URL = brain.repo_url;
      if (brain.repo_branch) env_vars.BRAIN_REPO_BRANCH = brain.repo_branch;
    }

    // Strip internal storage fields from brain before returning
    const { _collection: _, ...cleanBrain } = brain as Brain & { _collection?: string };

    return {
      brain: cleanBrain as Brain,
      repo: {
        url: brain.repo_url,
        branch: brain.repo_branch,
        clone_depth,
      },
      credentials,
      skills,
      memory,
      registry_snapshot,
      transcripts,
      ...(transcripts_error !== undefined && { transcripts_error }),
      brain_assets,
      env_vars,
      ...(toolsets !== undefined && { toolsets }),
      ttl_seconds,
      assembled_at: new Date().toISOString(),
    };
  }
}
