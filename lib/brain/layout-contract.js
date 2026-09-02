/**
 * Canonical brain repo layout (PRD-0014).
 * Authored/portable → brain/. Local runtime → .brain/. Human memory → memory/.
 */

import fs from 'fs';
import path from 'path';

const GITIGNORE_MARKER = '# agentbootup: local brain runtime (.brain/)';
const GITIGNORE_LINES = ['.brain/*', '!.brain/.gitkeep'];

/**
 * Ensure PRD layout directories and .gitignore rules exist under project root.
 *
 * @param {string} projectRoot - Absolute path to repository root
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] - Log planned actions only; no writes
 * @param {boolean} [opts.portfolioProtocols=false] - Create brain/protocols/
 * @returns {{ createdDirs: string[], gitignoreUpdated: boolean, dryRun: boolean }}
 */
export function ensureBrainLayout(projectRoot, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const portfolioProtocols = Boolean(opts.portfolioProtocols);
  const root = path.resolve(projectRoot);
  const createdDirs = [];

  const plan = [
    path.join(root, 'brain', 'tools'),
    path.join(root, 'memory', 'daily'),
    path.join(root, '.brain', 'collab', 'sessions'),
    path.join(root, '.brain', 'roundtable', 'checkpoints'),
    path.join(root, '.brain', 'skills', 'state'),
    path.join(root, '.brain', 'skills', 'backups'),
  ];
  if (portfolioProtocols) {
    plan.push(path.join(root, 'brain', 'protocols'));
  }

  for (const dir of plan) {
    if (dryRun) {
      if (!fs.existsSync(dir)) {
        createdDirs.push(path.relative(root, dir));
      }
      continue;
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      createdDirs.push(path.relative(root, dir));
    }
  }

  const gitkeep = path.join(root, '.brain', '.gitkeep');
  if (!dryRun) {
    if (!fs.existsSync(gitkeep)) {
      fs.mkdirSync(path.dirname(gitkeep), { recursive: true });
      fs.writeFileSync(gitkeep, '');
      createdDirs.push(path.relative(root, path.dirname(gitkeep)) + '/.gitkeep');
    }
    const dbPath = path.join(root, '.brain', 'brain.db');
    if (!fs.existsSync(dbPath)) {
      fs.writeFileSync(dbPath, '');
    }
  }

  let gitignoreUpdated = false;
  if (!dryRun) {
    gitignoreUpdated = mergeBrainGitignore(root);
  }

  return { createdDirs, gitignoreUpdated, dryRun };
}

/**
 * Append .brain ignore rules to .gitignore if missing.
 * @param {string} projectRoot
 * @returns {boolean} true if file was created or updated
 */
export function mergeBrainGitignore(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let body = '';
  if (fs.existsSync(gitignorePath)) {
    body = fs.readFileSync(gitignorePath, 'utf-8');
  }
  const lines = new Set(body.split(/\r?\n/));
  if (lines.has('.brain/*') && lines.has('!.brain/.gitkeep')) {
    return false;
  }

  const block = [];
  if (!body.endsWith('\n') && body.length > 0) block.push('');
  if (!body.includes(GITIGNORE_MARKER)) block.push(GITIGNORE_MARKER);
  for (const line of GITIGNORE_LINES) {
    if (!lines.has(line)) block.push(line);
  }
  const append = block.join('\n') + '\n';
  fs.appendFileSync(gitignorePath, append, 'utf-8');
  return true;
}
