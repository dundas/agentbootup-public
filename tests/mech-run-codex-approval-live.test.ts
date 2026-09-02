import { expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from '@mech/run';
import {
  RuntimeApprovalAuthority,
  createRuntimeApprovalGate,
} from '../node_modules/@mech/plane/src/interactive/runtime-approval-authority.ts';

const live = process.env.CODEX_APP_SERVER_APPROVAL_SMOKE === '1';

test.skipIf(!live)('real Codex session denies an effect then resumes for an allowed effect', async () => {
  const root = join(process.cwd(), `.codex-approval-live-${Date.now()}`);
  const denied = join(root, 'denied-marker');
  const allowed = join(root, 'allowed-marker');
  const timeoutMs = 120_000;

  async function turn(sessionId: string | undefined, decision: 'once' | 'deny', marker: string) {
    let proposed = false;
    let accepted = false;
    const authority = new RuntimeApprovalAuthority({ expiresInMs: 30_000 });
    const gate = createRuntimeApprovalGate({
      authority,
      onRequested: (envelope) => {
        proposed = true;
        accepted = authority.resolve({
          challengeId: envelope.challengeId,
          bindingDigest: envelope.bindingDigest,
          invocationId: envelope.invocationId,
          decision,
        }).accepted;
      },
    });
    const result = await spawn({
      provider: 'codex',
      cwd: process.cwd(),
      ...(sessionId ? { sessionId } : {}),
      prompt: `Use Bash exactly once to run: mkdir -p ${root} && touch ${marker}. Then reply DONE.`,
      timeoutMs,
      allowedTools: ['Bash'],
      onToolCall: gate,
    });
    return { result, proposed, accepted };
  }

  try {
    const first = await turn(undefined, 'deny', denied);
    expect(first.result.sessionId).toBeString();
    expect(first.proposed).toBe(true);
    expect(first.accepted).toBe(true);
    expect(existsSync(denied)).toBe(false);

    const resumed = await turn(first.result.sessionId!, 'once', allowed);
    expect(resumed.result.sessionId).toBe(first.result.sessionId);
    expect(resumed.proposed).toBe(true);
    expect(resumed.accepted).toBe(true);
    expect(existsSync(allowed)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
