#!/usr/bin/env bun

/** Bounded PRD-0072 Task 1.3 successor qualification; never a connector or route. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn as spawnProcess } from 'node:child_process';

// Pin the exact clean Mech Plane main revision independently qualified by the
// retained Linux/ARM64 GO receipt. Pinning its direct parent prevents a
// different tree from being substituted under the same qualification claim.
const TARGET_COMMIT = 'ab4c156313d6d5b43c00edf5458e2e3a38ab3e6c';
const TARGET_PARENT_COMMIT = '3822a1bc9a27ac402414de708c8f9f8d781979df';
const RUN_IDENTITY = '@mech/run@0.4.6';
const RUN_INTEGRITY = 'sha512-O3spSfiBHBJo7K3JDFuCEt/g5Cn0gtEwxTNNH7Rzzs+eV01Rg44gVFS71JIfKcfye3Wv4cN3i+lMoA1Llah8ng==';
const CODEX_CLI_VERSION = '0.148.0';
const CODEX_CLI_LAUNCHER_INTEGRITY = 'sha512-bh5kH9+BMrFaHGmLeoSansPdfRksvr4UXzjQInns/KRO7r8VJ+6AAW+SqUsE8XcG3+OW/mI4EEy8Gpo9UDXGvQ==';
const CODEX_CLI_PACKAGE_INTEGRITY = 'sha512-51DCd+izzk6n4mMh4w2utWj3lTLhSTnCOEJQfRh0LS9nBDkcYZcK3iSKOST6fByRIlLSXuLO33LlYYA1VPot6A==';
const EVIDENCE_OUTPUT_DIR = resolve(import.meta.dir);
// Computed from the exact source bytes Bun loaded for this invocation. This is
// included in the atomic receipt itself; a later sidecar cannot retrofit it.
const QUALIFIER_SOURCE_SHA256 = createHash('sha256').update(await readFile(import.meta.path)).digest('hex');

function contained(base: string, candidate: string): boolean {
  const path = relative(base, candidate);
  return path !== '' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path);
}

function containedOrSame(base: string, candidate: string): boolean {
  return base === candidate || contained(base, candidate);
}

/** The effect base must survive temp cleanup and be operator-selected, never inferred. */
export async function validateDurableOutsideBase(plane: string, outsideBase: string): Promise<void> {
  if (!isAbsolute(outsideBase)) throw new Error('outside base must be an absolute directory outside the Plane checkout');
  let canonicalBase: string;
  try {
    canonicalBase = await realpath(outsideBase);
    if (!(await stat(canonicalBase)).isDirectory()) throw new Error('not a directory');
    await access(canonicalBase, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error('outside base must be an existing writable directory');
  }
  const canonicalPlane = await realpath(plane);
  if (containedOrSame(canonicalPlane, canonicalBase)) throw new Error('outside base must be an absolute directory outside the Plane checkout');
  const tempRoots = ['/tmp', tmpdir(), process.env.TMPDIR].filter((value): value is string => Boolean(value));
  for (const tempRoot of tempRoots) {
    try {
      if (containedOrSame(await realpath(tempRoot), canonicalBase)) throw new Error('outside base must not be inside a system temporary directory');
    } catch (error) {
      if (error instanceof Error && error.message === 'outside base must not be inside a system temporary directory') throw error;
    }
  }
}

/**
 * Evidence is an AgentBootup-owned artifact.  Do not let an invocation turn
 * this qualifier into a writer for the checked-out Plane source (or anywhere
 * else), and avoid following a symlink planted below the evidence directory.
 */
interface EvidenceOutput {
  readonly output: string;
  readonly parent: FileHandle;
  readonly name: string;
}

function descriptorPath(directory: FileHandle, name = ''): string {
  // Linux procfs resolves this through the held directory descriptor.  POSIX
  // lacks a portable JS openat(2) binding; on every other platform we refuse
  // to write rather than reintroducing a path-based parent TOCTOU.
  if (process.platform !== 'linux') {
    throw new Error('secure descriptor-relative evidence output is unavailable on this runtime; refusing to write evidence');
  }
  return `/proc/self/fd/${directory.fd}${name ? `/${name}` : ''}`;
}

async function openChildDirectory(parent: FileHandle, name: string): Promise<FileHandle> {
  try {
    return await open(descriptorPath(parent, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('evidence output parent must be a real directory below the AgentBootup evidence root');
  }
}

async function requireDescriptorRelativeDirectory(parent: FileHandle): Promise<void> {
  try {
    if (!(await stat(descriptorPath(parent))).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('secure descriptor-relative evidence output is unavailable on this runtime; refusing to write evidence');
  }
}

/**
 * Acquire the output parent as a descriptor chain before any write.  All later
 * output operations address that held descriptor, never the mutable pathname.
 */
export async function prepareEvidenceOutput(output: string): Promise<EvidenceOutput> {
  const resolvedOutput = resolve(output);
  if (!contained(EVIDENCE_OUTPUT_DIR, resolvedOutput)) {
    throw new Error(`evidence output must be a new file under ${EVIDENCE_OUTPUT_DIR}`);
  }
  const segments = relative(EVIDENCE_OUTPUT_DIR, resolvedOutput).split(/[\\/]/).filter(Boolean);
  const name = segments.pop();
  if (!name || name === '.' || name === '..') throw new Error('evidence output must name a new file below the AgentBootup evidence root');
  let parent: FileHandle;
  try {
    parent = await open(EVIDENCE_OUTPUT_DIR, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('evidence output parent must be a real directory below the AgentBootup evidence root');
  }
  try {
    await requireDescriptorRelativeDirectory(parent);
    for (const segment of segments) {
      const next = await openChildDirectory(parent, segment);
      await parent.close();
      parent = next;
    }
    try {
      await lstat(descriptorPath(parent, name));
      throw new Error(`refusing to overwrite existing evidence output: ${resolvedOutput}`);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { output: resolvedOutput, parent, name };
  } catch (error) {
    await parent.close();
    throw error;
  }
}

export async function writeNewEvidence(output: EvidenceOutput, result: unknown): Promise<void> {
  const temporaryName = `.qualification-receipt-${randomUUID()}.tmp`;
  const temporaryPath = descriptorPath(output.parent, temporaryName);
  try {
    // Publish by same-directory hard link only after the complete file is
    // flushed. link(2) is atomic and refuses an existing final name, avoiding
    // both partial receipts and rename-overwrite races.
    const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`);
      await handle.sync();
    }
    finally { await handle.close(); }
    await link(temporaryPath, descriptorPath(output.parent, output.name));
    await unlink(temporaryPath);
    await output.parent.sync();
  } catch (error: any) {
    try { await unlink(temporaryPath); } catch { /* absent or already unlinked */ }
    if (error?.code === 'EEXIST' || error?.code === 'ELOOP') throw new Error(`refusing to overwrite existing evidence output: ${output.output}`);
    throw error;
  }
}

function run(command: string[], cwd: string, timeout = 120_000): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe', timeout });
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed`);
  return new TextDecoder().decode(result.stdout).trim();
}

function absoluteArg(name: string): string {
  const index = Bun.argv.indexOf(name); const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value || !isAbsolute(value)) throw new Error(`usage: ${name} <absolute-path>`);
  return value;
}

type CredentialProfile = 'auth_only' | 'auth_plus_config';

function credentialProfileArg(): CredentialProfile {
  const index = Bun.argv.indexOf('--credential-profile'); const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (value !== 'auth_only' && value !== 'auth_plus_config') {
    throw new Error('usage: --credential-profile <auth_only|auth_plus_config>');
  }
  return value;
}

/**
 * Record only independently observable runtime facts.  The credential profile
 * is a bounded operator-declared mount shape; neither its contents nor path is
 * retained. The package is hashed here rather than asserted in prose, so two
 * redacted failures can still be distinguished without exposing a credential.
 */
async function verifiedTarball(path: string, integrity: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isFile()) throw new Error(`${label} must be a regular file`);
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(canonical)) hash.update(chunk);
  if (`sha512-${hash.digest('base64')}` !== integrity) throw new Error(`${label} integrity mismatch`);
  return canonical;
}

async function sameRegularFile(actual: string, expected: string, label: string): Promise<void> {
  const [canonicalActual, canonicalExpected] = await Promise.all([realpath(actual), realpath(expected)]);
  if (canonicalActual !== canonicalExpected || !(await stat(canonicalActual)).isFile()) throw new Error(`${label} does not match the declared credential profile`);
}

async function verifyCredentialProfile(credentialProfile: CredentialProfile, authFile: string, configFile: string | undefined): Promise<void> {
  const credentialHome = process.env.CODEX_HOME;
  if (!credentialHome || !isAbsolute(credentialHome)) throw new Error('CODEX_HOME must be an absolute credential home for a real qualification');
  await sameRegularFile(join(credentialHome, 'auth.json'), authFile, 'Codex auth file');
  if (credentialProfile === 'auth_plus_config') {
    if (!configFile) throw new Error('auth_plus_config requires --codex-config-file');
    await sameRegularFile(join(credentialHome, 'config.toml'), configFile, 'Codex config file');
  }
}

interface VerifiedCodexRuntime {
  readonly bin: string;
  readonly execution: {
    readonly provider: 'codex'; readonly cliVersion: string;
    readonly platform: { readonly os: string; readonly arch: string };
    readonly codexLauncherIntegrity: string; readonly codexLauncherIntegrityVerified: true;
    readonly codexPackageIntegrity: string; readonly codexPackageIntegrityVerified: true;
    readonly credentialProfile: CredentialProfile;
  };
  readonly cleanup: () => Promise<void>;
}

async function prepareVerifiedCodexRuntime(plane: string, launcherTarball: string, packageTarball: string, credentialProfile: CredentialProfile, authFile: string, configFile: string | undefined): Promise<VerifiedCodexRuntime> {
  if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('verified Codex runtime qualification requires linux/arm64');
  const [verifiedLauncher, verifiedPackage] = await Promise.all([
    verifiedTarball(launcherTarball, CODEX_CLI_LAUNCHER_INTEGRITY, 'Codex launcher tarball'),
    verifiedTarball(packageTarball, CODEX_CLI_PACKAGE_INTEGRITY, 'Codex package tarball'),
  ]);
  await verifyCredentialProfile(credentialProfile, authFile, configFile);
  const root = await mkdtemp(join(tmpdir(), 'agentbootup-codex-runtime-'));
  try {
    const [launcherExtract, packageExtract] = [join(root, 'launcher'), join(root, 'package')];
    await Promise.all([mkdir(launcherExtract), mkdir(packageExtract), mkdir(join(root, 'node_modules', '@openai'), { recursive: true }), mkdir(join(root, 'bin'))]);
    run(['tar', '-xzf', verifiedLauncher, '-C', launcherExtract], plane);
    run(['tar', '-xzf', verifiedPackage, '-C', packageExtract], plane);
    await rename(join(launcherExtract, 'package'), join(root, 'node_modules', '@openai', 'codex'));
    await rename(join(packageExtract, 'package'), join(root, 'node_modules', '@openai', 'codex-linux-arm64'));
    const bin = join(root, 'bin');
    await symlink('../node_modules/@openai/codex/bin/codex.js', join(bin, 'codex'));
    if (run([join(bin, 'codex'), '--version'], plane) !== `codex-cli ${CODEX_CLI_VERSION}`) throw new Error('verified Codex CLI version drifted from the qualified runtime');
    return {
      bin,
      execution: {
        provider: 'codex', cliVersion: CODEX_CLI_VERSION,
        platform: { os: process.platform, arch: process.arch },
        codexLauncherIntegrity: CODEX_CLI_LAUNCHER_INTEGRITY, codexLauncherIntegrityVerified: true,
        codexPackageIntegrity: CODEX_CLI_PACKAGE_INTEGRITY, codexPackageIntegrityVerified: true,
        credentialProfile,
      },
      cleanup: async () => { await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function lockEntry(lock: string): [string, string, unknown, string] {
  const line = lock.split('\n').find((row) => /^    "@mech\/run": /.test(row));
  if (!line) throw new Error('exact @mech/run lock entry is absent');
  const value = JSON.parse(line.slice(line.indexOf(':') + 1).trim().replace(/,$/, ''));
  if (!Array.isArray(value) || value.length !== 4 || typeof value[0] !== 'string' || typeof value[1] !== 'string' || typeof value[3] !== 'string') throw new Error('malformed @mech/run lock entry');
  return value as [string, string, unknown, string];
}

export function parseSoakSummary(stdout: string): {
  cases: number; allowEffectsObserved: number; deniedEffectsObserved: number;
  nativeToolObservedEveryRow: boolean; approvalProofObserved: boolean; approvalProofNotObserved: string[];
} {
  let value: any;
  try { value = JSON.parse(stdout); } catch { throw new Error('real Codex soak did not emit one JSON summary'); }
  if (value?.schemaVersion !== 'mech-plane.runtime-approval-soak.v2' || value?.passed !== true || value?.cycles !== 2
    || value?.runtime?.package !== '@mech/run' || value?.runtime?.version !== '0.4.6' || value?.runtime?.provider !== 'codex'
    || !Array.isArray(value?.results) || value.results.length !== 8) throw new Error('real Codex soak summary identity or matrix drifted');
  let allowEffectsObserved = 0; let deniedEffectsObserved = 0;
  const approvalProofNotObserved = new Set<string>();
  for (const cycle of [1, 2]) for (const mode of ['allow', 'deny', 'expiry', 'disconnect']) {
    const row = value.results.find((item: any) => item?.cycle === cycle && item?.mode === mode);
    if (!row || row.nativeToolObserved !== true) throw new Error(`real Codex soak lacks native tool proof for ${cycle}/${mode}`);
    if (row.approvalRequested !== true) throw new Error(`real Codex soak lacks approval proof for ${cycle}/${mode}`);
    for (const field of ['approvalRequestCount', 'approvalDecisionsSubmitted', 'approvalDecisionsAccepted']) {
      if (!Number.isInteger(row[field]) || row[field] < 0) throw new Error(`real Codex soak has invalid ${field} for ${cycle}/${mode}`);
    }
    const expected = mode === 'allow'
      ? { approved: true, decision: 'once', reason: 'resolved', effect: true }
      : mode === 'deny' ? { approved: false, decision: 'deny', reason: 'resolved', effect: false }
        : mode === 'expiry' ? { approved: false, decision: 'deny', reason: 'expired', effect: false }
          : { approved: false, decision: 'deny', reason: 'cancelled', effect: false };
    const expectedRuntime = mode === 'disconnect'
      ? { stopReason: 'cancelled', exitCode: null }
      : { stopReason: 'end_turn', exitCode: 0 };
    if (row.approvalOutcome?.approved !== expected.approved || row.approvalOutcome?.decision !== expected.decision
      || row.approvalOutcome?.reason !== expected.reason || row.effectObserved !== expected.effect
      || row.runtime?.stopReason !== expectedRuntime.stopReason || row.runtime?.exitCode !== expectedRuntime.exitCode) {
      throw new Error(`real Codex soak effect/outcome/runtime mismatch for ${cycle}/${mode}`);
    }
    if ((mode === 'allow' || mode === 'deny')
      ? row.approvalDecisionsSubmitted !== row.approvalRequestCount
        || row.approvalDecisionsAccepted !== row.approvalRequestCount
      : row.approvalDecisionsSubmitted !== 0 || row.approvalDecisionsAccepted !== 0) {
      throw new Error(`real Codex soak decision-count mismatch for ${cycle}/${mode}`);
    }
    if (row.effectObserved) allowEffectsObserved += 1; else deniedEffectsObserved += 1;
    // Task 1.3 requires runtime proof of the AgentMount canonical argument `bindingDigest`
    // and finite expiry. If the soak advertises those per-row fields they MUST be true;
    // if it does not carry them at all we record that fact rather than inferring success
    // (roborev). A field present but false is a hard failure, not a missing observation.
    for (const [field, sink] of [['bindingDigestPresent', 'bindingDigest'], ['expiryPresent', 'expiry']] as const) {
      if (row[field] === undefined) approvalProofNotObserved.add(sink);
      else if (row[field] !== true) throw new Error(`real Codex soak reports ${field}=false for ${cycle}/${mode}`);
    }
  }
  return {
    cases: 8, allowEffectsObserved, deniedEffectsObserved,
    nativeToolObservedEveryRow: true,
    // Explicit provenance: what this run actually observed vs. what its schema cannot express.
    approvalProofObserved: approvalProofNotObserved.size === 0,
    approvalProofNotObserved: [...approvalProofNotObserved].sort(),
  };
}

const RECEIPT_EVENT_FIELDS = {
  preflight_passed: ['outsideBaseReady', 'codexCliReady', 'codexAuthenticated', 'codexCliVersion', 'modelSource'],
  spawn_started: ['cycle', 'mode', 'attempt'],
  approval_requested: ['cycle', 'mode', 'approvalRequested'],
  native_tool_observed: ['cycle', 'mode', 'nativeToolObserved'],
  spawn_finished: ['cycle', 'mode', 'attempt', 'stopReason', 'exitCode'],
  case_observed: ['cycle', 'mode', 'attempt', 'approvalRequestCount', 'approvalDecisionsSubmitted', 'approvalDecisionsAccepted'],
  case_retrying: ['cycle', 'mode', 'attempt', 'maxAttempts', 'reason'],
  case_failed: ['cycle', 'mode', 'attempt', 'failureCode', 'nativeToolObserved', 'approvalRequestCount', 'terminalOutcomeCount', 'unsettledOutcomeCount', 'approvalDecisionsSubmitted', 'approvalDecisionsAccepted', 'approvalDecisionsReplayed', 'effectObserved', 'runtimeThrew', 'stopReason', 'exitCode', 'errorType', 'retryable', 'errorCode'],
} as const;

/** Retain only the bounded event fields needed to bind the summary to this run. */
export function parseReceiptEventStream(stderr: string): any[] {
  const events: any[] = [];
  for (const line of stderr.split('\n')) {
    let raw: any;
    try { raw = JSON.parse(line); } catch { continue; }
    const fields = RECEIPT_EVENT_FIELDS[raw?.event as keyof typeof RECEIPT_EVENT_FIELDS];
    if (!fields) continue;
    const event: any = { event: raw.event };
    for (const field of fields) if (raw[field] !== undefined) event[field] = raw[field];
    events.push(event);
  }
  return events;
}

/**
 * Bind an independently retained approval receipt to this qualifier's exact
 * source, runtime, package, and proof requirements. The validator derives GO;
 * it never trusts the receipt's top-level verdict in isolation.
 */
export function validateApprovalReceipt(receipt: any) {
  function requireReceipt(condition: unknown, detail: string): asserts condition {
    if (!condition) throw new Error(`invalid runtime approval receipt: ${detail}`);
  }
  requireReceipt(receipt?.schemaVersion === 'agentbootup.mech-plane-runtime-approval-qualification.v2', 'schema');
  requireReceipt(receipt?.source?.repository === 'dundas/mech-plane', 'repository');
  requireReceipt(receipt?.source?.commit === TARGET_COMMIT
    && receipt?.source?.directParent === TARGET_PARENT_COMMIT
    && receipt?.source?.cleanBefore === true && receipt?.source?.cleanAfter === true, 'source provenance');
  requireReceipt(receipt?.qualifier?.sourceSha256 === QUALIFIER_SOURCE_SHA256
    && /^[a-f0-9]{64}$/.test(receipt.qualifier.sourceSha256), 'qualifier source binding');
  requireReceipt(receipt?.integrityTuple?.platform?.os === 'linux'
    && receipt?.integrityTuple?.platform?.architecture === 'arm64'
    && receipt?.integrityTuple?.platform?.kernelArchitecture === 'aarch64', 'platform');
  requireReceipt(receipt?.integrityTuple?.runtime?.codexCli === CODEX_CLI_VERSION, 'Codex runtime');
  const packages = receipt?.integrityTuple?.packages;
  requireReceipt(packages?.mechRun?.identity === RUN_IDENTITY
    && packages?.mechRun?.integrity === RUN_INTEGRITY && packages?.mechRun?.verified === true, 'Mech Run package');
  requireReceipt(packages?.codexLauncher?.identity === `@openai/codex@${CODEX_CLI_VERSION}`
    && packages?.codexLauncher?.integrity === CODEX_CLI_LAUNCHER_INTEGRITY
    && packages?.codexLauncher?.verified === true, 'Codex launcher package');
  requireReceipt(packages?.codexLinuxArm64?.identity === `@openai/codex@${CODEX_CLI_VERSION}-linux-arm64`
    && packages?.codexLinuxArm64?.integrity === CODEX_CLI_PACKAGE_INTEGRITY
    && packages?.codexLinuxArm64?.verified === true, 'Codex Linux/ARM64 package');
  requireReceipt(receipt?.finalSummary?.runtime?.codexCliVersion === CODEX_CLI_VERSION, 'summary runtime');
  requireReceipt(receipt?.exitCode === 0 && Array.isArray(receipt?.caseFailures)
    && receipt.caseFailures.length === 0, 'terminal result');

  const summary = parseSoakSummary(JSON.stringify(receipt.finalSummary));
  const eventStream = Array.isArray(receipt?.eventStream) ? receipt.eventStream : [];
  const caseEvents = eventStream.filter((event: any) => event?.event === 'case_observed');
  const startEvents = eventStream.filter((event: any) => event?.event === 'spawn_started');
  const finishEvents = eventStream.filter((event: any) => event?.event === 'spawn_finished');
  const approvalEvents = eventStream.filter((event: any) => event?.event === 'approval_requested');
  const nativeToolEvents = eventStream.filter((event: any) => event?.event === 'native_tool_observed');
  const retryEvents = eventStream.filter((event: any) => event?.event === 'case_retrying');
  const failureEvents = eventStream.filter((event: any) => event?.event === 'case_failed');
  const preflightEvents = eventStream.filter((event: any) => event?.event === 'preflight_passed');
  requireReceipt(preflightEvents.length === 1
    && preflightEvents[0].outsideBaseReady === true
    && preflightEvents[0].codexCliReady === true
    && preflightEvents[0].codexAuthenticated === true
    && preflightEvents[0].codexCliVersion === CODEX_CLI_VERSION, 'preflight');
  requireReceipt(caseEvents.length === summary.cases, 'event/summary case count');
  requireReceipt(retryEvents.length === 0, 'zero retries');
  requireReceipt(failureEvents.length === 0 && receipt.caseFailures.length === 0, 'zero case failures');
  for (const row of receipt.finalSummary.results) {
    const event = caseEvents.find((candidate: any) => candidate?.cycle === row.cycle && candidate?.mode === row.mode);
    const start = startEvents.filter((candidate: any) => candidate?.cycle === row.cycle && candidate?.mode === row.mode);
    const finish = finishEvents.filter((candidate: any) => candidate?.cycle === row.cycle && candidate?.mode === row.mode);
    const approvals = approvalEvents.filter((candidate: any) => candidate?.cycle === row.cycle && candidate?.mode === row.mode);
    const nativeTools = nativeToolEvents.filter((candidate: any) => candidate?.cycle === row.cycle && candidate?.mode === row.mode);
    requireReceipt(event && start.length === 1 && finish.length === 1
      && start[0].attempt === 1 && finish[0].attempt === 1 && event.attempt === 1, `event/attempt coverage for ${row.cycle}/${row.mode}`);
    for (const field of ['approvalRequestCount', 'approvalDecisionsSubmitted', 'approvalDecisionsAccepted']) {
      requireReceipt(Number.isInteger(event[field]) && event[field] >= 0, `${field} for ${row.cycle}/${row.mode}`);
    }
    requireReceipt(event.approvalRequestCount >= 1
      && event.approvalRequestCount === approvals.length
      && approvals.every((candidate: any) => candidate?.approvalRequested === true)
      && event.approvalRequestCount === row.approvalRequestCount
      && nativeTools.length === row.approvalRequestCount
      && nativeTools.every((candidate: any) => candidate?.nativeToolObserved === true)
      && row.nativeToolObserved === true
      && event.approvalDecisionsSubmitted === row.approvalDecisionsSubmitted
      && event.approvalDecisionsAccepted === row.approvalDecisionsAccepted, `event/summary mismatch for ${row.cycle}/${row.mode}`);
    requireReceipt(finish[0].stopReason === row.runtime.stopReason
      && finish[0].exitCode === row.runtime.exitCode, `finish/summary mismatch for ${row.cycle}/${row.mode}`);
    if (row.mode === 'allow' || row.mode === 'deny') {
      requireReceipt(event.approvalDecisionsSubmitted === event.approvalRequestCount
        && event.approvalDecisionsAccepted === event.approvalRequestCount, `decision counts for ${row.cycle}/${row.mode}`);
    } else {
      requireReceipt(event.approvalDecisionsSubmitted === 0
        && event.approvalDecisionsAccepted === 0, `decision counts for ${row.cycle}/${row.mode}`);
    }
  }
  const executed = startEvents.length === summary.cases;
  const completeOutputObserved = finishEvents.length === summary.cases
    && caseEvents.length === summary.cases && approvalEvents.length > 0 && nativeToolEvents.length > 0;
  const completedSuccessfully = receipt.exitCode === 0 && receipt.finalSummary.passed === true;
  const nativeToolEventObserved = receipt.finalSummary.results.every((row: any) =>
    nativeToolEvents.some((event: any) => event?.cycle === row.cycle && event?.mode === row.mode && event?.nativeToolObserved === true));
  const proofs = evaluateProofs({
    executed, ok: completedSuccessfully, outputDrainComplete: completeOutputObserved,
    nativeToolEventObserved, zeroRetries: retryEvents.length === 0,
    zeroCaseFailures: failureEvents.length === 0 && receipt.caseFailures.length === 0, ...summary,
  });
  requireReceipt(proofs.verdict === 'GO' && receipt.verdict === proofs.verdict, 'derived verdict');
  return {
    schemaVersion: 'agentbootup.mech-plane-runtime-successor-reconcile.v6',
    source: { targetCommit: TARGET_COMMIT, parentCommit: TARGET_PARENT_COMMIT, clean: true },
    artifact: { identity: RUN_IDENTITY, integrity: RUN_INTEGRITY, registryVerified: true },
    independentRuntime: { executed, ok: completedSuccessfully, outputDrainComplete: completeOutputObserved,
      nativeToolEventObserved, zeroRetries: retryEvents.length === 0,
      zeroCaseFailures: failureEvents.length === 0 && receipt.caseFailures.length === 0, ...summary },
    requiredProofsSatisfied: proofs.satisfied,
    verdict: proofs.verdict,
    blockers: proofs.blockers,
  };
}

/** Build the immutable sanitized receipt from one verified qualifier invocation. */
export function buildApprovalReceipt(soak: any, runtimeFacts = {
  platform: { os: process.platform, architecture: process.arch, kernelArchitecture: process.arch === 'arm64' ? 'aarch64' : process.arch },
  runtime: { bun: Bun.version, node: process.versions.node, codexCli: CODEX_CLI_VERSION },
}) {
  const receipt = {
    schemaVersion: 'agentbootup.mech-plane-runtime-approval-qualification.v2',
    verdict: 'GO',
    source: { repository: 'dundas/mech-plane', commit: TARGET_COMMIT, directParent: TARGET_PARENT_COMMIT, cleanBefore: true, cleanAfter: true },
    qualifier: { sourceSha256: QUALIFIER_SOURCE_SHA256 },
    integrityTuple: {
      platform: runtimeFacts.platform,
      runtime: runtimeFacts.runtime,
      packages: {
        mechRun: { identity: RUN_IDENTITY, integrity: RUN_INTEGRITY, verified: true },
        codexLauncher: { identity: `@openai/codex@${CODEX_CLI_VERSION}`, integrity: CODEX_CLI_LAUNCHER_INTEGRITY, verified: true },
        codexLinuxArm64: { identity: `@openai/codex@${CODEX_CLI_VERSION}-linux-arm64`, integrity: CODEX_CLI_PACKAGE_INTEGRITY, verified: true },
      },
    },
    eventStream: soak.eventStream,
    finalSummary: soak.finalSummary,
    exitCode: 0,
    caseFailures: [],
  };
  validateApprovalReceipt(receipt);
  return receipt;
}

export function safeProbeFailure(stderr: string, timedOut: boolean, exitCode: number): { classification: string; phase: string | null; preflightCode?: string; stderrSha256: string; stderrBytes: number; exitCode: number } {
  const match = /"event":"(preflight_passed|spawn_started|approval_requested|spawn_finished)","cycle":(\d+),"mode":"(allow|deny|expiry|disconnect)"/g;
  let phase: string | null = null;
  for (const item of stderr.matchAll(match)) phase = `cycle-${item[2]}-${item[3]}-${item[1]}`;
  const code = /runtime approval soak preflight failed: (outside_base_not_directory|outside_base_not_writable|outside_base_cleanup_failed|codex_cli_unavailable|codex_cli_version_unparseable|codex_auth_unavailable)/.exec(stderr)?.[1];
  return {
    classification: timedOut ? 'real_probe_timeout_or_stall' : 'real_probe_command_failed', phase,
    ...(code ? { preflightCode: code } : {}),
    stderrSha256: createHash('sha256').update(stderr).digest('hex'), stderrBytes: Buffer.byteLength(stderr), exitCode,
  };
}

/**
 * STRUCTURAL: the verdict is DERIVED from a declared checklist of required proofs, not
 * assembled by remembering to add a blocker at each new failure site. Two consecutive
 * review rounds found "success emitted although a required proof was absent" — first
 * hardcoded `bindingDigest: true`, then `GO` with `approvalProofObserved: false`. Patching
 * the next instance would repeat the class, so the shape is inverted: enumerate what a GO
 * MUST prove, and let anything unproven produce its own blocker automatically. Adding a
 * requirement here can never silently pass; it fails closed until something observes it.
 */
export const REQUIRED_PROOFS = [
  { id: 'independent_real_codex_runtime_exercised', blocker: 'independent_real_codex_runtime_not_exercised',
    holds: (p: any) => p?.executed === true },
  { id: 'probe_completed_successfully', blocker: 'real_probe_did_not_complete',
    holds: (p: any) => p?.ok === true },
  { id: 'complete_output_observed', blocker: 'real_probe_output_drain_incomplete',
    holds: (p: any) => p?.outputDrainComplete === true },
  { id: 'full_two_cycle_matrix', blocker: 'real_probe_matrix_incomplete',
    holds: (p: any) => p?.cases === 8 },
  { id: 'native_tool_event_observed', blocker: 'native_tool_event_not_observed',
    holds: (p: any) => p?.nativeToolEventObserved === true && p?.nativeToolObservedEveryRow === true },
  { id: 'zero_retries', blocker: 'real_probe_retry_observed',
    holds: (p: any) => p?.zeroRetries === true },
  { id: 'zero_case_failures', blocker: 'real_probe_case_failure_observed',
    holds: (p: any) => p?.zeroCaseFailures === true },
  // Task 1.3 demands runtime proof of the AgentMount canonical argument `bindingDigest`
  // and finite expiry. A receipt that omits either proof blocks; absence of proof is not
  // proof (roborev).
  { id: 'approval_proof_observed', blocker: 'approval_proof_not_observed',
    holds: (p: any) => p?.approvalProofObserved === true },
] as const;

export function evaluateProofs(probe: any): { verdict: 'GO' | 'NO_GO'; blockers: string[]; satisfied: string[] } {
  const blockers: string[] = []; const satisfied: string[] = [];
  for (const proof of REQUIRED_PROOFS) {
    if (proof.holds(probe)) satisfied.push(proof.id);
    else if (!blockers.includes(proof.blocker)) blockers.push(proof.blocker);
  }
  // A probe that failed carries its own classification; surface it alongside the checklist.
  if (probe && probe.ok === false && typeof probe.classification === 'string' && !blockers.includes(probe.classification)) {
    blockers.push(probe.classification);
  }
  return { verdict: blockers.length === 0 ? 'GO' : 'NO_GO', blockers, satisfied };
}

/** @deprecated Use evaluateProofs — a two-state ok/not-ok verdict cannot express a missing proof. */
export function verdictFromProbe(probe: { ok: true } | { ok: false }): 'GO' | 'NO_GO' { return probe.ok ? 'GO' : 'NO_GO'; }

async function directoryManifest(root: string, prefix = ''): Promise<string[]> {
  const manifest: string[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      manifest.push(`d:${relativeName}`);
      manifest.push(...await directoryManifest(path, relativeName));
    } else if (entry.isFile()) {
      manifest.push(`f:${relativeName}:${createHash('sha512').update(await readFile(path)).digest('base64')}`);
    } else if (entry.isSymbolicLink()) {
      manifest.push(`l:${relativeName}:${await readlink(path)}`);
    } else {
      throw new Error('installed runtime package contains an unsupported filesystem entry');
    }
  }
  return manifest;
}

async function verifyArtifact(plane: string) {
  const [identity, url, , integrity] = lockEntry(await readFile(join(plane, 'bun.lock'), 'utf8'));
  if (identity !== RUN_IDENTITY || integrity !== RUN_INTEGRITY || !url.startsWith('https://registry.mechdna.net/')) throw new Error('published runtime identity or approved registry integrity drifted');
  const response = await fetch(url); if (!response.ok) throw new Error(`runtime tarball fetch failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== RUN_INTEGRITY) throw new Error('runtime tarball integrity mismatch');
  // Force a fresh frozen install, then compare the executed package byte-for-byte
  // with the package extracted from the integrity-verified registry tarball.
  run(['bun', 'install', '--frozen-lockfile', '--force'], plane, 5 * 60_000);
  const verificationRoot = await mkdtemp(join(tmpdir(), 'agentbootup-mech-run-verify-'));
  try {
    const tarball = join(verificationRoot, 'package.tgz');
    const extracted = join(verificationRoot, 'extracted');
    await writeFile(tarball, bytes, { mode: 0o600 });
    await mkdir(extracted);
    run(['tar', '-xzf', tarball, '-C', extracted], plane);
    const installed = await realpath(join(plane, 'node_modules', '@mech', 'run'));
    const [expectedManifest, installedManifest] = await Promise.all([
      directoryManifest(join(extracted, 'package')),
      directoryManifest(installed),
    ]);
    if (JSON.stringify(expectedManifest) !== JSON.stringify(installedManifest)) {
      throw new Error('installed runtime package bytes drifted from the integrity-verified tarball');
    }
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }
}

export async function realSoak(plane: string, outsideBase: string, timeoutMs: number, drainGraceMs = 15_000, codexBin?: string) {
  // STRUCTURAL: own the process GROUP, not one process. Killing only the direct child left
  // descendants running the real-agent workload and touching local effects after the
  // qualification had already reported failure (roborev). `detached: true` makes the child a
  // session/group leader, so a single negative-PID signal terminates the whole tree. Bounding
  // one PID is the wrong unit when the thing being bounded is a process tree.
  // Lifecycle ownership that survives leader exit, without ever signalling from OUTSIDE the
  // group after the leader is reaped. The wrapper is the detached group leader and cleans up
  // its own group FROM INSIDE, where the group provably still exists — so there is no window
  // in which a recycled PID can be signalled. (Probing from outside after exit was measured
  // to kill unrelated processes: phase-1 went 3377/0 -> 2695/52.) `trap '' TERM` makes the
  // wrapper immune to the sweep so it survives to report the real exit code; every descendant
  // — the soak and any codex child it spawned — receives TERM.
  //
  // RESIDUAL LIMITATION (do not overstate this): TERM is a request, not a guarantee. A
  // descendant that ignores or blocks SIGTERM survives the sweep, so containment holds for
  // well-behaved children only. There is no KILL escalation on this path because the wrapper
  // cannot survive its own KILL and must live to report the real exit code. Closing it needs
  // a detached in-group reaper that TERMs, waits, then KILLs the group after the wrapper has
  // exited — deliberately not added here, since it changes the success path's timing and
  // wants its own soak coverage. The soak test proves containment for a normal descendant;
  // it does not prove it for a TERM-ignoring one.
  const wrapped = "trap '' TERM; bun scripts/soak-runtime-approval.ts --cycles=2; ec=$?; "
    + "kill -TERM -$$ 2>/dev/null; exit $ec";
  const child = spawnProcess('bash', ['-c', wrapped], {
    cwd: plane, env: { ...process.env, ...(codexBin ? { PATH: `${codexBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` } : {}), MECH_PLANE_SOAK_OUTSIDE_BASE: outsideBase },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let timedOut = false;
  let watchdogTerminationApplied = false;
  // True only when the WATCHDOG killed the group from outside (timeout path, child known
  // alive and unreaped). It is NOT set on the clean-exit path, where containment is done
  // from inside the group by the wrapper and no outside signal is sent.
  let groupTerminationApplied = false;
  const killTree = (signal: NodeJS.Signals) => {
    // Negative PID addresses the group. Guard it: if the child never became a group leader
    // the negative signal would hit OUR group, so fall back to the direct child only.
    if (typeof child.pid !== 'number') return false;
    try { process.kill(-child.pid, signal); return true; }
    catch { try { child.kill(signal); } catch { /* already gone */ } return false; }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    groupTerminationApplied = killTree('SIGKILL');
    watchdogTerminationApplied = true;
  }, timeoutMs);
  // Killing the direct child does NOT bound this function: a descendant that inherited
  // stdout/stderr keeps the pipes open, so `Response(...).text()` can stay pending forever
  // after proc.kill(9) and the configured watchdog never actually terminates the run
  // (roborev). Bound every awaiter, not just the process.
  //
  // The grace window MUST start at process exit, not at spawn. An earlier version armed it
  // when draining began, so a healthy multi-minute soak blew a 15s deadline, discarded all
  // output, and reported `real_probe_output_drain_incomplete` on an exit-0 run — a gate that
  // false-fails is as broken as one that cannot fail. Reads therefore start immediately and
  // run unbounded alongside the child (never let a full pipe buffer block it); only the
  // RESIDUAL wait after exit is bounded, which is exactly the descendant-holds-the-pipe case.
  const readAll = (stream: NodeJS.ReadableStream | null): Promise<string | null> => {
    if (!stream) return Promise.resolve('');
    return new Promise((resolve) => {
      let buf = ''; stream.setEncoding('utf8');
      stream.on('data', (c) => { buf += c; });
      stream.on('end', () => resolve(buf));
      stream.on('error', () => resolve(null));
    });
  };
  const outRead = readAll(child.stdout);
  const errRead = readAll(child.stderr);
  // 'exit', NOT 'close': 'close' additionally waits for every stdio stream to end, so a
  // descendant holding the pipes delays it indefinitely — which would put the unbounded wait
  // back one layer down, before the grace window can even arm. 'exit' fires on process death.
  const exitCode: number | null = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(1));
  });
  clearTimeout(timer);
  // Descendant containment is handled INSIDE the group by the wrapper (see spawn above), so
  // nothing is signalled from here after the leader is reaped. The watchdog path still kills
  // the group from outside, which is safe because the child is known alive and unreaped then.
  const INCOMPLETE = Symbol('drain-incomplete');
  const graced = async (read: Promise<string | null>): Promise<string | typeof INCOMPLETE> => {
    let settle: (v: string | typeof INCOMPLETE) => void;
    const done = new Promise<string | typeof INCOMPLETE>((resolve) => { settle = resolve; });
    const deadline = setTimeout(() => settle(INCOMPLETE), drainGraceMs);
    void read.then((text) => { clearTimeout(deadline); settle(text ?? INCOMPLETE); });
    return done;
  };
  const [outValue, errValue] = await Promise.all([graced(outRead), graced(errRead)]);
  const stdout = outValue === INCOMPLETE ? '' : outValue;
  const stderr = errValue === INCOMPLETE ? '' : errValue;
  const outputDrainComplete = outValue !== INCOMPLETE && errValue !== INCOMPLETE;
  // An incomplete drain means we cannot claim to have seen the whole summary, so it can
  // never yield GO — absence of observed failure is not proof of success.
  if (timedOut || exitCode !== 0 || !outputDrainComplete) {
    return {
      // groupTerminationApplied belongs on EVERY return, and most of all on the timeout
      // path: retained failure evidence must distinguish a successful group kill from a
      // fallback that only reached the direct child, or a reader cannot tell whether a
      // real-agent workload was still running when the qualifier gave up (roborev).
      ok: false as const, watchdogTerminationApplied, groupTerminationApplied, outputDrainComplete,
      ...safeProbeFailure(stderr, timedOut, exitCode ?? 1),
      ...(outputDrainComplete ? {} : { classification: 'real_probe_output_drain_incomplete' }),
    };
  }
  try {
    const finalSummary = JSON.parse(stdout);
    const eventStream = parseReceiptEventStream(stderr);
    const nativeToolEventObserved = finalSummary.results.every((row: any) =>
      eventStream.some((event: any) => event?.event === 'native_tool_observed'
        && event?.cycle === row.cycle && event?.mode === row.mode && event?.nativeToolObserved === true));
    const zeroRetries = !eventStream.some((event: any) => event?.event === 'case_retrying');
    const zeroCaseFailures = !eventStream.some((event: any) => event?.event === 'case_failed');
    return { ok: true as const, watchdogTerminationApplied, groupTerminationApplied, outputDrainComplete,
      ...parseSoakSummary(stdout), nativeToolEventObserved, zeroRetries, zeroCaseFailures, eventStream, finalSummary };
  }
  catch { return { ok: false as const, watchdogTerminationApplied, groupTerminationApplied, outputDrainComplete, ...safeProbeFailure(stderr, false, exitCode), classification: 'real_probe_malformed_output' }; }
}

async function main() {
  const plane = absoluteArg('--mech-plane'); const output = absoluteArg('--output');
  const allowRealAgent = Bun.argv.includes('--allow-real-agent');
  const outsideBase = allowRealAgent ? absoluteArg('--outside-base') : undefined;
  if (outsideBase) await validateDurableOutsideBase(plane, outsideBase);
  const codexLauncherTarball = allowRealAgent ? absoluteArg('--codex-launcher-tarball') : undefined;
  const codexPackageTarball = allowRealAgent ? absoluteArg('--codex-package-tarball') : undefined;
  const credentialProfile = allowRealAgent ? credentialProfileArg() : undefined;
  const codexAuthFile = allowRealAgent ? absoluteArg('--codex-auth-file') : undefined;
  const codexConfigFile = allowRealAgent && credentialProfile === 'auth_plus_config' ? absoluteArg('--codex-config-file') : undefined;
  const evidenceOutput = await prepareEvidenceOutput(output);
  let runtime: VerifiedCodexRuntime | null = null;
  try {
    const timeoutArg = Bun.argv.find((value) => value.startsWith('--soak-timeout-ms='));
    const timeoutMs = Number(timeoutArg?.slice('--soak-timeout-ms='.length) ?? 10 * 60_000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) throw new Error('soak timeout must be an integer from 1000 to 600000 ms');
    const head = run(['git', 'rev-parse', 'HEAD'], plane); const dirty = run(['git', 'status', '--short', '--untracked-files=all'], plane);
    if (head !== TARGET_COMMIT) throw new Error(`Plane target provenance mismatch: expected ${TARGET_COMMIT}, got ${head}`);
    if (dirty) throw new Error('Plane checkout is not clean; refusing to qualify runtime behavior from mutable source');
    if (run(['git', 'rev-parse', `${TARGET_COMMIT}^`], plane) !== TARGET_PARENT_COMMIT) {
      throw new Error('Plane target/parent provenance mismatch');
    }
    await verifyArtifact(plane);
    runtime = allowRealAgent
      ? await prepareVerifiedCodexRuntime(plane, codexLauncherTarball!, codexPackageTarball!, credentialProfile!, codexAuthFile!, codexConfigFile)
      : null;
    const soak = allowRealAgent ? await realSoak(plane, outsideBase!, timeoutMs, 15_000, runtime!.bin) : null;
    if (run(['git', 'status', '--short', '--untracked-files=all'], plane)) throw new Error('Plane source changed during qualification');
    const reconciliation = {
      schemaVersion: 'agentbootup.mech-plane-runtime-successor-reconcile.v6',
      source: {
        targetCommit: TARGET_COMMIT,
        parentCommit: TARGET_PARENT_COMMIT,
        clean: true,
      },
      artifact: { identity: RUN_IDENTITY, integrity: RUN_INTEGRITY, registryVerified: true },
      execution: runtime?.execution ?? null,
      // These are CLAIMS read from Plane-authored evidence, not observations of this run.
      // Emitting them as bare `true` alongside runtime results read as independently
      // verified when nothing here verified them (roborev). Provenance is now explicit.
      reviewedPlaneEvidence: {
        source: 'plane-authored evidence review; NOT verified by this run',
        verifiedByThisRun: false,
        matrix: 'codex/local/plane-bound-live',
        claimed: { bindingDigest: true, finiteExpiry: true, atomicDenyReplay: true, disconnectCancellation: true },
        planeRemoteLocalMode: false, serverRouteMounted: false,
      },
      independentRuntime: soak ? { executed: true, ...soak } : { executed: false, reason: 'explicit --allow-real-agent was not supplied' },
      ...(() => { const e = evaluateProofs(soak ? { executed: true, ...soak } : { executed: false });
                  return { requiredProofsSatisfied: e.satisfied, verdict: e.verdict, blockers: e.blockers }; })(),
      scope: { agentbootupConnector: false, publicRoute: false, relayFrames: false, planeCodeChanged: false },
    };
    const result = reconciliation.verdict === 'GO'
      ? buildApprovalReceipt(soak)
      : reconciliation;
    await writeNewEvidence(evidenceOutput, result);
    console.log(JSON.stringify({ verdict: result.verdict, realAgentExecuted: Boolean(soak) }));
  } finally {
    await runtime?.cleanup();
    await evidenceOutput.parent.close();
  }
}

if (import.meta.main) await main();
