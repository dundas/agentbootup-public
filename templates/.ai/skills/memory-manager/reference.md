# Memory Manager - Technical Reference

## File Paths

### Memory Directory Structure
```
memory/
├── MEMORY.md              # Core knowledge (always loaded)
└── daily/
    ├── TEMPLATE.md        # Daily log template
    ├── 2026-02-05.md     # Today's log
    └── YYYY-MM-DD.md     # Historical logs
```

### Absolute Paths
- Memory root: `${CWD}/memory/`
- Core knowledge: `${CWD}/memory/MEMORY.md`
- Daily logs: `${CWD}/memory/daily/`
- Template: `${CWD}/memory/daily/TEMPLATE.md`

## Memory Operations

### Read Operations

**Load MEMORY.md**:
```javascript
import { readFile } from 'fs/promises';
import path from 'path';

const memoryPath = path.join(process.cwd(), 'memory/MEMORY.md');
const memory = await readFile(memoryPath, 'utf-8');
```

**Load Today's Log**:
```javascript
const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
const logPath = path.join(process.cwd(), `memory/daily/${today}.md`);

let log;
try {
  log = await readFile(logPath, 'utf-8');
} catch (err) {
  // Create from template if doesn't exist
  const template = await readFile(
    path.join(process.cwd(), 'memory/daily/TEMPLATE.md'),
    'utf-8'
  );
  log = template.replace(/YYYY-MM-DD/g, today);
}
```

### Write Operations

**Update MEMORY.md**:
```javascript
import { readFile, writeFile } from 'fs/promises';

// Read current content
const memoryPath = path.join(process.cwd(), 'memory/MEMORY.md');
let memory = await readFile(memoryPath, 'utf-8');

// Add new content to appropriate section
// Example: Adding to "Critical Learnings"
const newLearning = `
### New Pattern
- **Description**: Pattern details here
`;

// Find section and append
const section = '## Critical Learnings';
const sectionIndex = memory.indexOf(section);
const nextSectionIndex = memory.indexOf('\n##', sectionIndex + section.length);
const beforeSection = memory.slice(0, nextSectionIndex);
const afterSection = memory.slice(nextSectionIndex);
memory = beforeSection + '\n' + newLearning + afterSection;

// Write back
await writeFile(memoryPath, memory, 'utf-8');
```

**Append to Daily Log**:
```javascript
import { appendFile } from 'fs/promises';

const today = new Date().toISOString().split('T')[0];
const logPath = path.join(process.cwd(), `memory/daily/${today}.md`);

const entry = `
## New Section
- Entry detail 1
- Entry detail 2
`;

await appendFile(logPath, entry, 'utf-8');
```

### Update Operations

**Add Skill to MEMORY.md**:
```javascript
async function addSkillToMemory(skillName, skillPurpose, skillCategory) {
  const memoryPath = path.join(process.cwd(), 'memory/MEMORY.md');
  let memory = await readFile(memoryPath, 'utf-8');

  // Find Skills Acquired section
  const section = '## Skills Acquired';
  const sectionMatch = memory.match(new RegExp(`${section}.*?\n\n`, 's'));

  if (!sectionMatch) {
    throw new Error('Skills Acquired section not found in MEMORY.md');
  }

  // Parse skill count
  const countMatch = sectionMatch[0].match(/\((\d+)\)/);
  const currentCount = countMatch ? parseInt(countMatch[1]) : 0;
  const newCount = currentCount + 1;

  // Update count
  memory = memory.replace(
    `${section} (${currentCount})`,
    `${section} (${newCount})`
  );

  // Find category line
  const categoryLine = `**${skillCategory}**:`;
  const categoryIndex = memory.indexOf(categoryLine);

  if (categoryIndex === -1) {
    // Create new category
    const newCategory = `\n**${skillCategory}**: ${skillName}`;
    memory = memory.replace(section, `${section}\n${newCategory}`);
  } else {
    // Add to existing category
    const lineEndIndex = memory.indexOf('\n', categoryIndex);
    const beforeLine = memory.slice(0, lineEndIndex);
    const afterLine = memory.slice(lineEndIndex);
    memory = beforeLine + `, ${skillName}` + afterLine;
  }

  // Add skill details
  const skillDetail = `
### ${skillName}
- **Purpose**: ${skillPurpose}
- **Created**: ${new Date().toISOString().split('T')[0]}
- **Location**: \`.claude/skills/${skillName}/\`
`;

  const nextSection = memory.indexOf('\n##', memory.indexOf(section) + 1);
  memory = memory.slice(0, nextSection) + skillDetail + memory.slice(nextSection);

  await writeFile(memoryPath, memory, 'utf-8');
}

// Usage
await addSkillToMemory(
  'skill-acquisition',
  'Systematically learn new capabilities and save as permanent skills',
  'Automation'
);
```

## Hook Integration

### session_start.mjs Enhancement

Add memory loading to session start:

```javascript
#!/usr/bin/env bun

import { readFile } from 'fs/promises';
import path from 'path';

export async function handleSessionStart(input) {
  try {
    // Existing session start logic...

    // Load memory for context
    const memoryPath = path.join(process.cwd(), 'memory/MEMORY.md');
    try {
      const memory = await readFile(memoryPath, 'utf-8');
      console.log('[SessionStart] Memory loaded successfully');

      // Memory is now available in Claude's context
      // It will be included in the first turn
    } catch (err) {
      console.log('[SessionStart] No memory file found (first run?)');
    }

    // Load today's log
    const today = new Date().toISOString().split('T')[0];
    const logPath = path.join(process.cwd(), `memory/daily/${today}.md`);
    try {
      const log = await readFile(logPath, 'utf-8');
      console.log('[SessionStart] Today\'s log loaded');
    } catch (err) {
      console.log('[SessionStart] Starting new daily log');
    }

    // Existing session start logic continues...
  } catch (error) {
    console.error('[SessionStart] Error:', error);
  }
}

// Entry point
const input = JSON.parse(process.argv[2] || '{}');
await handleSessionStart(input);
```

### session_end.mjs Enhancement

Add memory updating to session end:

```javascript
#!/usr/bin/env bun

import { appendFile, readFile, writeFile } from 'fs/promises';
import path from 'path';

export async function handleSessionEnd(input) {
  try {
    // Existing session end logic...

    // Update daily log
    const today = new Date().toISOString().split('T')[0];
    const logPath = path.join(process.cwd(), `memory/daily/${today}.md`);

    // Create session summary
    const summary = `
---

## Session End: ${new Date().toISOString()}

**Duration**: ${input.duration || 'unknown'}

**Activities**: ${input.activities || 'Session activities logged in timeline'}

**Next**: Continue from work queue

`;

    await appendFile(logPath, summary, 'utf-8');
    console.log('[SessionEnd] Memory updated successfully');

    // Existing session end logic continues...
  } catch (error) {
    console.error('[SessionEnd] Error updating memory:', error);
  }
}

// Entry point
const input = JSON.parse(process.argv[2] || '{}');
await handleSessionEnd(input);
```

### stop.mjs Enhancement

Add learning capture to stop hook:

```javascript
#!/usr/bin/env bun

import { appendFile } from 'fs/promises';
import path from 'path';

export async function handleStop(input) {
  try {
    // Existing stop hook logic (timeline update)...

    // Check if this response included significant learnings
    const response = input.last_response || '';

    // Pattern matching for learning indicators
    const hasLearning = response.match(
      /learned|discovered|found that|realized|key insight/i
    );

    if (hasLearning) {
      const today = new Date().toISOString().split('T')[0];
      const logPath = path.join(process.cwd(), `memory/daily/${today}.md`);

      // Extract learning context
      const timestamp = new Date().toISOString();
      const entry = `
## Learning Captured: ${timestamp}

${response.slice(0, 500)}...

_Captured automatically by stop hook_
`;

      await appendFile(logPath, entry, 'utf-8');
      console.log('[Stop] Learning captured to memory');
    }

    // Existing stop hook logic continues...
  } catch (error) {
    console.error('[Stop] Error capturing learning:', error);
  }
}

// Entry point
const input = JSON.parse(process.argv[2] || '{}');
await handleStop(input);
```

## Memory Analysis

### Line Count Check

```javascript
import { readFile } from 'fs/promises';

async function checkMemorySize() {
  const memoryPath = path.join(process.cwd(), 'memory/MEMORY.md');
  const memory = await readFile(memoryPath, 'utf-8');
  const lines = memory.split('\n');

  console.log(`MEMORY.md has ${lines.length} lines`);

  if (lines.length > 200) {
    console.warn('⚠️  MEMORY.md exceeds 200 lines - consider pruning');
  }

  return lines.length;
}
```

### Section Extraction

```javascript
async function extractSection(sectionName) {
  const memoryPath = path.join(process.cwd(), 'memory/MEMORY.md');
  const memory = await readFile(memoryPath, 'utf-8');

  const sectionStart = memory.indexOf(`## ${sectionName}`);
  if (sectionStart === -1) return null;

  const nextSection = memory.indexOf('\n##', sectionStart + 1);
  const sectionEnd = nextSection === -1 ? memory.length : nextSection;

  return memory.slice(sectionStart, sectionEnd);
}

// Usage
const criticalLearnings = await extractSection('Critical Learnings');
```

## Backup and Recovery

### Create Backup

```javascript
import { copyFile } from 'fs/promises';

async function backupMemory() {
  const memoryPath = path.join(process.cwd(), 'memory/MEMORY.md');
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const backupPath = path.join(
    process.cwd(),
    `memory/.backups/MEMORY-${timestamp}.md`
  );

  await copyFile(memoryPath, backupPath);
  console.log(`Backup created: ${backupPath}`);
}
```

### Restore from Backup

```javascript
import { copyFile, readdir } from 'fs/promises';

async function restoreMemory(backupTimestamp) {
  const backupPath = path.join(
    process.cwd(),
    `memory/.backups/MEMORY-${backupTimestamp}.md`
  );
  const memoryPath = path.join(process.cwd(), 'memory/MEMORY.md');

  await copyFile(backupPath, memoryPath);
  console.log('Memory restored from backup');
}

async function listBackups() {
  const backupsDir = path.join(process.cwd(), 'memory/.backups/');
  const files = await readdir(backupsDir);
  return files.filter(f => f.startsWith('MEMORY-')).sort().reverse();
}
```

## Performance Optimization

### Lazy Loading

Only load memory when needed:

```javascript
let memoryCache = null;

async function getMemory() {
  if (memoryCache) return memoryCache;

  const memoryPath = path.join(process.cwd(), 'memory/MEMORY.md');
  memoryCache = await readFile(memoryPath, 'utf-8');
  return memoryCache;
}

// Invalidate cache after updates
function invalidateMemoryCache() {
  memoryCache = null;
}
```

### Incremental Updates

Avoid rewriting entire file:

```javascript
import { open } from 'fs/promises';

async function appendToSection(sectionName, content) {
  const memoryPath = path.join(process.cwd(), 'memory/MEMORY.md');
  const memory = await readFile(memoryPath, 'utf-8');

  // Find insertion point
  const sectionStart = memory.indexOf(`## ${sectionName}`);
  const nextSection = memory.indexOf('\n##', sectionStart + 1);

  // Build new content
  const before = memory.slice(0, nextSection);
  const after = memory.slice(nextSection);
  const updated = before + '\n' + content + after;

  // Atomic write
  await writeFile(memoryPath, updated, 'utf-8');
}
```

## Testing

### Validation Tests

```javascript
import { test, expect } from 'bun:test';

test('MEMORY.md has required sections', async () => {
  const memory = await readFile('memory/MEMORY.md', 'utf-8');

  expect(memory).toContain('## Core Identity');
  expect(memory).toContain('## Operational Protocols');
  expect(memory).toContain('## Skills Acquired');
  expect(memory).toContain('## Standing Orders');
});

test('MEMORY.md is under 200 lines', async () => {
  const memory = await readFile('memory/MEMORY.md', 'utf-8');
  const lines = memory.split('\n');

  expect(lines.length).toBeLessThanOrEqual(200);
});

test('Daily log template exists', async () => {
  const template = await readFile('memory/daily/TEMPLATE.md', 'utf-8');

  expect(template).toContain('YYYY-MM-DD');
  expect(template).toContain('## Session Summary');
  expect(template).toContain('## Technical Decisions');
});
```

## Error Handling

### Graceful Degradation

```javascript
async function safeMemoryUpdate(updateFn) {
  try {
    await updateFn();
  } catch (error) {
    console.error('[Memory] Update failed:', error);
    // Don't throw - memory updates should never break execution
    // Log to timeline instead
    await logToTimeline('memory_update_failed', { error: error.message });
  }
}

// Usage
await safeMemoryUpdate(async () => {
  await addSkillToMemory('new-skill', 'Purpose', 'Category');
});
```

### Recovery Strategies

1. **Corrupted MEMORY.md**: Restore from backup
2. **Missing daily log**: Create from template
3. **Write permission denied**: Log to timeline, notify user
4. **Disk full**: Skip memory update, log warning

## Related Documentation

- `memory/MEMORY.md` - Core knowledge base
- `memory/daily/TEMPLATE.md` - Daily log template
- `.claude/skills/skill-acquisition/` - Skill creation workflow
- `.claude/hooks/session_start.mjs` - Session initialization
- `.claude/hooks/session_end.mjs` - Session cleanup
