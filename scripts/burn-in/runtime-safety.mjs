export function assertSafeBrainId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('unsafe brain id'); return value; }
export function assertSafeSshTarget(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9._-]+)?$/.test(value) || value.startsWith('-')) throw new Error('unsafe ssh target'); return value; }
