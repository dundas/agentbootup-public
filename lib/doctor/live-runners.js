import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'fs/promises';
import path from 'node:path';
import { readCredentials } from '../auth/credentials.js';
import { apiUrl, isPlausibleServerUrl } from '../auth/validate.js';
import { httpRedeemTransport, redeemSecret, VaultUnreachableError } from '../brain/vault-redeem.js';
import { getAgentId } from '../project-config.js';
import { checkCredentialsAuthenticate } from './credentials-check.js';
import { checkIdentityMaterializes } from './identity-check.js';
import { checkMessagingRoundTrip } from './messaging-check.js';
import { checkRuntimeResolves } from './runtime-check.js';
import { createMemoryTransportReceiptRunner } from './memory-transport-receipt.js';
import {
  hasCompleteConvergeHealth,
  isConvergeHealthSafe,
} from '../memory/converge-safety.js';
import { getNetworkRoot, readConfig } from '../config/config.js';
import { agentStatus } from '@derivativelabs/agent-process';
import { readLivePersistedBrainSyncHealth } from '../daemon/brain-asset-sync.mjs';
import { readLiveBrainDbSyncHealth } from '../daemon/brain-db-health.js';
import { assessDaemonFreshness, checkObservedConfigIntegrity, resolveCommittedExpectation, resolveFreshnessCeiling } from './reconciliation-health.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_VAULT_BASE_URL = process.env.MECH_VAULT_URL || 'https://vault.mechdna.net';
const DEFAULT_CHAT_MODEL = process.env.AGENTBOOTUP_DOCTOR_CHAT_MODEL || 'doctor-health-probe';
const UNAUTHENTICATED_STATUSES = new Set([401, 403]);

export class RuntimeProbeUnreachableError extends VaultUnreachableError {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'RuntimeProbeUnreachableError';
  }
}

function trimToNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readJsonIfPresent(filePath, readFile = fsp.readFile) {
  try {
    return safeJsonParse(await readFile(filePath, 'utf8'));
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return null;
    throw err;
  }
}

function bearerHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function fingerprintForPublicKey(publicKey) {
  const normalized = trimToNull(publicKey);
  if (!normalized) return null;
  return `sha256:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
}

function normalizeRegistryRecord(payload, agentId) {
  const candidate = payload?.data?.agent ??
    payload?.data ??
    payload?.agent ??
    payload;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const publicKey = trimToNull(candidate.public_key);
  return {
    id: trimToNull(candidate.id) ?? agentId,
    ...(publicKey ? { key_fingerprint: fingerprintForPublicKey(publicKey) } : {}),
  };
}

function extractChatText(body) {
  if (!body || typeof body !== 'object') return null;
  const direct = trimToNull(body.output_text);
  if (direct) return direct;

  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  const message = choice?.message;
  if (typeof message?.content === 'string') return trimToNull(message.content);
  if (Array.isArray(message?.content)) {
    const text = message.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
    return trimToNull(text);
  }

  return null;
}

function selectIngressToken(secrets) {
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return null;
  const preferred = [
    'AGENTHOST_INGRESS_KEY',
    'BRAIN_API_KEY',
    'API_KEY',
    'TOKEN',
    'AUTH_TOKEN',
  ];
  for (const key of preferred) {
    const value = trimToNull(secrets[key]);
    if (value) return value;
  }
  for (const value of Object.values(secrets)) {
    const token = trimToNull(value);
    if (token) return token;
  }
  return null;
}

async function fetchJson(url, { fetchFn, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await fetchFn(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { response, payload };
}

async function postJson(url, body, { fetchFn, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { response, payload };
}

async function loadProjectDoctorContext({
  cwd = process.cwd(),
  agentId,
  readCredentialsFn = readCredentials,
  readFile = fsp.readFile,
} = {}) {
  const brainConfigPath = path.join(cwd, 'brain', 'config.json');
  const brainConfig = await readJsonIfPresent(brainConfigPath, readFile);
  const creds = await readCredentialsFn().catch(() => null);
  const resolvedAgentId = trimToNull(agentId) ??
    trimToNull(getAgentId(cwd)) ??
    null;

  const registryRootUrl = trimToNull(brainConfig?.registry?.root_url);
  const registryTokenPath = trimToNull(brainConfig?.registry?.token_path);
  let registryToken = null;
  if (registryTokenPath) {
    try {
      registryToken = trimToNull(await readFile(registryTokenPath, 'utf8'));
    } catch (err) {
      if (!err || typeof err !== 'object' || err.code !== 'ENOENT') throw err;
    }
  }

  const localIdentity = (() => {
    const id = resolvedAgentId;
    const publicKey = trimToNull(brainConfig?.registry?.identity?.public_key);
    const keyFingerprint = fingerprintForPublicKey(publicKey);
    if (!id && !keyFingerprint) return null;
    return {
      ...(id ? { id } : {}),
      ...(keyFingerprint ? { key_fingerprint: keyFingerprint } : {}),
    };
  })();

  return {
    cwd,
    agentId: resolvedAgentId,
    creds,
    registryRootUrl,
    registryToken,
    localIdentity,
  };
}

export async function buildLiveDoctorRunners(options = {}) {
  const hasObservedConfigOverride = typeof options.readConfigFn === 'function';
  const hasNetworkRootOverride = typeof options.getNetworkRootFn === 'function';
  const {
    cwd = process.cwd(),
    agentId,
    readCredentialsFn = readCredentials,
    readConfigFn = readConfig,
    getNetworkRootFn = getNetworkRoot,
    readFile = fsp.readFile,
    readFileSync = fs.readFileSync,
    fetch: fetchFn = globalThis.fetch,
    vaultBaseUrl = DEFAULT_VAULT_BASE_URL,
    agentStatusFn = agentStatus,
    readBrainAssetHealthFn = readLivePersistedBrainSyncHealth,
    readBrainDbHealthFn = readLiveBrainDbSyncHealth,
    now = () => Date.now(),
  } = options;

  const ctx = await loadProjectDoctorContext({ cwd, agentId, readCredentialsFn, readFile });
  const runners = {};
  const canUseServer = ctx.creds && isPlausibleServerUrl(ctx.creds.serverUrl) && ctx.agentId;
  let committedExpectation;
  function getCommittedExpectation() {
    return committedExpectation ??= resolveCommittedExpectation({ cwd, agentId, readFile: readFileSync });
  }

  let runtimeAddressPromise = null;
  async function getRuntimeAddress() {
    if (!canUseServer) return null;
    if (!runtimeAddressPromise) {
      runtimeAddressPromise = (async () => {
        const url = apiUrl(ctx.creds.serverUrl, `/v1/agents/${encodeURIComponent(ctx.agentId)}/runtime_address`);
        let result;
        try {
          result = await fetchJson(url, {
            fetchFn,
            headers: bearerHeaders(ctx.creds.apiKey),
          });
        } catch (err) {
          throw new Error(`runtime lease lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const { response, payload } = result;
        if (response.status === 404) {
          return { ready: false, reason: 'no runtime lease is registered for this agent' };
        }
        if (!response.ok) {
          if (response.status >= 500 || response.status === 408 || response.status === 429) {
            throw new Error(`runtime lease lookup failed: HTTP ${response.status}`);
          }
          return { ready: false, reason: `runtime lease is not ready (HTTP ${response.status})` };
        }
        const data = payload?.data ?? payload;
        const runtimeAddress = data?.runtime_address ?? null;
        const leaseStatus = trimToNull(data?.status) ?? trimToNull(runtimeAddress?.status) ?? 'unknown';
        const endpoint = trimToNull(runtimeAddress?.endpoint);
        const ingressKeyRef = trimToNull(runtimeAddress?.ingressKeyRef);
        if (leaseStatus !== 'chat_ready' || !endpoint) {
          return {
            ready: false,
            reason: `runtime lease is ${leaseStatus}, not chat_ready`,
            ...(ingressKeyRef ? { ingressKeyRef } : {}),
          };
        }
        return {
          ready: true,
          endpoint,
          ingressKeyRef,
          runtimeSource: 'runtime_address',
        };
      })();
    }
    return runtimeAddressPromise;
  }

  async function ensureRuntimeEndpoint() {
    const runtimeAddress = await getRuntimeAddress();
    return trimToNull(runtimeAddress?.endpoint);
  }

  let ingressSecretsPromise = null;
  async function getIngressSecrets() {
    if (!ingressSecretsPromise) {
      ingressSecretsPromise = (async () => {
        const runtimeAddress = await getRuntimeAddress();
        const ingressKeyRef = trimToNull(runtimeAddress?.ingressKeyRef);
        if (!ingressKeyRef) {
          throw new Error('runtime lease is missing ingressKeyRef');
        }
        return redeemSecret(
          ingressKeyRef,
          { transport: httpRedeemTransport({ vaultBaseUrl, fetch: fetchFn, timeoutMs: DEFAULT_TIMEOUT_MS }) },
        );
      })();
    }
    return ingressSecretsPromise;
  }

  async function runAuthenticatedChat(prompt, secretsOverride) {
    const runtimeAddress = await getRuntimeAddress();
    const endpoint = trimToNull(runtimeAddress?.endpoint);
    if (!endpoint) {
      throw new Error(runtimeAddress?.reason || 'runtime endpoint is unavailable');
    }
    const ingressKeyRef = trimToNull(runtimeAddress?.ingressKeyRef);
    if (!ingressKeyRef) {
      throw new Error('runtime lease is missing ingressKeyRef');
    }

    const secrets = secretsOverride ?? await getIngressSecrets();
    const token = selectIngressToken(secrets);
    if (!token) {
      throw new Error('redeemed ingress secret did not include an auth token');
    }

    let result;
    try {
      result = await postJson(
        `${endpoint.replace(/\/$/, '')}/v1/chat/completions`,
        {
          model: DEFAULT_CHAT_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 16,
        },
        {
          fetchFn,
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch (err) {
      throw new RuntimeProbeUnreachableError(
        `runtime auth probe unreachable: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    return result;
  }

  if (canUseServer) {
    runners.runtime_resolves = async () => checkRuntimeResolves({
      readyz: async () => {
        const runtimeAddress = await getRuntimeAddress();
        if (!runtimeAddress?.ready) {
          return {
            ok: false,
            runtimeSource: runtimeAddress?.runtimeSource ?? 'runtime_address',
          };
        }
        return {
          ok: true,
          runtimeTarget: runtimeAddress.endpoint,
          runtimeSource: runtimeAddress.runtimeSource,
        };
      },
      probeLease: async () => {
        const endpoint = await ensureRuntimeEndpoint();
        if (!endpoint) return false;
        let response;
        try {
          response = await fetchFn(`${endpoint.replace(/\/$/, '')}/readyz`, {
            method: 'GET',
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
          });
        } catch (err) {
          throw new Error(`runtime readyz probe failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return response.ok;
      },
    });

    runners.credentials_authenticate = async () => {
      const runtimeAddress = await getRuntimeAddress();
      const ingressKeyRef = trimToNull(runtimeAddress?.ingressKeyRef);
      if (!ingressKeyRef) {
        return {
          state: 'unknown',
          severity: 'warning',
          category: 'credentials',
          message: 'credentials could not be checked because the runtime lease has no ingressKeyRef',
        };
      }
      return checkCredentialsAuthenticate({
        ingressKeyRef,
        transport: httpRedeemTransport({ vaultBaseUrl, fetch: fetchFn, timeoutMs: DEFAULT_TIMEOUT_MS }),
        authenticate: async (secrets) => {
          const { response } = await runAuthenticatedChat('credential probe', secrets);
          if (UNAUTHENTICATED_STATUSES.has(response.status)) return false;
          if (response.ok) return true;
          throw new VaultUnreachableError(`runtime auth probe returned HTTP ${response.status}`);
        },
      });
    };

    runners.messaging_round_trips = async () => {
      const runtimeAddress = await getRuntimeAddress();
      const ingressKeyRef = trimToNull(runtimeAddress?.ingressKeyRef);
      if (!ingressKeyRef) {
        return {
          state: 'unknown',
          severity: 'warning',
          category: 'messaging',
          message: 'messaging could not be checked because the runtime lease has no ingressKeyRef',
        };
      }
      return checkMessagingRoundTrip({
        chat: async (prompt) => {
          const { response, payload } = await runAuthenticatedChat(prompt);
          if (!response.ok) {
            throw new Error(`runtime chat returned HTTP ${response.status}`);
          }
          return extractChatText(payload) ?? '';
        },
      });
    };
  }

  if (ctx.agentId && ctx.registryRootUrl && ctx.localIdentity) {
    runners.identity_materializes = async () => checkIdentityMaterializes({
      agentId: ctx.agentId,
      localIdentity: ctx.localIdentity,
      fetchRegistry: async (targetAgentId) => {
        const url = `${ctx.registryRootUrl.replace(/\/$/, '')}/-/v1/agents/${encodeURIComponent(targetAgentId)}`;
        let result;
        try {
          result = await fetchJson(url, {
            fetchFn,
            headers: bearerHeaders(ctx.registryToken),
          });
        } catch (err) {
          throw new Error(`registry fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const { response, payload } = result;
        if (response.status === 404) return null;
        if (!response.ok) {
          throw new Error(`registry fetch failed: HTTP ${response.status}`);
        }
        return normalizeRegistryRecord(payload, targetAgentId);
      },
    });
  } else if (ctx.agentId) {
    // Agent is identified but registry is not configured — return a distinct honest-degrade
    // message so operators can distinguish "check not wired" from "registry not configured".
    const reason = !ctx.registryRootUrl
      ? 'registry URL not configured (set brain.registry.root_url to enable)'
      : 'local identity not available (check brain/config.json for registry.identity)';
    runners.identity_materializes = async () => ({
      state: 'unknown',
      severity: 'warning',
      category: 'identity',
      message: `identity_materializes: ${reason}`,
    });
  }

  // P3's committed receipt verifies actual transport, unlike freshness alone.
  const memoryTransport = await createMemoryTransportReceiptRunner({ cwd, readFile });
  if (memoryTransport) runners.memory_transport = memoryTransport;

  // PRD-0028 FR-7: global config is observed state, never the expectation.
  // A committed project/network declaration supplies the expectation and makes
  // a temp bootup-machine root or an identity split fail loudly.
  runners.config_integrity = async () => {
    const expectation = getCommittedExpectation();
    if (expectation.state !== 'pass') {
      return {
        state: expectation.state,
        severity: expectation.state === 'fail' ? 'error' : 'warning',
        category: 'config_integrity',
        message: `config_integrity: ${expectation.reason}`,
        ...expectation,
      };
    }
    const observed = await readConfigFn();
    // Daemon resolution honors AGENTBOOTUP_NETWORK_ROOT over config.json.
    // Doctor must observe the same effective value or it would manufacture a
    // false split-brain result on a supported deployment configuration.
    const effectiveNetworkRoot = hasObservedConfigOverride && !hasNetworkRootOverride
      ? observed.networkRoot
      : await getNetworkRootFn();
    const result = checkObservedConfigIntegrity(expectation, {
      ...observed,
      networkRoot: effectiveNetworkRoot ?? observed.networkRoot,
    });
    return {
      state: result.state,
      severity: result.state === 'fail' ? 'error' : 'info',
      category: 'config_integrity',
      message: result.state === 'pass'
        ? `config_integrity: committed declaration verified (${result.declarationPath})`
        : `config_integrity: ${result.reason}`,
      ...result,
    };
  };

  // PRD-0028 FR-8: an online daemon is not proof of useful work. Each active
  // daemon must supply a durable, successful completion timestamp; otherwise
  // the component fails closed. Non-installed components stay explicitly
  // unknown instead of being fabricated as passing.
  async function onlineAgent(name) {
    try {
      const status = await agentStatusFn(name);
      return status?.state === 'online' || status?.state === 'running' ? status : null;
    } catch {
      return null;
    }
  }

  function committedFreshness(component, expectation) {
    return resolveFreshnessCeiling(component, expectation.projectDoctor, process.env);
  }

  runners.brain_asset_freshness = async () => {
    const expectation = getCommittedExpectation();
    if (expectation.state !== 'pass' || !expectation.projectId) {
      return { state: 'unknown', severity: 'warning', category: 'freshness', message: 'brain_asset: committed project declaration unavailable' };
    }
    const status = await onlineAgent(`agentbootup-brain-${expectation.projectId}`);
    const health = status ? readBrainAssetHealthFn(expectation.expectedBrainId, status.pid) : null;
    return assessDaemonFreshness({
      component: 'brain_asset', active: !!status, completedAt: health?.lastSyncAt,
      ceiling: committedFreshness('brainAsset', expectation), now: now(),
    });
  };

  runners.brain_db_freshness = async () => {
    const expectation = getCommittedExpectation();
    if (expectation.state !== 'pass' || !expectation.projectId) {
      return { state: 'unknown', severity: 'warning', category: 'freshness', message: 'brain_db: committed project declaration unavailable' };
    }
    const status = await onlineAgent(`agentbootup-brain-db-${expectation.projectId}`);
    const health = status ? readBrainDbHealthFn(expectation.expectedBrainId, status.pid) : null;
    return assessDaemonFreshness({
      component: 'brain_db', active: !!status, completedAt: health?.lastSyncAt,
      ceiling: committedFreshness('brainDb', expectation), now: now(),
    });
  };

  runners.memory_daemon_freshness = async () => {
    const expectation = getCommittedExpectation();
    if (expectation.state !== 'pass' || !expectation.projectId) {
      return { state: 'unknown', severity: 'warning', category: 'freshness', message: 'memory: committed project declaration unavailable' };
    }
    const status = await onlineAgent(`agentbootup-brain-${expectation.projectId}`);
    const assetHealth = status ? readBrainAssetHealthFn(expectation.expectedBrainId, status.pid) : null;
    const converge = assetHealth?.memoryConverge;
    if (status && converge) {
      const effectiveLabel = typeof converge.enabled === 'boolean'
        ? (converge.enabled ? 'on' : 'off')
        : 'unknown';
      const gateLabel = typeof converge.gateOpen === 'boolean'
        ? (converge.gateOpen ? 'open' : 'closed')
        : 'unknown';
      if (!hasCompleteConvergeHealth(converge)) {
        return {
          state: 'fail',
          severity: 'error',
          category: 'freshness',
          message:
            `memory: converge health incomplete; state=${converge.state ?? 'unknown'} ` +
            `effective=${effectiveLabel} source=${converge.configSource ?? 'unknown'} ` +
            `gate=${gateLabel} store=${converge.store ?? 'unknown'} ` +
            `fleet_freshness=${converge.freshnessState ?? 'unknown'}`,
        };
      }
    }
    if (status && converge && !isConvergeHealthSafe(converge)) {
      return {
        state: 'fail',
        severity: 'error',
        category: 'freshness',
        message:
          `memory: converge cycle unsafe state=${converge.state} effective=${converge.enabled ? 'on' : 'off'} ` +
          `source=${converge.configSource} gate=${converge.gateOpen ? 'open' : 'closed'}` +
          `${converge.detail ? ` detail=${converge.detail}` : ''}`,
      };
    }
    const active = !!status;
    return assessDaemonFreshness({
      component: 'memory converge cycle', active, completedAt: converge?.lastCycleAt,
      ceiling: committedFreshness('memory', expectation), now: now(),
      detail: converge?.detail,
    });
  };

  runners.transcript_active_freshness = async () => {
    const expectation = getCommittedExpectation();
    const fallbackCeiling = resolveFreshnessCeiling('transcriptActive');
    if (expectation.state !== 'pass') {
      return assessDaemonFreshness({ component: 'transcript_active', active: false, ceiling: fallbackCeiling });
    }
    const status = await onlineAgent('agentbootup-transcripts');
    const ceiling = committedFreshness('transcriptActive', expectation);
    let completedAt = null;
    if (status) {
      const port = Number(status.port) || Number(process.env.AGENTBOOTUP_DAEMON_PORT) || 8766;
      try {
        const response = await fetchFn(`http://127.0.0.1:${port}/status`, {
          method: 'GET', signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        if (response.ok) {
          const payload = await response.json();
          completedAt = payload?.lastCompletedAt ?? null;
        }
      } catch {
        // An active service with an unreachable/invalid status endpoint has no
        // usable completion evidence and must fail closed below.
      }
    }
    return assessDaemonFreshness({
      component: 'transcript_active', active: !!status, completedAt, ceiling, now: now(),
    });
  };

  return runners;
}
