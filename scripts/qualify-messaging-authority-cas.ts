#!/usr/bin/env bun

import {
  createStorageSdk,
  reconcileUncertainCommit,
  type CasCreateBody,
  type CasCreateResult,
  type CasGetResult,
  type CasUpdateBody,
  type CasUpdateResult,
} from '@mech/storage-sdk';

export const QUALIFIED_STORAGE_SDK_VERSION = '0.4.0';
export const QUALIFICATION_COLLECTION = 'agentbootup-cas-qualification';
const EXPIRED_SERVER_TIME_DEADLINE = '2000-01-01T00:00:00.000Z';

export interface CasQualificationClient {
  getDocument(collection: string, documentKey: string): Promise<CasGetResult>;
  createDocument(body: CasCreateBody): Promise<CasCreateResult>;
  updateDocument(
    collection: string,
    documentKey: string,
    body: CasUpdateBody,
  ): Promise<CasUpdateResult>;
}

export interface CasQualificationInput {
  clientA: CasQualificationClient;
  clientB: CasQualificationClient;
  lossyClient: CasQualificationClient;
  collection: string;
  documentKey: string;
  qualificationId: string;
  uncertainTransport: {
    getPutAttempts(): number;
    isDeliberatePostCommitLoss(error: unknown): boolean;
  };
}

export interface CasQualificationResult {
  verdict: 'GO';
  sdkVersion: typeof QUALIFIED_STORAGE_SDK_VERSION;
  createRace: { winners: 1; typedConflicts: 1 };
  serverTimePrecondition: { expiredDeadline: 'rejected'; documentUnchanged: true };
  updateRace: { winners: 1; typedConflicts: 1 };
  revisionChain: { transitions: 3; unique: true; strictlyIncreasing: true };
  uncertainCommit: {
    updateAttempts: 1;
    state: 'committed';
    reason: 'revision-advanced-content-matches';
  };
  postRevocationRead: { client: 'B'; state: 'revoked'; currentOrNewer: true };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`CAS qualification failed: ${message}`);
}

function semanticJsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => semanticJsonEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key) && semanticJsonEqual(leftRecord[key], rightRecord[key]));
}

function oneSuccess<T extends { ok: boolean }>(results: T[]): Extract<T, { ok: true }> {
  const successes = results.filter((result): result is Extract<T, { ok: true }> => result.ok);
  invariant(successes.length === 1, `expected exactly one winner, received ${successes.length}`);
  return successes[0];
}

function exactTypedConflict(
  results: Array<CasCreateResult | CasUpdateResult>,
  code: 'DOCUMENT_EXISTS' | 'REVISION_CONFLICT',
): void {
  const conflicts = results.filter((result) => !result.ok && result.code === code);
  invariant(conflicts.length === 1, `expected exactly one ${code}, received ${conflicts.length}`);
}

function syntheticAuthorityData(qualificationId: string): Record<string, unknown> {
  return {
    schema_version: 1,
    brain_id: `synthetic-${qualificationId}`,
    owner_principal_id: 'synthetic-owner',
    authority_state: 'active',
    hosted_target_id: 'synthetic-target',
    host_id: 'synthetic-host',
    deployment_generation: 1,
    adapter_identity: 'synthetic-adapter',
    adapter_version: '1',
    fencing_revision: 1,
    credential_revision: 1,
    policy_revision: 1,
    last_command_id: `${qualificationId}:create`,
    audit: { purpose: 'agentbootup-i1a-provider-qualification' },
  };
}

export async function runCasQualification(input: CasQualificationInput): Promise<CasQualificationResult> {
  const initialData = syntheticAuthorityData(input.qualificationId);
  const metadata = { purpose: 'agentbootup-i1a-provider-qualification' };
  const createBody: CasCreateBody = {
    collection: input.collection,
    document_key: input.documentKey,
    data: initialData,
    metadata,
  };

  const createResults = await Promise.all([
    input.clientA.createDocument(createBody),
    input.clientB.createDocument(createBody),
  ]);
  const created = oneSuccess(createResults);
  exactTypedConflict(createResults, 'DOCUMENT_EXISTS');
  invariant(semanticJsonEqual(created.document.data, initialData), 'create winner returned torn or unexpected data');
  invariant(semanticJsonEqual(created.document.metadata, metadata), 'create winner returned torn or unexpected metadata');
  const createReads = await Promise.all([
    input.clientA.getDocument(input.collection, input.documentKey),
    input.clientB.getDocument(input.collection, input.documentKey),
  ]);
  for (const read of createReads) {
    invariant(read.ok, 'a client could not read the create winner');
    invariant(read.document._rev === created.document._rev, 'a client did not read the create winner revision');
    invariant(semanticJsonEqual(read.document.data, initialData), 'a client read torn create-winner data');
    invariant(semanticJsonEqual(read.document.metadata, metadata), 'a client read torn create-winner metadata');
  }

  // This must be a server-owned rejection, not a client-clock decision. The
  // rejected body intentionally differs from the stored document: a passing
  // result therefore proves the predicate did not mutate data or advance rev.
  const expiredDeadlineAttempt = await input.clientA.updateDocument(input.collection, input.documentKey, {
    _rev: created.document._rev,
    data: { ...initialData, last_command_id: `${input.qualificationId}:expired-deadline-attempt` },
    precondition: { server_time_before: EXPIRED_SERVER_TIME_DEADLINE },
  });
  invariant(!expiredDeadlineAttempt.ok && expiredDeadlineAttempt.code === 'SERVER_TIME_PRECONDITION_FAILED',
    'expired server-time precondition was not rejected explicitly');
  const postPredicateRead = await input.clientB.getDocument(input.collection, input.documentKey);
  invariant(postPredicateRead.ok, 'a client could not read after rejected server-time precondition');
  invariant(postPredicateRead.document._rev === created.document._rev, 'rejected server-time precondition advanced revision');
  invariant(semanticJsonEqual(postPredicateRead.document.data, initialData), 'rejected server-time precondition mutated data');

  const updateAData = {
    ...initialData,
    fencing_revision: 2,
    last_command_id: `${input.qualificationId}:race:a`,
  };
  const updateBData = {
    ...initialData,
    fencing_revision: 2,
    last_command_id: `${input.qualificationId}:race:b`,
  };
  const updateResults = await Promise.all([
    input.clientA.updateDocument(input.collection, input.documentKey, {
      _rev: created.document._rev,
      data: updateAData,
    }),
    input.clientB.updateDocument(input.collection, input.documentKey, {
      _rev: created.document._rev,
      data: updateBData,
    }),
  ]);
  const updated = oneSuccess(updateResults);
  exactTypedConflict(updateResults, 'REVISION_CONFLICT');
  const updateWinnerMatchesA = semanticJsonEqual(updated.document.data, updateAData);
  const updateWinnerMatchesB = semanticJsonEqual(updated.document.data, updateBData);
  invariant(updateWinnerMatchesA !== updateWinnerMatchesB, 'update winner returned torn or ambiguous data');
  invariant(semanticJsonEqual(updated.document.metadata, metadata), 'update winner returned torn metadata');
  const expectedUpdateData = updateWinnerMatchesA ? updateAData : updateBData;
  const updateReads = await Promise.all([
    input.clientA.getDocument(input.collection, input.documentKey),
    input.clientB.getDocument(input.collection, input.documentKey),
  ]);
  for (const read of updateReads) {
    invariant(read.ok, 'a client could not read the update winner');
    invariant(read.document._rev === updated.document._rev, 'a client did not read the update winner revision');
    invariant(semanticJsonEqual(read.document.data, expectedUpdateData), 'a client read torn update-winner data');
    invariant(semanticJsonEqual(read.document.metadata, metadata), 'a client read torn update-winner metadata');
  }

  const uncertainData = {
    ...updated.document.data,
    policy_revision: 2,
    last_command_id: `${input.qualificationId}:uncertain`,
  };
  const attemptsBefore = input.uncertainTransport.getPutAttempts();
  let uncertainThrew = false;
  try {
    await input.lossyClient.updateDocument(input.collection, input.documentKey, {
      _rev: updated.document._rev,
      data: uncertainData,
    });
  } catch (error) {
    invariant(
      input.uncertainTransport.isDeliberatePostCommitLoss(error),
      'uncertain update failed for a reason other than the deliberate post-commit response loss',
    );
    uncertainThrew = true;
  }
  const uncertainAttempts = input.uncertainTransport.getPutAttempts() - attemptsBefore;
  invariant(uncertainThrew, 'lossy client did not discard the successful update response');
  invariant(uncertainAttempts === 1, 'uncertain update was retried blindly');

  const uncertainRead = await input.clientB.getDocument(input.collection, input.documentKey);
  const reconciled = reconcileUncertainCommit({
    prevRev: updated.document._rev,
    intendedData: uncertainData,
    readResult: uncertainRead,
  });
  invariant(reconciled.state === 'committed', `uncertain commit reconciled as ${reconciled.state}`);
  invariant(
    reconciled.reason === 'revision-advanced-content-matches',
    `unexpected uncertain-commit reason ${reconciled.reason}`,
  );
  invariant(reconciled.current, 'committed reconciliation omitted the current document');

  const revokedData = {
    ...reconciled.current.data,
    authority_state: 'revoked',
    fencing_revision: 3,
    last_command_id: `${input.qualificationId}:revoke`,
  };
  const revoked = await input.clientA.updateDocument(input.collection, input.documentKey, {
    _rev: reconciled.current._rev,
    data: revokedData,
  });
  invariant(revoked.ok, `revocation failed with ${revoked.code}`);

  // The commit barrier is the awaited successful update above. Client B is a
  // separately constructed SDK client and performs its read only afterward.
  const postRevocationRead = await input.clientB.getDocument(input.collection, input.documentKey);
  invariant(postRevocationRead.ok, 'client B could not read after revocation committed');
  invariant(postRevocationRead.document.data.authority_state === 'revoked', 'client B observed pre-revocation state');
  invariant(postRevocationRead.document._rev === revoked.document._rev, 'client B did not observe the committed revision');

  const revisions = [
    created.document._rev,
    updated.document._rev,
    reconciled.current._rev,
    revoked.document._rev,
  ];
  invariant(new Set(revisions).size === revisions.length, 'a revision was reused or a transition was lost');
  // The qualification checks the provider's documented canonical positive
  // integer representation. I1B still treats `_rev` as an opaque equality
  // token and must never derive authority from its magnitude.
  invariant(
    revisions.slice(1).every((revision, index) => BigInt(revision) > BigInt(revisions[index])),
    'revisions did not advance monotonically',
  );

  return {
    verdict: 'GO',
    sdkVersion: QUALIFIED_STORAGE_SDK_VERSION,
    createRace: { winners: 1, typedConflicts: 1 },
    serverTimePrecondition: { expiredDeadline: 'rejected', documentUnchanged: true },
    updateRace: { winners: 1, typedConflicts: 1 },
    revisionChain: { transitions: 3, unique: true, strictlyIncreasing: true },
    uncertainCommit: {
      updateAttempts: 1,
      state: 'committed',
      reason: 'revision-advanced-content-matches',
    },
    postRevocationRead: { client: 'B', state: 'revoked', currentOrNewer: true },
  };
}

function requiredEnv(name: 'MECH_APP_ID' | 'MECH_API_KEY'): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyExecutableProvenance(): Promise<void> {
  const packageFile = Bun.file(new URL('../node_modules/@mech/storage-sdk/package.json', import.meta.url));
  const packageJson = await packageFile.json() as { version?: unknown };
  invariant(
    packageJson.version === QUALIFIED_STORAGE_SDK_VERSION,
    `installed SDK is ${String(packageJson.version)}, expected ${QUALIFIED_STORAGE_SDK_VERSION}`,
  );
  const mergeBase = Bun.spawnSync({
    cmd: ['git', 'merge-base', 'HEAD', 'origin/main'],
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  invariant(mergeBase.exitCode === 0, 'could not verify the branch base against origin/main');
  invariant(
    mergeBase.stdout.toString().trim() === 'df315535ed119ecce0fb652374442d939e4971f1',
    'branch base does not match the Task 2.5 source base',
  );
}

export class DeliberatePostCommitResponseLoss extends Error {
  constructor() {
    super('synthetic lost successful PUT response');
    this.name = 'DeliberatePostCommitResponseLoss';
  }
}

async function main(): Promise<void> {
  await verifyExecutableProvenance();
  const baseUrl = process.env.MECH_STORAGE_URL || 'https://mech-storage.fly.dev';
  const appId = requiredEnv('MECH_APP_ID');
  const apiKey = requiredEnv('MECH_API_KEY');
  const qualificationId = `${Date.now()}-${crypto.randomUUID()}`;
  const documentKey = `i1a-${qualificationId}`;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  let discardNextSuccessfulPut = true;
  let lossyPutAttempts = 0;
  const lossyFetch: typeof fetch = async (request, init) => {
    if (init?.method === 'PUT') lossyPutAttempts += 1;
    const response = await nativeFetch(request, init);
    if (discardNextSuccessfulPut && init?.method === 'PUT' && response.ok) {
      discardNextSuccessfulPut = false;
      throw new DeliberatePostCommitResponseLoss();
    }
    return response;
  };

  const clientA = createStorageSdk({ baseUrl, apiKey }).apps(appId).nosql.cas;
  const clientB = createStorageSdk({ baseUrl, apiKey }).apps(appId).nosql.cas;
  const lossyClient = createStorageSdk({ baseUrl, apiKey, fetch: lossyFetch }).apps(appId).nosql.cas;
  const result = await runCasQualification({
    clientA,
    clientB,
    lossyClient,
    collection: QUALIFICATION_COLLECTION,
    documentKey,
    qualificationId,
    uncertainTransport: {
      getPutAttempts: () => lossyPutAttempts,
      isDeliberatePostCommitLoss: (error) => error instanceof Error
        && error.cause instanceof DeliberatePostCommitResponseLoss,
    },
  });

  const endpoint = new URL(baseUrl);
  console.log(JSON.stringify({
    evidenceVersion: 1,
    checkedAt: new Date().toISOString(),
    sourceBaseCommit: 'df315535ed119ecce0fb652374442d939e4971f1',
    providerAttestation: {
      sourceMessageId: 'msg-1787455639187-4rv2dk',
      productionRelease: 197,
      sdkVersion: QUALIFIED_STORAGE_SDK_VERSION,
      endpointOrigin: endpoint.origin,
      endpointPath: '/api/apps/{appId}/nosql/cas',
    },
    disposableRecord: {
      collection: QUALIFICATION_COLLECTION,
      documentKeySha256: await sha256(documentKey),
      syntheticContentOnly: true,
    },
    clients: {
      independentlyConstructed: 3,
      sharedSdkClientOrSessionState: false,
      transport: 'stateless HTTPS',
    },
    result,
    secretsOrCustomerDataRetained: false,
  }, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[qualify-messaging-authority-cas] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
