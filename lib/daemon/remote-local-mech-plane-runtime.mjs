/**
 * Protected Mech Plane extension for the local daemon. It discovers only
 * existing Codex sessions, resumes only the private ID selected by the local
 * registry, and keeps native approval resolution bound to that same call.
 */
import { randomUUID } from 'node:crypto';
// This pre-release contract is intentionally pinned to its exact published
// version in package.json and bun.lock: changing its digest semantics requires
// a separate approval-protocol qualification.
import { scanNativeSessions } from '@mech/run/transcripts';
import { createCodexExistingSessionContinuation } from '@mech/plane/interactive/mech-run-existing-session-bridge';
import { createRemoteLocalConnectorHandlerComposition } from './remote-local-connector-handler.mjs';
import { createHostExtensionClient } from './host-extension-client.mjs';
import { isValidRemoteLocalRuntime } from './remote-local-runtime-config.mjs';

function workspaceProjectId(workspace) { return workspace.replace(/^[/\\]+/, '').replace(/[/\\]/g, '__'); }

function createContinuation(runtime, { spawnStreamImpl, randomUUIDImpl }) {
  return (nativeSessionId) => createCodexExistingSessionContinuation({
    nativeSessionId, cwd: runtime.daemon.runtime.workspace, provider: 'codex', spawnStream: spawnStreamImpl,
    authorityTuple: () => Object.freeze({ ...runtime.planeAuthority, runGeneration: `rgen_${randomUUIDImpl().replaceAll('-', '')}` }),
  });
}

/** Construct the daemon's full local execution composition from sealed v2 state. */
export function createRemoteLocalMechPlaneRuntime(runtime, {
  scanNativeSessionsImpl = scanNativeSessions,
  spawnStreamImpl,
  randomUUIDImpl = randomUUID,
  now = Date.now,
  installHostExtensions,
} = {}) {
  if (!isValidRemoteLocalRuntime(runtime)) throw new Error('remote-local Mech Plane runtime configuration is invalid');
  if (installHostExtensions !== undefined && typeof installHostExtensions !== 'function') {
    throw new Error('remote-local host-extension installer must be a function');
  }
  const continuationFor = createContinuation(runtime, { spawnStreamImpl, randomUUIDImpl });
  const composition = createRemoteLocalConnectorHandlerComposition({
    daemon: runtime.daemon,
    authorityScope: runtime.authorityScope,
    listExistingSessions: async () => (await scanNativeSessionsImpl(['codex'])).flatMap((session) => (
      session?.projectId === workspaceProjectId(runtime.daemon.runtime.workspace)
        && Number.isFinite(session?.mtimeMs) && now() - session.mtimeMs >= -runtime.daemon.runtime.sessionClockSkewToleranceMs
        && now() - session.mtimeMs <= runtime.daemon.runtime.sessionDiscoveryMaxAgeMs
        && typeof session?.sessionId === 'string' && session.sessionId.length > 0 && session.sessionId.length <= 512 ? [{
      nativeSessionId: session.sessionId, runtimeClass: 'codex_cli', availability: 'online', activity: 'unknown',
      }] : []
    )),
    continueExisting: ({ nativeSessionId, ...input }) => continuationFor(nativeSessionId)(input),
    mintSystemResolutionId: () => `sys_${randomUUIDImpl().replaceAll('-', '')}`,
  });
  const hostExtensions = createHostExtensionClient({ relay: composition.hostExtensionHandler });
  if (!installHostExtensions) return Object.freeze({ ...composition, hostExtensions });

  // The daemon owner supplies this installer as a local composition dependency,
  // never from connector state or a relay frame. It receives only the public
  // registration client. In particular, it cannot inspect or operate Plane
  // sessions, approval authority, or the connector transport. Re-run it for
  // every fresh admission because the relay deliberately forgets registrations
  // when its fence changes.
  const baseHandler = composition.handler;
  const handler = Object.freeze({
    async admitted(...args) {
      const accepted = await baseHandler.admitted(...args);
      if (!accepted) return false;
      try { await installHostExtensions(hostExtensions); } catch { /* extension failure cannot widen or stop the fixed runtime */ }
      return true;
    },
    receive: (...args) => baseHandler.receive(...args),
    disconnect: (...args) => baseHandler.disconnect(...args),
    idle: (...args) => baseHandler.idle(...args),
    activeCount: () => baseHandler.activeCount(),
  });
  return Object.freeze({ ...composition, handler, hostExtensions });
}
