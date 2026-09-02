import fs from 'fs';
import path from 'path';
import { normalizeProjectPathForTranscripts } from './discovery.js';
import { hashTranscriptFile } from './state.js';

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export class FileBackedMechStorageClient {
  constructor(options = {}) {
    this.cloudRoot = options.cloudRoot;
    this.stateRoot = options.stateRoot;
  }

  listTranscripts({ agentId, hoursBack = 24 }) {
    const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
    const out = [];
    const seen = new Map();
    const agentRoot = path.join(this.cloudRoot, agentId);
    for (const cli of safeReadDir(agentRoot)) {
      const cliDir = path.join(agentRoot, cli);
      collectTranscriptFiles(out, cliDir, cli, cutoff, seen, 'flat');
      for (const legacyDir of safeChildDirs(cliDir)) {
        collectTranscriptFiles(out, legacyDir, cli, cutoff, seen, path.basename(legacyDir));
      }
    }
    return out;
  }

  loadProcessedSessions(agentId, projectPath) {
    const key = `${agentId}-${normalizeProjectPathForTranscripts(projectPath)}.json`;
    const filepath = path.join(this.stateRoot, key);
    if (!fs.existsSync(filepath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      return parsed.processedSessions || [];
    } catch {
      return [];
    }
  }

  saveProcessedSessions(agentId, projectPath, processedSessions, stats) {
    fs.mkdirSync(this.stateRoot, { recursive: true });
    const key = `${agentId}-${normalizeProjectPathForTranscripts(projectPath)}.json`;
    const filepath = path.join(this.stateRoot, key);
    fs.writeFileSync(filepath, JSON.stringify({ processedSessions, stats, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  }
}

function safeChildDirs(dir) {
  const out = [];
  for (const entry of safeReadDir(dir)) {
    const full = path.join(dir, entry);
    try {
      if (fs.statSync(full).isDirectory()) out.push(full);
    } catch {
      continue;
    }
  }
  return out;
}

function isTranscriptFile(file) {
  return /\.(jsonl|json|txt)$/i.test(file) && !file.endsWith('.meta.json');
}

function collectTranscriptFiles(out, dir, cli, cutoff, seen, sourceScope) {
  for (const file of safeReadDir(dir)) {
    if (!isTranscriptFile(file)) continue;
    const full = path.join(dir, file);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtime.getTime() < cutoff) continue;
    const sessionId = file.replace(/\.(jsonl|json|txt)$/i, '');
    const contentHash = hashTranscriptFile(full);
    const dedupeKey = `${cli}/${sessionId}`;
    const seenHashes = seen.get(dedupeKey) || new Set();
    if (seenHashes.has(contentHash)) continue;
    seenHashes.add(contentHash);
    seen.set(dedupeKey, seenHashes);
    out.push({
      path: full,
      sessionId,
      cli,
      sourceKey: `${cli}/${sourceScope}/${sessionId}/${contentHash}`,
      mtime: st.mtime.toISOString(),
    });
  }
}
