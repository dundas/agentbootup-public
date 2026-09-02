// Committed presence manifest for canonical memory (PRD-0051).
//
// brain-map.json lives at the REPO ROOT (outside the gitignored memory/) and is committed
// to git. It records WHICH memory pages exist — path + type only, no content, no hashes, no
// timestamps — so it changes only when pages are added/removed (low git churn). It is the
// git-annex/LFS "committed pointer": GitHub knows what memory exists without the content
// living in git. Restore reads it to compute the gap, then fetches content from the backup.
//
// Schema is the FLEET-SHARED `brain-map/1` (decisive memory-substrate parity) so every brain
// speaks one format.

import fs from 'fs';
import path from 'path';
import { assertContainedRelativePath } from '../bundle/manifest-schema.js';
import { getAgentId } from '../project-config.js';
import {
  assertBrainBackupSelectionReady,
  classifyBrainBackupPath,
  resolveBrainBackupSelection,
} from './brain-backup-selection.js';

export const BRAIN_MAP_SCHEMA = 'brain-map/1';
export const BRAIN_MAP_FILENAME = 'brain-map.json';

// Coarse, STABLE type inference — kept low-churn on purpose (a rename of categories, not an
// edit, changes the map). Mirrors decisive's brain-map pageType so the fleet agrees on types.
export function pageType(rel) {
  const top = rel.split('/')[0];
  if (
    ['daily', 'narratives', 'pairing', 'round-tables', 'threads', 'campaigns', 'strategy', 'portfolio-daily', 'messages'].includes(
      top,
    )
  ) {
    return top;
  }
  const base = rel.split('/').pop() || rel;
  const m = base.match(/^(feedback|reference|strategy|project|queued)[_-]/);
  if (m) return m[1];
  if (base === 'MEMORY.md') return 'index';
  if (base.endsWith('.schema.json')) return 'schema';
  if (base.endsWith('.json')) return 'manifest';
  return 'page';
}

function relativeMemoryPath(repositoryPath) {
  return repositoryPath.slice('memory/'.length);
}

function buildBrainMap(root, selection) {
  const pages = selection.selected
    .map((record) => relativeMemoryPath(record.path))
    .sort()
    .map((rel) => ({ path: rel, type: pageType(rel) }));
  return {
    schema: BRAIN_MAP_SCHEMA,
    brain: getAgentId(root) || path.basename(root) || 'unknown',
    page_count: pages.length,
    pages,
  };
}

/** Build the presence manifest for a project's memory/ (does not write it). */
export function generateBrainMap(projectRoot) {
  const root = path.resolve(projectRoot);
  const selection = resolveBrainBackupSelection(root);
  assertBrainBackupSelectionReady(selection, 'brain-map generation');
  return buildBrainMap(root, selection);
}

/** Write brain-map.json at the repo root; returns the written doc. */
export function writeBrainMap(projectRoot) {
  const root = path.resolve(projectRoot);
  const selection = resolveBrainBackupSelection(root);
  assertBrainBackupSelectionReady(selection, 'brain-map write');
  const doc = buildBrainMap(root, selection);
  const dest = path.join(root, BRAIN_MAP_FILENAME);
  fs.writeFileSync(dest, JSON.stringify(doc, null, 2) + '\n');
  return { doc, path: dest, selection };
}

/**
 * Load + FULLY validate a committed brain-map (untrusted committed input — a bad merge or
 * hand edit must reject, not slip through). Mirrors decisive's refresh schema gate: required
 * typed fields, string paths, and every path contained under memory/.
 */
export function loadBrainMap(projectRoot) {
  const src = path.join(path.resolve(projectRoot), BRAIN_MAP_FILENAME);
  if (!fs.existsSync(src)) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch (err) {
    throw new Error(`brain-map is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (
    doc?.schema !== BRAIN_MAP_SCHEMA ||
    typeof doc.brain !== 'string' ||
    !doc.brain.trim() ||
    !Array.isArray(doc.pages) ||
    !Number.isInteger(doc.page_count)
  ) {
    throw new Error(`brain-map failed schema check (need schema "${BRAIN_MAP_SCHEMA}", string brain, array pages)`);
  }
  if (doc.page_count !== doc.pages.length) {
    throw new Error(`brain-map page_count ${doc.page_count} does not match pages.length ${doc.pages.length}`);
  }
  const seen = new Set();
  const normalizedPages = [];
  for (const entry of doc.pages) {
    if (!entry || typeof entry !== 'object') throw new Error('brain-map has a non-object page entry');
    if (typeof entry.path !== 'string' || !entry.path.trim()) throw new Error('brain-map has a non-string page path');
    if (typeof entry.type !== 'string' || !entry.type.trim()) throw new Error('brain-map has a non-string page type');
    // Reject any path that escapes memory/ before it is used to touch the filesystem.
    const rel = assertContainedRelativePath(entry.path, 'brain-map page path');
    if (rel.startsWith('memory/') || rel === 'memory') {
      throw new Error(`brain-map paths must be relative to memory/, not include it: "${entry.path}"`);
    }
    if (seen.has(rel)) throw new Error(`brain-map has duplicate page path: "${entry.path}"`);
    seen.add(rel);
    normalizedPages.push({ path: rel, type: entry.type.trim() });
  }
  return {
    ...doc,
    brain: doc.brain.trim(),
    pages: normalizedPages,
  };
}

/**
 * Compare a brain-map's expected pages against what actually exists under memory/.
 * @returns {{present:string[], missing:string[], extra:string[], expected:number}}
 */
export function verifyAgainstMap(projectRoot, doc) {
  const root = path.resolve(projectRoot);
  const memRoot = path.join(root, 'memory');
  const selection = resolveBrainBackupSelection(root);
  const selected = new Set(selection.selected.map((record) => relativeMemoryPath(record.path)));
  const want = new Set(doc.pages.map((p) => p.path));
  const present = [];
  const missing = [];
  for (const rel of want) {
    const absolute = path.join(memRoot, rel);
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isFile()) present.push(rel);
      else missing.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  const policySelected = new Set(
    [...want].filter((rel) => classifyBrainBackupPath(selection, `memory/${rel}`).status === 'SELECTED'),
  );
  const selectedPresent = present.filter((rel) => policySelected.has(rel));
  const selectionMissing = [...want].filter((rel) => !policySelected.has(rel));
  const extra = [...selected].filter((rel) => !want.has(rel));
  const pathsFor = (status) => selection.records
    .filter((record) => record.status === status)
    .map((record) => relativeMemoryPath(record.path))
    .sort();
  return {
    present: present.sort(),
    missing: missing.sort(),
    selectedPresent: selectedPresent.sort(),
    selectionMissing: selectionMissing.sort(),
    extra: extra.sort(),
    expected: want.size,
    selectionState: selection.state,
    policyReady: selection.policy !== null && selection.includeCount > 0,
    counts: selection.counts,
    ignored: pathsFor('IGNORED'),
    unselected: pathsFor('UNSELECTED'),
    secretBlocked: pathsFor('SECRET_BLOCKED'),
  };
}
