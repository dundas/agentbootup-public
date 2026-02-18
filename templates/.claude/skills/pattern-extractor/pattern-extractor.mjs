#!/usr/bin/env bun
/**
 * Pattern Extractor CLI
 *
 * Analyzes transcripts to extract error patterns, success patterns, and decisions.
 * Automates the learning loop.
 */

import { PatternDetector } from './lib/pattern-detector.js';
import { promises as fs } from 'fs';
import path from 'path';

const args = process.argv.slice(2);

// Parse arguments
const options = {
  last: null,
  since: null,
  errorsOnly: false,
  successesOnly: false,
  decisionsOnly: false,
  updateFile: null,
  generateChecks: false,
  format: 'markdown',
  output: null,
  check: null, // For pre-flight check mode
  file: null   // File to check
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--help' || arg === '-h') {
    console.log(`
Pattern Extractor - Automated Learning from Transcripts

Usage:
  pattern-extractor [options]

Options:
  --last N              Analyze last N days
  --since DATE          Analyze since date (YYYY-MM-DD)
  --errors-only         Extract only error patterns
  --successes-only      Extract only success patterns
  --decisions-only      Extract only decision patterns
  --update-file PATH    Update technical patterns file
  --generate-checks     Generate pre-flight check code
  --format FORMAT       Output format (markdown|json)
  --output FILE         Save to file instead of stdout
  --check TOOL          Pre-flight check mode (e.g., --check Write --file path/to/file)
  --file PATH           File path for pre-flight check

Examples:
  # Extract patterns from last week
  pattern-extractor --last 7

  # Extract only errors from last month
  pattern-extractor --errors-only --last 30

  # Update technical patterns file
  pattern-extractor --last 30 --update-file memory/technical-patterns.md

  # Generate pre-flight checks
  pattern-extractor --generate-checks --last 90

  # Pre-flight check before Write
  pattern-extractor --check Write --file src/api/auth.ts

  # Export for cross-brain sharing
  pattern-extractor --last 7 --format json --output patterns.json
    `);
    process.exit(0);
  } else if (arg === '--last' && i + 1 < args.length) {
    options.last = parseInt(args[++i], 10);
  } else if (arg === '--since' && i + 1 < args.length) {
    options.since = args[++i];
  } else if (arg === '--errors-only') {
    options.errorsOnly = true;
  } else if (arg === '--successes-only') {
    options.successesOnly = true;
  } else if (arg === '--decisions-only') {
    options.decisionsOnly = true;
  } else if (arg === '--update-file' && i + 1 < args.length) {
    options.updateFile = args[++i];
  } else if (arg === '--generate-checks') {
    options.generateChecks = true;
  } else if (arg === '--format' && i + 1 < args.length) {
    options.format = args[++i];
  } else if (arg === '--output' && i + 1 < args.length) {
    options.output = args[++i];
  } else if (arg === '--check' && i + 1 < args.length) {
    options.check = args[++i];
  } else if (arg === '--file' && i + 1 < args.length) {
    options.file = args[++i];
  }
}

// Main execution
async function main() {
  const detector = new PatternDetector();

  // Pre-flight check mode
  if (options.check) {
    const result = await detector.preFlightCheck(options.check, options.file);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.warnings.length > 0 ? 1 : 0);
  }

  // Pattern extraction mode
  console.log('📊 Extracting patterns from transcripts...');

  const patterns = await detector.extractPatterns(process.cwd(), options);

  // Format output
  let output;
  if (options.format === 'json') {
    output = JSON.stringify(patterns, null, 2);
  } else {
    output = detector.formatMarkdown(patterns);
  }

  // Save or print
  if (options.output) {
    await fs.writeFile(options.output, output, 'utf-8');
    console.log(`✅ Patterns saved to ${options.output}`);
  } else {
    console.log(output);
  }

  // Update technical patterns file if requested
  if (options.updateFile) {
    await detector.updateTechnicalPatterns(patterns, options.updateFile);
    console.log(`✅ Updated ${options.updateFile}`);
  }

  // Generate pre-flight checks if requested
  if (options.generateChecks) {
    const checks = detector.generatePreFlightChecks(patterns);
    const checksPath = '.claude/hooks/pre-flight-checks.js';
    await fs.mkdir(path.dirname(checksPath), { recursive: true });
    await fs.writeFile(checksPath, checks, 'utf-8');
    console.log(`✅ Generated pre-flight checks at ${checksPath}`);
  }
}

main().catch(console.error);
