/**
 * lib/brain/project-path.js
 *
 * Shared utility for encoding a filesystem path to the project identifier
 * used in brain.db's `project` column and Claude Code's transcript directory names.
 *
 * Encoding: replace all `/` and `_` characters with `-`.
 * e.g. /Users/kefentse/dev_env/agentbootup → -Users-kefentse-dev-env-agentbootup
 *
 * This mirrors the encoding Claude Code uses for its ~/.claude/projects/<encoded-path>/
 * directories. Both the transcript indexer and the clean-brain-db script must use
 * this same encoding — centralising it here prevents drift.
 */

import path from 'path';

/**
 * Encode an absolute repo path to the project identifier used in brain.db.
 *
 * @param {string} repoPath - absolute or relative path to the repo root
 * @returns {string} encoded project identifier
 */
export function encodeProjectPath(repoPath) {
  return path.resolve(repoPath).replace(/[\/_]/g, '-');
}
