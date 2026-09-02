import { spawn } from 'node:child_process';
import { attestRuntime, assertSafeBrainId, assertSafeSshTarget } from './runtime.mjs';
import { strictKnownHostsOptions } from './ssh-trust.mjs';

export function remoteAttestArgv(config) {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(config.miniDir) || /[\x00-\x1f\x7f]/.test(config.canonicalRef) || /[\x00-\x1f\x7f]/.test(config.canonicalCommit)) throw new Error('unsafe remote attestation input');
  return ['ssh', '-o', 'ConnectTimeout=10', ...strictKnownHostsOptions(config.knownHosts), '--', assertSafeSshTarget(config.miniSsh), 'agentbootup', 'burn-in', 'remote', 'attest', '--root', config.miniDir, '--brain', assertSafeBrainId(config.brain), '--ref', config.canonicalRef, '--commit', config.canonicalCommit];
}

function run(argv) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish(null); }, 10_000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 8192) child.kill(); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? stdout : null); });
  });
}

/** Both configured runtimes must independently attest before burn-in is ready. */
export async function preflightBurnIn(config) {
  const local = attestRuntime(config.localDir, config);
  if (!local.ready) return { ready: false, code: `local_${local.code}` };
  try {
    const stdout = await run(remoteAttestArgv(config));
    if (!stdout) return { ready: false, code: 'remote_attestation_failed' };
    const remote = JSON.parse(stdout);
    return remote?.ready === true && remote.code === 'ready'
      ? { ready: true, code: 'ready' }
      : { ready: false, code: 'remote_attestation_failed' };
  } catch { return { ready: false, code: 'remote_attestation_failed' }; }
}
