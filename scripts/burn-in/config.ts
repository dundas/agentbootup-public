import { loadBurnInConfig as loadSharedBurnInConfig } from './config.mjs';

export interface BurnInConfig {
  brain: string; localDir: string; miniSsh: string; knownHosts: string; miniDir: string; store: string;
  canonicalRef: string; canonicalCommit: string; descriptorStateRoot: string;
  stateRoot: string; ledger: string;
  receipt: { brain: string; store: string; canonical_ref: string; local_root: 'configured'; mini_target: string; remote_root: 'configured'; ledger: 'owned' };
}

/** Bun daemon wrapper around the exact shipped Node configuration contract. */
export function loadBurnInConfig(env: Record<string, string | undefined> = process.env): BurnInConfig {
  return loadSharedBurnInConfig(env) as BurnInConfig;
}
