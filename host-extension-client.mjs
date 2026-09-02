// Stable public package entrypoint for the service-neutral host-extension SDK.
export * from './lib/daemon/host-extension-client.mjs';

/** Start the standard managed daemon with an explicit local extension installer. */
export async function startManagedHostExtensionDaemon(options = {}) {
  const { startManagedBrainAssetSync } = await import('./lib/daemon/brain-asset-sync.mjs');
  return startManagedBrainAssetSync(options);
}
