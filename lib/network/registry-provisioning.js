import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isIP } from 'node:net';
import { writeFileAtomic } from '../brain/io-utils.js';

const REGISTRY_CAPABILITIES = new Set([
  'docs:read',
  'docs:search',
  'catalog:read',
  'package:read',
  'package:publish',
  'registry:upsert',
]);
const DEFAULT_REGISTRY_CAPABILITIES = ['catalog:read', 'docs:read', 'docs:search'];
const REGISTRY_REQUEST_TIMEOUT_MS = 10_000;

function ensureDir(dirPath, mode = 0o700) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  if (process.platform !== 'win32') {
    fs.chmodSync(dirPath, mode);
  }
}

function registryRootUrl() {
  return process.env.MECH_REGISTRY_ROOT_URL || 'https://registry.mechdna.net';
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeFileAtomicWithMode(filePath, content, mode) {
  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    if (process.platform !== 'win32') {
      fs.fchmodSync(fd, mode);
    }
    fs.writeFileSync(fd, content);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(filePath, mode);
      } catch {
        // best-effort; temp file was already created with restrictive mode
      }
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore cleanup failure
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function registryHost(rootUrl) {
  try {
    return new URL(rootUrl).host;
  } catch {
    throw new Error(`invalid_registry_root_url:${rootUrl}`);
  }
}

function registryUrl(rootUrl) {
  try {
    return new URL(rootUrl);
  } catch {
    throw new Error(`invalid_registry_root_url:${rootUrl}`);
  }
}

function isSecureRegistryRoot(rootUrl) {
  try {
    const parsed = registryUrl(rootUrl);
    if (parsed.protocol === 'https:') return true;
    // Fail closed by default; only explicit loopback hosts may receive bootstrap tokens over http.
    // Bun may preserve brackets for bracketed IPv6 literals, so strip one outer pair when present.
    const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
    if (host === 'localhost') return true;
    if (isIP(host) === 4) {
      // `isIP(host) === 4` already validated the dotted-quad format and octet ranges.
      return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    }
    if (isIP(host) === 6) {
      // Only pure-hex IPv6 loopback literals are accepted for insecure http roots.
      // Embedded IPv4 forms stay fail-closed.
      if (host.includes('.')) return false;
      const [leftRaw, rightRaw = ''] = host.split('::');
      if (host.split('::').length > 2) return false;
      const left = leftRaw ? leftRaw.split(':') : [];
      const right = rightRaw ? rightRaw.split(':') : [];
      const hasCompression = host.includes('::');
      if ((!hasCompression && left.length !== 8) || left.some((part) => part === '') || right.some((part) => part === '')) {
        return false;
      }
      const missing = hasCompression ? 8 - (left.length + right.length) : 0;
      if (missing < 0) return false;
      const expanded = [...left, ...Array(missing).fill('0'), ...right].map((part) => Number.parseInt(part || '0', 16));
      return expanded.length === 8 &&
        expanded.slice(0, 7).every((part) => part === 0) &&
        expanded[7] === 1;
    }
    return false;
  } catch {
    return false;
  }
}

function buildDid(publicKeyPem) {
  return `did:seed:${sha256Hex(publicKeyPem)}`;
}

function brainConfigPath(projectPath) {
  return path.join(projectPath, 'brain', 'config.json');
}

function brainSecretPath(projectPath) {
  return path.join(projectPath, 'brain', 'config.secret.json');
}

function loadBrainConfig(projectPath) {
  return readJson(brainConfigPath(projectPath), {});
}

function loadBrainSecret(projectPath) {
  return readJson(brainSecretPath(projectPath), {});
}

function existingRegistryIdentityState(projectPath) {
  const committed = loadBrainConfig(projectPath);
  const secret = loadBrainSecret(projectPath);
  const identity = committed.registry?.identity;
  const existingPrivateKey = typeof secret.registry_private_key === 'string'
    ? secret.registry_private_key
    : null;
  return { committed, secret, identity, existingPrivateKey };
}

function saveBrainConfig(projectPath, config) {
  writeFileAtomic(brainConfigPath(projectPath), `${JSON.stringify(config, null, 2)}\n`);
}

function saveBrainConfigIfChanged(projectPath, previousConfig, nextConfig) {
  if (JSON.stringify(previousConfig) === JSON.stringify(nextConfig)) return;
  saveBrainConfig(projectPath, nextConfig);
}

function saveBrainSecret(projectPath, secret) {
  const secretPath = brainSecretPath(projectPath);
  writeFileAtomicWithMode(secretPath, `${JSON.stringify(secret, null, 2)}\n`, 0o600);
}

function registryStateDir() {
  return process.env.AGENTBOOTUP_REGISTRY_STATE_DIR ||
    path.join(os.homedir(), '.agentbootup', 'registry-tokens');
}

function safeAgentIdPathComponent(agentId) {
  if (!/^[A-Za-z0-9._-]+$/.test(agentId)) {
    throw new Error(`invalid_agent_id_for_path:${agentId}`);
  }
  return agentId;
}

function inspectTokenOverride() {
  const override = process.env.AGENTBOOTUP_REGISTRY_TOKEN_FILE;
  if (!override) {
    return { override: null, shared: false, explicitPerAgent: false, error: null };
  }
  if (override.includes('{agentId}')) {
    return { override, shared: false, explicitPerAgent: true, error: null };
  }
  if (override.endsWith('/') || override.endsWith(path.sep)) {
    return { override, shared: false, explicitPerAgent: true, error: null };
  }
  try {
    const stat = fs.statSync(override);
    if (stat.isDirectory()) {
      return { override, shared: false, explicitPerAgent: true, error: null };
    }
    if (stat.isFile()) {
      return { override, shared: true, explicitPerAgent: false, error: null };
    }
    return {
      override,
      shared: false,
      explicitPerAgent: false,
      error: 'ambiguous_token_override',
      errorCode: 'UNSUPPORTED_FILE_TYPE',
    };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
    if (code === 'ENOENT') {
      return {
        override,
        shared: false,
        explicitPerAgent: false,
        error: 'ambiguous_token_override',
        errorCode: code,
      };
    }
    return {
      override,
      shared: false,
      explicitPerAgent: false,
      error: 'token_override_stat_error',
      errorCode: code,
    };
  }
}

function resolveTokenOverride(agentId, inspection) {
  const safeAgentId = safeAgentIdPathComponent(agentId);
  if (!inspection.override) {
    return { path: path.join(registryStateDir(), `${safeAgentId}.token`), shared: false, explicitPerAgent: false };
  }
  if (!inspection.shared) {
    if (inspection.override.includes('{agentId}')) {
      return { path: inspection.override.replaceAll('{agentId}', safeAgentId), shared: false, explicitPerAgent: true };
    }
    return { path: path.join(inspection.override, `${safeAgentId}.token`), shared: false, explicitPerAgent: true };
  }
  // Per-agent directory semantics must be explicit via a trailing separator, template token,
  // or a path that already exists as a directory. Everything else is treated as a shared file.
  return { path: inspection.override, shared: true, explicitPerAgent: false };
}

export function registryTokenPathForAgent(agentId, inspection = inspectTokenOverride()) {
  return resolveTokenOverride(agentId, inspection).path;
}

export function normalizeRegistryCapabilities(input) {
  const raw = Array.isArray(input) ? input : DEFAULT_REGISTRY_CAPABILITIES;
  const normalized = [...new Set(raw
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => REGISTRY_CAPABILITIES.has(value))
  )].sort();
  return normalized.length > 0 ? normalized : [...DEFAULT_REGISTRY_CAPABILITIES];
}

function tokenScopesRequireNpm(capabilities) {
  return capabilities.includes('package:read') || capabilities.includes('package:publish');
}

function normalizeScopeList(scopes) {
  return [...new Set((Array.isArray(scopes) ? scopes : [])
    .filter((value) => typeof value === 'string'))].sort();
}

function decodeTokenClaims(token) {
  const parts = String(token || '').split('.');
  const payload = parts.length === 2 ? parts[0] : parts.length === 3 ? parts[1] : null;
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function normalizedTokenScopes(token) {
  const claims = decodeTokenClaims(token);
  if (!claims || !Array.isArray(claims.scopes) || typeof claims.exp !== 'number') {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now + 30) return null;
  return [...new Set(claims.scopes.filter((value) => typeof value === 'string'))].sort();
}

function tokenCoversScopes(token, scopes) {
  const granted = normalizedTokenScopes(token);
  if (!granted) return false;
  const expected = normalizeScopeList(scopes);
  return expected.every((scope) => granted.includes(scope));
}

function tokenScopesMatch(token, scopes) {
  const granted = normalizedTokenScopes(token);
  if (!granted) return false;
  const expected = normalizeScopeList(scopes);
  // Registry exchange is expected to echo the exact requested scope set; mismatches trigger
  // a rewrite so local side effects (notably npm auth state) converge with current capabilities.
  return granted.length === expected.length && expected.every((scope) => granted.includes(scope));
}

function canReuseCachedTokenAfterExchangeFailure(token, scopes) {
  return tokenScopesMatch(token, scopes);
}
function requestedScopesMatchConfig(config, scopes) {
  const configured = normalizeScopeList(config?.registry?.requested_scopes);
  const expected = normalizeScopeList(scopes);
  return configured.length === expected.length && configured.every((scope, index) => scope === expected[index]);
}

function grantedScopesMatchConfig(config, token) {
  const configured = normalizeScopeList(config?.registry?.granted_scopes);
  const granted = normalizedTokenScopes(token);
  if (!granted) return false;
  return configured.length === granted.length && configured.every((scope, index) => scope === granted[index]);
}

function readTokenFile(agentId, inspection) {
  const tokenPath = registryTokenPathForAgent(agentId, inspection);
  try {
    return fs.readFileSync(tokenPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function writeTokenFile(agentId, token, inspection) {
  const tokenPath = registryTokenPathForAgent(agentId, inspection);
  ensureDir(path.dirname(tokenPath), 0o700);
  writeFileAtomicWithMode(tokenPath, `${token}\n`, 0o600);
  return tokenPath;
}

function deleteTokenFile(agentId, inspection) {
  if (inspection.shared) {
    return { deleted: false, skippedShared: true, missing: false, error: null };
  }
  const tokenPath = registryTokenPathForAgent(agentId, inspection);
  try {
    fs.unlinkSync(tokenPath);
    return { deleted: true, skippedShared: false, missing: false, error: null };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { deleted: false, skippedShared: false, missing: true, error: null };
    }
    return {
      deleted: false,
      skippedShared: false,
      missing: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function upsertGitignoreLine(projectPath, line) {
  const filePath = path.join(projectPath, '.gitignore');
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${line}\n`);
    return;
  }
  const current = fs.readFileSync(filePath, 'utf-8');
  const lines = current.split(/\r?\n/);
  if (lines.some((entry) => entry.trim() === line)) return;
  fs.writeFileSync(filePath, current.endsWith('\n') ? current + `${line}\n` : `${current}\n${line}\n`);
}

function ensureMcpSettings(projectPath, rootUrl) {
  const settingsDir = path.join(projectPath, '.claude');
  ensureDir(settingsDir, 0o755);
  const settingsPath = path.join(settingsDir, 'settings.json');
  const current = readJson(settingsPath, {});
  const mcpServers = current.mcpServers && typeof current.mcpServers === 'object'
    ? { ...current.mcpServers }
    : {};
  mcpServers['mech-registry'] = {
    type: 'http',
    url: `${rootUrl.replace(/\/$/, '')}/-/mcp`,
  };
  writeFileAtomic(settingsPath, `${JSON.stringify({ ...current, mcpServers }, null, 2)}\n`);
}

function managedRegistryHosts(lines) {
  const hosts = new Set();
  for (const line of lines) {
    if (!line.startsWith('@mech:registry=')) continue;
    const rawUrl = line.slice('@mech:registry='.length).trim();
    if (!rawUrl) continue;
    try {
      hosts.add(new URL(rawUrl).host);
    } catch {
      // ignore malformed prior lines
    }
  }
  return hosts;
}

function stripCurrentRegistryManagedNpmrc(projectPath, rootUrl) {
  const npmrcPath = path.join(projectPath, '.npmrc');
  if (!fs.existsSync(npmrcPath)) return false;
  const host = registryHost(rootUrl);
  const managedRegistryLine = `@mech:registry=${rootUrl.replace(/\/$/, '')}/npm/`;
  const existingLines = fs.readFileSync(npmrcPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line, index, arr) => line !== '' || index < arr.length - 1);
  const hasCurrentRegistryLine = existingLines.includes(managedRegistryLine);
  const hasCurrentTokenLine = existingLines.some((line) => line.startsWith(`//${host}/npm/:_authToken=`));
  if (!hasCurrentRegistryLine && !hasCurrentTokenLine) return false;
  const nextLines = existingLines.filter((line) => {
    if (line === managedRegistryLine) return false;
    if (line.startsWith(`//${host}/npm/:_authToken=`)) return false;
    return !(line === 'always-auth=true' && hasCurrentRegistryLine);
  });
  if (nextLines.length === 0) {
    fs.unlinkSync(npmrcPath);
    return true;
  }
  writeFileAtomicWithMode(npmrcPath, `${nextLines.join('\n')}\n`, 0o600);
  return true;
}

function readCurrentRegistryManagedNpmrcToken(projectPath, rootUrl) {
  const npmrcPath = path.join(projectPath, '.npmrc');
  if (!fs.existsSync(npmrcPath)) return null;
  const host = registryHost(rootUrl);
  const managedRegistryLine = `@mech:registry=${rootUrl.replace(/\/$/, '')}/npm/`;
  const existingLines = fs.readFileSync(npmrcPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line, index, arr) => line !== '' || index < arr.length - 1);
  if (!existingLines.includes(managedRegistryLine)) return null;
  const tokenLine = existingLines.find((line) => line.startsWith(`//${host}/npm/:_authToken=`));
  if (!tokenLine) return null;
  return tokenLine.slice(`//${host}/npm/:_authToken=`.length).trim() || null;
}

function stripManagedNpmrc(projectPath, rootUrl) {
  const npmrcPath = path.join(projectPath, '.npmrc');
  if (!fs.existsSync(npmrcPath)) return false;
  const host = registryHost(rootUrl);
  const managedRegistryLine = `@mech:registry=${rootUrl.replace(/\/$/, '')}/npm/`;
  const existingLines = fs.readFileSync(npmrcPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line, index, arr) => line !== '' || index < arr.length - 1);
  const managedHosts = managedRegistryHosts(existingLines);
  managedHosts.add(host);
  const hasManagedRegistryLine = existingLines.some((line) => line.startsWith('@mech:registry='));
  const nextLines = existingLines.filter((line) => {
    if (line.startsWith('@mech:registry=')) return false;
    if (line.startsWith('//') && line.includes('/npm/:_authToken=')) {
      return ![...managedHosts].some((managedHost) => line.startsWith(`//${managedHost}/npm/:_authToken=`));
    }
    return !(hasManagedRegistryLine && line === 'always-auth=true');
  });
  if (nextLines.length === existingLines.length) return false;
  if (nextLines.length === 0) {
    fs.unlinkSync(npmrcPath);
    return true;
  }
  writeFileAtomic(npmrcPath, `${nextLines.join('\n')}\n`);
  return true;
}

// Internal helper. The only caller is provisionRegistryAccess below, which consumes the structured result.
function writeNpmrc(projectPath, rootUrl, token) {
  const host = registryHost(rootUrl);
  const npmrcPath = path.join(projectPath, '.npmrc');
  const managedRegistryValue = `@mech:registry=${rootUrl.replace(/\/$/, '')}/npm/`;
  const existingLines = fs.existsSync(npmrcPath)
    ? fs.readFileSync(npmrcPath, 'utf-8').split(/\r?\n/).filter((line, index, arr) => line !== '' || index < arr.length - 1)
    : [];
  const managedTokenPrefix = `//${host}/npm/:_authToken=`;
  const managedHosts = managedRegistryHosts(existingLines);
  managedHosts.add(host);
  const existingManagedTokenLine = existingLines.find((line) => line.startsWith(managedTokenPrefix)) || null;
  const hasDifferentManagedRegistryValue = existingLines.some((line) => line.startsWith('@mech:registry=') && line !== managedRegistryValue);
  if (!token) {
    if (existingManagedTokenLine) {
      upsertGitignoreLine(projectPath, '.npmrc');
    }
    const shouldWarn = hasDifferentManagedRegistryValue || Boolean(existingManagedTokenLine);
    return {
      wrote: false,
      warning: shouldWarn
        ? `warning: retained existing managed .npmrc auth entries because mech-registry token exchange did not return a replacement token for ${host}`
        : null,
    };
  }
  const hasManagedRegistryLine = existingLines.some((line) => line.startsWith('@mech:registry='));
  const nextLines = existingLines.filter((line) => {
    if (line.startsWith('@mech:registry=')) return false;
    if (line.startsWith('//') && line.includes('/npm/:_authToken=')) {
      return ![...managedHosts].some((managedHost) => line.startsWith(`//${managedHost}/npm/:_authToken=`));
    }
    return !(hasManagedRegistryLine && line === 'always-auth=true');
  });
  nextLines.push(managedRegistryValue);
  const tokenLine = `${managedTokenPrefix}${token}`;
  nextLines.push(tokenLine);
  nextLines.push('always-auth=true');
  upsertGitignoreLine(projectPath, '.npmrc');
  const body = `${nextLines.join('\n')}\n`;
  writeFileAtomicWithMode(npmrcPath, body, 0o600);
  return { wrote: true, warning: null };
}

function registryConfigPatch(committed, rootUrl, registryCapabilities, tokenPath) {
  return {
    ...committed,
    registry: {
      ...(committed.registry && typeof committed.registry === 'object' ? committed.registry : {}),
      root_url: rootUrl,
      capabilities: registryCapabilities,
      token_path: tokenPath,
    },
  };
}

function hasValidCommittedIdentity(identity) {
  return Boolean(
    identity &&
    typeof identity === 'object' &&
    typeof identity.public_key === 'string' &&
      typeof identity.did === 'string'
  );
}
function loadOrCreateRegistryIdentity(projectPath, agentId, rootUrl, registryCapabilities, inspection) {
  const { committed, secret, identity, existingPrivateKey } = existingRegistryIdentityState(projectPath);
  const tokenPath = registryTokenPathForAgent(agentId, inspection);
  if (!identity && existingPrivateKey) {
    const nextConfig = registryConfigPatch(committed, rootUrl, registryCapabilities, tokenPath);
    saveBrainConfigIfChanged(projectPath, committed, nextConfig);
    return {
      error: 'missing_identity',
      tokenPath,
      config: nextConfig,
      created: false,
    };
  }
  if (identity && !hasValidCommittedIdentity(identity)) {
    if (existingPrivateKey) {
      return {
        error: 'invalid_identity',
        tokenPath,
        config: committed,
        created: false,
      };
    }
  }
  if (hasValidCommittedIdentity(identity)) {
    if (!existingPrivateKey) {
      const nextConfig = registryConfigPatch(committed, rootUrl, registryCapabilities, tokenPath);
      saveBrainConfigIfChanged(projectPath, committed, nextConfig);
      return {
        error: 'missing_private_key',
        did: identity.did,
        publicKey: identity.public_key,
        tokenPath,
        config: nextConfig,
        created: false,
      };
    }
    const nextConfig = registryConfigPatch(committed, rootUrl, registryCapabilities, tokenPath);
    saveBrainConfigIfChanged(projectPath, committed, nextConfig);
    return {
      did: identity.did,
      publicKey: identity.public_key,
      privateKey: existingPrivateKey,
      tokenPath,
      config: nextConfig,
      created: false,
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const did = buildDid(publicKeyPem);
  const baseConfig = registryConfigPatch(committed, rootUrl, registryCapabilities, tokenPath);
  const nextConfig = {
    ...baseConfig,
    registry: {
      ...baseConfig.registry,
      identity: {
        did,
        public_key: publicKeyPem,
        algorithm: 'ed25519',
        updated_at: new Date().toISOString(),
      },
    },
  };
  const nextSecret = {
    ...secret,
    registry_private_key: privateKeyPem,
  };
  saveBrainConfigIfChanged(projectPath, committed, nextConfig);
  saveBrainSecret(projectPath, nextSecret);
  return {
    did,
    publicKey: publicKeyPem,
    privateKey: privateKeyPem,
    tokenPath,
    config: nextConfig,
    created: true,
  };
}

function requestHeaders(method, requestPath, bodyText, agentId, did, privateKeyPem, extraHeaders = {}) {
  const timestamp = new Date().toISOString();
  const signingBase = `${method.toUpperCase()} ${requestPath} ${sha256Hex(bodyText)} ${timestamp}`;
  const signature = sign(null, Buffer.from(signingBase), privateKeyPem).toString('base64');
  return {
    ...extraHeaders,
    'content-type': 'application/json',
    'x-agent-id': agentId,
    'x-seedid-did': did,
    'x-seedid-timestamp': timestamp,
    'x-seedid-signature': signature,
  };
}

async function postJson(rootUrl, requestPath, body, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('registry_request_timeout')), REGISTRY_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${rootUrl.replace(/\/$/, '')}${requestPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { response, payload };
}

function normalizeRegistryError(error) {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'AbortError' || error.message === 'registry_request_timeout') {
    return 'registry_request_timeout';
  }
  return error.message;
}

export async function provisionRegistryAccess({ projectPath, project, io }) {
  const agentId = typeof project.agent_id === 'string' ? project.agent_id.trim() : '';
  if (!agentId) {
    return { ok: false, status: 'skipped', reason: 'missing_agent_id', secretChanged: false };
  }
  if (process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING === '1') {
    return { ok: false, status: 'disabled', reason: 'disabled', secretChanged: false };
  }

  const secretPath = brainSecretPath(projectPath);
  const secretBefore = fs.existsSync(secretPath) ? fs.readFileSync(secretPath, 'utf-8') : null;
  const rootUrl = registryRootUrl();
  const registryCapabilities = normalizeRegistryCapabilities(project.registry_capabilities);
  const exchangeScopes = [...registryCapabilities];
  const tokenOverride = inspectTokenOverride();
  const bootstrapToken = process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN || process.env.REGISTRY_SYNC_TOKEN || '';
  const bootstrapAllowed = bootstrapToken && isSecureRegistryRoot(rootUrl);
  if (bootstrapToken && !bootstrapAllowed) {
    io.stdout(`warning: refusing to send mech-registry bootstrap token to insecure registry URL ${rootUrl}`);
  }

  ensureMcpSettings(projectPath, rootUrl);

  if (tokenOverride.error === 'ambiguous_token_override') {
    io.stdout('warning: AGENTBOOTUP_REGISTRY_TOKEN_FILE points to a non-existent path; use a trailing slash, an existing directory, {agentId}, or an existing file to make token storage mode explicit');
    return { ok: false, status: 'mcp_only', reason: 'ambiguous_token_override', secretChanged: false };
  }
  if (tokenOverride.error === 'token_override_stat_error') {
    io.stdout(`warning: cannot stat AGENTBOOTUP_REGISTRY_TOKEN_FILE (${tokenOverride.errorCode || 'UNKNOWN'})`);
    return { ok: false, status: 'mcp_only', reason: 'token_override_stat_error', secretChanged: false };
  }
  if (tokenOverride.shared && tokenOverride.override) {
    io.stdout('note: AGENTBOOTUP_REGISTRY_TOKEN_FILE is using an explicit shared token file');
  }

  const identity = loadOrCreateRegistryIdentity(projectPath, agentId, rootUrl, registryCapabilities, tokenOverride);
  if (identity.error === 'missing_private_key') {
    io.stdout('warning: existing mech-registry identity found without local private key; skipping registry registration until secrets are restored');
    return {
      ok: false,
      status: 'mcp_only',
      reason: 'missing_private_key',
      registryCapabilities,
      tokenPath: registryTokenPathForAgent(agentId, tokenOverride),
      tokenGranted: false,
      secretChanged: false,
    };
  }
  if (identity.error === 'missing_identity') {
    io.stdout('warning: existing mech-registry private key found without committed identity metadata; skipping registry registration until config is restored');
    return {
      ok: false,
      status: 'mcp_only',
      reason: 'missing_identity',
      registryCapabilities,
      tokenPath: registryTokenPathForAgent(agentId, tokenOverride),
      tokenGranted: false,
      secretChanged: false,
    };
  }
  if (identity.error === 'invalid_identity') {
    io.stdout(`warning: existing mech-registry identity metadata is malformed in ${brainConfigPath(projectPath)}; skipping registry registration until the file is repaired or removed`);
    return {
      ok: false,
      status: 'mcp_only',
      reason: 'invalid_identity',
      registryCapabilities,
      tokenPath: registryTokenPathForAgent(agentId, tokenOverride),
      tokenGranted: false,
      secretChanged: false,
    };
  }

  const registerPayload = {
    brain_id: agentId,
    did: identity.did,
    public_key: identity.publicKey,
    repo: typeof project.repo === 'string' && project.repo.trim() ? project.repo.trim() : project.id,
    capabilities: registryCapabilities,
  };
  const registerHeaders = requestHeaders(
    'POST',
    '/-/v1/agents/register',
    JSON.stringify(registerPayload),
    agentId,
    identity.did,
    identity.privateKey,
    bootstrapAllowed ? { 'x-registry-sync-token': bootstrapToken } : {},
  );

  let exchangeEligible = false;
  try {
    const registerResult = await postJson(rootUrl, '/-/v1/agents/register', registerPayload, registerHeaders);
    if (registerResult.response.status === 200) {
      exchangeEligible = true;
    } else if (!bootstrapAllowed && (registerResult.response.status === 401 || registerResult.response.status === 403)) {
      io.stdout(bootstrapToken
        ? 'note: mech-registry registration skipped (bootstrap token suppressed for insecure registry URL)'
        : 'note: mech-registry registration skipped (bootstrap token missing for first registration)');
      exchangeEligible = identity.created === false;
    } else {
      const normalizedRegisterError = String(registerResult.payload?.error || '').toLowerCase();
      exchangeEligible = registerResult.response.status === 409 ||
        ((registerResult.response.status >= 400 && registerResult.response.status < 500) &&
          (normalizedRegisterError === 'already_registered' || normalizedRegisterError === 'conflict'));
      const reason = registerResult.payload?.error || `http_${registerResult.response.status}`;
      io.stdout(`warning: mech-registry registration failed (${reason}); retry provision after registry recovers`);
    }
  } catch (error) {
    io.stdout(`warning: mech-registry registration failed (${normalizeRegistryError(error)}); retry provision after registry recovers`);
  }

  let token = readTokenFile(agentId, tokenOverride);
  const priorToken = token;
  const tokenUsable = tokenCoversScopes(token, exchangeScopes);
  const tokenExact = tokenScopesMatch(token, exchangeScopes) ||
    (tokenUsable &&
      requestedScopesMatchConfig(identity.config, exchangeScopes) &&
      grantedScopesMatchConfig(identity.config, token));
  let tokenRefreshed = false;
  if (!tokenUsable || !tokenExact) {
    if (exchangeEligible) {
      try {
        const exchangePayload = { scopes: exchangeScopes, ttl_seconds: 900 };
        const exchangeHeaders = requestHeaders(
          'POST',
          '/auth/exchange',
          JSON.stringify(exchangePayload),
          agentId,
          identity.did,
          identity.privateKey,
        );
        const exchangeResult = await postJson(rootUrl, '/auth/exchange', exchangePayload, exchangeHeaders);
        if (exchangeResult.response.status === 200 && exchangeResult.payload?.token) {
          token = String(exchangeResult.payload.token);
          writeTokenFile(agentId, token, tokenOverride);
          tokenRefreshed = true;
        } else {
          const reason = exchangeResult.payload?.error || `http_${exchangeResult.response.status}`;
          io.stdout(`warning: mech-registry token exchange failed (${reason})`);
          // Fail closed on exchange failure unless the cached token exactly matches the requested scopes.
          token = canReuseCachedTokenAfterExchangeFailure(priorToken, exchangeScopes) ? priorToken : null;
          if (token) {
            io.stdout('note: keeping previously cached mech-registry token until next provision');
          }
        }
      } catch (error) {
        io.stdout(`warning: mech-registry token exchange failed (${normalizeRegistryError(error)})`);
        // Fail closed on exchange failure unless the cached token exactly matches the requested scopes.
        token = canReuseCachedTokenAfterExchangeFailure(priorToken, exchangeScopes) ? priorToken : null;
        if (token) {
          io.stdout('note: keeping previously cached mech-registry token until next provision');
        }
      }
    } else {
      token = canReuseCachedTokenAfterExchangeFailure(priorToken, exchangeScopes) ? priorToken : null;
    }
  }
  if (!tokenScopesRequireNpm(exchangeScopes) && token && !tokenScopesMatch(token, exchangeScopes)) {
    token = null;
  }
  const staleCachedToken = Boolean(priorToken) && !tokenScopesMatch(priorToken, exchangeScopes);

  const tokenGranted = Boolean(token);
  if (
    tokenGranted &&
    (tokenRefreshed || tokenScopesMatch(token, exchangeScopes)) &&
    (
      !requestedScopesMatchConfig(identity.config, exchangeScopes) ||
      !grantedScopesMatchConfig(identity.config, token)
    )
  ) {
    const nextConfig = {
      ...identity.config,
      registry: {
        ...(identity.config?.registry && typeof identity.config.registry === 'object' ? identity.config.registry : {}),
        requested_scopes: normalizeScopeList(exchangeScopes),
        granted_scopes: normalizedTokenScopes(token),
      },
    };
    saveBrainConfigIfChanged(projectPath, identity.config, nextConfig);
    identity.config = nextConfig;
  }
  if (tokenScopesRequireNpm(exchangeScopes)) {
    const currentManagedNpmrcToken = !token
      ? readCurrentRegistryManagedNpmrcToken(projectPath, rootUrl)
      : null;
    const staleCurrentManagedAuth = Boolean(currentManagedNpmrcToken) &&
      !tokenScopesMatch(currentManagedNpmrcToken, exchangeScopes);
    const strippedCurrentManagedAuth = !token && staleCurrentManagedAuth
      ? stripCurrentRegistryManagedNpmrc(projectPath, rootUrl)
      : false;
    if (!token && (staleCachedToken || strippedCurrentManagedAuth)) {
      const deleteResult = deleteTokenFile(agentId, tokenOverride);
      if (deleteResult.skippedShared) {
        io.stdout('warning: leaving stale shared mech-registry token file in place because AGENTBOOTUP_REGISTRY_TOKEN_FILE points to a shared path');
      } else if (!deleteResult.deleted && !deleteResult.missing) {
        io.stdout(`warning: unable to delete stale mech-registry token file at ${registryTokenPathForAgent(agentId, tokenOverride)}`);
      }
    } else {
      const npmrcResult = writeNpmrc(projectPath, rootUrl, token);
      if (npmrcResult.warning) {
        io.stdout(npmrcResult.warning);
      }
    }
  } else {
    stripManagedNpmrc(projectPath, rootUrl);
    if (!tokenCoversScopes(token, exchangeScopes)) {
      const deleteResult = deleteTokenFile(agentId, tokenOverride);
      if (deleteResult.skippedShared) {
        io.stdout('warning: leaving stale shared mech-registry token file in place because AGENTBOOTUP_REGISTRY_TOKEN_FILE points to a shared path');
      } else if (!deleteResult.deleted && !deleteResult.missing) {
        io.stdout(`warning: unable to delete stale mech-registry token file at ${registryTokenPathForAgent(agentId, tokenOverride)}`);
      }
    }
  }
  const secretAfter = fs.existsSync(secretPath) ? fs.readFileSync(secretPath, 'utf-8') : null;

  return {
    ok: true,
    status: tokenGranted && (exchangeEligible || tokenRefreshed) ? 'configured' : 'mcp_only',
    registryCapabilities,
    tokenPath: identity.tokenPath,
    tokenGranted,
    secretChanged: secretBefore !== secretAfter,
  };
}
