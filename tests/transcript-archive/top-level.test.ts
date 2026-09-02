import { afterEach, expect, test } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))); });

test('top-level transcripts dispatch works without daemon state or credentials', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ab-transcripts-top-'));
  roots.push(root);
  const sessions = path.join(root, 'codex');
  const transcript = path.join(sessions, '2026/07/20/rollout-2026-07-20T12-00-00-0190abcd-1234-7890-abcd-1234567890ab.jsonl');
  await fsp.mkdir(path.dirname(transcript), { recursive: true });
  await fsp.writeFile(transcript, `${JSON.stringify({ payload: { id: 'session-one', cwd: root } })}\n`);
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({ brainId: 'brain-one' }));
  const child = Bun.spawnSync([process.execPath, 'bootup.mjs', 'transcripts', 'backup', '--cwd', root, '--dry-run', '--json'], {
    cwd: path.resolve('.'),
    env: { ...process.env, AGENTBOOTUP_CONFIG_FILE: config, AGENTBOOTUP_RESTORE_ROOT_CODEX: sessions,
      AGENTBOOTUP_RESTORE_ROOT_CLAUDE: path.join(root, 'none-claude'), AGENTBOOTUP_RESTORE_ROOT_CURSOR: path.join(root, 'none-cursor'),
      AGENTBOOTUP_RESTORE_ROOT_GEMINI: path.join(root, 'none-gemini') },
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(child.exitCode).toBe(0);
  expect(new TextDecoder().decode(child.stderr)).toBe('');
  expect(JSON.parse(new TextDecoder().decode(child.stdout))).toMatchObject({
    command: 'backup', dryRun: true, summary: { discovered: 1, contentUploaded: false },
  });
});
