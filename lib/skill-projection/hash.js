import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

export async function readFileHash(filePath) {
  try {
    const content = await readFile(filePath, 'utf-8');
    return hashContent(content);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
