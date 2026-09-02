/**
 * Skill-Projection Backend Interface
 *
 * Defines the contract for skill storage backends. Implementations:
 *   - StaticBackend     — read-only, maps .claude/skills/ directory structure
 *   - MechStorageBackend — read/write, {agentId}-skills collection on storage.mechdna.net
 *
 * Collection naming: {agentId}-skills  (e.g. "signal.gm-skills")
 * Auth: ~/.agentbootup/credentials (same as brain asset sync)
 */

/**
 * A managed skill — a named block of markdown content belonging to a scope.
 *
 * @typedef {Object} Skill
 * @property {string|undefined} [id] — Unique identifier (UUID); omit or leave undefined for new skills
 * @property {string} name        — Human-readable skill name (e.g. "response-format")
 * @property {string} content     — Markdown content
 * @property {'master'|'tenant'} scope — 'master' applies to all tenants; 'tenant' is tenant-specific
 * @property {string|null} tenantId   — agent_id of the brain project (null for master-scoped)
 * @property {string} createdAt   — ISO 8601 timestamp
 * @property {string} updatedAt   — ISO 8601 timestamp
 */

/**
 * A snapshot of a skill's state before a mutation.
 *
 * @typedef {Object} SkillVersion
 * @property {string} id          — Unique identifier (UUID)
 * @property {string} skillId     — References the parent Skill.id
 * @property {number} versionNum  — 1-based, monotonically increasing per skill
 * @property {string} name        — Skill name at the time of this snapshot
 * @property {string} content     — Skill content at the time of this snapshot
 * @property {string} savedBy     — agent_id or user identifier that triggered the mutation
 * @property {string|null} note   — Optional description (e.g. "Replaced by restore of v3")
 * @property {string} createdAt   — ISO 8601 timestamp
 */

/**
 * Pluggable backend interface for skill storage.
 *
 * All methods are async. Implementations must handle their own error wrapping —
 * callers (SkillProjector) expect thrown errors to be descriptive.
 *
 * @typedef {Object} SkillBackend
 *
 * @property {(scope: 'master'|'tenant', tenantId?: string) => Promise<Skill[]>} loadSkills
 *   Load skills filtered by scope. For 'tenant' scope, tenantId is required.
 *
 * @property {(scope: 'master'|'tenant', tenantId?: string) => Promise<string|null>} loadAgentConfig
 *   Load the agent config content for the given scope/tenant. Returns null if not set.
 *
 * @property {(skill: Skill) => Promise<Skill>} saveSkill
 *   Persist a skill. Returns the saved skill with id set (new id on creation, same id on update).
 *   Callers must use the returned Skill — do not rely on input mutation.
 *
 * @property {(skillId: string) => Promise<void>} deleteSkill
 *   Remove a skill by ID. No-op if not found.
 *
 * @property {(skillId: string) => Promise<SkillVersion[]>} loadVersions
 *   Load version history for a skill, sorted by versionNum descending.
 *   Returns [] if no history exists (e.g. StaticBackend).
 *
 * @property {(skillId: string, versionNum: number, savedBy: string) => Promise<void>} restoreVersion
 *   Restore a skill to a previous version. Snapshots current state (with savedBy attribution)
 *   before restoring. savedBy should be the agent_id or user identifier triggering the restore.
 *
 * @property {(skillId: string, name: string, content: string, savedBy: string, note?: string) => Promise<void>} saveVersion
 *   Snapshot the current state of a skill BEFORE a mutation. Trims to 20 versions.
 *   Called by SkillProjector (or API handlers) before mutations — NOT called internally
 *   by saveSkill/deleteSkill. Callers are responsible for invoking this before mutations.
 *   savedBy should be the agent_id or user identifier that triggered the mutation.
 */

/**
 * Optional extension method implemented by MechStorageBackend.
 * Not part of the core SkillBackend interface; cast to MechStorageBackend before calling.
 *
 * @typedef {Object} MechSkillBackend
 * @augments SkillBackend
 * @property {() => Promise<boolean>} isEmptyStore
 *   Returns true when the skills collection has no documents.
 *   Used by daemon startup for fail-fast checks.
 */

// MechStorageError lives in backends/errors.js — import from there or from the module index.
