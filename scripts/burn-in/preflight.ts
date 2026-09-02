import type { BurnInConfig } from './config';
import { appendTerminalFailure } from './ledger';
import { attestRuntime, type RuntimeAttestation } from './attestation';
import { $ } from 'bun';
import { assertSafeBrainId, assertSafeSshTarget } from './health';
import { strictKnownHostsOptions } from './ssh-trust.mjs';

export function remoteAttestArgv(config: BurnInConfig): string[] {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(config.miniDir) || /[\x00-\x1f\x7f]/.test(config.canonicalRef) || /[\x00-\x1f\x7f]/.test(config.canonicalCommit)) throw new Error('unsafe remote attestation input');
  return ['ssh', '-o', 'ConnectTimeout=10', ...strictKnownHostsOptions(config.knownHosts), '--', assertSafeSshTarget(config.miniSsh), 'agentbootup', 'burn-in', 'remote', 'attest', '--root', config.miniDir, '--brain', assertSafeBrainId(config.brain), '--ref', config.canonicalRef, '--commit', config.canonicalCommit];
}

/** Validate the remote root before services start. The false path deliberately
 * writes only a fixed, sanitized reset classification and starts no probes. */
export async function preflightBurnInRemote(
  config: BurnInConfig,
  validate: (target: string, root: string) => Promise<boolean>,
): Promise<boolean> {
  if (await validate(config.miniSsh, config.miniDir)) return true;
  appendTerminalFailure(config.ledger, 0, 'remote_preflight_failed');
  return false;
}

/** Remote work is only the installed fixed helper protocol. There is no remote
 * shell source: every value is a separately validated argv element. */
export async function preflightBurnIn(config: BurnInConfig): Promise<boolean> {
  const local = attestRuntime(config.localDir, config);
  if (!local.ready) { appendTerminalFailure(config.ledger, 0, 'runtime_attestation_failed'); return false; }
  try {
    const proc = Bun.spawn({ cmd: remoteAttestArgv(config), stdout: 'pipe', stderr: 'pipe' });
    const timeout = setTimeout(() => { try { proc.kill(); } catch {} }, 10_000);
    try {
      const text = await new Response(proc.stdout).text();
      if (await proc.exited !== 0) throw new Error('remote');
      const remote = JSON.parse(text) as RuntimeAttestation;
      if (!remote?.ready || remote.code !== 'ready') throw new Error('unready');
      return true;
    } finally { clearTimeout(timeout); }
  } catch {
    appendTerminalFailure(config.ledger, 0, 'runtime_attestation_failed');
    return false;
  }
}
