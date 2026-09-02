/**
 * skill-usage-selector.js — telemetry-driven bundle selection for `bundle rollout`.
 *
 * Fetches a target brain's skill-usage telemetry from the hosted brain-assets
 * server and returns the set of skill names that brain actually uses. Used by
 * the `telemetry` selector in `bundle rollout` to install only the skills a
 * brain needs — instead of pushing all 32 sync:all skills to every brain.
 *
 * Data flow:
 *   Brain runs friction-candidates → writes memory/self-improve/skill-usage.json
 *   brain-asset-sync daemon (30s poll) → pushes to hosted server
 *   This module → pulls from hosted server → returns used skill names + core
 *
 * Why this lives here (not in the brain):
 *   agentbootup may be on a different machine from the target brain. The
 *   telemetry must be fetched from the central server, not the brain's local
 *   filesystem. The brain-asset-sync daemon already pushes it there.
 */

import { readCredentials } from '../auth/credentials.js';
import { pullRemoteJsonAsset, createBoundedMemoryFetch } from '../memory/remote-store.js';

/**
 * Skills every brain needs regardless of telemetry. These are the infra a brain
 * needs to function as a brain — messaging, memory, search, skill authoring.
 * Without these, a brain can't receive work orders, manage memory, or query
 * transcripts. They're always installed, even if the brain hasn't used them
 * recently (cold-start safety for critical infra).
 */
export const CORE_SKILLS = Object.freeze([
  // Messaging — a brain that can't communicate isn't a brain
  'cross-brain-message',
  'brain-message-inbox',
  // Memory operations
  'memory-manager',
  // Self-improvement infra (chicken-and-egg: can't telemetry-select the miner)
  'self-improvement',
  'skill-doctor',
  // Skill authoring
  'skill-creator',
  // Search (transcript-query is a dependency of self-improvement)
  'transcript-query',
  'brain-search',
  // Standing orders / protocols
  'brain-protocols',
]);

/**
 * The path to the skill-usage telemetry file, relative to the project root.
 * This matches the path that friction-candidates.ts writes and that
 * brain-asset-sync pushes to the server.
 */
const SKILL_USAGE_ASSET_PATH = 'memory/self-improve/skill-usage.json';

/**
 * Fetch a brain's skill-usage telemetry from the hosted server and return the
 * set of skill names that brain should receive.
 *
 * @param {string} brainId — the target brain's agent_id
 * @param {{ fetchFn?: Function }} [opts]
 * @returns {Promise<{ skills: Set<string>, source: string, usageData: object | null }>}
 *   - skills: the union of CORE_SKILLS + skills with use_count > 0
 *   - source: 'telemetry' if usage data was found, 'core-only' if not
 *   - usageData: the raw parsed skill-usage index (for logging/debugging)
 */
export async function resolveTelemetrySkills(brainId, opts = {}) {
  const fetchFn = opts.fetchFn ?? createBoundedMemoryFetch();
  const readCreds = opts.readCredentialsFn ?? readCredentials;

  const skills = new Set(CORE_SKILLS);

  let usageData = null;
  let source = 'core-only';

  try {
    const creds = await readCreds();
    if (!creds || !creds.apiKey || !creds.serverUrl) {
      // No credentials — fall back to core-only. Don't fail the rollout.
      return { skills, source: 'core-only (no credentials)', usageData: null };
    }

    const remote = {
      serverUrl: creds.serverUrl,
      brainId,
      apiKey: creds.apiKey,
    };

    usageData = await pullRemoteJsonAsset({
      remote,
      path: SKILL_USAGE_ASSET_PATH,
      fetchFn,
    });

    if (usageData && typeof usageData === 'object' && usageData.skills) {
      const used = Object.entries(usageData.skills)
        .filter(([, entry]) => entry && entry.use_count > 0)
        .map(([name]) => name);
      for (const name of used) {
        skills.add(name);
      }
      source = `telemetry (${used.length} used + ${CORE_SKILLS.length} core)`;
    }
  } catch (err) {
    // Telemetry unavailable (brain not provisioned, server unreachable, file
    // not pushed yet). Fall back to core-only — don't fail the rollout.
    const msg = err instanceof Error ? err.message : String(err);
    return { skills, source: `core-only (telemetry unavailable: ${msg})`, usageData: null };
  }

  return { skills, source, usageData };
}

/**
 * Filter a list of discovered bundle manifest paths to only those matching
 * the telemetry-selected skill names.
 *
 * @param {string[]} allManifestPaths — all discovered skill-bundle-manifest.json paths
 * @param {Set<string>} skillNames — the skills to install (from resolveTelemetrySkills)
 * @param {Function} loadManifestFn — function(path) → { manifest, raw } (injected for testability)
 * @returns {string[]} filtered manifest paths
 */
export function filterManifestsBySkillNames(allManifestPaths, skillNames, loadManifestFn) {
  return allManifestPaths.filter((manifestPath) => {
    const { manifest } = loadManifestFn(manifestPath);
    return skillNames.has(manifest.bundle_name);
  });
}
