import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { DaemonHttpServer } from '../../lib/daemon/http-server.js';

// Minimal mock res capturing status + body.
function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(chunk) { if (chunk) this.body += chunk; },
  };
}

const stubDaemon = { getStatus: () => ({ running: true }), basePath: '/tmp/doctor-daemon-root' };
const record = {
  agent_id: 'brain-a', machine_id: 'machine-1', environment: null,
  ts: '2026-06-04T12:00:00Z', status: 'degraded',
  checks: { runtime_resolves: { state: 'unknown' } }, reason: 'runtime_resolves unknown',
};

describe('GET /v1/doctor (PRD-0039 Task 3.0, FR-5/FR-6)', () => {
  const origCredsFile = process.env.AGENTBOOTUP_CREDS_FILE;
  const origConfigFile = process.env.AGENTBOOTUP_CONFIG_FILE;

  beforeAll(() => {
    process.env.AGENTBOOTUP_CREDS_FILE = path.join(os.tmpdir(), 'agentbootup-http-doctor-test-creds');
    process.env.AGENTBOOTUP_CONFIG_FILE = path.join(os.tmpdir(), 'agentbootup-http-doctor-test-config.json');
  });

  afterAll(() => {
    if (origCredsFile === undefined) delete process.env.AGENTBOOTUP_CREDS_FILE;
    else process.env.AGENTBOOTUP_CREDS_FILE = origCredsFile;
    if (origConfigFile === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = origConfigFile;
  });

  function serverWith(builder) {
    return new DaemonHttpServer(stubDaemon, { requireAuth: false, buildDoctorReport: builder });
  }

  test('GET returns the §4 record as JSON (AC-3: same shape the CLI emits)', async () => {
    const srv = serverWith(async () => record);
    const res = mockRes();
    await srv.handleDoctorReport({ method: 'GET' }, res);
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.status).toBe('degraded');
    expect(parsed.agent_id).toBe('brain-a');
    expect(parsed.checks.runtime_resolves.state).toBe('unknown');
  });

  test('passes a fresh ts to the builder each request (FR-5)', async () => {
    let seenTs = null;
    const srv = serverWith(async ({ ts }) => { seenTs = ts; return { ...record, ts }; });
    await srv.handleDoctorReport({ method: 'GET' }, mockRes());
    expect(seenTs).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp stamped at request time
  });

  test('passes the daemon basePath through to the builder so live doctor reads the scoped project', async () => {
    let seenCwd = null;
    const srv = serverWith(async ({ cwd }) => {
      seenCwd = cwd;
      return record;
    });
    await srv.handleDoctorReport({ method: 'GET' }, mockRes());
    expect(seenCwd).toBe('/tmp/doctor-daemon-root');
  });

  test('non-GET → 405', async () => {
    const srv = serverWith(async () => record);
    const res = mockRes();
    await srv.handleDoctorReport({ method: 'POST' }, res);
    expect(res.statusCode).toBe(405);
  });

  test('builder failure (e.g. no brain) → 503 with status:error, never a 200 false-green', async () => {
    const srv = serverWith(async () => { throw new Error('no brain configured'); });
    const res = mockRes();
    await srv.handleDoctorReport({ method: 'GET' }, res);
    expect(res.statusCode).toBe(503);
    const parsed = JSON.parse(res.body);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toMatch(/no brain configured/);
  });

  test('the REAL default buildDoctorReport is wired when no override is passed', async () => {
    // No buildDoctorReport override → exercises the constructor default (the live assembler).
    // Credentials/config are pointed at temp paths above so this never depends on the test
    // runner's real machine state; the point is just to prove the default builder path runs.
    const srv = new DaemonHttpServer(stubDaemon, { requireAuth: false });
    const res = mockRes();
    await srv.handleDoctorReport({ method: 'GET' }, res);
    // Either a 200 record (brain configured) or a 503 (no brain) — both prove the real builder
    // ran. It must NEVER be a 200 with status 'error', and must never throw out of the handler.
    expect([200, 503]).toContain(res.statusCode);
    const parsed = JSON.parse(res.body);
    if (res.statusCode === 200) {
      expect(['healthy', 'degraded', 'stuck']).toContain(parsed.status);
      expect(parsed.checks).toBeDefined();
    } else {
      expect(parsed.status).toBe('error');
    }
  });

  test('route is registered and behind auth (not a public endpoint)', async () => {
    // requireAuth on, no token → 401 before the handler runs.
    const srv = new DaemonHttpServer(stubDaemon, { requireAuth: true, apiToken: 'secret', buildDoctorReport: async () => record });
    const res = mockRes();
    await srv.handleRequest({ method: 'GET', url: '/v1/doctor', headers: { host: 'localhost' } }, res);
    expect(res.statusCode).toBe(401);

    // With the token, the handler runs and returns the record.
    const ok = mockRes();
    await srv.handleRequest({ method: 'GET', url: '/v1/doctor', headers: { host: 'localhost', authorization: 'Bearer secret' } }, ok);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).agent_id).toBe('brain-a');
  });

  test('end-to-end routing: POST /v1/doctor through handleRequest → 405 (method filter reached)', async () => {
    const srv = new DaemonHttpServer(stubDaemon, { requireAuth: false, buildDoctorReport: async () => record });
    const res = mockRes();
    await srv.handleRequest({ method: 'POST', url: '/v1/doctor', headers: { host: 'localhost' } }, res);
    expect(res.statusCode).toBe(405);
  });

  test('the / root listing advertises the new /v1/doctor route', async () => {
    const srv = new DaemonHttpServer(stubDaemon, { requireAuth: false });
    const res = mockRes();
    await srv.handleRoot({ method: 'GET' }, res);
    expect(JSON.parse(res.body).endpoints['/v1/doctor']).toBeDefined();
  });
});
