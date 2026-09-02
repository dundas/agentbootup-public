import { attestRuntime as attestSharedRuntime } from './runtime.mjs';
import type { BurnInConfig } from './config';

export type RuntimeAttestation = { ready: boolean; code: string; descriptorHash?: string };

/** Bun daemon wrapper around the exact shipped Node attestation contract. */
export function attestRuntime(root: string, expected: Pick<BurnInConfig, 'brain' | 'canonicalRef' | 'canonicalCommit'>): RuntimeAttestation {
  return attestSharedRuntime(root, expected) as RuntimeAttestation;
}
