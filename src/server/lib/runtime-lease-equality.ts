import type { AgentHostRuntimeSpec } from '../types';

export function sameStringObject(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export function sameRuntimeSpec(a: AgentHostRuntimeSpec, b: AgentHostRuntimeSpec): boolean {
  return a.kind === b.kind &&
    a.agentId === b.agentId &&
    a.bundleRef === b.bundleRef &&
    a.image === b.image &&
    a.port === b.port &&
    a.ingressKeyRef === b.ingressKeyRef &&
    a.healthCheck.path === b.healthCheck.path &&
    a.healthCheck.intervalSeconds === b.healthCheck.intervalSeconds &&
    a.healthCheck.timeoutSeconds === b.healthCheck.timeoutSeconds &&
    a.resources.cpu === b.resources.cpu &&
    a.resources.memoryMb === b.resources.memoryMb &&
    sameStringObject(a.placementPolicy, b.placementPolicy);
}
