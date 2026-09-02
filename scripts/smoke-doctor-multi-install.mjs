#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-multi-install-smoke-'));
const shimBin = path.join(tempRoot, 'shim-bin');
const pathInstall = path.join(tempRoot, 'path-install');
const foreignInstall = path.join(tempRoot, 'foreign-install');
const projectRoot = path.join(tempRoot, 'projects', 'foreign-brain');
const foreignScript = path.join(foreignInstall, 'lib', 'daemon', 'brain-asset-sync.mjs');
let foreignDaemon;

function seedInstall(root, version) {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'agentbootup', version }));
}

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

async function waitForProcess(pid, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`foreign daemon PID ${pid} never became observable`);
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`foreign daemon PID ${child.pid} did not exit`)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

try {
  fs.mkdirSync(shimBin, { recursive: true });
  seedInstall(pathInstall, '91.0.0-smoke');
  seedInstall(foreignInstall, '92.0.0-smoke');
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(foreignScript, 'setInterval(() => {}, 1000);\n');
  fs.symlinkSync(path.join(pathInstall, 'bootup.mjs'), path.join(pathInstall, 'bin', 'agentbootup'));
  fs.writeFileSync(path.join(pathInstall, 'bootup.mjs'), '#!/usr/bin/env node\n');

  foreignDaemon = spawn(process.execPath, [foreignScript], {
    stdio: 'ignore',
    cwd: projectRoot,
  });
  await waitForProcess(foreignDaemon.pid);

  writeExecutable(path.join(shimBin, 'ps'), `#!/bin/sh
printf '%s %s %s\\n' '${foreignDaemon.pid}' '${process.execPath}' '${foreignScript}'
`);
  writeExecutable(path.join(shimBin, 'lsof'), `#!/bin/sh
printf 'p%s\\nfcwd\\nn%s\\n' '${foreignDaemon.pid}' '${projectRoot}'
`);
  writeExecutable(path.join(shimBin, 'brew'), '#!/bin/sh\nexit 1\n');
  writeExecutable(path.join(shimBin, 'bun'), '#!/bin/sh\nexit 1\n');

  const result = spawnSync(process.execPath, [path.join(repoRoot, 'bootup.mjs'), 'doctor', '--json'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tempRoot,
      PATH: `${shimBin}${path.delimiter}${path.join(pathInstall, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      AGENTBOOTUP_CONFIG_FILE: path.join(tempRoot, 'config.json'),
      AGENTBOOTUP_CREDENTIALS_FILE: path.join(tempRoot, 'credentials.json'),
      AGENTBOOTUP_TRANSCRIPTS_DIR: path.join(tempRoot, 'transcripts'),
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  const payload = JSON.parse(result.stdout);
  const messages = payload.issues.map((issue) => issue.message);
  const versionMessage = messages.find((message) => message.includes('Multiple agentbootup versions detected'));
  const daemonMessage = messages.find((message) => message.includes(`PID ${foreignDaemon.pid}`));
  if (!versionMessage || !versionMessage.includes('91.0.0-smoke') || !versionMessage.includes('PATH')) {
    throw new Error(`doctor did not report the PATH install/version: ${result.stdout}`);
  }
  if (!daemonMessage || !daemonMessage.includes(projectRoot) || !daemonMessage.includes(foreignInstall) || !daemonMessage.includes(`kill ${foreignDaemon.pid}`)) {
    throw new Error(`doctor did not report the foreign daemon contract: ${result.stdout}`);
  }
  console.log(`PASS: doctor identified foreign install ${foreignInstall}, project ${projectRoot}, and kill ${foreignDaemon.pid}`);
} finally {
  if (foreignDaemon && foreignDaemon.exitCode === null) {
    foreignDaemon.kill('SIGTERM');
    await waitForExit(foreignDaemon).catch(() => {});
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
