#!/usr/bin/env node
/**
 * Bun (and some npm layouts) only install the libsql native prebuild for the
 * install-time CPU. Node can run under a different arch on macOS (e.g. x64
 * Rosetta vs arm64 Bun), which then requires('@libsql/darwin-x64') and fails.
 *
 * On darwin, ensure both darwin-arm64 and darwin-x64 are present at the same
 * version as libsql's optionalDependencies.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readLibsqlOptional() {
  try {
    const p = join(root, 'node_modules', 'libsql', 'package.json');
    if (!existsSync(p)) return null;
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    return pkg.optionalDependencies ?? null;
  } catch (e) {
    console.warn('[postinstall-libsql] Unable to read libsql optionalDependencies:', e?.message ?? e);
    return null;
  }
}

function hasNative(pkgName) {
  const short = pkgName.replace('@libsql/', '');
  return existsSync(join(root, 'node_modules', '@libsql', short, 'package.json'));
}

function npmInstall(pkg, version) {
  const spec = `${pkg}@${version}`;
  execFileSync('npm', ['install', spec, '--no-save', '--package-lock=false', '--prefix', root, '--no-audit', '--no-fund'], {
    stdio: 'inherit',
    timeout: 60_000,
  });
}

const optional = readLibsqlOptional();
if (!optional) {
  process.exit(0);
}

if (process.platform === 'darwin') {
  for (const name of ['@libsql/darwin-arm64', '@libsql/darwin-x64']) {
    const ver = optional[name];
    if (!ver) continue;
    if (hasNative(name)) continue;
    console.warn(`[postinstall-libsql] Installing missing ${name}@${ver} for cross-arch Node/libsql…`);
    try {
      npmInstall(name, ver);
    } catch (e) {
      console.warn(`[postinstall-libsql] npm install ${name} failed:`, e?.message ?? e);
      process.exitCode = 0;
    }
  }
}
