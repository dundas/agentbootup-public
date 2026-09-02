import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

function assertPrivateParentChain(value) {
  let cursor = path.parse(value).root;
  const parts = value.slice(cursor.length).split(path.sep);
  // The final component is the known-hosts file. Validate every lexical
  // directory component first so a `link/../known_hosts` alias cannot bypass
  // the trust boundary through path normalization.
  for (const part of parts.slice(0, -1)) {
    if (!part || part === '.') continue;
    if (part === '..') { cursor = path.dirname(cursor); continue; }
    cursor = path.join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); } catch { throw new Error('AGENTBOOTUP_BURNIN_KNOWN_HOSTS parent must exist'); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('AGENTBOOTUP_BURNIN_KNOWN_HOSTS must not traverse a symlinked parent directory');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid() && stat.uid !== 0) throw new Error('AGENTBOOTUP_BURNIN_KNOWN_HOSTS parent directories must be owned by this user or root');
    const rootOwnedStickyDirectory = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    // A root-owned sticky directory such as /tmp permits a user to create a
    // private child but prevents other users from replacing that child. Other
    // shared parents can rename the trust file or one of its ancestors.
    if ((stat.mode & 0o022) !== 0 && !rootOwnedStickyDirectory) throw new Error('AGENTBOOTUP_BURNIN_KNOWN_HOSTS parent directories must not be group- or world-writable unless root-owned sticky');
  }
}

/**
 * Burn-in talks to a configured peer, not an opportunistic SSH destination.
 * Require a pre-provisioned, private known-hosts file so SSH never learns or
 * rewrites trust during a production evidence run.
 */
export function assertTrustedKnownHosts(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('AGENTBOOTUP_BURNIN_KNOWN_HOSTS must be an absolute path');
  }
  assertPrivateParentChain(value);
  let stat;
  try { stat = lstatSync(value); } catch { throw new Error('AGENTBOOTUP_BURNIN_KNOWN_HOSTS must exist'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('AGENTBOOTUP_BURNIN_KNOWN_HOSTS must be a real regular file, not a symlink');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('AGENTBOOTUP_BURNIN_KNOWN_HOSTS must be owned by this user');
  if ((stat.mode & 0o022) !== 0) throw new Error('AGENTBOOTUP_BURNIN_KNOWN_HOSTS must not be group- or world-writable');
  const trusted = realpathSync(value);
  // Re-check the canonical chain after resolving the file. This is redundant
  // for an honest filesystem, but makes a parent swap or alias race fail
  // closed before SSH receives the trust-file path.
  assertPrivateParentChain(trusted);
  let canonicalStat;
  try { canonicalStat = lstatSync(trusted); } catch { throw new Error('AGENTBOOTUP_BURNIN_KNOWN_HOSTS must exist'); }
  if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && canonicalStat.uid !== process.getuid()) ||
      (canonicalStat.mode & 0o022) !== 0) {
    throw new Error('AGENTBOOTUP_BURNIN_KNOWN_HOSTS trust file changed during validation');
  }
  return trusted;
}

/** Fixed SSH options: no prompts, no TOFU, no use or mutation of global trust. */
export function strictKnownHostsOptions(knownHosts) {
  const trusted = assertTrustedKnownHosts(knownHosts);
  return ['-o', 'BatchMode=yes', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `UserKnownHostsFile=${trusted}`, '-o', 'StrictHostKeyChecking=yes'];
}
