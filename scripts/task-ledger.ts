#!/usr/bin/env bun

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

type SourceType =
  | 'inbox_message'
  | 'daily_narrative'
  | 'human_prompt'
  | 'campaign'
  | 'review_finding'
  | 'system_alert'
  | 'manual_note';

type Priority = 'low' | 'medium' | 'high' | 'critical';
type Status = 'new' | 'triaged' | 'accepted' | 'parked' | 'blocked' | 'done' | 'dropped';
type Bucket = 'do_now' | 'workqueue' | 'campaign' | 'waiting' | 'archive';

type LedgerItem = {
  id: string;
  created_at: string;
  updated_at: string;
  source: {
    type: SourceType;
    ref?: string;
    excerpt?: string;
  };
  title: string;
  summary?: string;
  priority: Priority;
  status: Status;
  bucket?: Bucket;
  owner?: string;
  linked_artifacts?: string[];
  blocked_on?: string[];
  notes?: string;
};

type Ledger = {
  schema_version: 'task-ledger-v1';
  updated_at: string;
  items: LedgerItem[];
};

const LEDGER_PATH = join(process.cwd(), 'memory', 'task-ledger.json');

const SOURCE_TYPES: SourceType[] = [
  'inbox_message',
  'daily_narrative',
  'human_prompt',
  'campaign',
  'review_finding',
  'system_alert',
  'manual_note',
];

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical'];
const STATUSES: Status[] = ['new', 'triaged', 'accepted', 'parked', 'blocked', 'done', 'dropped'];
const BUCKETS: Bucket[] = ['do_now', 'workqueue', 'campaign', 'waiting', 'archive'];

function usage(exitCode = 0): never {
  console.log(`task-ledger [command]

Commands:
  add                 Create a new ledger item
  update <id>         Update an existing ledger item
  list                List ledger items
  show <id>           Show one ledger item

Common options:
  --ledger <path>     Override ledger path (default: memory/task-ledger.json)
  --dry-run           Print the resulting change without writing

Add options:
  --source-type <type>    ${SOURCE_TYPES.join(' | ')}
  --title <text>          Required
  --priority <value>      ${PRIORITIES.join(' | ')} (default: medium)
  --status <value>        ${STATUSES.join(' | ')} (default: new)
  --bucket <value>        ${BUCKETS.join(' | ')}
  --source-ref <text>
  --source-excerpt <text>
  --summary <text>
  --owner <text>
  --link <text>           Repeatable
  --blocked-on <text>     Repeatable
  --notes <text>

Update options:
  --title <text>
  --priority <value>
  --status <value>
  --bucket <value>
  --source-ref <text>
  --source-excerpt <text>
  --summary <text>
  --owner <text>
  --link <text>           Repeatable; appended
  --blocked-on <text>     Repeatable; replaces current list
  --notes <text>          Replaces current notes
  --append-note <text>    Appends to notes with timestamp

List filters:
  --status <value>
  --priority <value>
  --source-type <type>
  --limit <n>
`);
  process.exit(exitCode);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readArg(flag: string, args: string[]): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return undefined;
  return next;
}

function readRepeated(flag: string, args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

function ensureEnum<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  fail(`Invalid ${label}: ${value}. Expected one of: ${allowed.join(', ')}`);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) fail(`Invalid --limit: ${value}`);
  return Number(value);
}

function loadLedger(ledgerPath: string): Ledger {
  if (!existsSync(ledgerPath)) {
    return {
      schema_version: 'task-ledger-v1',
      updated_at: new Date().toISOString(),
      items: [],
    };
  }

  const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as Ledger;
  if (parsed.schema_version !== 'task-ledger-v1' || !Array.isArray(parsed.items)) {
    fail(`Invalid task ledger at ${ledgerPath}`);
  }
  return parsed;
}

function saveLedger(ledgerPath: string, ledger: Ledger): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

function nextId(items: LedgerItem[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const prefix = `task-${today}-`;
  const sameDay = items
    .map((item) => item.id)
    .filter((id) => id.startsWith(prefix))
    .map((id) => id.substring(prefix.length))
    .filter((s) => /^\d+$/.test(s))
    .map((s) => Number(s));
  const max = sameDay.length > 0 ? Math.max(...sameDay) : 0;
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

function printItem(item: LedgerItem): void {
  console.log(JSON.stringify(item, null, 2));
}

function appendNote(existing: string | undefined, extra: string): string {
  const stamp = new Date().toISOString();
  const line = `[${stamp}] ${extra}`;
  return existing?.trim() ? `${existing.trim()}\n${line}` : line;
}

function getLedgerPath(args: string[]): string {
  return readArg('--ledger', args) || LEDGER_PATH;
}

function cmdAdd(args: string[]): void {
  const ledgerPath = getLedgerPath(args);
  const dryRun = args.includes('--dry-run');
  const sourceType = ensureEnum(readArg('--source-type', args), SOURCE_TYPES, 'source type');
  const title = readArg('--title', args);
  const priority = ensureEnum(readArg('--priority', args), PRIORITIES, 'priority') || 'medium';
  const status = ensureEnum(readArg('--status', args), STATUSES, 'status') || 'new';
  const bucket = ensureEnum(readArg('--bucket', args), BUCKETS, 'bucket');

  if (!sourceType) fail('Missing required --source-type');
  if (!title) fail('Missing required --title');

  const now = new Date().toISOString();
  const ledger = loadLedger(ledgerPath);
  const item: LedgerItem = {
    id: nextId(ledger.items),
    created_at: now,
    updated_at: now,
    source: {
      type: sourceType,
      ...(readArg('--source-ref', args) ? { ref: readArg('--source-ref', args) } : {}),
      ...(readArg('--source-excerpt', args) ? { excerpt: readArg('--source-excerpt', args) } : {}),
    },
    title,
    ...(readArg('--summary', args) ? { summary: readArg('--summary', args) } : {}),
    priority,
    status,
    ...(bucket ? { bucket } : {}),
    ...(readArg('--owner', args) ? { owner: readArg('--owner', args) } : {}),
    ...(readRepeated('--link', args).length > 0 ? { linked_artifacts: readRepeated('--link', args) } : {}),
    ...(readRepeated('--blocked-on', args).length > 0 ? { blocked_on: readRepeated('--blocked-on', args) } : {}),
    ...(readArg('--notes', args) ? { notes: readArg('--notes', args) } : {}),
  };

  ledger.items.unshift(item);
  ledger.updated_at = now;

  if (dryRun) {
    printItem(item);
    return;
  }

  saveLedger(ledgerPath, ledger);
  printItem(item);
}

function cmdUpdate(id: string, args: string[]): void {
  const ledgerPath = getLedgerPath(args);
  const dryRun = args.includes('--dry-run');
  const ledger = loadLedger(ledgerPath);
  const item = ledger.items.find((entry) => entry.id === id);
  if (!item) fail(`Ledger item not found: ${id}`);

  const now = new Date().toISOString();
  const priority = ensureEnum(readArg('--priority', args), PRIORITIES, 'priority');
  const status = ensureEnum(readArg('--status', args), STATUSES, 'status');
  const bucket = ensureEnum(readArg('--bucket', args), BUCKETS, 'bucket');
  const sourceRef = readArg('--source-ref', args);
  const sourceExcerpt = readArg('--source-excerpt', args);
  const title = readArg('--title', args);
  const summary = readArg('--summary', args);
  const owner = readArg('--owner', args);
  const notes = readArg('--notes', args);
  const append = readArg('--append-note', args);
  const links = readRepeated('--link', args);
  const blockedOn = readRepeated('--blocked-on', args);

  if (title !== undefined) item.title = title;
  if (summary !== undefined) item.summary = summary;
  if (priority !== undefined) item.priority = priority;
  if (status !== undefined) item.status = status;
  if (bucket !== undefined) item.bucket = bucket;
  if (owner !== undefined) item.owner = owner;
  if (sourceRef !== undefined) item.source.ref = sourceRef;
  if (sourceExcerpt !== undefined) item.source.excerpt = sourceExcerpt;
  if (links.length > 0) {
    item.linked_artifacts = Array.from(new Set([...(item.linked_artifacts || []), ...links]));
  }
  if (blockedOn.length > 0) item.blocked_on = blockedOn;
  if (notes !== undefined) item.notes = notes;
  if (append !== undefined) item.notes = appendNote(item.notes, append);
  item.updated_at = now;
  ledger.updated_at = now;

  if (dryRun) {
    printItem(item);
    return;
  }

  saveLedger(ledgerPath, ledger);
  printItem(item);
}

function cmdList(args: string[]): void {
  const ledgerPath = getLedgerPath(args);
  const ledger = loadLedger(ledgerPath);
  const status = ensureEnum(readArg('--status', args), STATUSES, 'status');
  const priority = ensureEnum(readArg('--priority', args), PRIORITIES, 'priority');
  const sourceType = ensureEnum(readArg('--source-type', args), SOURCE_TYPES, 'source type');
  const limit = parseLimit(readArg('--limit', args));

  let items = [...ledger.items];
  if (status) items = items.filter((item) => item.status === status);
  if (priority) items = items.filter((item) => item.priority === priority);
  if (sourceType) items = items.filter((item) => item.source.type === sourceType);
  if (limit !== undefined) items = items.slice(0, limit);

  console.log(JSON.stringify(items, null, 2));
}

function cmdShow(id: string, args: string[]): void {
  const ledger = loadLedger(getLedgerPath(args));
  const item = ledger.items.find((entry) => entry.id === id);
  if (!item) fail(`Ledger item not found: ${id}`);
  printItem(item);
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '--help' || command === '-h') usage();

  switch (command) {
    case 'add':
      cmdAdd(args.slice(1));
      break;
    case 'update': {
      const id = args[1];
      if (!id) fail('Missing ledger item id for update');
      cmdUpdate(id, args.slice(2));
      break;
    }
    case 'list':
      cmdList(args.slice(1));
      break;
    case 'show': {
      const id = args[1];
      if (!id) fail('Missing ledger item id for show');
      cmdShow(id, args.slice(2));
      break;
    }
    default:
      usage(1);
  }
}

main();
