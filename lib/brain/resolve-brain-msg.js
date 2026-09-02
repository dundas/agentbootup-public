/**
 * Resolve brain-msg.ts for ADMP registration (PRD-0040 FR-1b).
 * Canonical: brain/brain-msg.ts (Channel B). Legacy: skill-bundled shim.
 */

import fs from 'fs';
import path from 'path';

/**
 * @param {string} target  Project root
 * @returns {string|null} Absolute path to brain-msg.ts, or null if missing
 */
export function resolveBrainMsgScript(target) {
  const root = path.resolve(target);
  const candidates = [
    path.join(root, 'brain', 'brain-msg.ts'),
    path.join(root, '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
