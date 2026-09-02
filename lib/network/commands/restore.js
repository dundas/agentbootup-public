import { extractCwd, getPositionalArgs, hasFlag } from '../args.js';
import fs from 'fs';
import path from 'path';
import { loadNetworkConfig, resolveNetworkConfigPath, resolveProjectPath, validateNetworkConfig } from '../config.js';
import {
  getVaultSecretPath,
  materializePortableAdmpIdentity,
  mergeVaultBrainSecret,
  restoreBrainSecretRecord,
  writeProjectBrainSecret,
} from '../brain/config-portability.js';
import { resolveProjectMetadataPath, restoreFileSnapshot, snapshotFile } from '../brain/project-state.js';
import { getAgentId, resolveProjectAgentId } from '../../project-config.js';

function printUsage(io) {
  io.stdout('Usage: agentbootup restore <project-id> [--cwd <path>]');
}

function resolveProjectEffectiveBrainId(project, networkRoot = '') {
  if (!project || typeof project !== 'object') return '';
  const metadataPath = resolveProjectMetadataPath(project, networkRoot);
  if (metadataPath) return getAgentId(metadataPath) || '';
  return project.agent_id || '';
}

function findConflictingProject(projects, currentProject, brainId, networkRoot = '') {
  if (!brainId) return null;
  return projects.find((row) =>
    row &&
    row !== currentProject &&
    (row.agent_id === brainId || resolveProjectEffectiveBrainId(row, networkRoot) === brainId)
  ) || null;
}

function normalizeNetworkProjectAgentId(networkRoot, projectId, projectRoot, brainId) {
  if (!brainId) return { ok: true, changed: false, previousRaw: '' };
  const configPath = resolveNetworkConfigPath(networkRoot);
  const previousRaw = fs.readFileSync(configPath, 'utf-8');
  const raw = JSON.parse(previousRaw);
  if (!Array.isArray(raw.projects)) return { ok: true, changed: false, previousRaw: '' };
  let changed = false;
  for (const project of raw.projects) {
    const matchesId = project?.id === projectId;
    const matchesPath =
      typeof project?.path === 'string' &&
      resolveProjectPath(project.path, networkRoot) === projectRoot;
    if (!matchesId && !matchesPath) continue;
    if (project.agent_id === brainId) return { ok: true, changed: false, previousRaw: '' };
    const duplicate = raw.projects.find((row) =>
      row !== project &&
      typeof row?.agent_id === 'string' &&
      row.agent_id === brainId
    );
    if (duplicate) {
      throw new Error(`agent_id ${brainId} already belongs to project ${duplicate.id || '(unknown)'}`);
    }
    project.agent_id = brainId;
    changed = true;
    break;
  }
  if (changed) {
    const validation = validateNetworkConfig(raw);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
  }
  return { ok: true, changed, previousRaw: changed ? previousRaw : '' };
}

function rollbackNetworkProjectAgentId(networkRoot, previousRaw) {
  if (!networkRoot || !previousRaw) return;
  fs.writeFileSync(resolveNetworkConfigPath(networkRoot), previousRaw);
}

export function runRestoreCommand(args, io) {
  const extracted = extractCwd(args);
  const localArgs = extracted.args;
  const [projectId = ''] = getPositionalArgs(localArgs, ['--cwd']);

  if (hasFlag(localArgs, '--help') || hasFlag(localArgs, '-h')) {
    printUsage(io);
    return 0;
  }

  if (!projectId) {
    io.stderr('restore failed: missing <project-id>');
    printUsage(io);
    return 1;
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(extracted.cwd);
  } catch (err) {
    io.stderr(`restore failed: ${err.message}`);
    return 1;
  }

  if (loaded.config.role !== 'network') {
    io.stderr('restore failed: command requires role "network"');
    return 1;
  }

  const project = (loaded.config.projects || []).find((item) => item.id === projectId);
  if (!project) {
    io.stderr(`restore failed: unknown project ${projectId}`);
    return 1;
  }

  if (!project.path) {
    io.stderr(`restore failed: project ${projectId} is not linked (run 'brain link ${project.agent_id} --path <dir>')`);
    return 1;
  }
  const legacyBrainId = project.agent_id;
  const projectMetadataPath = resolveProjectMetadataPath(project, extracted.cwd) || project.path;
  let resolvedBrainId;
  let conflictingProject;
  try {
    resolvedBrainId = resolveProjectAgentId(projectMetadataPath);
    conflictingProject = resolvedBrainId
      ? findConflictingProject(loaded.config.projects || [], project, resolvedBrainId, extracted.cwd)
      : null;
  } catch (err) {
    io.stderr(`restore failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (conflictingProject) {
    io.stderr(
      `restore failed: local brain id ${resolvedBrainId} already belongs to project ${conflictingProject.id || '(unknown)'}`
    );
    return 1;
  }
  let normalization = { ok: true, changed: false, previousRaw: '' };
  if (resolvedBrainId && legacyBrainId !== resolvedBrainId) {
    try {
      normalization = normalizeNetworkProjectAgentId(extracted.cwd, project.id, projectMetadataPath, resolvedBrainId);
    } catch (err) {
      io.stderr(`restore failed: unable to update network config agent_id (${err.message})`);
      return 1;
    }
    if (!normalization.ok) {
      io.stderr('restore failed: unable to update network config agent_id');
      return 1;
    }
  }

  let restored;
  try {
    restored = restoreBrainSecretRecord(extracted.cwd, resolvedBrainId, {
      fallbackIds: [legacyBrainId],
    });
  } catch (err) {
    if (normalization.changed) {
      try {
        rollbackNetworkProjectAgentId(extracted.cwd, normalization.previousRaw);
      } catch {}
    }
    io.stderr(`restore failed: ${err.message}`);
    return 1;
  }
  const secret = restored.secret && typeof restored.secret === 'object'
    ? { ...restored.secret }
    : {};
  const hasPortableAdmpKeyMaterial =
    (typeof secret.secret_key === 'string' && secret.secret_key.trim()) ||
    (typeof secret.admp_public_key === 'string' && secret.admp_public_key.trim());
  if (
    restored.admpAgentId &&
    (
      hasPortableAdmpKeyMaterial ||
      !secret.admp_agent_id ||
      (typeof secret.admp_agent_id === 'string' && !secret.admp_agent_id.trim())
    )
  ) {
    secret.admp_agent_id = restored.admpAgentId;
  }

  let targetPath = '';
  if (resolvedBrainId && (restored.agentId !== resolvedBrainId || restored.usedFallbackData)) {
    const migratedVaultPath = getVaultSecretPath(extracted.cwd, resolvedBrainId);
    const vaultSnapshot = snapshotFile(migratedVaultPath);
    try {
      mergeVaultBrainSecret(extracted.cwd, resolvedBrainId, secret, {
        fallbackIds: [restored.agentId, legacyBrainId],
      });
    } catch (err) {
      if (normalization.changed) {
        try {
          rollbackNetworkProjectAgentId(extracted.cwd, normalization.previousRaw);
        } catch {}
      }
      io.stderr(`restore failed: failed to update migrated vault secret (${err.message})`);
      return 1;
    }
    try {
      targetPath = writeProjectBrainSecret(projectMetadataPath, secret);
    } catch (err) {
      try {
        restoreFileSnapshot(migratedVaultPath, vaultSnapshot);
      } catch {}
      if (normalization.changed) {
        try {
          rollbackNetworkProjectAgentId(extracted.cwd, normalization.previousRaw);
        } catch {}
      }
      io.stderr(`restore failed: ${err.message}`);
      return 1;
    }
  }
  if (!targetPath) {
    try {
      targetPath = writeProjectBrainSecret(projectMetadataPath, secret);
    } catch (err) {
      if (normalization.changed) {
        try {
          rollbackNetworkProjectAgentId(extracted.cwd, normalization.previousRaw);
        } catch {}
      }
      io.stderr(`restore failed: ${err.message}`);
      return 1;
    }
  }
  let admpResult = { changed: false, filePath: '' };
  try {
    admpResult = materializePortableAdmpIdentity(secret, resolvedBrainId);
  } catch (err) {
    io.stderr(`restore warning: failed to materialize ADMP identity (${err.message})`);
  }

  io.stdout(`Restored secrets for ${project.id}`);
  io.stdout(`Updated ${targetPath}`);
  if (admpResult.changed) {
    io.stdout(`Materialized ADMP identity at ${admpResult.filePath}`);
  }
  io.stdout('note: restore complete; optional ADMP re-registration remains manual');
  return 0;
}
