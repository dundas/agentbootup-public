import { extractCwd, getPositionalArgs, hasFlag } from '../args.js';
import fs from 'fs';
import path from 'path';
import { loadNetworkConfig } from '../config.js';
import { loadEnvSchema } from '../env/schema.js';
import { parseEnvFile } from '../env/parse.js';

function printUsage(io) {
  io.stdout('Usage: agentbootup env sync <VAR...> [--fly] [--cwd <path>]');
}

function mergeEnvValues(filepath, updates) {
  const sanitizedUpdates = {};
  for (const [key, value] of Object.entries(updates)) {
    sanitizedUpdates[key] = sanitizeEnvValue(value);
  }
  const existing = fs.existsSync(filepath) ? fs.readFileSync(filepath, 'utf-8').split('\n') : [];
  const keys = new Set(Object.keys(sanitizedUpdates));
  const out = [];
  const seen = new Set();

  for (const rawLine of existing) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      out.push(rawLine);
      continue;
    }
    const key = line.slice(0, line.indexOf('=')).trim();
    if (keys.has(key)) {
      out.push(`${key}=${sanitizedUpdates[key]}`);
      seen.add(key);
    } else {
      out.push(rawLine);
    }
  }

  for (const key of keys) {
    if (!seen.has(key)) {
      out.push(`${key}=${sanitizedUpdates[key]}`);
    }
  }

  const finalText = `${out.filter((line, index) => !(line === '' && index === out.length - 1)).join('\n')}\n`;
  fs.writeFileSync(filepath, finalText);
}

function sanitizeEnvValue(value) {
  return String(value).replaceAll('\r', '').replaceAll('\n', '');
}

export function runEnvCommand(args, io) {
  const extracted = extractCwd(args);
  const localArgs = extracted.args;
  const positionals = getPositionalArgs(localArgs, ['--cwd']);
  const [subcommand = ''] = positionals;
  const fly = hasFlag(localArgs, '--fly');

  if (hasFlag(localArgs, '--help') || hasFlag(localArgs, '-h') || !subcommand) {
    printUsage(io);
    return 0;
  }

  if (subcommand !== 'sync') {
    io.stderr(`env failed: unknown subcommand "${subcommand}"`);
    printUsage(io);
    return 1;
  }

  const vars = positionals.slice(1);
  if (vars.length === 0) {
    io.stderr('env failed: sync requires at least one variable name');
    return 1;
  }
  if (fly) {
    io.stderr('env failed: --fly is not implemented yet');
    return 1;
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(extracted.cwd);
  } catch (err) {
    io.stderr(`env failed: ${err.message}`);
    return 1;
  }

  if (loaded.config.role !== 'network') {
    io.stderr('env failed: command requires role "network"');
    return 1;
  }

  const sourceEnvPath = path.join(extracted.cwd, '.env');
  const sourceVars = parseEnvFile(sourceEnvPath);
  const projects = loaded.config.projects || [];

  io.stdout(`Env sync source: ${sourceEnvPath}`);
  let updatedProjects = 0;

  for (const project of projects) {
    if (!project.path) {
      io.stdout(`Project ${project.id}: skipped (not linked)`);
      continue;
    }
    const schema = loadEnvSchema(project.path);
    if (!schema) {
      io.stdout(`Project ${project.id}: skipped (no brain/.env.schema)`);
      continue;
    }

    const updates = {};
    for (const name of vars) {
      if (!schema.allowed.has(name)) continue;
      if (sourceVars[name] == null) continue;
      updates[name] = sourceVars[name];
    }

    if (Object.keys(updates).length === 0) {
      io.stdout(`Project ${project.id}: no matching vars to sync`);
      continue;
    }

    const targetEnvPath = path.join(project.path, '.env');
    mergeEnvValues(targetEnvPath, updates);
    io.stdout(`Project ${project.id}: synced ${Object.keys(updates).length} var(s)`);
    updatedProjects += 1;
  }

  io.stdout(`Env sync complete: ${updatedProjects} project(s) updated`);
  return 0;
}
