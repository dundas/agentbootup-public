/**
 * Three-way file reads: present, absent, or error — never two-way.
 *
 * This exists as one shared helper because the same defect appeared three times in
 * one change set, each time as an innocent-looking `try { read } catch { return
 * null }`:
 *
 *   - a corrupt `index.json` read as an empty store, so a writer would publish
 *     against revision 0 and discard every prior entry and tombstone;
 *   - a corrupt `lease.json` read as "no lease", handing the single-writer fence to
 *     a second machine while the first still believed it held it;
 *   - a corrupt `source-descriptor.json` read as "no descriptor", which quarantines
 *     for the wrong reason and hides on-disk corruption from the operator.
 *
 * "Could not read it" and "it is not there" are different facts. Only the caller
 * knows whether the second one is benign, and it never gets the chance if the read
 * has already thrown the distinction away.
 */

import fs from 'fs';

/**
 * @returns {{ absent: true, body: null } | { absent: false, body: string|Buffer }}
 * @throws the original error, annotated, for anything that is not ENOENT.
 */
export function readFileOrAbsent(filePath, { encoding = 'utf8' } = {}) {
  try {
    return { absent: false, body: fs.readFileSync(filePath, encoding) };
  } catch (err) {
    if (err?.code === 'ENOENT') return { absent: true, body: null };
    throw err;
  }
}

/**
 * Read and parse JSON with the absent/invalid distinction preserved.
 *
 * @returns {{ state: 'absent' } | { state: 'present', value: any } | { state: 'invalid', detail: string }}
 */
export function readJsonFile(filePath) {
  let read;
  try {
    read = readFileOrAbsent(filePath);
  } catch (err) {
    return { state: 'invalid', detail: err?.code ?? err?.message ?? 'unreadable' };
  }
  if (read.absent) return { state: 'absent' };
  try {
    return { state: 'present', value: JSON.parse(read.body) };
  } catch {
    return { state: 'invalid', detail: 'malformed_json' };
  }
}
