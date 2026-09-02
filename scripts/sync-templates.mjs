#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');
const templatesRoot = path.join(repoRoot, 'templates');

const CLAUDE_ROOT = path.join(templatesRoot, '.claude');
const GEMINI_ROOT = path.join(templatesRoot, '.gemini');
const CODEX_ROOT = path.join(templatesRoot, '.codex');
const CURSOR_ROOT = path.join(templatesRoot, '.cursor');

const GEMINI_SKILL_OVERRIDES = new Set([
  // Gemini versions differ materially from Claude versions
  'dialectical-autocoder',
  'task-processor-parallel',
]);

const CODEX_SKILLS_ALLOWLIST = new Set([
  // Codex supports skills but not Claude-style subagents.
  // Keep this list small and only include skills we validate.
  'brain-message-inbox',
  'changelog-manager',
  'cross-brain-message',
  'dev-workflow-orchestrator',
  'pr-review-loop',
  'prd-writer',
  'production-readiness',
  'runbook-generator',
  'task-processor',
  'task-processor-auto',
  'tasklist-generator',
  'test-plan-generator',
  'transcript-query',
  'user-journey-mapper',
  'user-story-generator',
]);

const CURSOR_SKILLS_ALLOWLIST = new Set([
  // Cursor agent skills — auto-applied based on description.
  // Exclude brain-*, agent-teams, heartbeat-manager, memory-manager,
  // self-replicator, and task-processor-parallel (Claude subagent-specific).
  //
  // Entries marked [future] do not yet exist in templates/.claude/skills/.
  // They are pre-reserved so the skill auto-populates when added; buildExpectedOutputs
  // silently skips missing source dirs so check-templates still passes in the interim.
  'adversarial-reviewer',
  'api-integrator',
  'changelog-manager',
  'decision-review',
  'design-system-from-reference',
  'design-system-implementation',
  'dev-workflow-orchestrator',
  'dialectical-autocoder',
  'docs-generator',         // [future]
  'frontend-design-concept',
  'git-conflict-resolver',  // [future]
  'info-processor',
  'landing-page-generator',
  'launch-checklist',
  'pattern-extractor',
  'pr-review-loop',
  'prd-writer',
  'production-readiness',
  'runbook-generator',
  'safe-deployment',        // [future]
  'security-audit',         // [future]
  'self-improvement',
  'skill-creator',
  'task-processor',
  'task-processor-auto',
  'tasklist-generator',
  'test-plan-generator',
  'transcript-query',
  'user-journey-mapper',
  'user-story-generator',
  'web-browse',             // [future]
]);

const AUTO_GENERATED_HEADER = '<!-- AUTO-GENERATED';
const TIMEFRAME_PATTERN = /\b(\d+\s*[-–]\s*\d+|\d+)\s*(minutes?|hours?|days?|weeks?|months?)\b|\b(within|in|after|before)\s+\d+\s*(minutes?|hours?|days?|weeks?|months?)\b|\b(sprint|day|week)\s+\d+\b|\b(Q[1-4])\b/i;
const TIMEFRAME_IGNORE_PATTERN = /\b(rate\s*limit|timeout|ttl|interval|heartbeat|cron|lease|retry|cache|token|expires?|test|tests|test case)\b/i;
const NO_ARBITRARY_TIMEFRAME_SKILLS = new Set([
  'prd-writer',
  'tasklist-generator',
  'user-story-generator',
]);

function parseArgs(argv) {
  return {
    check: argv.includes('--check'),
    verbose: argv.includes('--verbose'),
  };
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listChildDirs(p) {
  if (!isDirectory(p)) return [];
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function listFilesRecursively(rootDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  walk(rootDir);
  return out.sort();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function normalizeNewlines(s) {
  // Keep output stable across platforms.
  return s.replace(/\r\n/g, '\n');
}


function transformForGemini(content) {
  let out = normalizeNewlines(content);

  // Path references
  out = out.replace(/\.claude\//g, '.gemini/');

  // Branding (minimal + intentionally conservative)
  out = out.replace(/\bClaude Code\b/g, 'Gemini CLI');
  out = out.replace(/\bClaude\b(?=\s+is\s+capable\b)/g, 'Gemini');

  return out;
}

function transformForCodex(content) {
  let out = normalizeNewlines(content);

  // Codex skills live under .codex/skills.
  out = out.replace(/\.claude\/skills\//g, '.codex/skills/');

  // Codex does not use Claude-style subagents.
  // Drop standalone agent-reference lines rather than leaving broken paths.
  // Note: this is intentionally conservative; if a future doc line combines an agent reference
  // with other content, prefer splitting that line in the source template.
  out = out
    .split('\n')
    .filter((line) => !line.includes('.claude/agents/'))
    .join('\n');

  // Branding where it is explicitly Claude Code
  out = out.replace(/\bClaude Code\b/g, 'Codex');

  return out;
}

function transformForCursor(content) {
  let out = normalizeNewlines(content);

  // Path references
  out = out.replace(/\.claude\/skills\//g, '.cursor/skills/');

  // Cursor does not use Claude-style subagents — drop agent-reference lines.
  out = out
    .split('\n')
    .filter((line) => !line.includes('.claude/agents/'))
    .join('\n');

  // Branding
  out = out.replace(/\bClaude Code\b/g, 'Cursor');

  // Strip `category:` from YAML frontmatter — Cursor only reads name + description.
  // Assumes at most one `category:` field per frontmatter block (current convention).
  out = out.replace(/^(---\n[\s\S]*?)^category:.*\n([\s\S]*?^---)/m, '$1$2');

  return out;
}

function sanitizeNoArbitraryTimeframes(content) {
  const lines = normalizeNewlines(content).split('\n');
  const sanitized = lines.map((line) => {
    if (!TIMEFRAME_PATTERN.test(line)) return line;
    if (TIMEFRAME_IGNORE_PATTERN.test(line)) return line;
    if (/No Arbitrary Timeframes/i.test(line)) return line;

    let out = line;
    out = out.replace(/\b(within|in|after|before)\s+\d+\s*(minutes?|hours?|days?|weeks?|months?)\b/gi, 'with appropriate urgency');
    out = out.replace(/\b\d+\s*[-–]\s*\d+\s*(minutes?|hours?|days?|weeks?|months?)\b/gi, 'small-to-medium complexity');
    out = out.replace(/\b\d+\s*(minutes?|hours?|days?|weeks?|months?)\b/gi, 'appropriate complexity');
    out = out.replace(/\b(sprint|day|week)\s+\d+\b/gi, 'phase');
    out = out.replace(/\bQ[1-4]\b/gi, 'the planned release window');
    return out;
  });

  return sanitized.join('\n');
}

function findArbitraryTimeframes(content) {
  const findings = [];
  const lines = normalizeNewlines(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!TIMEFRAME_PATTERN.test(line)) continue;
    if (TIMEFRAME_IGNORE_PATTERN.test(line)) continue;
    if (/No Arbitrary Timeframes/i.test(line)) continue;
    findings.push({ line: i + 1, text: line.trim() });
  }
  return findings;
}

function skillNameFromPath(filePath) {
  return path.basename(path.dirname(filePath));
}

function parseFrontmatter(content) {
  // Extract YAML frontmatter from markdown
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const metadata = {};

  for (const line of yaml.split('\n')) {
    const [key, ...valueParts] = line.split(':');
    if (key && valueParts.length > 0) {
      const value = valueParts.join(':').trim();
      metadata[key.trim()] = value;
    }
  }

  return metadata;
}

function shouldAutoGenerate(skillContent) {
  const metadata = parseFrontmatter(skillContent);
  // Default to true if not specified
  return metadata.auto_generate !== 'false';
}

function generateCommand(skillName, skillContent, platform = 'claude') {
  const metadata = parseFrontmatter(skillContent);
  const description = metadata.description || `Run the ${skillName} skill`;
  const skillRoot = platform === 'gemini' ? '.gemini/skills' : '.claude/skills';

  return `<!-- AUTO-GENERATED from ${skillRoot}/${skillName}/SKILL.md -->
---
name: ${skillName}
description: ${description}
---

# ${titleCase(skillName)} Command

${description.charAt(0).toUpperCase() + description.slice(1)}.

## Usage

\`\`\`
/${skillName}
\`\`\`

## What It Does

This command invokes the \`${skillName}\` skill. See the skill documentation for detailed process steps.

## Skill Reference

This command invokes: \`@skills/${skillName}\`

See \`${skillRoot}/${skillName}/SKILL.md\` and \`${skillRoot}/${skillName}/reference.md\` for full documentation.
`;
}

function generateWorkflow(skillName, skillContent) {
  const metadata = parseFrontmatter(skillContent);
  const description = metadata.description || `Run the ${skillName} skill`;

  // Extract ## Process section from SKILL.md
  const processMatch = skillContent.match(/## Process\n\n([\s\S]*?)(?=\n## |$)/);
  const processSteps = processMatch ? processMatch[1].trim() : 'See @skills/' + skillName + '/SKILL.md for process steps.';

  // Extract ## Input and ## Output sections
  const inputMatch = skillContent.match(/## Input\n([\s\S]*?)(?=\n## |$)/);
  const outputMatch = skillContent.match(/## Output\n([\s\S]*?)(?=\n## |$)/);

  const inputSection = inputMatch ? inputMatch[1].trim() : 'See skill documentation';
  const outputSection = outputMatch ? outputMatch[1].trim() : 'See skill documentation';

  return `<!-- AUTO-GENERATED from .claude/skills/${skillName}/SKILL.md -->
# ${titleCase(skillName)}

${description.charAt(0).toUpperCase() + description.slice(1)}.

## Input
${inputSection}

## Steps

${processSteps}

## Output
${outputSection}

## Reference

Use @skills/${skillName}/SKILL.md for detailed process documentation.
`;
}

function generateAiDevTask(skillName, skillContent) {
  // For ai-dev-tasks, we create a simplified "Rule" format
  const metadata = parseFrontmatter(skillContent);
  const description = metadata.description || `Run the ${skillName} skill`;

  // Extract Goal, Input, Output, Process sections
  const goalMatch = skillContent.match(/## Goal\n([\s\S]*?)(?=\n## |$)/);
  const inputMatch = skillContent.match(/## Input\n([\s\S]*?)(?=\n## |$)/);
  const outputMatch = skillContent.match(/## Output\n([\s\S]*?)(?=\n## |$)/);
  const processMatch = skillContent.match(/## Process\n\n([\s\S]*?)(?=\n## |$)/);

  const goal = goalMatch ? goalMatch[1].trim() : description;
  const input = inputMatch ? inputMatch[1].trim() : 'See documentation';
  const output = outputMatch ? outputMatch[1].trim() : 'See documentation';
  const process = processMatch ? processMatch[1].trim() : 'See SKILL.md';

  return `<!-- AUTO-GENERATED from .claude/skills/${skillName}/SKILL.md -->
# Rule: ${titleCase(skillName)}

## Goal

${goal}

## Output

${output}

## Process

${process}

---

*This is an auto-generated reference. For full documentation, see \`.claude/skills/${skillName}/SKILL.md\`.*
`;
}

function titleCase(str) {
  return str
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function isAutoGeneratedFile(filePath) {
  if (!isFile(filePath)) return false;
  return readUtf8(filePath).startsWith(AUTO_GENERATED_HEADER);
}

function writeIfMissingOrManaged(filePath, content, verbose, label) {
  const existed = isFile(filePath);
  if (!existed || isAutoGeneratedFile(filePath)) {
    fs.writeFileSync(filePath, content);
    if (verbose) console.log(`${existed ? 'updated' : 'generated'} ${label}: ${path.basename(filePath)}`);
    return true;
  }
  return false;
}

function buildExpectedSupportingOutputs() {
  const expectedFiles = new Map();
  const expectedDirs = new Set();
  const srcSkillsRoot = path.join(CLAUDE_ROOT, 'skills');
  const claudeCommandsDir = path.join(CLAUDE_ROOT, 'commands');
  const aiDevTasksDir = path.join(templatesRoot, 'ai-dev-tasks');

  expectedDirs.add(claudeCommandsDir);
  expectedDirs.add(aiDevTasksDir);

  for (const skillName of listChildDirs(srcSkillsRoot)) {
    const skillMdPath = path.join(srcSkillsRoot, skillName, 'SKILL.md');
    if (!isFile(skillMdPath)) continue;

    const skillContent = readUtf8(skillMdPath);
    if (!shouldAutoGenerate(skillContent)) continue;

    const claudeCommandPath = path.join(claudeCommandsDir, `${skillName}.md`);
    if (isFile(claudeCommandPath) && !isAutoGeneratedFile(claudeCommandPath)) continue;
    expectedFiles.set(claudeCommandPath, generateCommand(skillName, skillContent, 'claude'));
    expectedDirs.add(path.dirname(claudeCommandPath));

    const aiDevTaskPath = path.join(aiDevTasksDir, `${skillName}.md`);
    if (!isFile(aiDevTaskPath) || isAutoGeneratedFile(aiDevTaskPath)) {
      expectedFiles.set(aiDevTaskPath, generateAiDevTask(skillName, skillContent));
      expectedDirs.add(path.dirname(aiDevTaskPath));
    }
  }

  return { expectedFiles, expectedDirs };
}

function checkSupportingOutputs({ verbose }) {
  const { expectedFiles, expectedDirs } = buildExpectedSupportingOutputs();
  const problems = [];

  for (const dir of expectedDirs) {
    if (!isDirectory(dir)) problems.push(`Missing dir: ${path.relative(repoRoot, dir)}`);
  }

  for (const [destFile, expected] of expectedFiles.entries()) {
    if (!isFile(destFile)) {
      problems.push(`Missing file: ${path.relative(repoRoot, destFile)}`);
      continue;
    }
    const actual = normalizeNewlines(readUtf8(destFile));
    if (actual !== expected) {
      problems.push(`Out of sync: ${path.relative(repoRoot, destFile)}`);
      if (verbose) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-sync-'));
        const expPath = path.join(tmp, 'expected');
        const actPath = path.join(tmp, 'actual');
        fs.writeFileSync(expPath, expected);
        fs.writeFileSync(actPath, actual);
        problems.push(`  diff: diff -u "${actPath}" "${expPath}"`);
      }
    }
  }

  return problems;
}

function buildExpectedOutputs({ platform, mode }) {
  // mode: 'write' | 'check'
  const expectedFiles = new Map();
  const expectedDirs = new Set();

  const platformRoot =
    platform === 'gemini'
      ? GEMINI_ROOT
      : platform === 'codex'
        ? CODEX_ROOT
        : platform === 'cursor'
          ? CURSOR_ROOT
          : CLAUDE_ROOT;

  const transform =
    platform === 'gemini'
      ? transformForGemini
      : platform === 'codex'
        ? transformForCodex
        : platform === 'cursor'
          ? transformForCursor
          : (s) => normalizeNewlines(s);

  const addDir = (absDir) => expectedDirs.add(absDir);

  const addFile = (absFile, content) => {
    expectedFiles.set(absFile, content);
    addDir(path.dirname(absFile));
  };

  // Agents
  if (platform === 'gemini') {
    const srcAgents = path.join(CLAUDE_ROOT, 'agents');
    const destAgents = path.join(GEMINI_ROOT, 'agents');

    for (const srcFile of listFilesRecursively(srcAgents)) {
      const rel = path.relative(srcAgents, srcFile);
      const destFile = path.join(destAgents, rel);
      const srcContent = readUtf8(srcFile);
      const rendered = srcFile.endsWith('.md') ? transform(srcContent) : srcContent;
      addFile(destFile, rendered);
    }
  }

  // Skills
  if (platform === 'gemini') {
    const srcSkillsRoot = path.join(CLAUDE_ROOT, 'skills');
    const destSkillsRoot = path.join(GEMINI_ROOT, 'skills');

    for (const skillName of listChildDirs(srcSkillsRoot)) {
      if (GEMINI_SKILL_OVERRIDES.has(skillName)) continue;

      const srcSkillDir = path.join(srcSkillsRoot, skillName);
      const destSkillDir = path.join(destSkillsRoot, skillName);
      addDir(destSkillDir);

      for (const srcFile of listFilesRecursively(srcSkillDir)) {
        const rel = path.relative(srcSkillDir, srcFile);
        const destFile = path.join(destSkillDir, rel);
        const srcContent = readUtf8(srcFile);
        let rendered = srcFile.endsWith('.md') ? transform(srcContent) : srcContent;
        if (rel === 'SKILL.md' && NO_ARBITRARY_TIMEFRAME_SKILLS.has(skillName)) {
          rendered = sanitizeNoArbitraryTimeframes(rendered);
        }
        addFile(destFile, rendered);
      }
    }
  }

  // Commands
  if (platform === 'gemini') {
    const srcCommands = path.join(CLAUDE_ROOT, 'commands');
    const destCommands = path.join(GEMINI_ROOT, 'commands');

    for (const srcFile of listFilesRecursively(srcCommands)) {
      const rel = path.relative(srcCommands, srcFile);
      const destFile = path.join(destCommands, rel);
      const srcContent = readUtf8(srcFile);
      const rendered = srcFile.endsWith('.md') ? transform(srcContent) : srcContent;
      addFile(destFile, rendered);
    }
  }

  if (platform === 'codex') {
    const srcSkillsRoot = path.join(CLAUDE_ROOT, 'skills');
    const destSkillsRoot = path.join(CODEX_ROOT, 'skills');

    for (const skillName of listChildDirs(srcSkillsRoot)) {
      if (!CODEX_SKILLS_ALLOWLIST.has(skillName)) continue;

      const srcSkillDir = path.join(srcSkillsRoot, skillName);
      const destSkillDir = path.join(destSkillsRoot, skillName);
      addDir(destSkillDir);

      for (const srcFile of listFilesRecursively(srcSkillDir)) {
        const rel = path.relative(srcSkillDir, srcFile);
        const destFile = path.join(destSkillDir, rel);
        const srcContent = readUtf8(srcFile);
        let rendered = srcFile.endsWith('.md') ? transform(srcContent) : srcContent;
        if (rel === 'SKILL.md' && NO_ARBITRARY_TIMEFRAME_SKILLS.has(skillName)) {
          rendered = sanitizeNoArbitraryTimeframes(rendered);
        }
        addFile(destFile, rendered);
      }
    }
  }

  if (platform === 'cursor') {
    const srcSkillsRoot = path.join(CLAUDE_ROOT, 'skills');
    const destSkillsRoot = path.join(CURSOR_ROOT, 'skills');

    for (const skillName of listChildDirs(srcSkillsRoot)) {
      if (!CURSOR_SKILLS_ALLOWLIST.has(skillName)) continue;

      const srcSkillDir = path.join(srcSkillsRoot, skillName);
      const destSkillDir = path.join(destSkillsRoot, skillName);
      addDir(destSkillDir);

      for (const srcFile of listFilesRecursively(srcSkillDir)) {
        const rel = path.relative(srcSkillDir, srcFile);
        const destFile = path.join(destSkillDir, rel);
        const srcContent = readUtf8(srcFile);
        // Transform is intentionally limited to .md files. Non-MD support files
        // (e.g. .mjs/.js in transcript-query) may contain "Claude Code" in code
        // comments — this is acceptable since those files document Claude-specific
        // functionality (parsing Claude transcripts). Extending the transform to
        // non-MD files risks breaking executable code; revisit per-skill if needed.
        let rendered = srcFile.endsWith('.md') ? transform(srcContent) : srcContent;
        if (rel === 'SKILL.md' && NO_ARBITRARY_TIMEFRAME_SKILLS.has(skillName)) {
          rendered = sanitizeNoArbitraryTimeframes(rendered);
        }
        addFile(destFile, rendered);
      }
    }
  }

  // Ensure root folders exist
  addDir(platformRoot);

  return { expectedFiles, expectedDirs };
}

function verifyNoExtras({ managedRoot, expectedPaths }) {
  // expectedPaths is Set of absolute file/dir paths.
  if (!isDirectory(managedRoot)) return [];

  const extras = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (!expectedPaths.has(abs)) {
        extras.push(abs);
        continue;
      }
      if (entry.isDirectory()) walk(abs);
    }
  };

  walk(managedRoot);
  return extras;
}

function runCheck({ platform, verbose }) {
  const { expectedFiles, expectedDirs } = buildExpectedOutputs({ platform, mode: 'check' });

  const problems = [];

  for (const dir of expectedDirs) {
    if (!isDirectory(dir)) problems.push(`Missing dir: ${path.relative(repoRoot, dir)}`);
  }

  for (const [destFile, expected] of expectedFiles.entries()) {
    if (!isFile(destFile)) {
      problems.push(`Missing file: ${path.relative(repoRoot, destFile)}`);
      continue;
    }
    const actual = normalizeNewlines(readUtf8(destFile));
    if (actual !== expected) {
      problems.push(`Out of sync: ${path.relative(repoRoot, destFile)}`);
      if (verbose) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-sync-'));
        const expPath = path.join(tmp, 'expected');
        const actPath = path.join(tmp, 'actual');
        fs.writeFileSync(expPath, expected);
        fs.writeFileSync(actPath, actual);
        problems.push(`  diff: diff -u "${actPath}" "${expPath}"`);
      }
    }

    if (
      (platform === 'gemini' || platform === 'codex' || platform === 'cursor') &&
      path.basename(destFile) === 'SKILL.md'
    ) {
      const skillName = skillNameFromPath(destFile);
      if (!NO_ARBITRARY_TIMEFRAME_SKILLS.has(skillName)) continue;
      const timeframeFindings = findArbitraryTimeframes(actual);
      for (const finding of timeframeFindings) {
        problems.push(
          `Timeframe policy violation: ${path.relative(repoRoot, destFile)}:${finding.line} "${finding.text}"`
        );
      }
    }
  }

  // Extra files/dirs check (only for managed roots)
  if (platform === 'gemini') {
    const expectedPaths = new Set([...expectedDirs, ...expectedFiles.keys()]);
    const extras = [
      ...verifyNoExtras({ managedRoot: path.join(GEMINI_ROOT, 'agents'), expectedPaths }),
      ...verifyNoExtras({ managedRoot: path.join(GEMINI_ROOT, 'skills'), expectedPaths }),
      ...verifyNoExtras({ managedRoot: path.join(GEMINI_ROOT, 'commands'), expectedPaths }),
    ];
    for (const extra of extras) {
      // Allow overridden skill directories and their contents.
      const rel = path.relative(path.join(GEMINI_ROOT, 'skills'), extra);
      const top = rel.split(path.sep)[0];
      if (top && GEMINI_SKILL_OVERRIDES.has(top)) continue;
      problems.push(`Unexpected extra: ${path.relative(repoRoot, extra)}`);
    }
  }

  if (platform === 'codex') {
    const expectedPaths = new Set([...expectedDirs, ...expectedFiles.keys()]);
    const extras = verifyNoExtras({ managedRoot: path.join(CODEX_ROOT, 'skills'), expectedPaths });
    for (const extra of extras) {
      // Allow other codex files (future) only if outside skills.
      problems.push(`Unexpected extra: ${path.relative(repoRoot, extra)}`);
    }
  }

  if (platform === 'cursor') {
    // Note: no override allowlist for cursor (unlike GEMINI_SKILL_OVERRIDES) — intentional.
    // All cursor skills are fully managed; none have platform-specific overrides today.
    const expectedPaths = new Set([...expectedDirs, ...expectedFiles.keys()]);
    const extras = verifyNoExtras({ managedRoot: path.join(CURSOR_ROOT, 'skills'), expectedPaths });
    for (const extra of extras) {
      problems.push(`Unexpected extra: ${path.relative(repoRoot, extra)}`);
    }
  }
  // Timeframe policy for cursor SKILL.md files is already covered by the shared
  // expectedFiles loop above (which checks platform === 'cursor').

  return problems;
}

function cleanupCodexSkills({ verbose }) {
  const destSkillsRoot = path.join(CODEX_ROOT, 'skills');
  if (!isDirectory(destSkillsRoot)) return;

  for (const skillName of listChildDirs(destSkillsRoot)) {
    if (CODEX_SKILLS_ALLOWLIST.has(skillName)) continue;
    const abs = path.join(destSkillsRoot, skillName);
    fs.rmSync(abs, { recursive: true, force: true });
    if (verbose) console.log('removed', path.relative(repoRoot, abs));
  }
}

function cleanupCursorSkills({ verbose }) {
  const destSkillsRoot = path.join(CURSOR_ROOT, 'skills');
  if (!isDirectory(destSkillsRoot)) return;

  for (const skillName of listChildDirs(destSkillsRoot)) {
    if (CURSOR_SKILLS_ALLOWLIST.has(skillName)) continue;
    const abs = path.join(destSkillsRoot, skillName);
    fs.rmSync(abs, { recursive: true, force: true });
    if (verbose) console.log('removed', path.relative(repoRoot, abs));
  }
}

function deprecatedTemplateRoots() {
  return [
    path.join(GEMINI_ROOT, 'agents'),
    path.join(GEMINI_ROOT, 'commands'),
    path.join(GEMINI_ROOT, 'skills'),
    path.join(CODEX_ROOT, 'skills'),
    path.join(CURSOR_ROOT, 'skills'),
    path.join(templatesRoot, '.windsurf', 'workflows'),
  ];
}

function removeDeprecatedTemplateTrees({ verbose }) {
  for (const abs of deprecatedTemplateRoots()) {
    if (!fs.existsSync(abs)) continue;
    fs.rmSync(abs, { recursive: true, force: true });
    if (verbose) console.log('removed', path.relative(repoRoot, abs));
  }
}

function checkDeprecatedTemplateTrees() {
  const problems = [];
  for (const abs of deprecatedTemplateRoots()) {
    if (fs.existsSync(abs)) {
      problems.push(`Deprecated template tree still present: ${path.relative(repoRoot, abs)}`);
    }
  }
  return problems;
}

function runWrite({ platform, verbose }) {
  const { expectedFiles, expectedDirs } = buildExpectedOutputs({ platform, mode: 'write' });

  for (const dir of expectedDirs) ensureDir(dir);

  // Write files
  for (const [destFile, content] of expectedFiles.entries()) {
    ensureDir(path.dirname(destFile));
    fs.writeFileSync(destFile, content);
    if (verbose) console.log('wrote', path.relative(repoRoot, destFile));
  }

  if (platform === 'codex') cleanupCodexSkills({ verbose });
  if (platform === 'cursor') cleanupCursorSkills({ verbose });
}

function autoGenerateSupportingFiles({ verbose }) {
  const srcSkillsRoot = path.join(CLAUDE_ROOT, 'skills');
  const claudeCommandsDir = path.join(CLAUDE_ROOT, 'commands');
  const aiDevTasksDir = path.join(templatesRoot, 'ai-dev-tasks');

  ensureDir(claudeCommandsDir);
  ensureDir(aiDevTasksDir);

  let generated = 0;

  for (const skillName of listChildDirs(srcSkillsRoot)) {
    const skillMdPath = path.join(srcSkillsRoot, skillName, 'SKILL.md');
    if (!isFile(skillMdPath)) continue;

    const skillContent = readUtf8(skillMdPath);
    if (!shouldAutoGenerate(skillContent)) {
      if (verbose) console.log(`skip (auto_generate: false): ${skillName}`);
      continue;
    }

    // Generate/update command wrappers for Claude.
    const claudeCommandPath = path.join(claudeCommandsDir, `${skillName}.md`);
    if (writeIfMissingOrManaged(claudeCommandPath, generateCommand(skillName, skillContent, 'claude'), verbose, 'command')) {
      generated++;
    }

    // Generate/update ai-dev-task when the file is missing or managed.
    const aiDevTaskPath = path.join(aiDevTasksDir, `${skillName}.md`);
    if (writeIfMissingOrManaged(aiDevTaskPath, generateAiDevTask(skillName, skillContent), verbose, 'ai-dev-task')) {
      generated++;
    }
  }

  if (verbose || generated > 0) {
    console.log(`Auto-generated ${generated} supporting files from SKILL.md`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.check) {
    const allProblems = [
      ...checkSupportingOutputs({ verbose: args.verbose }),
      ...checkDeprecatedTemplateTrees(),
    ];

    if (allProblems.length > 0) {
      console.error('Templates are out of sync:\n' + allProblems.map((p) => `- ${p}`).join('\n'));
      process.exit(1);
    }

    console.log('Templates are in sync.');
    return;
  }

  // Auto-generate supporting files from Claude skills (commands, workflows, ai-dev-tasks)
  autoGenerateSupportingFiles({ verbose: args.verbose });
  removeDeprecatedTemplateTrees({ verbose: args.verbose });

  console.log('Sync complete.');
}

try {
  main();
} catch (err) {
  console.error('❌ sync-templates failed:', err?.stack || err?.message || String(err));
  process.exit(1);
}
