/**
 * Agentbootup Server — Entry Point
 *
 * Run: bun src/server/server.ts
 *
 * Routes:
 *   GET  /health              — public health check
 *   POST /v1/brains           — register brain
 *   GET  /v1/brains           — list brains
 *   GET  /v1/brains/:id       — get brain
 *   PATCH /v1/brains/:id      — update brain
 *   DELETE /v1/brains/:id     — deregister brain
 *   POST /v1/skills           — register skill
 *   GET  /v1/skills           — list skills (metadata only)
 *   GET  /v1/skills/:id       — get skill with files
 *   DELETE /v1/skills/:id     — remove skill
 *   POST /v1/skills/sync      — resolve hosted bundle rollout payload for selected skills
 *   GET  /v1/registry/search  — keyword search across endpoints + skills
 *   GET  /v1/registry/services — list all services
 *   GET  /v1/registry/services/:id — service detail with endpoints
 *   GET  /v1/registry/skills  — list skills (from skills index)
 *   POST /v1/registry/publish — publish registry + skills index
 *   GET  /v1/manifest         — get current manifest
 *   POST /v1/manifest         — publish updated manifest
 *   POST /v1/memory/:brainId/push — push memory files to brain's collection
 *   GET  /v1/memory/:brainId/pull — pull all memory files
 *   POST /v1/brain-assets/:brainId/push — push brain assets (skills, agents, commands, etc.)
 *   GET  /v1/brain-assets/:brainId/capabilities — non-mutating asset contract preflight
 *   GET  /v1/brain-assets/:brainId/hashes — list brain asset hashes (without content)
 *   GET  /v1/brain-assets/:brainId      — pull all (or filtered) brain assets
 *   DELETE /v1/brain-assets/:brainId   — delete secret generations (?asset_type=secret)
 *   POST /v1/sync/transcripts/push     — push transcript chunks from a session
 *   GET  /v1/sync/transcripts/pull     — pull transcripts for a brain (with optional inline)
 *   GET  /v1/sync/transcripts/download/:key — download a transcript file by storage key
 *   GET  /v1/sync/transcripts/status   — sync status grouped by machine
 *   GET  /v1/network-config            — retrieve stored network config
 *   PUT  /v1/network-config            — store/merge network config (upsert by agent_id)
 *   POST /v1/brain-db/provision        — issue per-brain Ed25519 JWT for sqld auth
 *   POST /v1/agents/:agentId/wake      — wake/resume an agent runtime lease
 *   GET  /v1/agents/:agentId/runtime_address — resolve canonical runtime address
 *   GET  /v1/auth/status          — principal summary (external allowlist)
 *   /auth/*                       — ClearAuth hosted login (developer console)
 *   /developer/*                  — server-rendered developer console
 *   POST /v1/developer/api-keys   — session-authenticated key management
 *   POST /v1/device-auth/start    — CLI device login bridge
 *   POST /v1/device-auth/poll     — CLI device login poll
 *   GET  /v1/internal/external-auth/audit — admin-only audit query
 */

import { resolveConfig } from './config';
import { authorizeRequest } from './lib/request-auth';
import { ExternalApiKeyStore } from './lib/external-api-key-store';
import { ExternalUserStore } from './lib/external-user-store';
import { ExternalAuthAuditStore } from './lib/external-auth-audit-store';
import { DeviceAuthStore } from './lib/device-auth-store';
import { ConsoleEphemeralStore } from './lib/console-ephemeral-store';
import { ExternalKeyService } from './lib/external-key-service';
import { createClearAuthClient } from './lib/clearauth-client';
import { ExternalRateLimiter } from './lib/external-rate-limit';
import { HttpError, jsonError, methodNotAllowed } from './errors';
import { decodeAndValidateBrainId } from './lib/brain-id';
import { decodeAndValidateIdentifier } from './lib/route-params';
import { MechClient } from './lib/mech-client';
import { VaultClient } from './lib/vault-client';
import { BrainStore } from './lib/brain-store';
import { SkillStore } from './lib/skill-store';
import { MemoryStore } from './lib/memory-store';
import { RegistryStore } from './lib/registry-store';
import { BundleBuilder } from './lib/bundle-builder';
import { TranscriptStore } from './lib/transcript-store';
import { TranscriptArchiveStore } from './lib/transcript-archive-store';
import { BrainAssetStore } from './lib/brain-asset-store';
import { BrainBranchStore } from './lib/brain-branch-store';
import { RuntimeLeaseStore } from './lib/runtime-lease-store';
import { createStorageSdk } from '@mech/storage-sdk';
import { createBrainAuthorizationRuntime } from './lib/brain-authorization-runtime';
import { handleHealth } from './routes/health';
import {
  handleListBrains,
  handleGetBrain,
  handleCreateBrain,
  handleUpdateBrain,
  handleDeleteBrain,
} from './routes/brains';
import {
  handleCreateBrainBranch,
  handleDeleteBrainBranch,
  handleGetBrainBranch,
  handleListBrainBranches,
} from './routes/brain-branches';
import { handleBootBundle } from './routes/boot-bundle';
import {
  handleListSkills,
  handleGetSkill,
  handleCreateSkill,
  handleDeleteSkill,
} from './routes/skills';
import { handleSyncSkills } from './routes/skills-sync';
import {
  handleRegistrySearch,
  handleListServices,
  handleGetService,
  handleListRegistrySkills,
  handlePublishRegistry,
} from './routes/registry';
import { handleGetManifest, handlePublishManifest } from './routes/manifest';
import { handlePushMemory, handlePullMemory } from './routes/memory';
import {
  handleBrainAssetCapabilities,
  handleDeleteSecretAssets,
  handlePushBrainAssets,
  handlePullBrainAssets,
  handleListBrainAssetHashes,
} from './routes/brain-assets';
import { NetworkConfigStore } from './lib/network-config-store';
import { handleGetNetworkConfig, handlePutNetworkConfig } from './routes/network-config';
import {
  handlePushTranscripts,
  handlePullTranscripts,
  handleDownloadTranscript,
  handleTranscriptStatus,
} from './routes/sync';
import { handleBrainDbProvision } from './routes/brain-db';
import { handleGetRuntimeAddress, handleWakeAgent } from './routes/runtime-lease';
import { handleAgentHostControlPlaneRoute } from './routes/agent-host-control-plane';
import { HealthStore } from './lib/health-store';
import { handleHealthReport, handleFleetHealth, handleBrainHealth, resolveHealthReportAuthzMode } from './routes/health-board';
import { handleAuthStatusRoute } from './routes/auth-status';
import { handleExternalAuthRoute } from './routes/external-auth';
import { handleExternalApiKeysRoute } from './routes/external-api-keys';
import { handleDeveloperConsoleRoute, translateDeveloperConsoleHttpError } from './routes/developer-console';
import { handleDeviceAuthRoute } from './routes/device-auth';
import { handleExternalAuthAuditRoute } from './routes/external-auth-audit';
import { authFailureEvent } from './lib/auth-log';
import { handleArchiveV2Route } from './routes/transcript-archive';
import { createRemoteLocalPreflight, REMOTE_LOCAL_PREFLIGHT_PATH } from './lib/remote-local-wss-preflight';
import { createRemoteLocalWssAdmission, REMOTE_LOCAL_ADMISSION_PATH } from './lib/remote-local-wss-admission';
import { createRemoteLocalWssRouter } from './lib/remote-local-wss-router';
import { RemoteLocalDeviceReauthenticationStore } from './lib/remote-local-device-reauthentication';
import { RemoteLocalDeviceEnrollmentStore } from './lib/remote-local-device-enrollment';
import { RemoteLocalSessionAdmission, inspectRemoteLocalDeviceAuthority } from './lib/remote-local-session-admission';
import { RemoteLocalConnectorRegistry } from './lib/remote-local-connector-registry';
import { RemoteLocalLiveEventBroker } from './lib/remote-local-live-event-broker';
import { RemoteLocalApprovalStore } from './lib/remote-local-approval-store';
import { createRemoteLocalConnectorTerminalizer, RemoteLocalTurnStore } from './lib/remote-local-turn-store';
import { createRemoteLocalRegistryOwnerOperations, createUnavailableRemoteLocalOwnerOperations, handleRemoteLocalChatRoute, isRemoteLocalChatPath } from './routes/remote-local-chat';
import { handleRemoteLocalEnrollmentRoute, isRemoteLocalEnrollmentPath } from './routes/remote-local-enrollment';
import { handleRemoteLocalAuthorityBootstrapRoute, isRemoteLocalAuthorityBootstrapPath } from './routes/remote-local-authority-bootstrap';
import { withStorageCasReadRetries } from './lib/storage-read-retry';

function log(msg: string): void {
  console.error(`[agentbootup-server] ${msg}`);
}

function logWarn(msg: string): void {
  console.error(`[agentbootup-server] warn: ${msg}`);
}

async function main(): Promise<void> {
  const config = resolveConfig();

  const mech = new MechClient({
    baseUrl: config.mechStorageUrl,
    appId: config.mechAppId,
    apiKey: config.mechApiKey,
    apiSecret: config.mechApiSecret,
    maxEnumerationRecords: config.mechMaxEnumerationRecords,
    readRetryAttempts: config.mechReadRetryAttempts,
    readRetryMaxDelayMs: config.mechReadRetryMaxDelayMs,
  });

  const vault = new VaultClient({
    baseUrl: config.mechVaultUrl,
    appId: config.mechAppId,
    apiKey: config.mechApiKey,
  });

  const brainStore = new BrainStore(mech);
  const brainBranchStore = new BrainBranchStore(mech);
  const skillStore = new SkillStore(mech);
  const memoryStore = new MemoryStore(mech);
  const registryStore = new RegistryStore(mech);
  const transcriptStore = new TranscriptStore(mech);
  const transcriptArchiveStore = config.archiveEnabled ? new TranscriptArchiveStore(mech, {
    receiptSecret: config.archiveReceiptSecret!,
    receiptKeyId: config.archiveReceiptKeyId,
    maxPartBytes: config.archiveMaxPartBytes,
    maxParts: config.archiveMaxParts,
    maxArchiveBytes: config.archiveMaxBytes,
    defaultPageSize: config.archiveInventoryPageSize,
    maxPageSize: config.archiveInventoryMaxPageSize,
    maxConcurrentCommits: config.archiveMaxConcurrentCommits,
    maxCommitBytes: config.archiveCommitByteBudget,
    maxPendingCommits: config.archiveMaxPendingCommits,
    inventoryMaxScanRows: config.archiveInventoryMaxScanRows,
    inventoryMaxScanRequests: config.archiveInventoryMaxScanRequests,
    storageOperationTimeoutMs: config.archiveStorageOperationTimeoutMs,
    temporaryPartRetentionMs: config.archiveTemporaryPartRetentionMs,
    gcMaxScanRows: config.archiveGcMaxScanRows,
    temporaryPartGcEnabled: config.archiveTemporaryPartGcEnabled,
  }) : null;
  const brainAssetStore = new BrainAssetStore(mech);
  const networkConfigStore = new NetworkConfigStore(mech);
  const runtimeLeaseStore = new RuntimeLeaseStore(mech);
  const rawDurableBrainAuthorizationCas = config.brainAuthorizationMode === 'durable'
    ? createStorageSdk({ baseUrl: config.mechStorageUrl, apiKey: config.mechApiKey }).apps(config.mechAppId).nosql.cas
    : null;
  const durableBrainAuthorizationCas = rawDurableBrainAuthorizationCas
    ? withStorageCasReadRetries(rawDurableBrainAuthorizationCas, {
      attempts: config.mechReadRetryAttempts,
      maxDelayMs: config.mechReadRetryMaxDelayMs,
    })
    : null;
  const brainAuthorizationRuntime = await createBrainAuthorizationRuntime({
    mode: config.brainAuthorizationMode,
    documents: mech,
    cas: durableBrainAuthorizationCas ?? undefined,
    bootstrapCohort: config.brainAuthorizationBootstrapCohort,
    adapterIdentity: config.brainAuthorizationAdapterIdentity ?? undefined,
    adapterVersion: config.brainAuthorizationAdapterVersion ?? undefined,
  });
  const agentHostControlPlaneStore = brainAuthorizationRuntime.agentHosts;
  const healthStore = new HealthStore(mech);
  const externalKeyStore = new ExternalApiKeyStore(mech, { keyPrefix: config.externalApiKeyPrefix });
  const externalUserStore = new ExternalUserStore(mech);
  const externalAuthAuditStore = new ExternalAuthAuditStore(mech);
  const deviceAuthStore = new DeviceAuthStore(mech);
  const consoleEphemeralStore = new ConsoleEphemeralStore(mech);
  const externalKeyService = new ExternalKeyService(
    externalKeyStore,
    externalAuthAuditStore,
    config.externalMaxActiveKeysPerUser,
  );
  const clearAuth = createClearAuthClient(config);
  if (!clearAuth) {
    logWarn('AUTH_SECRET unset — developer console, /auth/*, and device-auth routes are disabled');
  }
  if (process.env.FLY_APP_NAME && process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP !== '1') {
    logWarn(
      'AGENTBOOTUP_TRUST_CF_CONNECTING_IP is unset on Fly — device-auth rate limits use peer IP; set it to 1 when behind Cloudflare',
    );
  }
  const developerSessionDeps = clearAuth
    ? { clearAuth, externalUserStore }
    : null;
  const externalRateLimiter = new ExternalRateLimiter({
    limit: config.externalRateLimitPerMinute,
    windowMs: 60_000,
  });
  const deviceAuthRateLimiter = new ExternalRateLimiter({
    limit: config.deviceAuthRateLimitPerMinute,
    windowMs: 60_000,
  });
  const requestAuthDeps = {
    adminApiKey: config.apiKey,
    externalApiKeyPrefix: config.externalApiKeyPrefix,
    externalKeyStore,
    rateLimiter: externalRateLimiter,
  };
  const healthReportAuthzMode = resolveHealthReportAuthzMode();
  const remoteLocalPreflight = createRemoteLocalPreflight({
    enabled: config.remoteLocalPreflightEnabled,
    bearerToken: config.remoteLocalPreflightToken,
    idleTimeoutSeconds: config.remoteLocalPreflightIdleTimeoutSeconds,
    maxPayloadBytes: config.remoteLocalPreflightMaxPayloadBytes,
  });
  if (config.remoteLocalAdmissionEnabled && !brainAuthorizationRuntime.repository) throw new Error('remote-local admission requires durable authority repository');
  const admissionFeature = { snapshot: async () => ({ enabled: config.remoteLocalAdmissionEnabled, revision: 'startup-config-v1' }) };
  const admissionRepository = brainAuthorizationRuntime.repository;
  const remoteLocalBootstrapOwners = new Map(config.brainAuthorizationBootstrapCohort.map((member) => [member.brainId, member.ownerPrincipalId]));
  const remoteLocalTurnStore = durableBrainAuthorizationCas ? new RemoteLocalTurnStore(durableBrainAuthorizationCas) : null;
  const remoteLocalApprovalStore = durableBrainAuthorizationCas ? new RemoteLocalApprovalStore(durableBrainAuthorizationCas) : null;
  const remoteLocalLiveEventBroker = new RemoteLocalLiveEventBroker();
  const remoteLocalConnectorRegistry = new RemoteLocalConnectorRegistry({ maxConnections: config.remoteLocalMaxConnections,
    maxTurnAttemptsPerMinute: config.remoteLocalTurnAttemptsPerMinute, maxRateKeys: config.remoteLocalMaxRateKeys,
    stagedTurnTimeoutMs: config.remoteLocalTurnArmTimeoutMs,
    onInvalidate: async ({ scope, commandId, outcome }) => {
      if (!remoteLocalApprovalStore) throw new Error('Remote-local approval store is unavailable.');
      const closed = await remoteLocalLiveEventBroker.closeAuthorized({ scope, commandId, outcome, approvalStore: remoteLocalApprovalStore });
      if (closed === 'unavailable') throw new Error('Remote-local pending approval cleanup is unavailable.');
    },
    onTerminal: remoteLocalTurnStore
      ? async (input) => {
        await createRemoteLocalConnectorTerminalizer(remoteLocalTurnStore)(input);
        if (!remoteLocalApprovalStore) throw new Error('Remote-local approval store is unavailable.');
        const closed = await remoteLocalLiveEventBroker.closeAuthorized({ scope: input.scope, commandId: input.commandId,
          outcome: 'indeterminate', approvalStore: remoteLocalApprovalStore });
        if (closed === 'unavailable') throw new Error('Remote-local pending approval cleanup is unavailable.');
      }
      : async () => { throw new Error('Remote-local turn receipt store is unavailable.'); },
    onEvents: async ({ scope, commandId, events }) => {
      if (!(await remoteLocalConnectorRegistry.isLive(scope))) {
        if (!remoteLocalTurnStore) throw new Error('Remote-local turn receipt store is unavailable.');
        await createRemoteLocalConnectorTerminalizer(remoteLocalTurnStore)({ scope, commandId, disposition: 'interrupted' });
        if (!remoteLocalApprovalStore) throw new Error('Remote-local approval store is unavailable.');
        const closed = await remoteLocalLiveEventBroker.closeAuthorized({ scope, commandId, outcome: 'indeterminate', approvalStore: remoteLocalApprovalStore });
        if (closed === 'unavailable') throw new Error('Remote-local pending approval cleanup is unavailable.');
        return false;
      }
      if (!remoteLocalApprovalStore) throw new Error('Remote-local approval store is unavailable.');
      const published = await remoteLocalLiveEventBroker.publishAuthorized({ scope, commandId, events, approvalStore: remoteLocalApprovalStore });
      // A live-only command may disclose frames only to its attached SSE
      // subscriber. `not_subscribed` is therefore a failed handoff, never a
      // benign pre-stream state (the owner route arms before dispatch).
      if (published === 'delivered') return;
      if (!remoteLocalTurnStore) throw new Error('Remote-local turn receipt store is unavailable.');
      await createRemoteLocalConnectorTerminalizer(remoteLocalTurnStore)({ scope, commandId, disposition: 'interrupted' });
      const closed = await remoteLocalLiveEventBroker.closeAuthorized({ scope, commandId, outcome: 'indeterminate', approvalStore: remoteLocalApprovalStore });
      if (closed === 'unavailable') throw new Error('Remote-local pending approval cleanup is unavailable.');
      return false;
    },
  });
  const remoteLocalAdmission = createRemoteLocalWssAdmission({
    enabled: config.remoteLocalAdmissionEnabled,
    initialDeadlineMs: config.remoteLocalAdmissionInitialDeadlineMs,
    handshake: admissionRepository
      ? (() => {
        const reauthenticate = new RemoteLocalDeviceReauthenticationStore(admissionRepository);
        const admission = new RemoteLocalSessionAdmission({ reauthenticate, inspectAuthority: inspectRemoteLocalDeviceAuthority(admissionRepository), feature: admissionFeature });
        return { feature: admissionFeature, inspectAuthority: inspectRemoteLocalDeviceAuthority(admissionRepository), reauthenticate, admission };
      })()
      : { feature: admissionFeature, inspectAuthority: async () => ({ disposition: 'unavailable' as const }), reauthenticate: { issueChallenge: async () => ({ status: 'denied' }) }, admission: { open: async () => ({ status: 'closed' as const, code: 'unavailable' as const }), receive: async () => ({ status: 'closed' as const, code: 'unavailable' as const }), recheckSession: async () => ({ status: 'closed' as const, code: 'unavailable' as const }), revoke: async () => ({ status: 'closed' as const, code: 'unavailable' as const }), claimCommand: async () => ({ status: 'closed' as const, code: 'unavailable' as const }) } },
    connectorRegistry: remoteLocalConnectorRegistry,
    onCloseDiagnostic: ({ disposition, transportCode }) => {
      logWarn(`remote-local connector closed disposition=${disposition ?? 'unrecorded'} transport_code=${transportCode}`);
    },
  });
  const remoteLocalWssRouter = createRemoteLocalWssRouter(remoteLocalPreflight, remoteLocalAdmission);
  const remoteLocalEnrollment = admissionRepository
    ? new RemoteLocalDeviceEnrollmentStore(admissionRepository, { initialCredentialTtlMs: config.remoteLocalInitialCredentialTtlMs })
    : null;
  const remoteLocalOwnerOperations = config.remoteLocalOperationsEnabled && remoteLocalTurnStore
    ? createRemoteLocalRegistryOwnerOperations({ registry: remoteLocalConnectorRegistry, turnStore: remoteLocalTurnStore, approvalStore: remoteLocalApprovalStore ?? undefined, eventBroker: remoteLocalLiveEventBroker })
    : createUnavailableRemoteLocalOwnerOperations();
  const bundleBuilder = new BundleBuilder(vault, { skillStore, memoryStore, registryStore, transcriptStore, brainAssetStore });

  // Startup backfill runs AFTER the server binds (see below). It scans the full
  // brain-branch collection per brain and reconciles/cleans legacy rows, which is
  // slow at scale (thousands of orphan rows) — awaiting it before Bun.serve would
  // block the port and make the app unreachable during boot.
  const runStartupBackfill = async (): Promise<void> => {
    if (process.env.AGENTBOOTUP_SKIP_STARTUP_BACKFILL === '1') {
      log('brain-branch backfill skipped (AGENTBOOTUP_SKIP_STARTUP_BACKFILL=1)');
      return;
    }
    try {
      const brains = await brainStore.list();
      const backfill = await brainBranchStore.backfillDefaults(brains);
      if (backfill.created > 0) {
        log(`brain-branch backfill created=${backfill.created} existing=${backfill.existing}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`brain-branch backfill skipped: ${message}`);
    }
  };

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    idleTimeout: config.serverIdleTimeoutSeconds,

    websocket: {
      ...remoteLocalWssRouter,
    },

    async fetch(req: Request, server: import('bun').Server): Promise<Response | undefined> {
      const clientIp = server.requestIP(req)?.address;
      const startedAt = Date.now();
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      try {
        if (path === REMOTE_LOCAL_PREFLIGHT_PATH) {
          const res = remoteLocalPreflight.upgrade(req, server);
          if (res) log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }
        if (path === REMOTE_LOCAL_ADMISSION_PATH) {
          const res = remoteLocalAdmission.upgrade(req, server);
          if (res) log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }
        if (isRemoteLocalChatPath(path) && !config.remoteLocalOperationsEnabled) {
          const res = jsonError(404, 'not_found', 'Not Found');
          res.headers.set('cache-control', 'no-store, private');
          res.headers.set('pragma', 'no-cache');
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }
        if ((isRemoteLocalAuthorityBootstrapPath(path) || isRemoteLocalEnrollmentPath(path)) && !config.remoteLocalAdmissionEnabled) {
          const res = jsonError(404, 'not_found', 'Not Found');
          res.headers.set('cache-control', 'no-store, private');
          res.headers.set('pragma', 'no-cache');
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Public routes ─────────────────────────────────────────────
        if (path === '/health') {
          if (method !== 'GET') {
            const res = methodNotAllowed(['GET']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = handleHealth();
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Self-serve auth surface (requires AUTH_SECRET) ─────────────
        if (developerSessionDeps && clearAuth) {
          const clearAuthResponse = await handleExternalAuthRoute(req, path, {
            clearAuth,
            publicBaseUrl: config.publicBaseUrl,
          });
          if (clearAuthResponse) {
            log(`${method} ${path} -> ${clearAuthResponse.status} (${Date.now() - startedAt}ms)`);
            return clearAuthResponse;
          }

          const developerResponse = await handleDeveloperConsoleRoute(req, method, path, {
            ...developerSessionDeps,
            keyService: externalKeyService,
            deviceAuthStore,
            ephemeralStore: consoleEphemeralStore,
            publicBaseUrl: config.publicBaseUrl,
            maxActiveKeys: config.externalMaxActiveKeysPerUser,
          });
          if (developerResponse) {
            log(`${method} ${path} -> ${developerResponse.status} (${Date.now() - startedAt}ms)`);
            return developerResponse;
          }

          const sessionApiResponse = await handleExternalApiKeysRoute(req, method, path, {
            ...developerSessionDeps,
            keyService: externalKeyService,
          });
          if (sessionApiResponse) {
            log(`${method} ${path} -> ${sessionApiResponse.status} (${Date.now() - startedAt}ms)`);
            return sessionApiResponse;
          }

          const deviceAuthResponse = await handleDeviceAuthRoute(req, method, path, {
            deviceAuthStore,
            rateLimiter: deviceAuthRateLimiter,
            publicBaseUrl: config.publicBaseUrl,
            grantTtlSeconds: config.deviceAuthGrantTtlSeconds,
            clientIp,
          });
          if (deviceAuthResponse) {
            log(`${method} ${path} -> ${deviceAuthResponse.status} (${Date.now() - startedAt}ms)`);
            return deviceAuthResponse;
          }
        } else if (
          path === '/auth' || path.startsWith('/auth/')
          || path === '/developer' || path.startsWith('/developer/')
          || path.startsWith('/v1/developer/') || path.startsWith('/v1/device-auth/')
        ) {
          const disabled = new Response('Self-serve auth is not configured (set AUTH_SECRET).', {
            status: 503,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
          log(`${method} ${path} -> 503 (${Date.now() - startedAt}ms)`);
          return disabled;
        }

        // ── Auth gate (admin + external personal keys, route policy, rate limits) ──
        const authResult = await authorizeRequest(req, method, path, requestAuthDeps);
        if (!authResult.ok) {
          const res = authResult.response;
          logWarn(`${method} ${path} ${authFailureEvent(res.status)} status=${res.status}`);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }
        const principal = authResult.principal;

        if (config.remoteLocalAdmissionEnabled && remoteLocalEnrollment) {
          const remoteLocalBootstrapResponse = await handleRemoteLocalAuthorityBootstrapRoute({
            req, method, path, principal, repository: admissionRepository,
            bootstrapOwners: remoteLocalBootstrapOwners,
            adapterIdentity: config.brainAuthorizationAdapterIdentity!, adapterVersion: config.brainAuthorizationAdapterVersion!,
          });
          if (remoteLocalBootstrapResponse) {
            log(`${method} ${path} -> ${remoteLocalBootstrapResponse.status} (${Date.now() - startedAt}ms)`);
            return remoteLocalBootstrapResponse;
          }
          const remoteLocalEnrollmentResponse = await handleRemoteLocalEnrollmentRoute({
            req, method, path, principal, enrollment: remoteLocalEnrollment, repository: admissionRepository,
          });
          if (remoteLocalEnrollmentResponse) {
            log(`${method} ${path} -> ${remoteLocalEnrollmentResponse.status} (${Date.now() - startedAt}ms)`);
            return remoteLocalEnrollmentResponse;
          }
        }

        if (config.remoteLocalOperationsEnabled && admissionRepository) {
          const remoteLocalChatResponse = await handleRemoteLocalChatRoute({
            req, method, path, principal,
            deps: { repository: admissionRepository, operations: remoteLocalOwnerOperations },
          });
          if (remoteLocalChatResponse) {
            log(`${method} ${path} -> ${remoteLocalChatResponse.status} (${Date.now() - startedAt}ms)`);
            return remoteLocalChatResponse;
          }
        }

        // ── Immutable transcript archive v2 ───────────────────────────
        if (transcriptArchiveStore) {
          const archiveResponse = await handleArchiveV2Route(
            req, url, principal, brainStore, transcriptArchiveStore,
          );
          if (archiveResponse) {
            log(`${method} ${path} -> ${archiveResponse.status} (${Date.now() - startedAt}ms)`);
            return archiveResponse;
          }
        }

        // ── Admin-only external-auth audit (AC-9) ─────────────────────
        const auditResponse = await handleExternalAuthAuditRoute(method, path, principal, {
          auditStore: externalAuthAuditStore,
        });
        if (auditResponse) {
          log(`${method} ${path} -> ${auditResponse.status} (${Date.now() - startedAt}ms)`);
          return auditResponse;
        }

        // ── Auth status (external allowlist bootstrap) ────────────────
        if (path === '/v1/auth/status') {
          const res = handleAuthStatusRoute(method, principal);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── AgentHost Protocol v1 control plane (no transport/ingress) ──
        const agentHostControlPlaneResponse = await handleAgentHostControlPlaneRoute({
          req,
          method,
          path,
          principal,
          brainStore,
          controlPlaneStore: agentHostControlPlaneStore,
        });
        if (agentHostControlPlaneResponse) {
          log(`${method} ${path} -> ${agentHostControlPlaneResponse.status} (${Date.now() - startedAt}ms)`);
          return agentHostControlPlaneResponse;
        }

        // ── Boot bundle ───────────────────────────────────────────────
        if (path === '/v1/boot-bundle') {
          if (method !== 'POST') {
            const res = methodNotAllowed(['POST']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handleBootBundle(req, brainStore, bundleBuilder, brainBranchStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Brain DB provisioning ─────────────────────────────────────
        if (path === '/v1/brain-db/provision') {
          if (method !== 'POST') {
            const res = methodNotAllowed(['POST']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handleBrainDbProvision(req, { mechClient: mech });
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Fleet Health Board (PRD-0038 FR-8/9/11) ───────────────────
        if (path === '/v1/health/report') {
          const res = method === 'POST'
            ? await handleHealthReport(req, healthStore, new Date(), brainStore, healthReportAuthzMode)
            : methodNotAllowed(['POST']);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }
        if (path === '/v1/health') {
          const res = method === 'GET'
            ? await handleFleetHealth(healthStore, new Date(), config.healthStaleAfterMs)
            : methodNotAllowed(['GET']);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }
        const brainHealthMatch = path.match(/^\/v1\/brains\/([^/]+)\/health$/);
        if (brainHealthMatch) {
          let brainId: string;
          try {
            brainId = decodeAndValidateIdentifier(brainHealthMatch[1] ?? '', 'brainId', 128);
          } catch {
            const res = jsonError(400, 'invalid_request', 'brainId must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = method === 'GET'
            ? await handleBrainHealth(brainId, healthStore, new Date(), config.healthStaleAfterMs)
            : methodNotAllowed(['GET']);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Brain registry ────────────────────────────────────────────
        if (path === '/v1/brains') {
          let res: Response;
          if (method === 'GET') {
            res = await handleListBrains(brainStore);
          } else if (method === 'POST') {
            res = await handleCreateBrain(req, brainStore, brainBranchStore);
          } else {
            res = methodNotAllowed(['GET', 'POST']);
          }
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        const brainMatch = path.match(/^\/v1\/brains\/([^/]+)$/);
        if (brainMatch) {
          let brainId: string;
          try {
            brainId = decodeAndValidateIdentifier(brainMatch[1] ?? '', 'brainId', 128);
          } catch {
            const res = jsonError(400, 'invalid_request', 'brainId must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          let res: Response;
          if (method === 'GET') {
            res = await handleGetBrain(brainId, brainStore);
          } else if (method === 'PATCH') {
            res = await handleUpdateBrain(brainId, req, brainStore);
          } else if (method === 'DELETE') {
            res = await handleDeleteBrain(brainId, brainStore, brainBranchStore);
          } else {
            res = methodNotAllowed(['GET', 'PATCH', 'DELETE']);
          }
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        const brainBranchesMatch = path.match(/^\/v1\/brains\/([^/]+)\/branches$/);
        if (brainBranchesMatch) {
          let brainId: string;
          try {
            brainId = decodeAndValidateIdentifier(brainBranchesMatch[1] ?? '', 'brainId', 128);
          } catch {
            const res = jsonError(400, 'invalid_request', 'brainId must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = method === 'GET'
            ? await handleListBrainBranches(brainId, brainStore, brainBranchStore)
            : method === 'POST'
              ? await handleCreateBrainBranch(brainId, req, brainStore, brainBranchStore)
              : methodNotAllowed(['GET', 'POST']);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        const brainBranchMatch = path.match(/^\/v1\/brains\/([^/]+)\/branches\/([^/]+)$/);
        if (brainBranchMatch) {
          let brainId: string;
          let branchId: string;
          try {
            brainId = decodeAndValidateIdentifier(brainBranchMatch[1] ?? '', 'brainId', 128);
            branchId = decodeAndValidateIdentifier(brainBranchMatch[2] ?? '', 'branchId', 128);
          } catch {
            const res = jsonError(400, 'invalid_request', 'brainId and branchId must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = method === 'GET'
            ? await handleGetBrainBranch(brainId, branchId, brainStore, brainBranchStore)
            : method === 'DELETE'
              ? await handleDeleteBrainBranch(brainId, branchId, brainStore, brainBranchStore)
              : methodNotAllowed(['GET', 'DELETE']);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        const agentWakeMatch = path.match(/^\/v1\/agents\/([^/]+)\/wake$/);
        if (agentWakeMatch) {
          let agentId: string;
          try {
            agentId = decodeAndValidateIdentifier(agentWakeMatch[1] ?? '', 'agentId', 128);
          } catch {
            const res = jsonError(400, 'invalid_request', 'agentId must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = method === 'POST'
            ? await handleWakeAgent(req, agentId, brainStore, runtimeLeaseStore, {
              image: config.agentHostRuntimeImage,
              port: config.agentHostRuntimePort,
              healthPath: config.agentHostRuntimeHealthPath,
              healthIntervalSeconds: config.agentHostRuntimeHealthIntervalSeconds,
              healthTimeoutSeconds: config.agentHostRuntimeHealthTimeoutSeconds,
              cpu: config.agentHostRuntimeCpu,
              memoryMb: config.agentHostRuntimeMemoryMb,
            })
            : methodNotAllowed(['POST']);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        const runtimeAddressMatch = path.match(/^\/v1\/agents\/([^/]+)\/runtime_address$/);
        if (runtimeAddressMatch) {
          let agentId: string;
          try {
            agentId = decodeAndValidateIdentifier(runtimeAddressMatch[1] ?? '', 'agentId', 128);
          } catch {
            const res = jsonError(400, 'invalid_request', 'agentId must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = method === 'GET'
            ? await handleGetRuntimeAddress(agentId, runtimeLeaseStore)
            : methodNotAllowed(['GET']);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Skill registry ────────────────────────────────────────────
        if (path === '/v1/skills') {
          let res: Response;
          if (method === 'GET') {
            res = await handleListSkills(skillStore);
          } else if (method === 'POST') {
            res = await handleCreateSkill(req, skillStore);
          } else {
            res = methodNotAllowed(['GET', 'POST']);
          }
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        if (path === '/v1/skills/sync') {
          const res = method === 'POST'
            ? await handleSyncSkills(req, skillStore, registryStore)
            : methodNotAllowed(['POST']);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        const skillMatch = path.match(/^\/v1\/skills\/([^/]+)$/);
        if (skillMatch) {
          let skillId: string;
          try {
            skillId = decodeAndValidateIdentifier(skillMatch[1] ?? '', 'skillId', 200);
          } catch {
            const res = jsonError(400, 'invalid_request', 'skillId must be 1-200 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          let res: Response;
          if (method === 'GET') {
            res = await handleGetSkill(skillId, skillStore);
          } else if (method === 'DELETE') {
            res = await handleDeleteSkill(skillId, skillStore);
          } else {
            res = methodNotAllowed(['GET', 'DELETE']);
          }
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Tool Registry ─────────────────────────────────────────────
        if (path === '/v1/registry/search') {
          if (method !== 'GET') {
            const res = methodNotAllowed(['GET']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handleRegistrySearch(req, registryStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        if (path === '/v1/registry/services') {
          if (method !== 'GET') {
            const res = methodNotAllowed(['GET']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handleListServices(registryStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        const serviceMatch = path.match(/^\/v1\/registry\/services\/([^/]+)$/);
        if (serviceMatch) {
          let serviceId: string;
          try {
            serviceId = decodeAndValidateIdentifier(serviceMatch[1] ?? '', 'serviceId', 200);
          } catch {
            const res = jsonError(400, 'invalid_request', 'serviceId must be 1-200 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          if (method !== 'GET') {
            const res = methodNotAllowed(['GET']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handleGetService(serviceId, registryStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        if (path === '/v1/registry/skills') {
          if (method !== 'GET') {
            const res = methodNotAllowed(['GET']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handleListRegistrySkills(registryStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        if (path === '/v1/registry/publish') {
          if (method !== 'POST') {
            const res = methodNotAllowed(['POST']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handlePublishRegistry(req, registryStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Manifest ──────────────────────────────────────────────────
        if (path === '/v1/manifest') {
          let res: Response;
          if (method === 'GET') {
            res = await handleGetManifest(registryStore);
          } else if (method === 'POST') {
            res = await handlePublishManifest(req, registryStore);
          } else {
            res = methodNotAllowed(['GET', 'POST']);
          }
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Memory sync ───────────────────────────────────────────────
        const memoryPushMatch = path.match(/^\/v1\/memory\/([^/]+)\/push$/);
        if (memoryPushMatch) {
          let brainId: string;
          try {
            brainId = decodeAndValidateBrainId(memoryPushMatch[1] ?? '');
          } catch {
            const res = jsonError(400, 'invalid_request', 'Brain ID must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          if (method !== 'POST') {
            const res = methodNotAllowed(['POST']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handlePushMemory(brainId, req, brainStore, memoryStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        const memoryPullMatch = path.match(/^\/v1\/memory\/([^/]+)\/pull$/);
        if (memoryPullMatch) {
          let brainId: string;
          try {
            brainId = decodeAndValidateBrainId(memoryPullMatch[1] ?? '');
          } catch {
            const res = jsonError(400, 'invalid_request', 'Brain ID must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          if (method !== 'GET') {
            const res = methodNotAllowed(['GET']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handlePullMemory(brainId, brainStore, memoryStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Brain asset sync ──────────────────────────────────────────
        const brainAssetPushMatch = path.match(/^\/v1\/brain-assets\/([^/]+)\/push$/);
        if (brainAssetPushMatch) {
          let brainId: string;
          try {
            brainId = decodeAndValidateBrainId(brainAssetPushMatch[1] ?? '');
          } catch {
            const res = jsonError(400, 'invalid_request', 'Brain ID must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          if (method !== 'POST') {
            const res = methodNotAllowed(['POST']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handlePushBrainAssets(brainId, req, brainStore, brainAssetStore, brainBranchStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        const brainAssetCapabilitiesMatch = path.match(/^\/v1\/brain-assets\/([^/]+)\/capabilities$/);
        if (brainAssetCapabilitiesMatch) {
          let brainId: string;
          try {
            brainId = decodeAndValidateBrainId(brainAssetCapabilitiesMatch[1] ?? '');
          } catch {
            const res = jsonError(400, 'invalid_request', 'Brain ID must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          if (method !== 'GET') {
            const res = methodNotAllowed(['GET']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handleBrainAssetCapabilities(brainId, brainStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        const brainAssetHashesMatch = path.match(/^\/v1\/brain-assets\/([^/]+)\/hashes$/);
        if (brainAssetHashesMatch) {
          let brainId: string;
          try {
            brainId = decodeAndValidateBrainId(brainAssetHashesMatch[1] ?? '');
          } catch {
            const res = jsonError(400, 'invalid_request', 'Brain ID must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          if (method !== 'GET') {
            const res = methodNotAllowed(['GET']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handleListBrainAssetHashes(brainId, req, brainStore, brainAssetStore, brainBranchStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        const brainAssetPullMatch = path.match(/^\/v1\/brain-assets\/([^/]+)$/);
        if (brainAssetPullMatch) {
          let brainId: string;
          try {
            brainId = decodeAndValidateBrainId(brainAssetPullMatch[1] ?? '');
          } catch {
            const res = jsonError(400, 'invalid_request', 'Brain ID must be 1-128 identifier-safe characters.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          if (method !== 'GET' && method !== 'DELETE') {
            const res = methodNotAllowed(['GET', 'DELETE']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = method === 'DELETE'
            ? await handleDeleteSecretAssets(brainId, req, brainStore, brainAssetStore)
            : await handlePullBrainAssets(brainId, req, brainStore, brainAssetStore, brainBranchStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Network config ─────────────────────────────────────────────
        if (path === '/v1/network-config') {
          let res: Response;
          if (method === 'GET') {
            res = await handleGetNetworkConfig(networkConfigStore);
          } else if (method === 'PUT') {
            res = await handlePutNetworkConfig(req, networkConfigStore);
          } else {
            res = methodNotAllowed(['GET', 'PUT']);
          }
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── Transcript sync ───────────────────────────────────────────
        if (path === '/v1/sync/transcripts/push') {
          if (method !== 'POST') {
            const res = methodNotAllowed(['POST']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handlePushTranscripts(req, brainStore, transcriptStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        if (path === '/v1/sync/transcripts/pull') {
          if (method !== 'GET') {
            const res = methodNotAllowed(['GET']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handlePullTranscripts(req, brainStore, transcriptStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // Key may contain slashes — capture everything after the prefix
        const downloadMatch = path.match(/^\/v1\/sync\/transcripts\/download\/(.+)$/);
        if (downloadMatch) {
          if (method !== 'GET') {
            const res = methodNotAllowed(['GET']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          let key: string;
          try {
            key = decodeURIComponent(downloadMatch[1] ?? '');
          } catch {
            const res = jsonError(400, 'invalid_request', 'Transcript key is not valid URL-encoded.');
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handleDownloadTranscript(key, req, brainStore, transcriptStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        if (path === '/v1/sync/transcripts/status') {
          if (method !== 'GET') {
            const res = methodNotAllowed(['GET']);
            log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
            return res;
          }
          const res = await handleTranscriptStatus(req, brainStore, transcriptStore);
          log(`${method} ${path} -> ${res.status} (${Date.now() - startedAt}ms)`);
          return res;
        }

        // ── 404 ───────────────────────────────────────────────────────
        const notFound = new Response('Not Found', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
        log(`${method} ${path} -> 404 (${Date.now() - startedAt}ms)`);
        return notFound;

      } catch (err) {
        if (err instanceof HttpError) {
          const developerError = translateDeveloperConsoleHttpError(err, config.publicBaseUrl, path);
          if (developerError) {
            logWarn(`${method} ${path} -> ${err.status} ${err.code}: ${err.message}`);
            return developerError;
          }
          logWarn(`${method} ${path} -> ${err.status} ${err.code}: ${err.message}`);
          return jsonError(err.status, err.code, err.message);
        }
        logWarn(`${method} ${path} -> 500 internal_error: ${err instanceof Error ? err.message : String(err)}`);
        return jsonError(500, 'internal_error', 'Internal Server Error');
      }
    },
  });

  log(`listening on http://${config.host}:${config.port}`);

  // Fire-and-forget: never block the bound server on backfill I/O.
  void runStartupBackfill();

  // Graceful shutdown
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      log(`${signal} received, shutting down`);
      await server.stop(true);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('[agentbootup-server] startup failed:', err);
  process.exit(1);
});
