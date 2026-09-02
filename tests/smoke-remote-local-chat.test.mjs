import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ONLINE_HANDLE = 'rsh_abcdefghijklmnop';
const COMMAND_ID = 'rlc_abcdefghijklmnop';
const OTHER_COMMAND_ID = 'rlc_ponmlKjIhGfEdCbAzyxwvutsr';
const APPROVAL_REQUEST_ID = 'apr_abcdefghijklmnop';
const RESOLUTION_ID = 'arr_abcdefghijklmnop';
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const completed = () => frame('terminal', { commandId: COMMAND_ID, disposition: 'completed' });
const text = (value = 'check completed') => frame('text', { commandId: COMMAND_ID, sequence: 0, text: value });

async function ownerVerification({ proofMode, approvalDisposition, approvalResponse = { resolutionId: RESOLUTION_ID, disposition: 'accepted' }, authStatusRedirect = false, eventRedirect = false, eventText, hostname = '127.0.0.1', serverUrlHost = hostname }) {
  const root = mkdtempSync(join(tmpdir(), 'remote-local-smoke-owner-'));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({
    brainId: 'brain-a', serverUrl: 'http://127.0.0.1:0', message: 'perform the disposable check', expectedText: 'check completed', ...(proofMode ? { proofMode } : {}), ...(proofMode === 'approval' ? { deviceId: 'device-a' } : {}), ...(approvalDisposition ? { approvalDisposition } : {}),
  }));
  let turns = 0; let authStatus = 0; let redirectedRequests = 0; const approvals = [];
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/auth/status') { authStatus += 1; return authStatusRedirect ? Response.redirect(new URL('/redirect-target', request.url), 302) : Response.json({ data: { principal: { kind: 'external', user_id: 'owner-a', key_id: 'key-a' }, allowed_surface: 'external' } }); }
      if (path === '/redirect-target') { redirectedRequests += 1; return Response.json({ data: { principal: { kind: 'external', user_id: 'owner-a', key_id: 'key-a' } } }); }
      if (path.endsWith('/sessions')) return Response.json({ data: { sessions: [{ availability: 'online', handle: ONLINE_HANDLE }] } });
      if (path.endsWith('/turns')) { turns += 1; return Response.json({ data: { commandId: COMMAND_ID } }); }
      if (path === `/v1/remote-local/brains/brain-a/sessions/${ONLINE_HANDLE}/approvals`) return request.json().then((body) => { approvals.push(body); return Response.json({ data: approvalResponse }, { status: 202 }); });
      if (path.endsWith(`/commands/${COMMAND_ID}/events`)) return eventRedirect ? Response.redirect(new URL('/redirect-target', request.url), 302) : new Response(eventText, { headers: { 'content-type': 'text/event-stream' } });
      return new Response('not found', { status: 404 });
    },
  });
  const liveConfig = JSON.parse(await Bun.file(config).text());
  liveConfig.serverUrl = `http://${serverUrlHost.includes(':') ? `[${serverUrlHost}]` : serverUrlHost}:${server.port}`;
  writeFileSync(config, JSON.stringify(liveConfig));
  try {
    const child = spawn(process.execPath, ['scripts/smoke-remote-local-chat.mjs', '--mode', 'owner-verify', '--config', config, '--execute'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, AGENTBOOTUP_ALLOW_REMOTE_LOCAL_SMOKE: '1', AGENTBOOTUP_REMOTE_LOCAL_SMOKE_API_KEY: 'test-key' },
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), new Promise((resolve) => child.once('close', resolve)),
    ]);
    return { stdout, stderr, status, turns, authStatus, redirectedRequests, approvals };
  } finally {
    server.stop(true);
  }
}

test('remote-local smoke is plan-only by default and never enables runtime state', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-local-smoke-'));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ brainId: 'brain-a', serverUrl: 'https://example.test', message: 'perform the disposable tool check', expectedText: 'tool check completed' }));
  const result = spawnSync(process.execPath, ['scripts/smoke-remote-local-chat.mjs', '--mode', 'device-plan', '--config', config], { cwd: process.cwd(), encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'PLAN_ONLY', noFeatureFlagsChanged: true, noDaemonStarted: true });
});

test('remote-local smoke refuses an echo-shaped expected text before execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-local-smoke-'));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ brainId: 'brain-a', serverUrl: 'https://example.test', message: 'echo', expectedText: 'echo' }));
  const result = spawnSync(process.execPath, ['scripts/smoke-remote-local-chat.mjs', '--mode', 'device-plan', '--config', config], { cwd: process.cwd(), encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('must differ');
});

test('remote-local smoke refuses execution without an explicit acknowledgement', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-local-smoke-'));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ brainId: 'brain-a', serverUrl: 'https://example.test', message: 'perform the disposable tool check', expectedText: 'tool check completed' }));
  const result = spawnSync(process.execPath, ['scripts/smoke-remote-local-chat.mjs', '--mode', 'device-plan', '--config', config, '--execute'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, AGENTBOOTUP_ALLOW_REMOTE_LOCAL_SMOKE: '' } });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('AGENTBOOTUP_ALLOW_REMOTE_LOCAL_SMOKE=1');
});

test('remote-local smoke applies the owner API UTF-8 message bound before execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-local-smoke-'));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ brainId: 'brain-a', serverUrl: 'https://example.test', message: '界'.repeat(3000), expectedText: 'tool check completed' }));
  const result = spawnSync(process.execPath, ['scripts/smoke-remote-local-chat.mjs', '--mode', 'device-plan', '--config', config], { cwd: process.cwd(), encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('message is invalid');
});

test('approval proof requires an explicit target device before any execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-local-smoke-'));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ brainId: 'brain-a', serverUrl: 'https://example.test', message: 'perform the approval check', expectedText: 'approval check completed', proofMode: 'approval', approvalDisposition: 'allow' }));
  const result = spawnSync(process.execPath, ['scripts/smoke-remote-local-chat.mjs', '--mode', 'device-plan', '--config', config], { cwd: process.cwd(), encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('requires a valid deviceId');
});

test('owner verification refuses remote HTTP before making a bearer request', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-local-smoke-'));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ brainId: 'brain-a', serverUrl: 'http://example.test', message: 'perform the disposable check', expectedText: 'check completed' }));
  const result = spawnSync(process.execPath, ['scripts/smoke-remote-local-chat.mjs', '--mode', 'owner-verify', '--config', config, '--execute'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, AGENTBOOTUP_ALLOW_REMOTE_LOCAL_SMOKE: '1', AGENTBOOTUP_REMOTE_LOCAL_SMOKE_API_KEY: 'test-key' } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('requires HTTPS except literal loopback HTTP');
  expect(result.stderr).not.toContain('request failed');
});

test('owner verification refuses localhost HTTP before making a bearer request', async () => {
  const result = await ownerVerification({ serverUrlHost: 'localhost', eventText: `${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('requires HTTPS except literal loopback HTTP');
  expect(result.stderr).not.toContain('request failed');
  expect(result.authStatus).toBe(0);
  expect(result.turns).toBe(0);
});

test('owner verification refuses a redirect before forwarding its bearer request', async () => {
  const result = await ownerVerification({ proofMode: 'approval', approvalDisposition: 'allow', authStatusRedirect: true, eventText: `${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('UnexpectedRedirect');
  expect(result.authStatus).toBe(1);
  expect(result.redirectedRequests).toBe(0);
  expect(result.turns).toBe(0);
});

test('owner verification refuses an event-stream redirect before forwarding its bearer request', async () => {
  const result = await ownerVerification({ eventRedirect: true, eventText: `${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('UnexpectedRedirect');
  expect(result.redirectedRequests).toBe(0);
  expect(result.turns).toBe(2);
});

test('owner verification permits a literal IPv6 loopback HTTP fixture', async () => {
  const result = await ownerVerification({ hostname: '::1', eventText: `${text()}${completed()}` });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});

test('owner verification accepts a text-only result without falsely requiring a tool event', async () => {
  const result = await ownerVerification({ eventText: `${text()}${completed()}` });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'OWNER_VERIFIED', assertions: ['outbound_connector_precondition', 'opaque_session_selected', 'same_key_no_double_dispatch', 'non_echo_text_event'] });
  expect(result.turns).toBe(2);
});

test('owner verification recognizes an expected text token streamed across multiple frames', async () => {
  const result = await ownerVerification({ eventText: `${frame('text', { commandId: COMMAND_ID, sequence: 0, text: 'check ' })}${frame('text', { commandId: COMMAND_ID, sequence: 1, text: 'completed' })}${completed()}` });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});

test('owner verification requires a normalized tool event only in tool proof mode', async () => {
  const result = await ownerVerification({ proofMode: 'tool', eventText: `${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('normalized tool event');
  expect(result.turns).toBe(2);
});

test('owner verification records a normalized tool event in tool proof mode', async () => {
  const result = await ownerVerification({ proofMode: 'tool', eventText: `${frame('tool', { commandId: COMMAND_ID, sequence: 1, state: 'started' })}${frame('tool', { commandId: COMMAND_ID, sequence: 2, state: 'completed' })}${text()}${completed()}` });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ proofMode: 'tool', assertions: ['outbound_connector_precondition', 'opaque_session_selected', 'same_key_no_double_dispatch', 'non_echo_text_event', 'tool_event'] });
  expect(result.turns).toBe(2);
});

test('owner verification resolves an exact advertised approval only in approval proof mode', async () => {
  const result = await ownerVerification({ proofMode: 'approval', approvalDisposition: 'allow', eventText: `${frame('approval_required', { commandId: COMMAND_ID, approvalRequestId: APPROVAL_REQUEST_ID })}${frame('approval_resolved', { commandId: COMMAND_ID, disposition: 'allow', resolutionId: RESOLUTION_ID, decidingPrincipalId: 'owner-a', targetDeviceId: 'device-a' })}${frame('tool', { commandId: COMMAND_ID, sequence: 1, state: 'started' })}${frame('tool', { commandId: COMMAND_ID, sequence: 2, state: 'completed' })}${text()}${completed()}` });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'OWNER_VERIFIED', proofMode: 'approval', assertions: ['outbound_connector_precondition', 'opaque_session_selected', 'same_key_no_double_dispatch', 'non_echo_text_event', 'approval_required_event', 'bound_approval_allow_accepted', 'approval_resolved_event'] });
  expect(result.turns).toBe(2);
  expect(result.authStatus).toBe(1);
  expect(result.approvals).toEqual([{ approvalRequestId: APPROVAL_REQUEST_ID, disposition: 'allow', idempotencyKey: expect.stringMatching(/^smoke:.+:approval$/) }]);
});

test('approval deny proves bound resolution and completed terminal with no tool event', async () => {
  const result = await ownerVerification({ proofMode: 'approval', approvalDisposition: 'deny', eventText: `${frame('approval_required', { commandId: COMMAND_ID, approvalRequestId: APPROVAL_REQUEST_ID })}${frame('approval_resolved', { commandId: COMMAND_ID, disposition: 'deny', resolutionId: RESOLUTION_ID, decidingPrincipalId: 'owner-a', targetDeviceId: 'device-a' })}${text()}${completed()}` });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ proofMode: 'approval', assertions: ['outbound_connector_precondition', 'opaque_session_selected', 'same_key_no_double_dispatch', 'non_echo_text_event', 'approval_required_event', 'bound_approval_deny_accepted', 'approval_resolved_event'] });
  expect(result.authStatus).toBe(1);
  expect(result.approvals).toEqual([{ approvalRequestId: APPROVAL_REQUEST_ID, disposition: 'deny', idempotencyKey: expect.stringMatching(/^smoke:.+:approval$/) }]);
});

test('approval allow rejects tool evidence before its matching resolution', async () => {
  const result = await ownerVerification({ proofMode: 'approval', approvalDisposition: 'allow', eventText: `${frame('approval_required', { commandId: COMMAND_ID, approvalRequestId: APPROVAL_REQUEST_ID })}${frame('tool', { commandId: COMMAND_ID, sequence: 1, state: 'started' })}${frame('approval_resolved', { commandId: COMMAND_ID, disposition: 'allow', resolutionId: RESOLUTION_ID, decidingPrincipalId: 'owner-a', targetDeviceId: 'device-a' })}${frame('tool', { commandId: COMMAND_ID, sequence: 2, state: 'completed' })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('before the matching approval resolution');
});

test('approval deny rejects any tool evidence after the matching resolution', async () => {
  const result = await ownerVerification({ proofMode: 'approval', approvalDisposition: 'deny', eventText: `${frame('approval_required', { commandId: COMMAND_ID, approvalRequestId: APPROVAL_REQUEST_ID })}${frame('approval_resolved', { commandId: COMMAND_ID, disposition: 'deny', resolutionId: RESOLUTION_ID, decidingPrincipalId: 'owner-a', targetDeviceId: 'device-a' })}${frame('tool', { commandId: COMMAND_ID, sequence: 1, state: 'started' })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('deny proof received tool evidence');
});

test('tool proof refuses an approval requirement rather than treating it as a tool result', async () => {
  const result = await ownerVerification({ proofMode: 'tool', eventText: `${frame('approval_required', { commandId: COMMAND_ID, approvalRequestId: APPROVAL_REQUEST_ID })}${frame('tool', { commandId: COMMAND_ID, sequence: 1, state: 'started' })}${frame('tool', { commandId: COMMAND_ID, sequence: 2, state: 'completed' })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('unexpected approval requirement');
});

test('tool proof requires its single valid started event before completed evidence', async () => {
  const result = await ownerVerification({ proofMode: 'tool', eventText: `${frame('tool', { commandId: COMMAND_ID, sequence: 1, state: 'completed' })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('started tool evidence');
});

test('tool proof rejects completed tool evidence with an inverted sequence', async () => {
  const result = await ownerVerification({ proofMode: 'tool', eventText: `${frame('tool', { commandId: COMMAND_ID, sequence: 2, state: 'started' })}${frame('tool', { commandId: COMMAND_ID, sequence: 1, state: 'completed' })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('without a later sequence');
});

test('tool proof rejects failed or extra tool evidence beyond its lifecycle', async () => {
  const failed = await ownerVerification({ proofMode: 'tool', eventText: `${frame('tool', { commandId: COMMAND_ID, sequence: 1, state: 'started' })}${frame('tool', { commandId: COMMAND_ID, sequence: 2, state: 'failed' })}${text()}${completed()}` });
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain('failed tool evidence');
  const extra = await ownerVerification({ proofMode: 'tool', eventText: `${frame('tool', { commandId: COMMAND_ID, sequence: 1, state: 'started' })}${frame('tool', { commandId: COMMAND_ID, sequence: 2, state: 'completed' })}${frame('tool', { commandId: COMMAND_ID, sequence: 3, state: 'completed' })}${text()}${completed()}` });
  expect(extra.status).toBe(1);
  expect(extra.stderr).toContain('duplicate completed tool evidence');
});

test('owner verification rejects malformed or cross-command tool evidence', async () => {
  const result = await ownerVerification({ proofMode: 'tool', eventText: `${frame('tool', { commandId: OTHER_COMMAND_ID, sequence: 1, state: 'completed' })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('tool event did not match the accepted command');
});

test('owner verification rejects duplicate tool-start evidence', async () => {
  const result = await ownerVerification({ proofMode: 'tool', eventText: `${frame('tool', { commandId: COMMAND_ID, sequence: 1, state: 'started' })}${frame('tool', { commandId: COMMAND_ID, sequence: 2, state: 'started' })}${frame('tool', { commandId: COMMAND_ID, sequence: 3, state: 'completed' })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('duplicate tool-start evidence');
});

test('owner verification rejects a mismatched approval resolution receipt', async () => {
  const result = await ownerVerification({ proofMode: 'approval', approvalDisposition: 'allow', eventText: `${frame('approval_required', { commandId: COMMAND_ID, approvalRequestId: APPROVAL_REQUEST_ID })}${frame('approval_resolved', { commandId: COMMAND_ID, disposition: 'deny', resolutionId: RESOLUTION_ID, decidingPrincipalId: 'owner-a', targetDeviceId: 'device-a' })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('approval resolution did not match the bound decision');
});

test('owner verification rejects an approval resolution from a different decision', async () => {
  const result = await ownerVerification({ proofMode: 'approval', approvalDisposition: 'allow', eventText: `${frame('approval_required', { commandId: COMMAND_ID, approvalRequestId: APPROVAL_REQUEST_ID })}${frame('approval_resolved', { commandId: COMMAND_ID, disposition: 'allow', resolutionId: 'arr_ponmlkjihgfedcb', decidingPrincipalId: 'owner-a', targetDeviceId: 'device-a' })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('approval resolution did not match the bound decision');
});

test('owner verification rejects approval evidence for another device or owner', async () => {
  const result = await ownerVerification({ proofMode: 'approval', approvalDisposition: 'allow', eventText: `${frame('approval_required', { commandId: COMMAND_ID, approvalRequestId: APPROVAL_REQUEST_ID })}${frame('approval_resolved', { commandId: COMMAND_ID, disposition: 'allow', resolutionId: RESOLUTION_ID, decidingPrincipalId: 'owner-b', targetDeviceId: 'device-b' })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('approval resolution did not match the bound decision');
});

test('approval allow rejects failed tool evidence after resolution', async () => {
  const result = await ownerVerification({ proofMode: 'approval', approvalDisposition: 'allow', eventText: `${frame('approval_required', { commandId: COMMAND_ID, approvalRequestId: APPROVAL_REQUEST_ID })}${frame('approval_resolved', { commandId: COMMAND_ID, disposition: 'allow', resolutionId: RESOLUTION_ID, decidingPrincipalId: 'owner-a', targetDeviceId: 'device-a' })}${frame('tool', { commandId: COMMAND_ID, sequence: 1, state: 'started' })}${frame('tool', { commandId: COMMAND_ID, sequence: 2, state: 'completed' })}${frame('tool', { commandId: COMMAND_ID, sequence: 3, state: 'failed' })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('failed tool evidence');
});

test('owner verification rejects an inexact approval API receipt', async () => {
  const result = await ownerVerification({ proofMode: 'approval', approvalDisposition: 'allow', approvalResponse: { resolutionId: RESOLUTION_ID, disposition: 'replayed' }, eventText: `${frame('approval_required', { commandId: COMMAND_ID, approvalRequestId: APPROVAL_REQUEST_ID })}${text()}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('bound approval decision was not accepted');
});

test('owner verification requires a matching completed terminal receipt', async () => {
  const result = await ownerVerification({ eventText: text() });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('matching completed terminal receipt');
});

test('owner verification rejects a text event that merely echoes the submitted message', async () => {
  const result = await ownerVerification({ eventText: `${frame('text', { commandId: COMMAND_ID, sequence: 0, text: 'perform the disposable check' })}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('echoed the submitted message');
});

test('owner verification rejects a submitted-message echo split across text frames', async () => {
  const result = await ownerVerification({ eventText: `${frame('text', { commandId: COMMAND_ID, sequence: 0, text: 'perform the ' })}${frame('text', { commandId: COMMAND_ID, sequence: 1, text: 'disposable check' })}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('echoed the submitted message');
});

test('owner verification rejects a quoted or extended reflection of the submitted message', async () => {
  const result = await ownerVerification({ eventText: `${frame('text', { commandId: COMMAND_ID, sequence: 0, text: 'I received: perform the disposable check; proceeding.' })}${completed()}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('echoed the submitted message');
});
