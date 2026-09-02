/**
 * skill-projection — shared skill storage and CLAUDE.md projection module.
 *
 * Usage:
 *   import { SkillProjector, StaticBackend, MechStorageBackend } from '../skill-projection/index.js';
 *
 * Backends:
 *   - StaticBackend        read-only, reads from .claude/skills/ directory tree
 *   - MechStorageBackend   canonical, reads/writes {agentId}-skills collection
 *
 * Projector:
 *   - SkillProjector       generates CLAUDE.md per tenant, syncs to disk atomically,
 *                          hash-based no-op, orphan cleanup
 */

export { MechStorageError } from './backends/errors.js';
export { MechStorageBackend } from './backends/mech-storage.js';
export { nextVersionNum, trimVersions, buildVersionEntry } from './versions.js';
export { SkillProjector } from './projector.js';
export { StaticBackend } from './backends/static.js';
export { hashContent, readFileHash } from './hash.js';

