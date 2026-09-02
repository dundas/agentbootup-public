import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';

export function getTranscriptStatePath(cwd = process.cwd()) {
  return path.join(cwd, '.transcript-sync-state.json');
}

export function loadTranscriptState(cwd = process.cwd()) {
  const statePath = getTranscriptStatePath(cwd);
  if (!fs.existsSync(statePath)) {
    return { active: {}, completed: [], hashes: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return { active: {}, completed: [], hashes: {} };
  }
}

export function saveTranscriptState(state, cwd = process.cwd()) {
  fs.writeFileSync(getTranscriptStatePath(cwd), JSON.stringify(state, null, 2) + '\n');
}

export function hashTranscriptFile(filepath) {
  const data = fs.readFileSync(filepath);
  return createHash('sha256').update(data).digest('hex');
}
