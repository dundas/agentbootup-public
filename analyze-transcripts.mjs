#!/usr/bin/env node
/**
 * Analyze Transcripts CLI
 *
 * On-demand transcript analysis for self-improvement.
 * Extracts insights from Claude Code session transcripts and writes to memory.
 *
 * Usage:
 *   analyze-transcripts [options]
 *
 * Options:
 *   --project <path>     Project to analyze (default: cwd)
 *   --hours <n>          Hours back to analyze (default: 24)
 *   --all                Analyze all unprocessed sessions
 *   --session <id>       Analyze specific session
 *   --dry-run            Show what would be analyzed without writing
 *   --verbose            Show detailed output
 *   --reset              Clear processed sessions state and re-analyze
 *   --stats              Show analysis statistics only
 *   --help               Show this help
 *
 * Environment:
 *   MECH_APP_ID          Mech app ID for LLM access (required)
 *   MECH_API_KEY         Mech API key for LLM access (required)
 *   MECH_LLM_URL         Mech LLMs URL (default: https://llms.mechdna.net)
 */

import fs from 'fs/promises';
import path from 'path';
import { TranscriptParser } from './lib/analysis/transcript-parser.js';
import { InsightExtractor } from './lib/analysis/insight-extractor.js';
import { MemoryWriter } from './lib/analysis/memory-writer.js';
import { MechLLMsClient } from './lib/analysis/mech-llms-client.js';

// Parse CLI args
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project' && args[i + 1]) {
    flags.project = args[++i];
  } else if (args[i] === '--hours' && args[i + 1]) {
    const hoursVal = parseInt(args[++i], 10);
    if (isNaN(hoursVal) || hoursVal <= 0) {
      console.error('Error: --hours must be a positive number.');
      process.exit(1);
    }
    flags.hours = hoursVal;
  } else if (args[i] === '--session' && args[i + 1]) {
    flags.session = args[++i];
  } else if (args[i] === '--all') {
    flags.all = true;
  } else if (args[i] === '--dry-run') {
    flags.dryRun = true;
  } else if (args[i] === '--verbose') {
    flags.verbose = true;
  } else if (args[i] === '--reset') {
    flags.reset = true;
  } else if (args[i] === '--stats') {
    flags.stats = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    flags.help = true;
  }
}

if (flags.help) {
  console.log(`
analyze-transcripts - Extract insights from coding sessions for self-improvement

USAGE
  analyze-transcripts [options]

OPTIONS
  --project <path>     Project to analyze (default: current directory)
  --hours <n>          Hours back to analyze (default: 24)
  --all                Analyze all unprocessed sessions
  --session <id>       Analyze a specific session by ID
  --dry-run            Preview what would be analyzed without writing
  --verbose            Show detailed output including extracted insights
  --reset              Clear state and re-analyze all sessions
  --stats              Show analysis statistics only
  --help               Show this help

ENVIRONMENT
  MECH_APP_ID          Required. Mech app ID for LLM access.
  MECH_API_KEY         Required. Mech API key for LLM access.
  MECH_LLM_URL         Optional. Mech LLMs URL (default: https://llms.mechdna.net)

EXAMPLES
  # Analyze last 24 hours of sessions
  analyze-transcripts

  # Analyze specific project's last week
  analyze-transcripts --project ~/dev_env/myproject --hours 168

  # Preview without writing
  analyze-transcripts --dry-run --verbose

  # Re-analyze everything from scratch
  analyze-transcripts --reset --all

  # Check how many sessions have been analyzed
  analyze-transcripts --stats

OUTPUT
  Insights are written to:
  - memory/daily/YYYY-MM-DD.md   (all session logs)
  - memory/MEMORY.md             (significant learnings only)
`);
  process.exit(0);
}

async function main() {
  const projectPath = flags.project || process.cwd();
  const basePath = projectPath;

  // Stats-only mode
  if (flags.stats) {
    await showStats(basePath);
    return;
  }

  // Validate LLM credentials
  const appId = process.env.MECH_APP_ID;
  const apiKey = process.env.MECH_API_KEY;
  const mechUrl = process.env.MECH_LLM_URL;

  if (!appId || !apiKey) {
    console.error('Error: MECH_APP_ID and MECH_API_KEY environment variables required.');
    console.error('');
    console.error('Set them in your environment or .env file:');
    console.error('  export MECH_APP_ID=your-app-id');
    console.error('  export MECH_API_KEY=your-api-key');
    process.exit(1);
  }

  // Initialize components
  const parser = new TranscriptParser();
  const llmClient = new MechLLMsClient({
    appId,
    apiKey,
    ...(mechUrl && { mechUrl })
  });
  const extractor = new InsightExtractor(llmClient);
  const writer = new MemoryWriter({ basePath });

  // Load state
  const statePath = path.join(basePath, '.transcript-analyzer-state.json');
  let processedSessions = new Set();

  if (flags.reset) {
    console.log('Resetting analysis state...');
    await fs.unlink(statePath).catch(() => {});
  } else {
    try {
      const stateContent = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(stateContent);
      processedSessions = new Set(state.processedSessions || []);
      if (flags.verbose) {
        console.log(`Loaded state: ${processedSessions.size} previously analyzed sessions`);
      }
    } catch {
      // No state file yet
    }
  }

  // Find transcripts
  const transcripts = await parser.listTranscripts(projectPath);

  if (transcripts.length === 0) {
    console.log('No transcripts found for this project.');
    console.log(`Looked in: ~/.claude/projects/ for project path matching ${projectPath}`);
    return;
  }

  console.log(`Found ${transcripts.length} total sessions for this project.`);

  // Filter transcripts
  let toAnalyze;

  if (flags.session) {
    // Specific session
    toAnalyze = transcripts.filter(t => t.sessionId.startsWith(flags.session));
    if (toAnalyze.length === 0) {
      console.error(`Session not found: ${flags.session}`);
      console.log('Available sessions:');
      transcripts.slice(0, 10).forEach(t => {
        console.log(`  ${t.sessionId.substring(0, 8)} - ${t.path}`);
      });
      process.exit(1);
    }
  } else if (flags.all) {
    // All unprocessed
    toAnalyze = transcripts.filter(t => !processedSessions.has(t.sessionId));
  } else {
    // Recent (by hours)
    const hours = flags.hours || 24;
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);

    const withStats = (await Promise.all(
      transcripts.map(async (t) => {
        try {
          const stats = await fs.stat(t.path);
          return { ...t, mtime: stats.mtime };
        } catch {
          // File deleted between listing and stating - skip silently
          return null;
        }
      })
    )).filter(t => t !== null);

    toAnalyze = withStats
      .filter(t => t.mtime.getTime() > cutoff)
      .filter(t => !processedSessions.has(t.sessionId))
      .sort((a, b) => a.mtime - b.mtime);
  }

  if (toAnalyze.length === 0) {
    console.log('No new sessions to analyze.');
    if (!flags.all && !flags.session) {
      console.log(`(Looking at last ${flags.hours || 24} hours. Use --all for all sessions, or --reset to re-analyze.)`);
    }
    return;
  }

  console.log(`${toAnalyze.length} session(s) to analyze${flags.dryRun ? ' (dry run)' : ''}.\n`);

  // Analyze each session
  let analyzed = 0;
  let insightsTotal = 0;
  let memoryUpdates = 0;
  let errorCount = 0;

  for (const transcript of toAnalyze) {
    const { sessionId, path: transcriptPath } = transcript;
    const shortId = sessionId.substring(0, 8);

    process.stdout.write(`Analyzing ${shortId}...`);

    try {
      // Parse
      const data = await parser.parseTranscript(transcriptPath);

      // Check significance
      if (!extractor.isSignificant(data)) {
        console.log(` skipped (${data.summary.messageCount} msgs, not significant)`);
        processedSessions.add(sessionId);
        continue;
      }

      if (flags.dryRun) {
        console.log(` would analyze (${data.summary.messageCount} msgs, ${data.filesModified.length} files, ${data.errors.length} errors)`);
        continue;
      }

      // Extract insights via LLM
      const insights = await extractor.extractInsights(data);

      const insightCount =
        insights.insights.technicalLearnings.length +
        insights.insights.skillsDeveloped.length +
        insights.insights.mistakesAndCorrections.length +
        insights.insights.strategicDecisions.length +
        insights.insights.patterns.length;

      // Write to memory
      const dailyLogPath = await writer.writeDailyLog(insights);
      const memoryPath = await writer.updateMemoryMd(insights);

      // Track
      processedSessions.add(sessionId);
      analyzed++;
      insightsTotal += insightCount;
      if (memoryPath) memoryUpdates++;

      console.log(` ${insightCount} insights extracted${memoryPath ? ', MEMORY.md updated' : ''}`);

      // Verbose: show extracted insights
      if (flags.verbose) {
        const d = insights.insights;
        if (d.technicalLearnings.length > 0) {
          console.log('  Technical Learnings:');
          d.technicalLearnings.forEach(l => console.log(`    - ${l}`));
        }
        if (d.skillsDeveloped.length > 0) {
          console.log('  Skills:');
          d.skillsDeveloped.forEach(s => console.log(`    - ${s}`));
        }
        if (d.mistakesAndCorrections.length > 0) {
          console.log('  Mistakes:');
          d.mistakesAndCorrections.forEach(m => console.log(`    - ${m.mistake} → ${m.correction}`));
        }
        if (d.patterns.length > 0) {
          console.log('  Patterns:');
          d.patterns.forEach(p => console.log(`    - ${p}`));
        }
        console.log('');
      }
    } catch (err) {
      errorCount++;
      console.log(` ERROR: ${err.message}`);
      if (err.code) console.log(`  Error code: ${err.code}`);
      if (!flags.verbose) console.log(`  Use --verbose for full stack trace`);
      if (flags.verbose) {
        console.error(err);
      }
    }
  }

  // Save state
  if (!flags.dryRun) {
    const state = {
      processedSessions: Array.from(processedSessions),
      stats: {
        sessionsAnalyzed: analyzed,
        insightsExtracted: insightsTotal,
        memoryUpdates,
        lastAnalysisAt: Date.now()
      },
      lastSaved: Date.now()
    };

    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  // Summary
  console.log(`\n--- Analysis Complete ---`);
  console.log(`Sessions analyzed: ${analyzed}`);
  console.log(`Insights extracted: ${insightsTotal}`);
  console.log(`MEMORY.md updates: ${memoryUpdates}`);
  if (errorCount > 0) {
    console.log(`Errors: ${errorCount} session(s) failed`);
  }

  if (!flags.dryRun && analyzed > 0) {
    console.log(`\nResults written to:`);
    console.log(`  Daily logs: memory/daily/`);
    console.log(`  Long-term:  memory/MEMORY.md`);
  }
}

async function showStats(basePath) {
  const statePath = path.join(basePath, '.transcript-analyzer-state.json');

  try {
    const content = await fs.readFile(statePath, 'utf-8');
    const state = JSON.parse(content);

    console.log('--- Transcript Analysis Stats ---');
    console.log(`Sessions analyzed:  ${state.processedSessions?.length || 0}`);
    console.log(`Insights extracted: ${state.stats?.insightsExtracted || 0}`);
    console.log(`MEMORY.md updates:  ${state.stats?.memoryUpdates || 0}`);
    console.log(`Last analysis:      ${state.stats?.lastAnalysisAt ? new Date(state.stats.lastAnalysisAt).toLocaleString() : 'never'}`);
    console.log(`State saved:        ${state.lastSaved ? new Date(state.lastSaved).toLocaleString() : 'never'}`);
  } catch {
    console.log('No analysis state found. Run analyze-transcripts to start.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  if (flags.verbose) console.error(err);
  process.exit(1);
});
