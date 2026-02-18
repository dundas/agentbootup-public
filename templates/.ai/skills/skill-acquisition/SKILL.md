# Skill Acquisition

**Purpose**: Systematically learn new capabilities, test them thoroughly, and save them as permanent skills.

## When to Use

Trigger this skill when:
- Encountering a novel task or integration
- Building a reusable workflow for the first time
- Creating a new capability that should be permanently available
- User says "learn this" or "create a skill for this"

## Workflow

### Phase 0: Check Existing Skills (MANDATORY)

**CRITICAL**: Always check existing skills before building new ones!

1. **List existing skills**:
   ```bash
   ls .ai/skills/
   ls .claude/skills/  # If using Claude Code
   ls .gemini/skills/  # If using Gemini CLI
   ```

2. **Review skill documentation**:
   - Read SKILL.md for each potentially relevant skill
   - Check what capabilities already exist
   - Look for similar patterns or workflows

3. **Check memory**:
   - Review `memory/MEMORY.md` Skills Acquired section
   - Verify skill isn't already documented

4. **Consider skill composition**:
   - Can existing skills be combined to solve this?
   - Is extending an existing skill better than creating new?

5. **Decision point**:
   - ✅ **Proceed to Phase 1** if no existing skill covers this capability
   - ❌ **Use existing skill** if functionality already exists
   - ❌ **Compose skills** if combination solves the problem

**Common mistake**: Building a skill that duplicates existing functionality. Always search first!

### Phase 1: Discovery
1. Identify the new capability needed
2. **Confirm no existing skills cover it** (Phase 0 complete ✓)
3. Research relevant documentation/APIs
4. Document key requirements and constraints

### Phase 2: Implementation
1. Build working proof-of-concept
2. Test with realistic scenarios
3. Handle edge cases and errors
4. Refine based on test results

### Phase 3: Documentation
1. Create skill directory: `.claude/skills/skill-name/`
2. Write SKILL.md with:
   - Purpose and use cases
   - Step-by-step workflow
   - Examples
   - Common pitfalls
3. Create reference.md with:
   - API documentation
   - Configuration options
   - Technical details
4. Add examples/ directory if needed

### Phase 4: Integration
1. Test skill in real scenario
2. Update `memory/MEMORY.md` with new capability
3. Add to skills list in MEMORY.md
4. Announce skill availability
5. Log to daily notes

## Template Structure

```
.claude/skills/skill-name/
├── SKILL.md         # User-facing documentation
├── reference.md     # Technical reference
└── examples/        # Example files (optional)
    └── example-1.md
```

## SKILL.md Template

```markdown
# Skill Name

**Purpose**: [One-line description]

## When to Use

Trigger this skill when:
- [Trigger condition 1]
- [Trigger condition 2]
- User says "[trigger phrase]"

## Workflow

### Phase 1: [Phase Name]
1. [Step 1]
2. [Step 2]

### Phase 2: [Phase Name]
1. [Step 1]
2. [Step 2]

## Examples

### Example 1: [Scenario]
\`\`\`
[Example code or commands]
\`\`\`

## Common Pitfalls

- **Issue**: [Problem description]
  - **Solution**: [How to fix]

## Related Skills

- [Related skill 1]
- [Related skill 2]
```

## reference.md Template

```markdown
# Skill Name - Technical Reference

## API Documentation

### Function/Endpoint 1
- **Purpose**: [Description]
- **Parameters**: [Parameter details]
- **Returns**: [Return value]
- **Example**: [Code example]

## Configuration

### Environment Variables
- `VAR_NAME` - [Description]

### Config File
- `config.key` - [Description]

## Implementation Details

### Key Functions
- `functionName()` - [What it does]

### Error Handling
- [Error type] - [How it's handled]

## Testing

### Test Cases
1. [Test scenario 1]
2. [Test scenario 2]

### Validation
\`\`\`bash
# Commands to validate skill works
\`\`\`
```

## Decision Framework

### When to Create a New Skill

**FIRST: Check existing skills** (see Phase 0 above)

**Create a skill if ALL of these are true**:
- ✅ Task is repeatable and reusable
- ✅ Involves specific API/tool knowledge
- ✅ Has clear workflow steps
- ✅ Benefits from documentation
- ✅ **No existing skill provides this capability** (MANDATORY CHECK)
- ✅ **Cannot be achieved by composing existing skills** (MANDATORY CHECK)

**Don't create a skill if ANY of these are true**:
- ❌ One-time task with no reuse potential
- ❌ Too simple (basic file operations)
- ❌ **Already covered by existing skill** (ALWAYS CHECK FIRST!)
- ❌ **Can be solved by combining existing skills**
- ❌ Still experimental/not validated
- ❌ Duplicates existing functionality

### Skill Naming Conventions

- Use lowercase with hyphens: `skill-name`
- Be specific: `github-pr-review` not just `github`
- Action-oriented: `deploy-to-cloudflare` not `cloudflare-deployment`

## Integration with Memory

After creating a skill:

1. **Update MEMORY.md**:
```markdown
## Skills Acquired

**[Category]**: skill-name, ...

### skill-name
- **Purpose**: [One-line description]
- **Created**: YYYY-MM-DD
- **Usage**: [When to use]
```

2. **Update daily log**:
```markdown
## Skills Created

### skill-name
**Purpose**: [Description]

**Decision**: Created because [reasoning]

**Testing**: [Test results]

**Status**: Production-ready ✅
```

## Quality Checklist

Before marking skill complete:

- [ ] Implementation tested with realistic data
- [ ] SKILL.md includes clear trigger conditions
- [ ] reference.md documents all APIs/config
- [ ] Examples demonstrate key use cases
- [ ] Error handling covers edge cases
- [ ] MEMORY.md updated with new capability
- [ ] Daily log documents creation decision
- [ ] Skill works without manual intervention

## Examples

### Example: Creating API Integration Skill

```
0. Check Existing Skills Phase:
   - ls .ai/skills/ → Found: mech-storage, mech-llms, mech-reader
   - Review: None cover this specific API
   - Decision: No existing skill covers this, proceed to Phase 1 ✓

1. Discovery Phase:
   - Need: Integrate with new external API
   - Research: Read API docs, test endpoints
   - Requirements: Auth, rate limiting, error handling

2. Implementation Phase:
   - Build: HTTP client with auth headers
   - Test: Real API calls, error scenarios
   - Refine: Add retry logic, better errors

3. Documentation Phase:
   - Create: .claude/skills/api-name-integration/
   - Write: SKILL.md with workflow steps
   - Document: reference.md with endpoints

4. Integration Phase:
   - Test: Use in real scenario
   - Update: MEMORY.md with new capability
   - Log: Daily notes with decision rationale
```

## Common Pitfalls

- **Issue**: Creating duplicate skills without checking existing ones
  - **Solution**: ALWAYS run Phase 0 - check existing skills first!
  - **Impact**: Wastes time, creates confusion, maintenance burden

- **Issue**: Creating skills for one-off tasks
  - **Solution**: Only create skills for reusable capabilities

- **Issue**: Not checking if skills can be composed
  - **Solution**: Consider combining existing skills before building new

- **Issue**: Insufficient testing before saving
  - **Solution**: Test with realistic data, edge cases

- **Issue**: Poor documentation
  - **Solution**: Include examples, common errors, clear triggers

- **Issue**: Forgetting to update MEMORY.md
  - **Solution**: Make memory update part of workflow

## Related Skills

- `memory-manager` - Manages persistent memory system
- `autonomous-improver` - Uses skills for continuous improvement
- `dev-workflow-orchestrator` - Orchestrates complex development tasks
