/**
 * Claude Code settings.json hook policy for environment mounts (Phase 3).
 */

/**
 * @param {unknown} v hook value (object-form hooks map)
 */
function objectHookDescriptorMentionsPermissionRequest(v) {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v)) {
    return v.some((el) => objectHookDescriptorMentionsPermissionRequest(el));
  }
  const o = /** @type {Record<string, unknown>} */ (v);
  for (const k of ['event', 'name', 'type']) {
    const s = o[k];
    if (typeof s === 'string' && /permissionrequest/i.test(s)) return true;
  }
  return false;
}

/**
 * Remove hooks whose event/name indicates PermissionRequest (mech-plane path).
 * @param {unknown} settings parsed settings.json
 * @returns {object} deep-cloned modified settings
 */
export function stripPermissionRequestHooks(settings) {
  const out =
    settings && typeof settings === 'object'
      ? JSON.parse(JSON.stringify(settings))
      : { hooks: {} };

  if (Array.isArray(out.hooks)) {
    out.hooks = out.hooks.filter((h) => {
      if (!h || typeof h !== 'object') return true;
      const ev = /** @type {Record<string, unknown>} */ (h).event;
      const name = /** @type {Record<string, unknown>} */ (h).name;
      const type = /** @type {Record<string, unknown>} */ (h).type;
      const s = String(ev ?? name ?? type ?? '');
      if (/permissionrequest/i.test(s)) return false;
      return true;
    });
    return out;
  }

  if (out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks)) {
    const h = /** @type {Record<string, unknown>} */ (out.hooks);
    for (const key of Object.keys(h)) {
      const v = h[key];
      if (/permissionrequest/i.test(key) || objectHookDescriptorMentionsPermissionRequest(v)) {
        delete h[key];
      }
    }
  }

  return out;
}
