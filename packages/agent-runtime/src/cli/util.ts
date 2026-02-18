/**
 * CLI utilities — arg parsing, formatting, config resolution
 */

import { loadConfig, findConfigPath, type AgentDefinition } from '../config';

/** Parse CLI args into flags and positional args. */
export function parseArgs(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

/**
 * Resolve agent name: use provided name, or load from config.
 * Returns [name, config?] where config is set if loaded from file.
 */
export async function resolveAgentName(args: string[]): Promise<[string, AgentDefinition | null]> {
  const { positional } = parseArgs(args);

  if (positional.length > 0) {
    return [positional[0], null];
  }

  // Try loading config from cwd
  const configPath = findConfigPath();
  if (configPath) {
    const config = await loadConfig();
    return [config.name, config];
  }

  throw new Error('No agent name provided and no agent.config.ts found in current directory.');
}

/** Format a table with headers and rows. */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    const maxRow = Math.max(0, ...rows.map(r => (r[i] || '').length));
    return Math.max(h.length, maxRow);
  });

  const sep = widths.map(w => '-'.repeat(w + 2)).join('+');
  const headerLine = headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join('|');
  const dataLines = rows.map(row =>
    row.map((cell, i) => ` ${(cell || '').padEnd(widths[i])} `).join('|')
  );

  return [headerLine, sep, ...dataLines].join('\n');
}
