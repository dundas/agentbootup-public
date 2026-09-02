import fs from 'fs';
import path from 'path';
import { resolveProjectPath } from '../config.js';

export function resolveProjectMetadataPath(project, networkRoot = '') {
  if (!project || typeof project?.path !== 'string' || !project.path) return '';
  if (!networkRoot) return project.path;
  try {
    return resolveProjectPath(project.path, networkRoot);
  } catch {
    return project.path;
  }
}

export function snapshotFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { exists: false };
    return { exists: true, content: fs.readFileSync(filePath) };
  } catch {
    return { exists: false };
  }
}

export function restoreFileSnapshot(filePath, snapshot) {
  if (!snapshot || !snapshot.exists) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, snapshot.content);
}
