/**
 * Agentbootup Server — Shared Types
 */

export type TrustLevel = 'full' | 'standard' | 'restricted';

export interface SyncInstance {
  hostname: string;
  os_type: string;
  os_release: string;
  platform: string;
  ip: string | null;
  last_sync_at: string;           // ISO 8601
}

export interface Brain {
  id: string;                          // e.g. "decisive-gm"
  repo_url: string | null;             // e.g. "https://github.com/dundas/decisive-redux.git"; null = no repo yet
  repo_branch: string | null;          // default "main" when a repo is set; null when repo-less
  vault_namespace: string;             // e.g. "brain-server-prod"
  skills: string[];                    // assigned skill IDs
  memory_collection: string;           // Mech NoSQL collection name
  parent_brain: string | null;         // hierarchical reporting
  trust_level: TrustLevel;
  metadata: Record<string, unknown>;
  sync_instances?: Record<string, SyncInstance>; // keyed by machine_id
  registered_at: string;               // ISO 8601
  updated_at: string;                  // ISO 8601
}

export interface CreateBrainRequest {
  id: string;
  repo_url?: string | null;
  repo_branch?: string | null;
  vault_namespace: string;
  skills?: string[];
  memory_collection?: string;
  parent_brain?: string | null;
  trust_level?: TrustLevel;
  metadata?: Record<string, unknown>;
}

export interface UpdateBrainRequest {
  repo_url?: string;
  repo_branch?: string;
  vault_namespace?: string;
  skills?: string[];
  memory_collection?: string;
  parent_brain?: string | null;
  trust_level?: TrustLevel;
  metadata?: Record<string, unknown>;
}

export type BrainBranchStatus = 'active' | 'inactive' | 'deleted';

export interface BrainBranch {
  brain_id: string;
  branch_id: string;
  tenant_ref: string | null;
  base_image_sha: string | null;
  bundle_version: string | null;
  volume_uri: string | null;
  status: BrainBranchStatus;
  last_seen_at: string | null;
  last_platform_snapshot_ts: string | null;
  last_agentbootup_snapshot_ts: string | null;
  last_agentbootup_snapshot_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBrainBranchRequest {
  brain_id: string;
  branch_id: string;
  tenant_ref?: string | null;
  base_image_sha?: string | null;
  bundle_version?: string | null;
  volume_uri?: string | null;
  status?: BrainBranchStatus;
  last_seen_at?: string | null;
  last_platform_snapshot_ts?: string | null;
  last_agentbootup_snapshot_ts?: string | null;
  last_agentbootup_snapshot_key?: string | null;
}

export interface BrainBranchSnapshotUpdate {
  last_seen_at?: string | null;
  last_platform_snapshot_ts?: string | null;
  last_agentbootup_snapshot_ts?: string | null;
  last_agentbootup_snapshot_key?: string | null;
}

export interface BrainBranchSnapshotRef {
  brain_id: string;
  branch_id: string;
  snapshot_ts: string;
  storage_key: string;
  compatibility_lookup_keys: string[];
}

// ── Runtime Lease ────────────────────────────────────────────────────────────

export type RuntimeLeaseStatus = 'waking' | 'chat_ready' | 'failed' | 'expired';

export interface AgentHostRuntimeSpec {
  kind: 'agenthost-runtime';
  agentId: string;
  bundleRef: string;
  image: string;
  port: number;
  ingressKeyRef: string;
  healthCheck: {
    path: string;
    intervalSeconds: number;
    timeoutSeconds: number;
  };
  resources: {
    cpu: string;
    memoryMb: number;
  };
  placementPolicy?: Record<string, string>;
}

export interface RuntimeLease {
  agentId: string;
  bundleRef: string;
  machineId: string | null;
  endpoint: string | null;
  ingressKeyRef: string;
  status: RuntimeLeaseStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  agentHostRuntimeSpec: AgentHostRuntimeSpec;
}

export interface RuntimeAddress {
  agentId: string;
  endpoint: string;
  ingressKeyRef: string;
  /** RuntimeAddress is only emitted for ready leases; pending/failed/expired states return null. */
  status: 'chat_ready';
  expiresAt: string;
}

export interface RuntimeSpecOptions {
  image: string;
  port: number;
  healthPath: string;
  healthIntervalSeconds: number;
  healthTimeoutSeconds: number;
  cpu: string;
  memoryMb: number;
}

export interface WakeAgentRequest {
  bundleRef: string;
  ingressKeyRef?: string;
  ttlSeconds?: number;
  placementPolicy?: Record<string, string>;
}

export interface WakeAgentResponse {
  status: RuntimeLeaseStatus;
  lease: RuntimeLease;
  runtime_address: RuntimeAddress | null;
}

export interface RuntimeAddressResponse {
  status: RuntimeLeaseStatus;
  lease: RuntimeLease;
  runtime_address: RuntimeAddress | null;
}

// ── AgentHost Protocol v1 control plane ────────────────────────────────────
//
// These records model AgentHost enrollment evidence, scoped grants, and
// projections of the separate durable brain authority; they are not a second
// desired-state authority or a transport. In particular, no endpoint URL, host
// private key, device secret, tunnel credential, or environment grant can occur.

export type AgentHostIsolationClass = 'managed-cloud-sandbox' | 'user-owned-local-host';
export type AgentHostKeyCustody = 'managed-service' | 'user-device';
export type AgentHostOwnership = 'managed-by-agentbootup' | 'owned-by-user';
export type AgentHostStatus = 'active' | 'revoked';
export type AgentHostSessionOperation = 'turn.submit' | 'event.stream' | 'session.cancel';

export interface AgentHostDisclosure {
  isolationClass: AgentHostIsolationClass;
  keyCustody: AgentHostKeyCustody;
  hostOwnership: AgentHostOwnership;
}

export interface AgentHostRecord extends AgentHostDisclosure {
  brainId: string;
  hostId: string;
  /** SHA-256 fingerprint of a host public key; never a host/device secret. */
  publicKeyFingerprint: string;
  deploymentGeneration: number;
  status: AgentHostStatus;
  enrolledByCredentialId: string;
  enrolledAt: string;
  revokedAt: string | null;
}

export interface AgentHostDesiredState {
  brainId: string;
  deploymentGeneration: number;
  activeHostId: string | null;
  updatedAt: string;
}

export interface AgentHostEndpointTarget extends AgentHostDisclosure {
  brainId: string;
  hostId: string;
  deploymentGeneration: number;
}

export interface AgentHostEnrollmentChallenge extends AgentHostDisclosure {
  enrollmentId: string;
  enrollmentSecret: string;
  brainId: string;
  hostId: string;
  publicKeyFingerprint: string;
  expiresAt: string;
}

export interface AgentHostSessionGrant {
  grantId: string;
  grant: string;
  expiresAt: string;
  target: AgentHostEndpointTarget;
  operations: AgentHostSessionOperation[];
}

export interface ApiSuccessBody<T> {
  data: T;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

// ── Memory Sync ───────────────────────────────────────────────────────────────

export interface MemoryFile {
  path: string;    // relative path, e.g. "memory/MEMORY.md"
  content: string; // file content (text)
}

export interface PushMemoryRequest {
  files: MemoryFile[];
}

// ── Skill Registry ────────────────────────────────────────────────────────────

export interface SkillFile {
  path: string;    // relative path, e.g. "SKILL.md" or "lib/parser.js"
  content: string; // raw text content
}

export interface Skill {
  id: string;           // e.g. "transcript-query"
  name: string;         // display name
  description: string;
  tags: string[];
  files: SkillFile[];   // stored inline — skills are typically < 50KB
  file_count: number;
  created_at: string;   // ISO 8601
  updated_at: string;   // ISO 8601
}

/** Skill metadata without file content — returned by list endpoint */
export type SkillSummary = Omit<Skill, 'files'>;

export interface CreateSkillRequest {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  files: SkillFile[];
}

/** Internal doc shape from Mech NoSQL */
export interface MechDocument {
  id: string;
  document_id: string;
  document: Record<string, unknown>;
}

// ── Transcript Sync ───────────────────────────────────────────────────────────

export type TranscriptCli = 'claude' | 'codex' | 'cursor' | 'gemini';

/**
 * A single chunk from a transcript file push (supports append / chunked upload).
 *
 * Route handler translation note:
 *   `isFinal` passed to `TranscriptStore.appendChunk()` is derived as:
 *   `chunk_index === total_chunks - 1`
 */
export interface TranscriptChunk {
  filename: string;
  cli: TranscriptCli;
  /**
   * Path of the transcript relative to the CLI root directory, e.g.
   * `-Users-alice-myproject/abc123.jsonl` for Claude.
   * The server stores and returns this so pull+restore can reconstruct
   * the original directory structure on another machine.
   */
  relative_path: string;
  /** 0-based index of this chunk within the file */
  chunk_index: number;
  /** Total number of chunks for this file (1 = single-request, non-chunked) */
  total_chunks: number;
  /** Byte offset within the complete file where this chunk begins */
  byte_offset: number;
  /** Total size of the complete file in bytes */
  total_size: number;
  /** Base64-encoded chunk content */
  content_base64: string;
}

/** Metadata for a stored transcript file */
export interface TranscriptMeta {
  key: string;
  filename: string;
  /** Relative path from the CLI root to the file */
  relative_path: string;
  cli: TranscriptCli;
  machine_id: string;
  brain_id: string;
  size: number;
  updated_at: string;
  /** v1 inventory is compatibility evidence only, never archive authority. */
  verification_state?: 'legacy_unverified';
  archive_authority?: false;
  eviction_eligible?: false;
}

/** Transcript file with optional inlined content (< 100 KB) */
export interface TranscriptFile extends TranscriptMeta {
  /** Base64-encoded file content — only present when size < 100 KB */
  content?: string;
  /**
   * Hex-encoded SHA-256 of the raw file bytes.
   * Pull clients verify this after writing to detect corruption or truncation.
   */
  content_sha256?: string;
}

export interface PushTranscriptsRequest {
  brain_id: string;
  machine_id: string;
  cli: TranscriptCli;
  files: TranscriptChunk[];
}

export interface PushTranscriptsResult {
  key: string;
  status: 'pushed' | 'appended' | 'error';
  error?: string;
}

export interface PushTranscriptsResponse {
  pushed: number;
  appended: number;
  errors: number;
  results: PushTranscriptsResult[];
}

// ── TranscriptStore adapter ───────────────────────────────────────────────────

/**
 * Minimal interface for the transcript store dependency in BundleBuilder.
 * The concrete TranscriptStore satisfies this structurally.
 */
export interface TranscriptStoreAdapter {
  list(brainId: string): Promise<TranscriptMeta[]>;
  download(key: string): Promise<Buffer>;
}

// ── Boot Bundle transcript entry ──────────────────────────────────────────────

/** Reason transcript fetch failed in a boot bundle. */
export type TranscriptsError = 'no_transcript_store' | 'fetch_failed';

// brain_id is intentionally omitted here — clients can infer it from BootBundle.brain.id
type BundleTranscriptBase = {
  filename: string;
  cli: TranscriptCli;
  machine_id: string;
  updated_at: string;
  /**
   * Stored file size in bytes (from storage metadata).
   * When `content` is present the wire payload is ~33% larger due to base64 encoding.
   * Do NOT use this field to measure decoded content length.
   */
  size: number;
};

/**
 * A transcript entry in a boot bundle.
 *
 * Exactly one of `content` or `key` is always present:
 * - `content`: base64-encoded file bytes (files below the inline threshold, currently 100 000 bytes)
 * - `key`: storage key for retrieval via the transcript download endpoint
 *   (files at or above the threshold, or when a small-file download fails or times out)
 */
export type BundleTranscript =
  | (BundleTranscriptBase & { content: string; key?: never })
  | (BundleTranscriptBase & { key: string; content?: never });

// ── Tool Registry ─────────────────────────────────────────────────────────────

export interface RegistryEndpoint {
  method: string;
  path: string;
  description: string;
  params?: Record<string, string>;
  status: 'working' | 'broken' | 'untested' | 'deprecated';
  gotchas?: string[];
}

export interface RegistryService {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  auth: { headers: string[] };
  healthCheck: string;
  openApiSpec?: string;
  brain?: string;
  categories: string[];
  endpoints: RegistryEndpoint[];
}

export interface RegistrySearchResult {
  type: 'endpoint' | 'skill';
  score: number;
  service?: { id: string; name: string; baseUrl: string };
  endpoint?: RegistryEndpoint;
  skill?: RegistrySkill;
}

export interface RegistrySkill {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  skillPath: string;
  contentSnippet?: string;
}

export interface RegistryData {
  version: string;
  generatedAt: string;
  services: RegistryService[];
}

export interface SkillsIndex {
  version: string;
  skillCount: number;
  skills: RegistrySkill[];
}

export interface PublishRegistryRequest {
  registry: RegistryData;
  skillsIndex?: SkillsIndex;
}

// ── External consumer auth (PRD-0041) ───────────────────────────────────────

export type ExternalApiKeyStatus = 'active' | 'revoked';

export type AuthPrincipalKind = 'admin' | 'external';

export interface ExternalApiKey {
  id: string;
  user_id: string;
  label: string;
  secret_hash: string;
  status: ExternalApiKeyStatus;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ExternalApiKeySummary {
  id: string;
  user_id: string;
  label: string;
  status: ExternalApiKeyStatus;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CreateExternalApiKeyRequest {
  user_id: string;
  label: string;
  /** Optional bearer token; generated server-side when omitted (FR-6). */
  secret?: string;
}

export type AuthPrincipal =
  | { kind: 'admin'; credential_id: string }
  | { kind: 'external'; user_id: string; key_id: string };

export interface AuthStatusResponse {
  principal: { kind: 'admin' } | Extract<AuthPrincipal, { kind: 'external' }>;
  allowed_surface: 'admin' | 'external';
}

export type ExternalAuthAuditEventType = 'key_create' | 'key_revoke' | 'key_use';

export interface ExternalAuthAuditEvent {
  id: string;
  event_type: ExternalAuthAuditEventType;
  user_id: string;
  key_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PublicRouteRule {
  method: string;
  path: string;
}

export interface ExternalUser {
  id: string;
  clearauth_user_id: string;
  email: string;
  created_at: string;
  updated_at: string;
}

export interface CreateExternalUserRequest {
  clearauth_user_id: string;
  email: string;
}

export type DeviceAuthGrantStatus = 'pending' | 'approved' | 'consumed' | 'expired';

export interface DeviceAuthGrant {
  device_code: string;
  user_code: string;
  status: DeviceAuthGrantStatus;
  user_id: string | null;
  key_id: string | null;
  /** SHA-256 hex digest of the issued API key; plaintext is never stored on the grant. */
  api_key_secret_hash: string | null;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
}

export type DeviceAuthConsumeResult =
  | { outcome: 'delivered'; api_key: string; user_id: string; key_id: string }
  | { outcome: 'already_consumed' }
  | { outcome: 'delivery_expired' }
  | { outcome: 'authorization_expired' }
  | { outcome: 'not_ready' };

export interface DeviceAuthStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceAuthPollResponse {
  status: DeviceAuthGrantStatus;
  api_key?: string;
}
