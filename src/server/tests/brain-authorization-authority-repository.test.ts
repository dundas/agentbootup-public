import { describe, expect, test } from 'bun:test';
import type { CasCreateBody, CasCreateResult, CasDocument, CasGetResult, CasUpdateBody, CasUpdateResult } from '@mech/storage-sdk';
import {
  BrainAuthorizationAuthorityRepository,
  DurableBrainAuthorizationDecisionAuthority,
  type BrainAuthorizationAuthorityCasClient,
} from '../lib/brain-authorization-authority-repository';
import { createBrainAuthorizationFence } from '../lib/brain-authorization-decision';

class MemoryCas {
  readonly documents = new Map<string, CasDocument>();
  readonly revisionHistory: string[] = [];
  revision = 0;
  updateAttempts = 0;
  loseNextUpdate = false;
  pauseNextUpdate?: Promise<void>;
  releasePaused?: () => void;
  client(): BrainAuthorizationAuthorityCasClient {
    return {
      getDocument: async (collection, key) => {
        const value = this.documents.get(`${collection}/${key}`);
        return value ? { ok: true, document: structuredClone(value) } : { ok: false, code: 'DOCUMENT_NOT_FOUND' };
      },
      createDocument: async (body) => this.create(body),
      updateDocument: async (collection, key, body) => this.update(collection, key, body),
    };
  }
  create(body: CasCreateBody): CasCreateResult {
    const key = `${body.collection}/${body.document_key}`;
    const current = this.documents.get(key);
    if (current) return { ok: false, code: 'DOCUMENT_EXISTS', current: structuredClone(current) };
    const nextRevision = String(++this.revision);
    const document: CasDocument = { id: `id-${body.document_key}`, collection: body.collection, document_key: body.document_key,
      data: structuredClone(body.data), metadata: structuredClone(body.metadata ?? {}), _rev: nextRevision,
      created_at: '2026-08-15T00:00:00.000Z', updated_at: '2026-08-15T00:00:00.000Z' };
    this.documents.set(key, document);
    this.revisionHistory.push(nextRevision);
    return { ok: true, document: structuredClone(document) };
  }
  async update(collection: string, keyPart: string, body: CasUpdateBody): Promise<CasUpdateResult> {
    this.updateAttempts += 1;
    if (this.pauseNextUpdate) { const pause = this.pauseNextUpdate; this.pauseNextUpdate = undefined; await pause; }
    const key = `${collection}/${keyPart}`;
    const current = this.documents.get(key);
    if (!current) return { ok: false, code: 'DOCUMENT_NOT_FOUND' };
    if (body._rev !== current._rev) return { ok: false, code: 'REVISION_CONFLICT', current: structuredClone(current) };
    const nextRevision = String(++this.revision);
    const document = { ...current, data: structuredClone(body.data), metadata: body.metadata ? structuredClone(body.metadata) : current.metadata,
      _rev: nextRevision, updated_at: '2026-08-15T00:00:01.000Z' };
    this.documents.set(key, document);
    this.revisionHistory.push(nextRevision);
    if (this.loseNextUpdate) { this.loseNextUpdate = false; throw new Error('transport failed with secret=do-not-echo'); }
    return { ok: true, document: structuredClone(document) };
  }
}

const bootstrap = (commandId = 'cmd-bootstrap') => ({ kind: 'bootstrap' as const, commandId, brainId: 'brain-a',
  context: { kind: 'authenticated_external_owner' as const, principalId: 'user-a' },
  ownerPrincipalId: 'user-a', targetId: 'target-a', hostId: 'host-a', deploymentGeneration: 1,
  adapterIdentity: 'adapter-a', adapterVersion: '1' });

async function boot(backend = new MemoryCas()) {
  const repository = new BrainAuthorizationAuthorityRepository(backend.client());
  const result = await repository.execute(bootstrap());
  expect(result.status).toBe('applied');
  if (result.status !== 'applied') throw new Error('bootstrap failed');
  return { backend, repository, fence: result.fence };
}

describe('BrainAuthorizationAuthorityRepository', () => {
  test('requires an exact authenticated external-owner context and stores empty metadata', async () => {
    const backend = new MemoryCas();
    const repository = new BrainAuthorizationAuthorityRepository(backend.client());
    const command = {
      kind: 'bootstrap', commandId: 'cmd-bootstrap', brainId: 'brain-a',
      context: { kind: 'authenticated_external_owner', principalId: 'user-a' },
      ownerPrincipalId: 'user-a', targetId: 'target-a', hostId: 'host-a', deploymentGeneration: 1,
      adapterIdentity: 'adapter-a', adapterVersion: '1',
    } as never;

    expect((await repository.execute(command)).status).toBe('applied');
    expect([...backend.documents.values()][0]?.metadata).toEqual({});
    expect((await repository.execute({ ...command, commandId: 'other', context: { kind: 'session', principalId: 'user-a' } } as never)).status).toBe('denied');
    expect((await repository.execute({ ...command, commandId: 'other', arbitraryPatch: { owner_status: 'active' } } as never)).status).toBe('denied');

    let ownerRead = 0;
    const accessorCommand = { ...command, commandId: 'accessor' } as Record<string, unknown>;
    Object.defineProperty(accessorCommand, 'ownerPrincipalId', {
      enumerable: true,
      get: () => (++ownerRead === 1 ? 'user-a' : 'attacker'),
    });
    const accessorBackend = new MemoryCas();
    expect((await new BrainAuthorizationAuthorityRepository(accessorBackend.client()).execute(accessorCommand as never)).status).toBe('denied');
    expect(ownerRead).toBe(0);
    expect(accessorBackend.documents.size).toBe(0);
  });

  test('reconciles exact bootstrap replay and rejects a conflicting replay', async () => {
    const { repository, backend, fence } = await boot();
    expect(await repository.execute(bootstrap())).toEqual({ status: 'idempotent', fence });
    expect((await repository.execute({ ...bootstrap(), targetId: 'other-target' })).status).toBe('conflict');
    expect(backend.documents.size).toBe(1);
  });

  test('rejects a stale expected capability fence for every non-bootstrap command family', async () => {
    const { repository, backend } = await boot();
    const stale = 'v1.stale';
    const common = { commandId: 'cmd', brainId: 'brain-a', context: bootstrap().context, expectedCapabilitiesRevision: stale };
    const commands = [
      { ...common, kind: 'target_replace' as const, targetId: 'target-b', hostId: 'host-b', deploymentGeneration: 2 },
      { ...common, kind: 'target_revoke' as const }, { ...common, kind: 'owner_revoke' as const },
      { ...common, kind: 'credential_revoke' as const },
      { ...common, kind: 'adapter_select' as const, adapterIdentity: 'adapter-b', adapterVersion: '2' },
      { ...common, kind: 'adapter_disable' as const }, { ...common, kind: 'policy_change' as const },
      { ...common, kind: 'local_device_revoke' as const, revokedAt: '2026-08-21T12:00:00.000Z' },
    ];
    for (const command of commands) expect((await repository.execute(command)).status).toBe('conflict');
    expect(backend.updateAttempts).toBe(0);
  });

  test('advances a unique fence and provider revision for every execution-affecting command', async () => {
    const { repository, backend, fence: initial } = await boot();
    let expected = initial.capabilitiesRevision;
    const revisions = [expected];
    const commands = [
      { kind: 'target_replace' as const, targetId: 'target-b', hostId: 'host-b', deploymentGeneration: 2 },
      { kind: 'adapter_disable' as const },
      { kind: 'adapter_select' as const, adapterIdentity: 'adapter-b', adapterVersion: '2' },
      { kind: 'policy_change' as const }, { kind: 'credential_revoke' as const }, { kind: 'target_revoke' as const },
    ];
    for (const [index, command] of commands.entries()) {
      const result = await repository.execute({ ...command, commandId: `cmd-${index}`, brainId: 'brain-a', context: bootstrap().context, expectedCapabilitiesRevision: expected });
      expect(result.status).toBe('applied');
      if (result.status !== 'applied') throw new Error('command failed');
      expected = result.fence.capabilitiesRevision; revisions.push(expected);
    }
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(new Set(backend.revisionHistory).size).toBe(backend.revisionHistory.length);
    expect(backend.revision).toBe(commands.length + 1);
  });

  test('binds target identity into the fence while the adapter is disabled', async () => {
    const { repository, backend, fence } = await boot();
    const disabled = await repository.execute({ kind: 'adapter_disable', commandId: 'disable', brainId: 'brain-a',
      context: bootstrap().context, expectedCapabilitiesRevision: fence.capabilitiesRevision });
    if (disabled.status !== 'applied') throw new Error('disable failed');
    const document = [...backend.documents.values()][0];
    document.data.target_id = 'attacker-target';

    expect(await repository.inspect('brain-a')).toEqual({ disposition: 'invalid' });
    expect((await repository.execute({ kind: 'adapter_select', commandId: 'enable', brainId: 'brain-a',
      context: bootstrap().context, expectedCapabilitiesRevision: disabled.fence.capabilitiesRevision,
      adapterIdentity: 'adapter-a', adapterVersion: '1' })).status).toBe('denied');
  });

  test('uses CAS across independent writers and one reread without blind retry', async () => {
    const backend = new MemoryCas();
    const writerA = new BrainAuthorizationAuthorityRepository(backend.client());
    const writerB = new BrainAuthorizationAuthorityRepository(backend.client());
    const created = await writerA.execute(bootstrap());
    if (created.status !== 'applied') throw new Error('bootstrap failed');
    let release!: () => void;
    backend.pauseNextUpdate = new Promise<void>((resolve) => { release = resolve; });
    const revoke = writerA.execute({ kind: 'target_revoke', commandId: 'revoke', brainId: 'brain-a', context: bootstrap().context, expectedCapabilitiesRevision: created.fence.capabilitiesRevision });
    const replace = writerB.execute({ kind: 'target_replace', commandId: 'replace', brainId: 'brain-a', context: bootstrap().context, expectedCapabilitiesRevision: created.fence.capabilitiesRevision, targetId: 'target-b', hostId: 'host-b', deploymentGeneration: 2 });
    await Bun.sleep(1); release();
    const results = await Promise.all([revoke, replace]);
    expect(results.filter((result) => result.status === 'applied')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'conflict')).toHaveLength(1);
    expect(backend.updateAttempts).toBe(2);
    const decision = await new DurableBrainAuthorizationDecisionAuthority(writerB).decide({ brain: { id: 'brain-a', metadata: {} } as never });
    const stored = [...backend.documents.values()][0].data;
    expect(decision.allowed).toBe(stored.target_disposition === 'active');
  });

  test('an independently constructed reader denies after a committed revoke barrier', async () => {
    const backend = new MemoryCas();
    const writer = new BrainAuthorizationAuthorityRepository(backend.client());
    const reader = new BrainAuthorizationAuthorityRepository(backend.client());
    const created = await writer.execute(bootstrap());
    if (created.status !== 'applied') throw new Error('bootstrap failed');

    const revoked = await writer.execute({ kind: 'target_revoke', commandId: 'revoke', brainId: 'brain-a',
      context: bootstrap().context, expectedCapabilitiesRevision: created.fence.capabilitiesRevision });
    expect(revoked.status).toBe('applied');

    const inspected = await reader.inspect('brain-a');
    expect(inspected.disposition).toBe('current');
    if (inspected.disposition === 'current') expect(inspected.record.target_disposition).toBe('revoked');
    expect(await new DurableBrainAuthorizationDecisionAuthority(reader).decide({ brain: { id: 'brain-a', metadata: {} } as never }))
      .toMatchObject({ allowed: false, reason: 'authorization_record_invalid' });
  });

  test('reconciles an uncertain write by exact command/state and performs only one update', async () => {
    const { repository, backend, fence } = await boot();
    backend.loseNextUpdate = true;
    const command = { kind: 'policy_change' as const, commandId: 'policy', brainId: 'brain-a', context: bootstrap().context, expectedCapabilitiesRevision: fence.capabilitiesRevision };
    const result = await repository.execute(command);
    expect(result.status).toBe('idempotent');
    expect(backend.updateAttempts).toBe(1);
    expect(JSON.stringify(result)).not.toContain('do-not-echo');
    expect((await repository.execute({ ...command, expectedCapabilitiesRevision: 'v1.different' })).status).toBe('conflict');
  });

  test('does not reconcile intended content as committed when the provider revision was reused', async () => {
    const backend = new MemoryCas();
    const normal = backend.client();
    const repository = new BrainAuthorizationAuthorityRepository({
      ...normal,
      updateDocument: async (collection, key, body) => {
        const current = backend.documents.get(`${collection}/${key}`);
        if (!current || current._rev !== body._rev) return { ok: false, code: 'REVISION_CONFLICT' as const };
        backend.updateAttempts += 1;
        backend.documents.set(`${collection}/${key}`, {
          ...current,
          data: structuredClone(body.data),
          metadata: structuredClone(body.metadata ?? current.metadata),
          _rev: current._rev,
        });
        throw new Error('lost response');
      },
    });
    const created = await repository.execute(bootstrap());
    if (created.status !== 'applied') throw new Error('bootstrap failed');

    expect(await repository.execute({ kind: 'policy_change', commandId: 'policy', brainId: 'brain-a',
      context: bootstrap().context, expectedCapabilitiesRevision: created.fence.capabilitiesRevision }))
      .toEqual({ status: 'conflict' });
    expect(backend.updateAttempts).toBe(1);
  });

  test('isolates external principals and brain keys', async () => {
    const { repository, backend, fence } = await boot();
    expect((await repository.execute({ kind: 'policy_change', commandId: 'x', brainId: 'brain-a', context: { ...bootstrap().context, principalId: 'user-b' }, expectedCapabilitiesRevision: fence.capabilitiesRevision })).status).toBe('denied');
    expect((await repository.execute({ kind: 'policy_change', commandId: 'x', brainId: 'brain-b', context: bootstrap().context, expectedCapabilitiesRevision: fence.capabilitiesRevision })).status).toBe('denied');
    expect((await repository.execute({ ...bootstrap(), context: { ...bootstrap().context, principalId: 'user-b' } })).status).toBe('denied');
    expect(backend.updateAttempts).toBe(0);
  });

  test('rejects torn success responses and a provider revision reused across a mutation', async () => {
    const backend = new MemoryCas();
    const normal = backend.client();
    const repository = new BrainAuthorizationAuthorityRepository({
      ...normal,
      updateDocument: async (collection, key, body) => {
        const prior = backend.documents.get(`${collection}/${key}`)?._rev;
        const result = await normal.updateDocument(collection, key, body);
        if (result.ok) result.document = { ...result.document, _rev: prior!, data: { ...result.document.data, owner_status: 'revoked' } };
        return result;
      },
    });
    const created = await repository.execute(bootstrap());
    if (created.status !== 'applied') throw new Error('bootstrap failed');
    const result = await repository.execute({ kind: 'policy_change', commandId: 'policy', brainId: 'brain-a', context: bootstrap().context, expectedCapabilitiesRevision: created.fence.capabilitiesRevision });
    expect(result).toEqual({ status: 'unavailable' });

    const reusedBackend = new MemoryCas();
    const reusedNormal = reusedBackend.client();
    const reusedRepository = new BrainAuthorizationAuthorityRepository({
      ...reusedNormal,
      updateDocument: async (collection, key, body) => {
        const prior = reusedBackend.documents.get(`${collection}/${key}`)?._rev;
        const update = await reusedNormal.updateDocument(collection, key, body);
        return update.ok ? { ...update, document: { ...update.document, _rev: prior! } } : update;
      },
    });
    const reusedCreated = await reusedRepository.execute(bootstrap());
    if (reusedCreated.status !== 'applied') throw new Error('bootstrap failed');
    expect(await reusedRepository.execute({ kind: 'policy_change', commandId: 'policy', brainId: 'brain-a',
      context: bootstrap().context, expectedCapabilitiesRevision: reusedCreated.fence.capabilitiesRevision }))
      .toEqual({ status: 'unavailable' });
  });

  test('returns typed denial instead of throwing when a monotonic counter is exhausted', async () => {
    for (const [field, kind] of [
      ['fencing_epoch', 'policy_change'],
      ['credential_revision', 'credential_revoke'],
      ['capability_policy_revision', 'policy_change'],
    ] as const) {
      const { repository, backend, fence } = await boot();
      const document = [...backend.documents.values()][0];
      document.data[field] = Number.MAX_SAFE_INTEGER;
      const bounded = createBrainAuthorizationFence({
        brainId: 'brain-a',
        fencingEpoch: document.data.fencing_epoch as number,
        ownerPrincipalId: 'user-a',
        credentialRevision: document.data.credential_revision as number,
        hostId: 'host-a',
        deploymentGeneration: 1,
        adapterIdentityVersion: fence.adapterIdentityVersion,
        capabilityPolicyRevision: document.data.capability_policy_revision as number,
      });
      document.data.capabilities_revision = bounded.capabilitiesRevision;

      expect(await repository.execute({ kind, commandId: `exhaust-${field}`, brainId: 'brain-a',
        context: bootstrap().context, expectedCapabilitiesRevision: bounded.capabilitiesRevision } as never))
        .toEqual({ status: 'denied' });
      expect(backend.updateAttempts).toBe(0);
    }
  });

  test('denies malformed provider envelopes, exact-shape violations, stale aggregate fences, and unavailable reads', async () => {
    const { repository, backend } = await boot();
    const document = [...backend.documents.values()][0];
    for (const mutate of [
      (value: CasDocument) => { (value as unknown as Record<string, unknown>).extra = true; },
      (value: CasDocument) => { value.metadata = { ...value.metadata, legacy_token: 'secret' }; },
      (value: CasDocument) => { value.data = { ...value.data, message: 'forbidden' }; },
      (value: CasDocument) => { value.data.capabilities_revision = 'v1.stale'; },
      (value: CasDocument) => { value.data.target_id = 'tampered-target'; },
      (value: CasDocument) => { value._rev = ''; },
    ]) {
      const hostile = structuredClone(document); mutate(hostile); backend.documents.set(`${hostile.collection}/${hostile.document_key}`, hostile);
      expect((await repository.inspect('brain-a')).disposition).toBe('invalid');
    }
    const unavailable = new BrainAuthorizationAuthorityRepository({ ...backend.client(), getDocument: async () => { throw new Error('token=secret'); } });
    expect(await unavailable.inspect('brain-a')).toEqual({ disposition: 'unavailable' });
  });

  test('accepts provider-managed RFC 3339 timestamp variants without weakening timestamp validation', async () => {
    const { repository, backend } = await boot();
    const document = [...backend.documents.values()][0];
    document.created_at = '2026-08-15T17:01:02Z';
    document.updated_at = '2026-08-15T12:01:02.123456-05:00';
    expect((await repository.inspect('brain-a')).disposition).toBe('current');

    for (const invalid of [
      '2026-08-15',
      '08/15/2026 12:01:02',
      '2026-08-15T12:01:02',
      '2026-02-30T12:01:02Z',
      '2026-04-31T12:01:02Z',
      '2026-08-15T24:00:00Z',
    ]) {
      document.updated_at = invalid;
      expect((await repository.inspect('brain-a')).disposition).toBe('invalid');
    }
  });

  test('decision adapter denies missing, revoked, malformed, hostile legacy metadata, and unavailable records', async () => {
    const missing = new DurableBrainAuthorizationDecisionAuthority(new BrainAuthorizationAuthorityRepository(new MemoryCas().client()));
    expect(await missing.decide({ brain: { id: 'missing', metadata: {} } as never })).toMatchObject({ allowed: false, reason: 'ownership_unresolved' });
    const { repository, fence } = await boot();
    const authority = new DurableBrainAuthorizationDecisionAuthority(repository);
    expect(await authority.decide({ brain: { id: 'brain-a', metadata: {} } as never })).toMatchObject({ allowed: true, ownerPrincipalId: 'user-a' });
    expect(await authority.decide({ brain: { id: 'brain-a', metadata: { archive_tenant_id: 'user-a' } } as never })).toMatchObject({ allowed: false, reason: 'authorization_record_invalid' });
    expect(await authority.decide({ brain: { id: 'brain-a', metadata: { archive_tenant_id: 'other-user' } } as never })).toMatchObject({ allowed: false, reason: 'authorization_record_invalid' });
    expect(await authority.decide({ brain: { id: 'brain-a', metadata: { archive_tenant_id: 'x'.repeat(257) } } as never })).toMatchObject({ allowed: false, reason: 'authorization_record_invalid' });
    expect(await authority.decide({ brain: { id: 'brain-a', metadata: { archive_tenant_id: { hostile: true } } } as never })).toMatchObject({ allowed: false, reason: 'authorization_record_invalid' });
    await repository.execute({ kind: 'owner_revoke', commandId: 'owner-revoke', brainId: 'brain-a', context: bootstrap().context, expectedCapabilitiesRevision: fence.capabilitiesRevision });
    expect(await authority.decide({ brain: { id: 'brain-a', metadata: {} } as never })).toMatchObject({ allowed: false, reason: 'authorization_record_invalid' });

    const malformedBackend = new MemoryCas();
    const malformedRepository = new BrainAuthorizationAuthorityRepository(malformedBackend.client());
    await malformedRepository.execute(bootstrap());
    const malformedDocument = [...malformedBackend.documents.values()][0];
    malformedDocument.data = { ...malformedDocument.data, message: 'hostile' };
    expect(await new DurableBrainAuthorizationDecisionAuthority(malformedRepository)
      .decide({ brain: { id: 'brain-a', metadata: {} } as never }))
      .toMatchObject({ allowed: false, reason: 'authorization_record_invalid' });

    const unavailableRepository = new BrainAuthorizationAuthorityRepository({
      ...new MemoryCas().client(),
      getDocument: async () => { throw new Error('provider unavailable'); },
    });
    expect(await new DurableBrainAuthorizationDecisionAuthority(unavailableRepository)
      .decide({ brain: { id: 'brain-a', metadata: {} } as never }))
      .toMatchObject({ allowed: false, reason: 'authorization_store_unavailable' });
  });

  test('decision adapter snapshots one data-only brain identity and denies hostile metadata without leaking it', async () => {
    const { repository } = await boot();
    const authority = new DurableBrainAuthorizationDecisionAuthority(repository);
    let identityReads = 0;
    const accessorBrain = { metadata: {} } as Record<string, unknown>;
    Object.defineProperty(accessorBrain, 'id', {
      enumerable: true,
      get: () => {
        identityReads += 1;
        return identityReads === 1 ? 'brain-a' : 'brain-b';
      },
    });
    await expect(authority.decide({ brain: accessorBrain as never })).rejects.toThrow('Brain identifier is invalid.');
    expect(identityReads).toBe(0);

    const hostileSecret = 'credential=must-not-escape';
    const hostileMetadata = new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw new Error(hostileSecret); },
    });
    const denied = await authority.decide({ brain: { id: 'brain-a', metadata: hostileMetadata } as never });
    expect(denied).toMatchObject({ allowed: false, reason: 'authorization_record_invalid' });
    expect(JSON.stringify(denied)).not.toContain(hostileSecret);
  });

  test('retains the future I3 external-call race as unproven by exposing no dispatch surface', () => {
    const methods = Object.getOwnPropertyNames(BrainAuthorizationAuthorityRepository.prototype);
    expect(methods).not.toContain('dispatch');
    expect(methods).not.toContain('send');
    expect(methods).not.toContain('invoke');
  });

  test('record and error surfaces contain no messaging, content, topology secrets, or credentials', async () => {
    const { backend, repository, fence } = await boot();
    const serialized = JSON.stringify([...backend.documents.values()]);
    for (const forbidden of ['message', 'session', 'turn', 'namespace', 'database', 'url', 'token', 'secret', 'credential_value', 'header', 'sql']) expect(serialized.toLowerCase()).not.toContain(forbidden);
    const denied = await repository.execute({ kind: 'policy_change', commandId: 'safe-command', brainId: 'brain-a', context: { ...bootstrap().context, principalId: 'attacker' }, expectedCapabilitiesRevision: fence.capabilitiesRevision });
    expect(JSON.stringify(denied)).toBe('{"status":"denied"}');
  });
});
