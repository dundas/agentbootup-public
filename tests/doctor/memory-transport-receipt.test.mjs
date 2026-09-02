import { describe, expect, test } from 'bun:test';
import { memoryTransportReceiptResult, proposedMemoryTransportSelectors } from '../../lib/doctor/memory-transport-receipt.js';

describe('memory transport receipt', () => {
  test('preserves fail > unknown > pass without treating malformed evidence as pass', () => {
    expect(memoryTransportReceiptResult({ schema: 'memory-transport-check/1', outcome: 'pass' }).state).toBe('pass');
    expect(memoryTransportReceiptResult({ schema: 'memory-transport-check/1', outcome: 'unknown' }).state).toBe('unknown');
    expect(memoryTransportReceiptResult({ schema: 'memory-transport-check/1', outcome: 'fail' }).state).toBe('fail');
    expect(memoryTransportReceiptResult({ schema: 'memory-transport-check/1', outcome: 'other' }).state).toBe('unknown');
  });

  test('proposes one broad selector per proven-unselected category', () => {
    const selectors = proposedMemoryTransportSelectors({
      schema: 'memory-transport-check/1',
      findings: [
        { assertion: 'A0', reason: 'store_unselected', path: 'narratives/a.md' },
        { assertion: 'A0', reason: 'store_unselected', path: 'narratives/b.md' },
        { assertion: 'A0', reason: 'store_unselected', path: '../not-a-selector.md' },
        { assertion: 'A0', reason: 'store_not_configured', path: 'other/a.md' },
      ],
    });
    expect(selectors).toEqual(['memory/narratives/**']);
  });
});
