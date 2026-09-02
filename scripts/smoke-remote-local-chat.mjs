/**
 * PRD-0072 Task 5 owner/device qualification harness.
 * It never enables feature flags or starts a daemon. Run device enrollment on
 * the controlled device, then run owner verification from a separate network.
 */
import { readFile } from 'node:fs/promises';
import { apiUrl, isPlausibleServerUrl } from '../lib/auth/validate.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDLE = /^rsh_[A-Za-z0-9_-]{16,128}$/;
const COMMAND = /^rlc_[A-Za-z0-9_-]{16,128}$/;
const APPROVAL = /^apr_[A-Za-z0-9_-]{16,128}$/;
const MODE = new Set(['device-plan', 'owner-verify']);
const PROOF_MODE = new Set(['text', 'tool', 'approval']);
const TOOL_STATE = new Set(['started', 'completed', 'failed']);
const MAX_MESSAGE_BYTES = 8192;
const MAX_EXPECTED_TEXT_BYTES = 1024;
const REQUEST_TIMEOUT_MS = 60_000;

function usage() {
  return 'Usage: node scripts/smoke-remote-local-chat.mjs --mode <device-plan|owner-verify> --config <redacted-config.json> [--execute]';
}
function arg(argv, flag) { const index = argv.indexOf(flag); return index < 0 ? '' : argv[index + 1] || ''; }
function exactConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('smoke config must be an object');
  const allowed = ['brainId', 'serverUrl', 'deviceId', 'message', 'expectedText', 'proofMode', 'approvalDisposition'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('smoke config has unsupported fields');
  if (!ID.test(value.brainId || '') || !isPlausibleServerUrl(value.serverUrl || '')) throw new Error('smoke config requires a valid brainId and HTTPS/HTTP serverUrl');
  if (value.deviceId !== undefined && !ID.test(value.deviceId)) throw new Error('smoke config deviceId is invalid');
  if (typeof value.message !== 'string' || Buffer.byteLength(value.message, 'utf8') < 1 || Buffer.byteLength(value.message, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('smoke config message is invalid');
  if (typeof value.expectedText !== 'string' || Buffer.byteLength(value.expectedText, 'utf8') < 1 || Buffer.byteLength(value.expectedText, 'utf8') > MAX_EXPECTED_TEXT_BYTES) throw new Error('smoke config expectedText is invalid');
  if (value.expectedText === value.message) throw new Error('smoke config expectedText must differ from the submitted message');
  const proofMode = value.proofMode === undefined ? 'text' : value.proofMode;
  if (!PROOF_MODE.has(proofMode)) throw new Error('smoke config proofMode is invalid');
  if (proofMode === 'approval' && (!value.deviceId || value.approvalDisposition !== 'allow' && value.approvalDisposition !== 'deny')) throw new Error('smoke config approval mode requires a valid deviceId and approvalDisposition');
  if (proofMode !== 'approval' && value.approvalDisposition !== undefined) throw new Error('smoke config approvalDisposition requires approval proofMode');
  return Object.freeze({ ...value, proofMode });
}
function parseSseFrame(raw) {
  let event = 'message'; const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  return { event, data: data.join('\n') };
}
function exactObject(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function frameData(frame, keys, error) {
  let value;
  try { value = JSON.parse(frame.data); } catch { throw new Error(error); }
  if (!exactObject(value, keys)) throw new Error(error);
  return value;
}
function validSequence(value) { return Number.isSafeInteger(value) && value >= 0; }
function secureOwnerExecutionUrl(serverUrl) {
  let url;
  try { url = new URL(serverUrl); } catch { return false; }
  if (url.protocol === 'https:') return true;
  // WHATWG URL retains brackets in an IPv6 hostname; do not allow a DNS name
  // such as localhost, which could be externally remapped.
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
}
async function consumeSse(response, onFrame) {
  if (!response.body) throw new Error('event verification returned no event stream');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || '';
    for (const raw of frames) if (raw) await onFrame(parseSseFrame(raw), raw);
    if (done) break;
  }
  if (buffer) await onFrame(parseSseFrame(buffer), buffer);
}
async function request(config, apiKey, path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl(config.serverUrl, path), { ...init, redirect: 'error', headers: { authorization: `Bearer ${apiKey}`, ...(init.headers || {}) }, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`owner verification request failed (HTTP ${response.status})`);
    try { return JSON.parse(body); } catch { throw new Error('owner verification returned invalid JSON'); }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('owner verification request timed out');
    throw error;
  } finally { clearTimeout(timeout); }
}
async function authenticatedOwnerPrincipalId(config, apiKey) {
  const status = await request(config, apiKey, '/v1/auth/status');
  const principal = status?.data?.principal;
  if (!exactObject(principal, ['kind', 'user_id', 'key_id']) || principal.kind !== 'external' || !ID.test(principal.user_id) || !ID.test(principal.key_id)) throw new Error('owner verification returned an invalid authenticated principal');
  return principal.user_id;
}
async function ownerVerify(config, apiKey) {
  const authenticatedOwnerId = config.proofMode === 'approval' ? await authenticatedOwnerPrincipalId(config, apiKey) : null;
  const sessions = await request(config, apiKey, `/v1/remote-local/brains/${config.brainId}/sessions`);
  const selected = sessions?.data?.sessions?.find((session) => session?.availability === 'online' && HANDLE.test(session?.handle || ''));
  if (!selected) throw new Error('no online opaque session is advertised');
  const idempotencyKey = `smoke:${Date.now()}:turn`;
  const turn = await request(config, apiKey, `/v1/remote-local/brains/${config.brainId}/sessions/${selected.handle}/turns`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: config.message, idempotencyKey }),
  });
  const commandId = turn?.data?.commandId;
  if (typeof commandId !== 'string' || !COMMAND.test(commandId)) throw new Error('turn was not accepted');
  const retry = await request(config, apiKey, `/v1/remote-local/brains/${config.brainId}/sessions/${selected.handle}/turns`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: config.message, idempotencyKey }),
  });
  if (retry?.data?.commandId !== commandId) throw new Error('same-key retry did not preserve the command receipt');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let sawExpectedText = false; let textWindow = ''; let sawToolCompleted = false; let toolStartedSequence = null;
  let sawApprovalRequired = false; let sawApprovalResolved = false; let approvalSent = false; let resolutionId = null; let sawTerminal = false;
  let approvalToolStartedSequence = null; let approvalToolCompleted = false;
  try {
    const response = await fetch(apiUrl(config.serverUrl, `/v1/remote-local/brains/${config.brainId}/commands/${commandId}/events`), {
      headers: { authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) throw new Error(`event verification failed (HTTP ${response.status})`);
    await consumeSse(response, async (frame, raw) => {
      if (frame.event === 'text') {
        const data = frameData(frame, ['commandId', 'sequence', 'text'], 'text event was malformed');
        if (data.commandId !== commandId || !validSequence(data.sequence) || typeof data.text !== 'string') throw new Error('text event did not match the accepted command');
        // Runtime adapters are allowed to stream arbitrary text chunks. Keep
        // only the overlap needed to recognize the two bounded proof strings,
        // so neither a split expected token nor a split prompt echo can evade
        // qualification while the harness remains memory-bounded.
        textWindow += data.text;
        if (textWindow.includes(config.message)) throw new Error('text event echoed the submitted message');
        if (textWindow.includes(config.expectedText)) sawExpectedText = true;
        const overlap = Math.max(config.message.length, config.expectedText.length) - 1;
        textWindow = overlap > 0 ? textWindow.slice(-overlap) : '';
        return;
      }
      if (frame.event === 'terminal') {
        const data = frameData(frame, ['commandId', 'disposition'], 'terminal receipt was malformed');
        if (data.commandId !== commandId || data.disposition !== 'completed') throw new Error('terminal receipt did not match the accepted completed command');
        if (sawTerminal) throw new Error('event stream contained more than one terminal receipt');
        sawTerminal = true;
        return;
      }
      if (frame.event === 'tool' && config.proofMode === 'tool') {
        const data = frameData(frame, ['commandId', 'sequence', 'state'], 'tool event was malformed');
        if (data.commandId !== commandId || !validSequence(data.sequence) || !TOOL_STATE.has(data.state)) throw new Error('tool event did not match the accepted command');
        if (data.state === 'failed') throw new Error('tool proof received failed tool evidence');
        if (data.state === 'started') { if (toolStartedSequence !== null) throw new Error('event stream contained duplicate tool-start evidence'); toolStartedSequence = data.sequence; }
        if (data.state === 'completed') { if (toolStartedSequence === null) throw new Error('event stream completed a tool without started tool evidence'); if (data.sequence <= toolStartedSequence) throw new Error('event stream completed a tool without a later sequence'); if (sawToolCompleted) throw new Error('event stream contained duplicate completed tool evidence'); sawToolCompleted = true; }
        return;
      }
      if (frame.event === 'tool' && config.proofMode === 'approval') {
        if (config.approvalDisposition === 'deny') throw new Error('approval deny proof received tool evidence');
        if (!sawApprovalResolved) throw new Error('approval allow proof received tool evidence before the matching approval resolution');
        const data = frameData(frame, ['commandId', 'sequence', 'state'], 'tool event was malformed');
        if (data.commandId !== commandId || !validSequence(data.sequence) || !TOOL_STATE.has(data.state)) throw new Error('tool event did not match the accepted command');
        if (data.state === 'started') { if (approvalToolStartedSequence !== null) throw new Error('event stream contained duplicate approval tool-start evidence'); approvalToolStartedSequence = data.sequence; }
        if (data.state === 'completed') { if (approvalToolStartedSequence === null) throw new Error('approval allow proof completed a tool without started tool evidence'); if (data.sequence <= approvalToolStartedSequence) throw new Error('approval allow proof completed a tool without a later sequence'); if (approvalToolCompleted) throw new Error('event stream contained duplicate completed approval tool evidence'); approvalToolCompleted = true; }
        if (data.state === 'failed') throw new Error('approval allow proof received failed tool evidence');
        return;
      }
      if (frame.event === 'approval_resolved' && config.proofMode === 'approval') {
        const data = frameData(frame, ['commandId', 'disposition', 'resolutionId', 'decidingPrincipalId', 'targetDeviceId'], 'approval resolution was malformed');
        if (data.commandId !== commandId || data.disposition !== config.approvalDisposition || data.resolutionId !== resolutionId || data.targetDeviceId !== config.deviceId || data.decidingPrincipalId !== authenticatedOwnerId) throw new Error('approval resolution did not match the bound decision');
        if (sawApprovalResolved) throw new Error('event stream contained more than one approval resolution');
        sawApprovalResolved = true;
        return;
      }
      if (frame.event !== 'approval_required') return;
      sawApprovalRequired = true;
      if (config.proofMode === 'tool') throw new Error('tool proof received an unexpected approval requirement');
      if (config.proofMode !== 'approval') return;
      if (approvalSent) throw new Error('event stream requested more than one approval');
      const data = frameData(frame, ['commandId', 'approvalRequestId'], 'approval event contained invalid JSON');
      const approvalRequestId = data.approvalRequestId;
      if (data.commandId !== commandId || typeof approvalRequestId !== 'string' || !APPROVAL.test(approvalRequestId)) throw new Error('approval event did not contain an exact approval request id');
      const approval = await request(config, apiKey, `/v1/remote-local/brains/${config.brainId}/sessions/${selected.handle}/approvals`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approvalRequestId, disposition: config.approvalDisposition, idempotencyKey: `smoke:${Date.now()}:approval` }),
      });
      if (!exactObject(approval?.data, ['resolutionId', 'disposition']) || typeof approval.data.resolutionId !== 'string' || !ID.test(approval.data.resolutionId) || approval.data.disposition !== 'accepted') throw new Error('bound approval decision was not accepted');
      resolutionId = approval.data.resolutionId; approvalSent = true;
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('event verification timed out');
    throw error;
  } finally { clearTimeout(timeout); }
  if (!sawExpectedText) throw new Error('event stream did not contain the expected non-echo text');
  if (!sawTerminal) throw new Error('event stream did not contain a matching completed terminal receipt');
  const assertions = ['outbound_connector_precondition', 'opaque_session_selected', 'same_key_no_double_dispatch', 'non_echo_text_event'];
  if (config.proofMode === 'tool') {
    if (toolStartedSequence === null || !sawToolCompleted) throw new Error('event stream did not contain exactly one started and completed normalized tool event');
    assertions.push('tool_event');
  }
  if (config.proofMode === 'approval') {
    if (!sawApprovalRequired) throw new Error('event stream did not contain a normalized approval-required event');
    if (!approvalSent) throw new Error('bound approval decision was not accepted');
    if (!sawApprovalResolved) throw new Error('event stream did not contain a normalized approval-resolved event');
    if (config.approvalDisposition === 'allow' && (approvalToolStartedSequence === null || !approvalToolCompleted)) throw new Error('approval allow proof did not contain exactly one started and completed tool event after resolution');
    assertions.push('approval_required_event', `bound_approval_${config.approvalDisposition}_accepted`, 'approval_resolved_event');
  }
  return { brainId: config.brainId, deviceId: config.deviceId || null, sessionHandle: selected.handle, commandId, proofMode: config.proofMode, assertions };
}
async function main() {
  const mode = arg(process.argv.slice(2), '--mode'); const path = arg(process.argv.slice(2), '--config');
  const execute = process.argv.includes('--execute');
  if (!MODE.has(mode) || !path || process.argv.slice(2).some((value, index, all) => value.startsWith('--') && !['--mode', '--config', '--execute'].includes(value) && (index === 0 || all[index - 1] !== '--mode') && (index === 0 || all[index - 1] !== '--config'))) throw new Error(usage());
  const config = exactConfig(JSON.parse(await readFile(path, 'utf8')));
  if (!execute) { console.log(JSON.stringify({ verdict: 'PLAN_ONLY', mode, brainId: config.brainId, noFeatureFlagsChanged: true, noDaemonStarted: true })); return; }
  if (process.env.AGENTBOOTUP_ALLOW_REMOTE_LOCAL_SMOKE !== '1') throw new Error('refusing execution without AGENTBOOTUP_ALLOW_REMOTE_LOCAL_SMOKE=1');
  if (mode === 'device-plan') { console.log(JSON.stringify({ verdict: 'DEVICE_READY', brainId: config.brainId, noFeatureFlagsChanged: true, next: 'run the documented local enrollment command, then start the existing managed daemon separately' })); return; }
  if (!secureOwnerExecutionUrl(config.serverUrl)) throw new Error('owner verification execution requires HTTPS except literal loopback HTTP');
  const apiKey = process.env.AGENTBOOTUP_REMOTE_LOCAL_SMOKE_API_KEY;
  if (!apiKey) throw new Error('owner verification requires AGENTBOOTUP_REMOTE_LOCAL_SMOKE_API_KEY');
  console.log(JSON.stringify({ verdict: 'OWNER_VERIFIED', ...(await ownerVerify(config, apiKey)) }));
}
main().catch((error) => { process.stderr.write(`remote-local smoke: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
