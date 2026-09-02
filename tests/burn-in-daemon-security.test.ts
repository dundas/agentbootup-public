import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';

test('burn-in escalation is opt-in and never guesses a source checkout helper', () => {
  const source = readFileSync('scripts/burn-in-daemon.ts', 'utf8');
  expect(source).toContain('process.env.AGENTBOOTUP_BURNIN_BRAIN_MSG?.trim()');
  expect(source).toContain('escalation not configured: ${subject}');
  expect(source).not.toContain("path.join(HOME, 'dev_env'");
  expect(source).not.toContain("'cross-brain-message', 'brain-msg.ts'");
});
