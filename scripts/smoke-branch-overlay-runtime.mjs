#!/usr/bin/env node

import { createServer } from 'http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path, { dirname, join } from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { writeCredentials } from '../lib/auth/credentials.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const bootupPath = join(repoRoot, 'bootup.mjs');
const observerPath = join(repoRoot, 'scripts', 'branch-write-observer.cjs');

const BRAIN_ID = 'brain-smoke';
const BRANCH_ID = 'tenant-acme';
const BUNDLE_VERSION = 'bundle-smoke-v1';
const BASE_IMAGE_SHA = 'sha256:smoke-overlay-v1';
const API_KEY = 'smoke-api-key';

function fail(message) {
  throw new Error(`[smoke-branch-overlay] FAIL: ${message}`);
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
}

function runNodeAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        status: code,
        stdout,
        stderr,
      });
    });
  });
}

async function readObservedWrites(logPath, rwRoot) {
  const raw = await fsp.readFile(logPath, 'utf8').catch(() => '');
  const writes = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      fail(`write observer emitted invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!event?.path || event.path === logPath) continue;
    const rel = path.relative(rwRoot, event.path);
    const allowed = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    writes.push({ op: event.op, path: event.path, allowed });
  }
  return writes;
}

async function writeCredentialsToFile(credsFile, creds) {
  const previous = process.env.AGENTBOOTUP_CREDS_FILE;
  process.env.AGENTBOOTUP_CREDS_FILE = credsFile;
  try {
    await writeCredentials(creds);
  } finally {
    if (typeof previous === 'string') {
      process.env.AGENTBOOTUP_CREDS_FILE = previous;
    } else {
      delete process.env.AGENTBOOTUP_CREDS_FILE;
    }
  }
}

async function makeReadOnlyTree(targetPath) {
  const entries = await fsp.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(targetPath, entry.name); // nosemgrep: path-join-resolve-traversal -- entry.name comes from fs.readdir on the temporary smoke tree created within this script
    if (entry.isDirectory()) {
      await makeReadOnlyTree(childPath);
      await fsp.chmod(childPath, 0o555);
    } else {
      await fsp.chmod(childPath, 0o444);
    }
  }
  await fsp.chmod(targetPath, 0o555);
}

async function restoreWritableTree(targetPath) {
  const entries = await fsp.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(targetPath, entry.name); // nosemgrep: path-join-resolve-traversal -- entry.name comes from fs.readdir on the temporary smoke tree created within this script
    if (entry.isDirectory()) {
      await restoreWritableTree(childPath);
      await fsp.chmod(childPath, 0o755);
    } else {
      await fsp.chmod(childPath, 0o644);
    }
  }
  await fsp.chmod(targetPath, 0o755);
}

async function startRegistryServer() {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
      return;
    }

    if (req.method === 'GET' && req.url === `/v1/brains/${BRAIN_ID}/branches/${BRANCH_ID}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          brain_id: BRAIN_ID,
          branch_id: BRANCH_ID,
          tenant_ref: 'acme',
          status: 'active',
          base_image_sha: BASE_IMAGE_SHA,
          bundle_version: BUNDLE_VERSION,
        },
      }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine registry server address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function main() {
  const tmpRoot = mkdtempSync(join(os.tmpdir(), 'agentbootup-branch-overlay-smoke-'));
  const roRoot = join(tmpRoot, 'opt', 'brain');
  const rwRoot = join(tmpRoot, 'brain');
  const brainDbPath = join(rwRoot, 'brain.db');
  const credsFile = join(tmpRoot, 'credentials');
  // Credentials are encrypted at rest against the machine identity, so writing them
  // here would otherwise read (and create) the operator's real ~/.agentbootup/machine-id.
  // Bind the smoke run to a throwaway identity under tmpRoot instead.
  if (!process.env.AGENTBOOTUP_MACHINE_ID_FILE) {
    process.env.AGENTBOOTUP_MACHINE_ID_FILE = join(tmpRoot, 'machine-id');
  }
  const doctorEnv = {
    ...process.env,
    AGENTBOOTUP_CREDS_FILE: credsFile,
    BRAIN_ID,
    BRANCH_ID,
    BRAIN_VOLUME: 'vol-smoke',
    BRAIN_SHARED: roRoot,
    BRAIN_BUNDLE_VERSION: BUNDLE_VERSION,
    BRAIN_BASE_IMAGE_SHA: BASE_IMAGE_SHA,
    BRAIN_DB_PATH: brainDbPath,
    VAULT_NAMESPACE: 'vault/smoke',
  };

  let registry = null;
  try {
    if (process.getuid?.() === 0) {
      console.log('[smoke-branch-overlay] SKIP — running as root; chmod-based RO enforcement is not meaningful.');
      return;
    }

    mkdirSync(join(roRoot, 'skills'), { recursive: true });
    mkdirSync(join(roRoot, 'scripts'), { recursive: true });
    mkdirSync(join(roRoot, 'protocols'), { recursive: true });
    mkdirSync(join(roRoot, 'bin'), { recursive: true });
    mkdirSync(join(rwRoot, 'memory'), { recursive: true });
    mkdirSync(join(rwRoot, 'transcripts'), { recursive: true });
    mkdirSync(join(rwRoot, 'sessions'), { recursive: true });
    mkdirSync(join(rwRoot, 'state'), { recursive: true });
    mkdirSync(join(rwRoot, 'cache'), { recursive: true });

    writeFileSync(brainDbPath, '', 'utf8');
    writeFileSync(
      join(rwRoot, '.env'),
      [
        `BRAIN_ID=${BRAIN_ID}`,
        `BRANCH_ID=${BRANCH_ID}`,
        'BRAIN_VOLUME=vol-smoke',
        `BRAIN_SHARED=${roRoot}`,
        `BRAIN_BUNDLE_VERSION=${BUNDLE_VERSION}`,
        `BRAIN_BASE_IMAGE_SHA=${BASE_IMAGE_SHA}`,
        `BRAIN_DB_PATH=${brainDbPath}`,
        'VAULT_NAMESPACE=vault/smoke',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(rwRoot, 'manifest.json'),
      JSON.stringify({
        brain_id: BRAIN_ID,
        branch_id: BRANCH_ID,
        bundle_version: BUNDLE_VERSION,
        base_image_sha: BASE_IMAGE_SHA,
        brain_db_path: brainDbPath,
        rw_root: rwRoot,
        generated_at: new Date().toISOString(),
      }, null, 2),
      'utf8',
    );

    const allowedScript = join(roRoot, 'scripts', 'allowed-write.cjs');
    const disallowedScript = join(roRoot, 'scripts', 'disallowed-write.cjs');
    writeFileSync(
      allowedScript,
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const rwRoot = path.dirname(process.env.BRAIN_DB_PATH);",
        "const target = path.join(rwRoot, 'sessions', 'allowed-write.txt');",
        "fs.writeFileSync(target, 'ok\\n', 'utf8');",
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      disallowedScript,
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const target = path.join(process.env.BRAIN_SHARED, 'scripts', 'should-not-write.txt');",
        "fs.writeFileSync(target, 'bad\\n', 'utf8');",
      ].join('\n'),
      'utf8',
    );
    await makeReadOnlyTree(roRoot);

    registry = await startRegistryServer();
    await writeCredentialsToFile(credsFile, { apiKey: API_KEY, serverUrl: registry.baseUrl });

    const doctor = await runNodeAsync(
      [bootupPath, 'brain', 'doctor', '--branch-mode', '--brain', BRAIN_ID, '--branch', BRANCH_ID, '--json'],
      { env: doctorEnv },
    );
    if (doctor.status !== 0) {
      fail(`doctor exited ${doctor.status}: ${(doctor.stderr || doctor.stdout).trim()}`);
    }

    let doctorOutput;
    try {
      doctorOutput = JSON.parse(doctor.stdout.trim());
    } catch (err) {
      fail(`doctor output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(doctorOutput.issues) || doctorOutput.issues.length > 0) {
      fail(`doctor reported issues: ${JSON.stringify(doctorOutput.issues ?? doctorOutput)}`);
    }

    const allowedLog = join(tmpRoot, 'allowed-write.jsonl');
    const allowed = runNode(['-r', observerPath, allowedScript], {
      cwd: tmpRoot,
      env: {
        ...doctorEnv,
        AGENTBOOTUP_BRANCH_WRITE_LOG: allowedLog,
      },
    });
    if (allowed.error) fail(`allowed runtime failed to execute: ${allowed.error.message}`);
    if (allowed.status !== 0) {
      fail(`allowed runtime exited ${allowed.status}: ${(allowed.stderr || allowed.stdout).trim()}`);
    }
    const allowedWrites = await readObservedWrites(allowedLog, rwRoot);
    if (allowedWrites.length === 0) {
      fail('allowed runtime produced no observed writes');
    }
    if (allowedWrites.some((entry) => !entry.allowed)) {
      fail(`allowed runtime escaped the RW root: ${JSON.stringify(allowedWrites)}`);
    }

    const disallowedLog = join(tmpRoot, 'disallowed-write.jsonl');
    const disallowed = runNode(['-r', observerPath, disallowedScript], {
      cwd: tmpRoot,
      env: {
        ...doctorEnv,
        AGENTBOOTUP_BRANCH_WRITE_LOG: disallowedLog,
      },
    });
    if (disallowed.error) fail(`disallowed runtime failed to execute: ${disallowed.error.message}`);
    if (disallowed.status === 0) {
      fail('disallowed runtime unexpectedly succeeded writing into the RO tree');
    }
    const disallowedWrites = await readObservedWrites(disallowedLog, rwRoot);
    // The observer records attempted writes before the underlying fs call, so
    // the RO-tree write still appears here even when the OS rejects it.
    if (!disallowedWrites.some((entry) => !entry.allowed)) {
      fail(`disallowed runtime did not produce an RO-root write: ${JSON.stringify(disallowedWrites)}`);
    }

    console.log('[smoke-branch-overlay] PASS — branch-mode doctor validated a real temp overlay against a live registry stub, allowed writes stayed in /brain, and an attempted RO-tree write both failed and was detected outside the RW root.');
  } finally {
    try {
      await restoreWritableTree(roRoot).catch(() => {});
      registry?.server.closeAllConnections?.();
      await new Promise((resolve, reject) => {
        if (!registry?.server) {
          resolve();
          return;
        }
        registry.server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch {
      // best-effort shutdown
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
