// Package version, exported for reuse by clients that must identify themselves
// to the server (e.g. the demotion-floor handshake in PRD-0054 PR-5 / B-8).
//
// Resolution order:
//   1. AGENTBOOTUP_VERSION_OVERRIDE env (for unusual install layouts: bundled,
//      relocated, or containerized where package.json is not adjacent).
//   2. package.json `version` adjacent to this module (normal npm/bun install).
//   3. null — a loud console.warn fires once; callers that need the version
//      (brainAssetPushHeaders) OMIT the x-agentbootup-version header rather
//      than sending a fabricated value. The server's demotion floor treats a
//      missing header as below-floor ONLY for raw memory/** pushes to opted-in
//      brains, so a broken version read never blocks non-memory pushes or
//      pushes to non-demoted brains. The operator fixes it by setting the
//      override or repairing the install. We never silently report 0.0.0
//      (that would make a current client look below-floor — roborev 14641).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let cached;

function readVersion() {
  if (cached !== undefined) return cached;

  const override = (process.env.AGENTBOOTUP_VERSION_OVERRIDE || '').trim();
  if (override) {
    cached = override;
    return cached;
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    const v = String(pkg.version || '').trim();
    if (v) {
      cached = v;
      return cached;
    }
  } catch {
    // fall through to the unresolved path
  }

  console.warn(
    '[agentbootup] could not determine package version from package.json; ' +
      'set AGENTBOOTUP_VERSION_OVERRIDE to the installed version. ' +
      "Brain-asset pushes will omit x-agentbootup-version (safe unless raw-pushing memory/** to a demotion-opted-in brain)."
  );
  cached = null;
  return cached;
}

export const AGENTBOOTUP_VERSION = readVersion();
