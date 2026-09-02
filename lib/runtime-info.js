import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function isGitCheckoutRoot(rootPath) {
  const gitEntry = path.join(rootPath, '.git');
  if (!fs.existsSync(gitEntry)) {
    return false;
  }
  const gitStat = fs.statSync(gitEntry);
  if (gitStat.isDirectory()) {
    return fs.existsSync(path.join(gitEntry, 'HEAD'));
  }
  if (!gitStat.isFile()) {
    return false;
  }
  try {
    const gitFile = fs.readFileSync(gitEntry, 'utf8').trim();
    if (!gitFile.startsWith('gitdir:')) {
      return false;
    }
    const gitDir = gitFile.slice('gitdir:'.length).trim();
    if (!gitDir) {
      return false;
    }
    const resolvedGitDir = path.resolve(path.dirname(gitEntry), gitDir);
    return fs.existsSync(path.join(resolvedGitDir, 'HEAD'));
  } catch {
    return false;
  }
}

export function classifyRuntimeRoot(runtimeRoot) {
  const resolvedRoot = path.resolve(runtimeRoot);
  if (isGitCheckoutRoot(resolvedRoot)) {
    return 'local-checkout';
  }
  if (resolvedRoot.split(path.sep).includes('node_modules')) {
    return 'global-install';
  }
  return 'copied-bootstrap-checkout';
}

export function getCurrentRuntimeInfo(importMetaUrl) {
  const root = path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..');
  return {
    root,
    source: classifyRuntimeRoot(root),
  };
}

export function formatHandoffSupportMessage(runtimeInfo, options = {}) {
  const label = options.includePath ? `${runtimeInfo.source} (${runtimeInfo.root})` : runtimeInfo.source;
  return (
    `This ${label} runtime supports auth export/auth import. ` +
    'If another source host is older and lacks those commands, rerun the handoff from a current agentbootup release or current source checkout on that host first.'
  );
}
