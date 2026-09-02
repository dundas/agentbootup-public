/**
 * Read the persisted approval-flow field from a mount record, preferring the
 * canonical `approval_flow_mode` key while remaining compatible with older
 * records that stored `approval_flow_mechanism`. Fallback occurs only when the
 * canonical field is `null` or `undefined`.
 *
 * @param {object | undefined} record
 * @returns {string | undefined}
 */
export function getApprovalFlowMode(record) {
  // Intentional: empty string is treated as an explicitly set canonical value,
  // not as "missing". Only null/undefined fall back to the legacy field.
  return (
    record?.environment?.approval_flow_mode ??
    record?.environment?.approval_flow_mechanism
  );
}

/**
 * Normalize mount lifecycle metadata so older copy-only records remain readable
 * while newer watcher-backed records can surface explicit liveness fields.
 *
 * @param {object | undefined} record
 * @returns {{ mountKind: 'copy' | 'watch', live: boolean, lastSyncedAt: string | null, watcherStatus: 'not_applicable' | 'online' | 'offline' }}
 */
export function getMountLifecycle(record) {
  const mountKind = record?.mount_kind === 'watch' ? 'watch' : 'copy';
  const lastSyncedAt =
    typeof record?.last_synced_at === 'string' && record.last_synced_at
      ? record.last_synced_at
      : typeof record?.mounted_at === 'string' && record.mounted_at
        ? record.mounted_at
        : null;
  const live = mountKind === 'watch' ? record?.live === true : false;
  const watcherStatus =
    mountKind === 'watch'
      ? live
        ? 'online'
        : 'offline'
      : 'not_applicable';
  return { mountKind, live, lastSyncedAt, watcherStatus };
}

/**
 * Backfill legacy mount records with the current lifecycle fields for
 * downstream readers while preserving the original payload.
 *
 * @param {object | undefined} record
 * @returns {object}
 */
export function normalizeMountRecord(record) {
  const base = record && typeof record === 'object' ? record : {};
  const lifecycle = getMountLifecycle(base);
  return {
    schema_version:
      typeof base.schema_version === 'string' && base.schema_version
        ? base.schema_version
        : '1.0',
    ...base,
    workspace_path:
      typeof base.workspace_path === 'string' && base.workspace_path
        ? base.workspace_path
        : typeof base.source === 'string' && base.source
          ? base.source
          : null,
    mount_kind: lifecycle.mountKind,
    live: lifecycle.live,
    last_synced_at: lifecycle.lastSyncedAt,
    // watcher_status is always derived from mount_kind + live at read time.
    // Any persisted watcher_status value is overwritten during normalization.
    watcher_status: lifecycle.watcherStatus,
  };
}
