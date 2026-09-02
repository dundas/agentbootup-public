import fs from 'fs';
import os from 'os';
import path from 'path';

const ADMP_SECRET_FIELDS = ['secret_key', 'admp_public_key', 'admp_agent_id', 'admp_hub_url', 'admp_registered_at'];
const SECRET_KEYS = ['brain_api_key', 'admp_agent_token', ...ADMP_SECRET_FIELDS];
const RESERVED_AGENT_ID_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

function resolveAdmpHomeDir(options = {}) {
  return options.homeDir || process.env.AGENTBOOTUP_ADMP_HOME || os.homedir();
}

export function splitBrainConfig(config = {}) {
  const committed = {};
  const secret = {};

  for (const [key, value] of Object.entries(config)) {
    if (SECRET_KEYS.includes(key)) {
      if (value != null && value !== '') secret[key] = value;
      continue;
    }
    committed[key] = value;
  }

  return { committed, secret };
}

export function mergeBrainConfig(committed = {}, secret = {}) {
  return { ...committed, ...secret };
}

export function getVaultDir(networkRoot) {
  return path.join(networkRoot, '.agentbootup-vault');
}

export function validatePortableAgentId(agentId) {
  const value = typeof agentId === 'string' ? agentId.trim() : '';
  if (!value || value === '.' || value === '..' || path.isAbsolute(value)) {
    throw new Error(`invalid agent id: ${agentId}`);
  }
  const parts = value.split(/[\\/]+/);
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid agent id: ${agentId}`);
  }
  if (parts.some((part) => RESERVED_AGENT_ID_PARTS.has(part))) {
    throw new Error(`invalid agent id: ${agentId}`);
  }
  return value;
}

export function getVaultSecretPath(networkRoot, agentId) {
  return path.join(getVaultDir(networkRoot), `${validatePortableAgentId(agentId)}-brain-secrets.json`);
}

export function backupBrainSecret(networkRoot, agentId, secret) {
  const vaultDir = getVaultDir(networkRoot);
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(vaultDir, 0o700);
  const target = getVaultSecretPath(networkRoot, agentId);
  fs.writeFileSync(target, JSON.stringify({ agent_id: agentId, secret }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return target;
}

export function mergeVaultBrainSecret(networkRoot, agentId, secret, options = {}) {
  const primary = validatePortableAgentId(agentId);
  const fallbackIds = Array.isArray(options.fallbackIds) ? options.fallbackIds : [];
  const candidates = [primary, ...fallbackIds]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  const existing = {};
  const seen = new Set();
  for (const candidate of [...candidates].reverse()) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const restored = restoreBrainSecret(networkRoot, candidate);
      if (restored && typeof restored === 'object') {
        Object.assign(existing, restored);
      }
    } catch {
      // Continue to the next candidate.
    }
  }
  return backupBrainSecret(networkRoot, primary, {
    ...existing,
    ...(secret && typeof secret === 'object' ? secret : {}),
  });
}

export function restoreBrainSecret(networkRoot, agentId, options = {}) {
  return restoreBrainSecretRecord(networkRoot, agentId, options).secret;
}

export function restoreBrainSecretRecord(networkRoot, agentId, options = {}) {
  const primary = validatePortableAgentId(agentId);
  const fallbackIds = Array.isArray(options.fallbackIds) ? options.fallbackIds : [];
  const candidates = [primary, ...fallbackIds]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  const seen = new Set();
  let lastSource = getVaultSecretPath(networkRoot, primary || 'unknown');
  const mergedSecret = {};
  let primarySecret = {};
  const candidateAgentIds = new Map();
  const candidateSecrets = new Map();
  let found = false;
  let usedFallbackData = false;
  for (const candidate of [...candidates].reverse()) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const source = getVaultSecretPath(networkRoot, candidate);
    lastSource = source;
    if (!fs.existsSync(source)) continue;
    let stat;
    try {
      stat = fs.statSync(source);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(source, 'utf-8'));
    } catch {
      continue;
    }
    found = true;
    const secret = parsed.secret && typeof parsed.secret === 'object' ? parsed.secret : {};
    candidateSecrets.set(candidate, secret);
    if (candidate === primary) {
      primarySecret = { ...secret };
    }
    for (const [key, value] of Object.entries(secret)) {
      const alreadyPresent = key in mergedSecret;
      if (candidate === primary || !alreadyPresent) {
        mergedSecret[key] = value;
      }
      if (candidate !== primary && !alreadyPresent) {
        usedFallbackData = true;
      }
    }
    const candidateAgentId =
      typeof parsed.agent_id === 'string' && parsed.agent_id.trim()
        ? parsed.agent_id.trim()
        : candidate;
    if (candidateAgentId) candidateAgentIds.set(candidate, candidateAgentId);
  }
  if (found) {
    const mergedAgentIdCandidate = candidates.find((candidate) => candidateAgentIds.has(candidate));
    const mergedAgentId = mergedAgentIdCandidate ? candidateAgentIds.get(mergedAgentIdCandidate) : '';
    let admpSourceCandidate = '';
    let admpSourceRecord = null;
    for (const candidate of candidates) {
      const normalized = normalizeAdmpSecretFields(
        candidateSecrets.get(candidate),
        candidateAgentIds.get(candidate) || candidate,
      );
      if (!normalized) continue;
      if (
        !admpSourceRecord ||
        comparePortableAdmpEntryQuality(
          {
            secret_key: admpSourceRecord.secret_key,
            public_key: admpSourceRecord.admp_public_key,
            registered_at: admpSourceRecord.admp_registered_at,
          },
          {
            secret_key: normalized.secret_key,
            public_key: normalized.admp_public_key,
            registered_at: normalized.admp_registered_at,
          },
        ) > 0
      ) {
        admpSourceCandidate = candidate;
        admpSourceRecord = normalized;
      }
    }
    if (admpSourceRecord) {
      for (const field of ['secret_key', 'admp_public_key', 'admp_agent_id', 'admp_registered_at']) {
        delete mergedSecret[field];
      }
      for (const field of ['secret_key', 'admp_public_key', 'admp_agent_id', 'admp_registered_at', 'admp_hub_url']) {
        const value = admpSourceRecord[field];
        if (value == null || value === '') continue;
        mergedSecret[field] = value;
      }
      for (const field of ADMP_SECRET_FIELDS) {
        if (mergedSecret[field] !== primarySecret[field] && admpSourceCandidate !== primary) {
          usedFallbackData = true;
          break;
        }
      }
    }
    const admpAgentId = admpSourceRecord?.admp_agent_id
      ? admpSourceRecord.admp_agent_id
      : mergedAgentId || primary;
    return {
      secret: mergedSecret,
      agentId: mergedAgentId || primary,
      admpAgentId,
      usedFallbackData,
    };
  }
  throw new Error(`No vault secret found for ${primary || 'unknown'} at ${lastSource}`);
}

export function getBrainSecretPath(projectRoot) {
  return path.join(projectRoot, 'brain', 'config.secret.json');
}

export function readProjectBrainSecret(projectRoot) {
  const secretPath = getBrainSecretPath(projectRoot);
  if (!fs.existsSync(secretPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
  } catch (err) {
    throw new Error(`invalid brain secret inventory at ${secretPath}: ${err.message}`);
  }
}

export function writeProjectBrainSecret(projectRoot, secret) {
  const secretPath = getBrainSecretPath(projectRoot);
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, JSON.stringify(secret, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(secretPath, 0o600);
  return secretPath;
}

function admpConfigPaths(homeDir = resolveAdmpHomeDir()) {
  return [
    path.join(homeDir, '.brain', 'brain-inbox', '_admp.json'),
    path.join(homeDir, '.claude', 'brain-inbox', '_admp.json'),
    path.join(homeDir, '.codex', 'brain-inbox', '_admp.json'),
  ];
}

function canonicalAdmpConfigPath(homeDir = resolveAdmpHomeDir()) {
  return path.join(homeDir, '.brain', 'brain-inbox', '_admp.json');
}

function parsePortableAdmpTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return Date.parse(value);
}

function comparePortableAdmpFreshness(current = {}, incoming = {}) {
  const currentTs = parsePortableAdmpTimestamp(current.registered_at);
  const incomingTs = parsePortableAdmpTimestamp(incoming.registered_at);
  if (Number.isFinite(currentTs) && Number.isFinite(incomingTs)) {
    return incomingTs - currentTs;
  }
  if (!Number.isFinite(currentTs) && Number.isFinite(incomingTs)) return 1;
  if (Number.isFinite(currentTs) && !Number.isFinite(incomingTs)) return -1;
  return 0;
}

function isCompletePortableAdmpEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return (
    typeof entry.secret_key === 'string' &&
    entry.secret_key.trim() !== '' &&
    typeof entry.public_key === 'string' &&
    entry.public_key.trim() !== ''
  );
}

function portableAdmpEntryScore(entry = {}) {
  const hasSecretKey = typeof entry.secret_key === 'string' && entry.secret_key.trim() !== '';
  const hasPublicKey =
    (typeof entry.public_key === 'string' && entry.public_key.trim() !== '') ||
    (typeof entry.admp_public_key === 'string' && entry.admp_public_key.trim() !== '');
  if (hasSecretKey && hasPublicKey) return 2;
  if (hasSecretKey) return 1;
  if (hasPublicKey) return 0;
  return -1;
}

function comparePortableAdmpEntryQuality(current = {}, incoming = {}) {
  const currentScore = portableAdmpEntryScore(current);
  const incomingScore = portableAdmpEntryScore(incoming);
  if (currentScore !== incomingScore) {
    return incomingScore - currentScore;
  }
  return comparePortableAdmpFreshness(current, incoming);
}

function normalizeAdmpSecretFields(secret = {}, fallbackAgentId = '') {
  if (!secret || typeof secret !== 'object') return null;
  const secretKey = typeof secret.secret_key === 'string' ? secret.secret_key.trim() : '';
  const publicKey =
    typeof secret.admp_public_key === 'string' && secret.admp_public_key.trim()
      ? secret.admp_public_key.trim()
      : typeof secret.public_key === 'string' && secret.public_key.trim()
        ? secret.public_key.trim()
        : '';
  if (!secretKey && !publicKey) return null;
  return {
    ...(secretKey ? { secret_key: secretKey } : {}),
    ...(publicKey ? { admp_public_key: publicKey } : {}),
    ...(typeof secret.admp_agent_id === 'string' && secret.admp_agent_id.trim()
      ? { admp_agent_id: secret.admp_agent_id.trim() }
      : fallbackAgentId
        ? { admp_agent_id: fallbackAgentId }
        : {}),
    ...(typeof secret.admp_hub_url === 'string' && secret.admp_hub_url.trim()
      ? { admp_hub_url: secret.admp_hub_url.trim() }
      : {}),
    ...(typeof secret.admp_registered_at === 'string' && secret.admp_registered_at.trim()
      ? { admp_registered_at: secret.admp_registered_at.trim() }
      : {}),
  };
}

function mergePortableAdmpConfigs(configs = []) {
  const merged = { agents: Object.create(null) };
  for (const config of configs) {
    if (!config || typeof config !== 'object') continue;
    if (typeof merged.hub_url !== 'string' || !merged.hub_url.trim()) {
      if (typeof config.hub_url === 'string' && config.hub_url.trim()) {
        merged.hub_url = config.hub_url.trim();
      }
    }
    const agents = config.agents;
    if (!agents || typeof agents !== 'object') continue;
    for (const [agentId, entry] of Object.entries(agents)) {
      if (!entry || typeof entry !== 'object') continue;
      const current = merged.agents[agentId] && typeof merged.agents[agentId] === 'object'
        ? merged.agents[agentId]
        : null;
      if (!current) {
        merged.agents[agentId] = { ...entry };
        continue;
      }

      const currentComplete = isCompletePortableAdmpEntry(current);
      const nextComplete = isCompletePortableAdmpEntry(entry);
      if (!currentComplete && nextComplete) {
        merged.agents[agentId] = { ...current, ...entry };
        continue;
      }
      if (currentComplete && nextComplete && comparePortableAdmpFreshness(current, entry) > 0) {
        merged.agents[agentId] = { ...current, ...entry };
        continue;
      }

      const nextEntry = { ...current };
      for (const [key, value] of Object.entries(entry)) {
        if (nextEntry[key] == null || nextEntry[key] === '') {
          nextEntry[key] = value;
        }
      }
      merged.agents[agentId] = nextEntry;
    }
  }
  return merged;
}

export function readPortableAdmpConfig(options = {}) {
  const homeDir = resolveAdmpHomeDir(options);
  const configs = [];
  for (const filePath of admpConfigPaths(homeDir)) {
    if (!fs.existsSync(filePath)) continue;
    try {
      configs.push(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    } catch {
      // Ignore malformed legacy files and keep scanning later fallbacks.
    }
  }
  return {
    filePath: canonicalAdmpConfigPath(homeDir),
    config: mergePortableAdmpConfigs(configs),
  };
}

export function extractPortableAdmpIdentity(agentId, options = {}) {
  const primary = typeof agentId === 'string' ? agentId.trim() : '';
  const fallbackIds = Array.isArray(options.fallbackIds) ? options.fallbackIds : [];
  const candidates = [primary, ...fallbackIds]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  if (candidates.length === 0) return null;
  const { config } = readPortableAdmpConfig(options);
  let best = null;
  for (const candidate of candidates) {
    const entry = config?.agents?.[candidate];
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.secret_key !== 'string' || entry.secret_key.trim() === '') continue;
    const normalized = {
      secret_key: entry.secret_key,
      ...(typeof entry.public_key === 'string' && entry.public_key.trim()
        ? { admp_public_key: entry.public_key }
        : {}),
      admp_agent_id:
        typeof entry.admp_agent_id === 'string' && entry.admp_agent_id.trim()
          ? entry.admp_agent_id.trim()
          : candidate,
      ...(typeof entry.hub_url === 'string' && entry.hub_url.trim()
        ? { admp_hub_url: entry.hub_url.trim() }
        : typeof config?.hub_url === 'string' && config.hub_url.trim()
          ? { admp_hub_url: config.hub_url.trim() }
          : {}),
      ...(typeof entry.registered_at === 'string' && entry.registered_at.trim()
        ? { admp_registered_at: entry.registered_at.trim() }
        : {}),
    };
    if (
      !best ||
      comparePortableAdmpEntryQuality(
        {
          secret_key: best.secret_key,
          public_key: best.admp_public_key,
          registered_at: best.admp_registered_at,
        },
        {
          secret_key: normalized.secret_key,
          public_key: normalized.admp_public_key,
          registered_at: normalized.admp_registered_at,
        },
      ) > 0
    ) {
      best = normalized;
    }
  }
  return best;
}

export function mergeMissingPortableAdmpIdentity(secret = {}, agentId, options = {}) {
  return mergePortableAdmpIdentity(secret, agentId, options);
}

export function mergePortableAdmpIdentity(secret = {}, agentId, options = {}) {
  const existing = secret && typeof secret === 'object' ? { ...secret } : {};
  const portable = extractPortableAdmpIdentity(agentId, options);
  if (!portable) return { secret: existing, changed: false };

  const refresh = options.refresh === true;
  const refreshAllowed =
    refresh &&
    comparePortableAdmpFreshness(
      {
        registered_at: existing.admp_registered_at,
      },
      {
        registered_at: portable.admp_registered_at,
      },
    ) > 0;
  let changed = false;
  for (const field of ADMP_SECRET_FIELDS) {
    const nextValue = portable[field];
    if (nextValue == null || nextValue === '') continue;
    if (!refreshAllowed && existing[field] != null && existing[field] !== '') continue;
    if (existing[field] === nextValue) continue;
    existing[field] = nextValue;
    changed = true;
  }
  return { secret: existing, changed };
}

export function materializePortableAdmpIdentity(secret = {}, agentId, options = {}) {
  const value = typeof agentId === 'string' ? agentId.trim() : '';
  const homeDir = resolveAdmpHomeDir(options);
  const filePath = canonicalAdmpConfigPath(homeDir);
  const secretKey = typeof secret.secret_key === 'string' ? secret.secret_key.trim() : '';
  if (!value || !secretKey) return { changed: false, filePath };

  const { config } = readPortableAdmpConfig({ homeDir });
  const nextConfig = config && typeof config === 'object' ? structuredClone(config) : { agents: {} };
  if (!nextConfig.agents || typeof nextConfig.agents !== 'object') nextConfig.agents = Object.create(null);
  else nextConfig.agents = Object.assign(Object.create(null), nextConfig.agents);

  const hubUrl = typeof secret.admp_hub_url === 'string' && secret.admp_hub_url.trim()
    ? secret.admp_hub_url.trim()
    : typeof nextConfig.hub_url === 'string' && nextConfig.hub_url.trim()
      ? nextConfig.hub_url.trim()
      : '';
  if (hubUrl) nextConfig.hub_url = hubUrl;

  const nextEntry = {
    admp_agent_id:
      typeof secret.admp_agent_id === 'string' && secret.admp_agent_id.trim()
        ? secret.admp_agent_id.trim()
        : value,
    secret_key: secretKey,
    ...(typeof secret.admp_public_key === 'string' && secret.admp_public_key.trim()
      ? { public_key: secret.admp_public_key }
      : {}),
    ...(hubUrl ? { hub_url: hubUrl } : {}),
    ...(typeof secret.admp_registered_at === 'string' && secret.admp_registered_at.trim()
      ? { registered_at: secret.admp_registered_at.trim() }
      : {}),
  };

  const currentSerialized = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : '';
  const currentEntry =
    nextConfig.agents[value] && typeof nextConfig.agents[value] === 'object'
      ? nextConfig.agents[value]
      : {};
  const secretKeyChanged =
    typeof currentEntry.secret_key === 'string' &&
    currentEntry.secret_key.trim() &&
    currentEntry.secret_key.trim() !== secretKey;
  nextConfig.agents[value] = {
    ...currentEntry,
    ...nextEntry,
  };
  if (
    secretKeyChanged &&
    !(typeof secret.admp_public_key === 'string' && secret.admp_public_key.trim())
  ) {
    delete nextConfig.agents[value].public_key;
  }
  const nextSerialized = JSON.stringify(nextConfig, null, 2) + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  if (currentSerialized === nextSerialized) {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, 0o600);
    }
    return { changed: false, filePath };
  }

  fs.writeFileSync(filePath, nextSerialized, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return { changed: true, filePath };
}
