/**
 * Network Config route handler tests — uses mock store
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { handleGetNetworkConfig, handlePutNetworkConfig } from '../routes/network-config';
import { NetworkConfigStore } from '../lib/network-config-store';
import type { MechDocument } from '../types';

// ── Mock MechClient ───────────────────────────────────────────────────────────

class MockMechClient {
  private docs: Map<string, MechDocument> = new Map();
  private nextId = 1;

  async listDocuments(_collection: string): Promise<MechDocument[]> {
    return Array.from(this.docs.values());
  }

  async createDocument(_collection: string, data: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.nextId++}`;
    this.docs.set(id, { id, document_id: id, document: data });
    return id;
  }

  async updateDocument(docId: string, _collection: string, data: Record<string, unknown>): Promise<void> {
    const existing = this.docs.get(docId);
    if (!existing) throw new Error(`Doc ${docId} not found`);
    this.docs.set(docId, { ...existing, document: data });
  }

  async deleteDocument(docId: string): Promise<void> {
    this.docs.delete(docId);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/v1/network-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function parseResponse(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Network Config Routes', () => {
  let store: NetworkConfigStore;

  beforeEach(() => {
    const mech = new MockMechClient();
    store = new NetworkConfigStore(mech as never);
  });

  test('GET returns 404 when no config exists', async () => {
    const res = await handleGetNetworkConfig(store);
    expect(res.status).toBe(404);

    const body = await parseResponse(res);
    expect((body.error as Record<string, unknown>).code).toBe('not_found');
  });

  test('PUT creates config, subsequent GET returns it', async () => {
    const putRes = await handlePutNetworkConfig(
      makeRequest({
        version: '2.0',
        role: 'network',
        hub: 'https://hub.example.com',
        projects: [
          { id: 'proj-a', agent_id: 'agent-a.gm', type: 'service' },
        ],
      }),
      store,
    );

    expect(putRes.status).toBe(200);
    const putBody = await parseResponse(putRes);
    expect((putBody.data as Record<string, unknown>).projectCount).toBe(1);

    const getRes = await handleGetNetworkConfig(store);
    expect(getRes.status).toBe(200);
    const getBody = await parseResponse(getRes);
    const data = getBody.data as Record<string, unknown>;
    expect(data.version).toBe('2.0');
    expect(data.hub).toBe('https://hub.example.com');
    expect((data.projects as unknown[]).length).toBe(1);
  });

  test('PUT with invalid payload throws 400 — missing version', async () => {
    try {
      await handlePutNetworkConfig(
        makeRequest({ role: 'network', projects: [] }),
        store,
      );
      expect(true).toBe(false); // should not reach
    } catch (err: unknown) {
      expect((err as { status: number }).status).toBe(400);
    }
  });

  test('PUT with invalid payload throws 400 — wrong role', async () => {
    try {
      await handlePutNetworkConfig(
        makeRequest({ version: '2.0', role: 'project', projects: [] }),
        store,
      );
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect((err as { status: number }).status).toBe(400);
    }
  });

  test('PUT with invalid payload throws 400 — missing project agent_id', async () => {
    try {
      await handlePutNetworkConfig(
        makeRequest({ version: '2.0', role: 'network', projects: [{ id: 'p1' }] }),
        store,
      );
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect((err as { status: number }).status).toBe(400);
    }
  });

  test('PUT merges correctly — existing projects retained', async () => {
    // First PUT with 2 projects
    await handlePutNetworkConfig(
      makeRequest({
        version: '2.0',
        role: 'network',
        projects: [
          { id: 'proj-a', agent_id: 'agent-a.gm' },
          { id: 'proj-b', agent_id: 'agent-b.gm' },
        ],
      }),
      store,
    );

    // Second PUT with only 1 project
    await handlePutNetworkConfig(
      makeRequest({
        version: '2.0',
        role: 'network',
        projects: [
          { id: 'proj-a', agent_id: 'agent-a.gm' },
        ],
      }),
      store,
    );

    const getRes = await handleGetNetworkConfig(store);
    const body = await parseResponse(getRes);
    const projects = (body.data as Record<string, unknown>).projects as unknown[];
    expect(projects.length).toBe(2);
  });

  test('GET returns projects without path fields', async () => {
    await handlePutNetworkConfig(
      makeRequest({
        version: '2.0',
        role: 'network',
        projects: [
          { id: 'proj-a', agent_id: 'agent-a.gm', path: '~/dev_env/foo' },
        ],
      }),
      store,
    );

    const getRes = await handleGetNetworkConfig(store);
    const body = await parseResponse(getRes);
    const projects = (body.data as Record<string, unknown>).projects as Record<string, unknown>[];
    expect(projects[0].path).toBeUndefined();
    expect(projects[0].agent_id).toBe('agent-a.gm');
  });

  test('PUT with >500 projects throws 400', async () => {
    const projects = Array.from({ length: 501 }, (_, i) => ({
      id: `p${i}`,
      agent_id: `a${i}.gm`,
    }));
    try {
      await handlePutNetworkConfig(
        makeRequest({ version: '2.0', role: 'network', projects }),
        store,
      );
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect((err as { status: number }).status).toBe(400);
    }
  });

  test('PUT with empty body returns 400', async () => {
    const req = new Request('http://localhost/v1/network-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });

    try {
      const res = await handlePutNetworkConfig(req, store);
      // readJsonBody throws HttpError for empty body, but in case it returns:
      expect(res.status).toBe(400);
    } catch (err: unknown) {
      // HttpError from readJsonBody
      expect((err as { status: number }).status).toBe(400);
    }
  });
});
