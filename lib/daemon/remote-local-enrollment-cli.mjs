import { readFile } from 'node:fs/promises';
import { readCredentials, writeRemoteLocalConnectorState } from '../auth/credentials.js';
import { getBrainId } from '../config/config.js';
import { enrollRemoteLocalDevice } from './remote-local-enrollment.mjs';

export async function runRemoteLocalEnrollment(args, io, {
  readFileImpl = readFile, readCredentialsImpl = readCredentials, getBrainIdImpl = getBrainId,
  enrollImpl = enrollRemoteLocalDevice,
} = {}) {
  if (args[0] !== 'enroll' || args.includes('--help') || args.includes('-h')) {
    io.stdout('Usage: agentbootup brain remote-local enroll --runtime-config <local-runtime.json> [--brain <id>]');
    io.stdout('The runtime profile stays on this device; enrollment remains default-off until all rollout gates are authorized.');
    return args[0] === 'enroll' ? 0 : 1;
  }
  let runtimePath = '';
  let requestedBrainId = '';
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const next = args[index + 1];
    if ((flag !== '--runtime-config' && flag !== '--brain') || !next || next.startsWith('-') || (flag === '--runtime-config' ? !!runtimePath : !!requestedBrainId)) {
      io.stderr('remote-local enroll requires exactly --runtime-config <local-runtime.json> and optional --brain <id>');
      return 1;
    }
    if (flag === '--runtime-config') runtimePath = next;
    else requestedBrainId = next;
    index += 1;
  }
  if (!runtimePath) {
    io.stderr('remote-local enroll requires exactly --runtime-config <local-runtime.json> and optional --brain <id>');
    return 1;
  }
  let runtime;
  try { runtime = JSON.parse(await readFileImpl(runtimePath, 'utf8')); } catch { io.stderr('remote-local enroll could not read a valid runtime profile.'); return 1; }
  const brainId = requestedBrainId || await getBrainIdImpl();
  const credentials = await readCredentialsImpl();
  if (!credentials) { io.stderr('remote-local enroll requires local credentials. Run: agentbootup auth login'); return 1; }
  try {
    const result = await enrollImpl({ brainId, runtime, credentials, writeState: writeRemoteLocalConnectorState });
    io.stdout(`Remote-local device enrolled for brain ${result.brainId} as ${result.deviceId}. Restart the managed daemon only after the separate operations gate is enabled.`);
    return 0;
  } catch (error) {
    io.stderr(`remote-local enroll failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  }
}
