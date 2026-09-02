import { afterEach, expect, test } from 'bun:test';
import {
  BRAIN_ASSET_BODY_SAFE_CEILING_BYTES,
  createBrainAssetSizeError,
  getBrainAssetBodyBudget,
  planBrainAssetPushBatches,
  sendBrainAssetBatchWith413Split,
} from '../lib/brain/asset-transport.js';

test('size errors distinguish deterministic client bounds from retryable server 413s', () => {
  const detail = { path: 'memory/large.md', encodedBytes: 101, budget: 100 };
  expect(createBrainAssetSizeError(detail).retryable).toBe(false);
  expect(createBrainAssetSizeError({ ...detail, status: 413 }).retryable).toBe(true);
});

const ORIGINAL_BUDGET = process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES;

afterEach(() => {
  if (ORIGINAL_BUDGET === undefined) delete process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES;
  else process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES = ORIGINAL_BUDGET;
});

function entry(path: string, content: string) {
  return {
    path,
    content_base64: Buffer.from(content, 'utf8').toString('base64'),
    asset_type: 'memory',
    cli: 'shared',
  };
}

test('exact-byte planner includes UTF-8 JSON, base64, and request metadata overhead', () => {
  const items = [entry('memory/🧠-one.md', '🧠'.repeat(30)), entry('memory/two.md', '🌍'.repeat(30))];
  const makePayload = (files: typeof items) => ({
    branch_id: 'branch-🧠',
    machine_info: { hostname: 'máquina-🌍' },
    files,
  });
  const singletonBytes = Buffer.byteLength(JSON.stringify(makePayload([items[0]])), 'utf8');
  const combinedBytes = Buffer.byteLength(JSON.stringify(makePayload(items)), 'utf8');
  const budget = combinedBytes - 1;

  expect(singletonBytes).toBeLessThanOrEqual(budget);
  const plan = planBrainAssetPushBatches({ items, maxFiles: 500, makePayload, budget });
  expect(plan.oversized).toEqual([]);
  expect(plan.batches.map((batch) => batch.items.map((file) => file.path))).toEqual([
    ['memory/🧠-one.md'],
    ['memory/two.md'],
  ]);
  for (const batch of plan.batches) {
    expect(batch.encodedBytes).toBe(Buffer.byteLength(batch.body, 'utf8'));
    expect(batch.encodedBytes).toBeLessThanOrEqual(budget);
  }
});

test('planner preserves order, count ceiling, and reports an oversized singleton without blocking eligible files', () => {
  const items = [entry('memory/a.md', 'a'), entry('memory/huge.md', 'x'.repeat(500)), entry('memory/b.md', 'b')];
  const makePayload = (files: typeof items) => ({ files });
  const budget = Buffer.byteLength(JSON.stringify(makePayload([items[0]])), 'utf8') + 20;

  const plan = planBrainAssetPushBatches({ items, maxFiles: 1, makePayload, budget });
  expect(plan.batches.map((batch) => batch.items[0].path)).toEqual(['memory/a.md', 'memory/b.md']);
  expect(plan.oversized).toHaveLength(1);
  expect(plan.oversized[0].path).toBe('memory/huge.md');
  expect(plan.oversized[0].encodedBytes).toBeGreaterThan(budget);
});

test('validated budget override may reduce but never raise the compiled safe ceiling', () => {
  process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES = '4096';
  expect(getBrainAssetBodyBudget()).toBe(4096);
  process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES = String(BRAIN_ASSET_BODY_SAFE_CEILING_BYTES + 1);
  expect(() => getBrainAssetBodyBudget()).toThrow(/safe ceiling/i);
  process.env.AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES = 'not-a-number';
  expect(() => getBrainAssetBodyBudget()).toThrow(/positive integer/i);
});

test('unexpected multi-file 413 splits into smaller ordered requests and recovers', async () => {
  const items = [entry('memory/a.md', 'a'), entry('memory/b.md', 'b'), entry('memory/c.md', 'c')];
  const makePayload = (files: typeof items) => ({ files });
  const plan = planBrainAssetPushBatches({ items, maxFiles: 500, makePayload, budget: 100_000 });
  const calls: string[][] = [];
  const results = await sendBrainAssetBatchWith413Split(plan.batches[0], {
    makePayload,
    send: async (batch) => {
      calls.push(batch.items.map((file) => file.path));
      return new Response('', { status: batch.items.length > 1 ? 413 : 200 });
    },
  });

  expect(calls).toEqual([
    ['memory/a.md', 'memory/b.md', 'memory/c.md'],
    ['memory/a.md'],
    ['memory/b.md', 'memory/c.md'],
    ['memory/b.md'],
    ['memory/c.md'],
  ]);
  expect(results.map((result) => result.batch.items[0].path)).toEqual([
    'memory/a.md',
    'memory/b.md',
    'memory/c.md',
  ]);
});
