/**
 * Shared filesystem helpers for brain / network commands (no imports from provision).
 */

import fs from 'fs';

/**
 * Write `content` to `filePath` atomically via a sibling temp file + rename.
 * On POSIX (same filesystem) fs.renameSync is atomic — concurrent readers never
 * see a partial write. Uses process.pid in the temp name to avoid collisions
 * between simultaneous callers.
 * @param {string} filePath
 * @param {string} content
 */
export function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
