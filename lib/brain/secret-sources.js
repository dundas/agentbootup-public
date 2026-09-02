/**
 * Allowlist of relative paths (from project root) that are synced as "secrets"
 * when the user runs `agentbootup secrets push` / `agentbootup secrets pull`.
 *
 * Only these paths are included; the daemon never syncs them. Manual only.
 */

// Compatibility re-export. The canonical allowlist is shared with the server
// validator so these paths can never silently drift between client and server.
export { SECRET_REL_PATHS } from './asset-contract.js';
