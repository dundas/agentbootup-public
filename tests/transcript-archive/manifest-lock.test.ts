import { expect, test } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { withTranscriptManifestLock } from '../../lib/brain/transcript-manifest-lock.js';

test('a rejecting lock holder releases queued and later operations', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'transcript-manifest-lock-reject-'));
  const lock = path.join(root, '.brain', 'manifest-lock.sqlite');
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withTranscriptManifestLock(lock, async () => {
    await gate;
    throw new Error('first operation failed');
  }, { trustedRoot: root });
  const second = withTranscriptManifestLock(lock, async () => 'second', { trustedRoot: root });
  releaseFirst();
  await expect(first).rejects.toThrow('first operation failed');
  await expect(second).resolves.toBe('second');
  await expect(withTranscriptManifestLock(lock, async () => 'third', { trustedRoot: root })).resolves.toBe('third');
  await fsp.rm(root, { recursive: true, force: true });
});
