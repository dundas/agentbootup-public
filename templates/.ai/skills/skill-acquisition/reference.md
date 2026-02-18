# Skill Acquisition - Technical Reference

## Directory Structure

### Skill Location
```
.claude/skills/
└── skill-name/
    ├── SKILL.md         # User-facing workflow documentation
    ├── reference.md     # Technical implementation details
    └── examples/        # Optional example files
        ├── example-1.md
        └── example-2.md
```

### Memory Location
```
memory/
├── MEMORY.md           # Core knowledge (lists all skills)
└── daily/
    └── YYYY-MM-DD.md   # Daily logs (skill creation details)
```

## File Formats

### SKILL.md Structure
Required sections:
1. **Title and Purpose**: One-line description
2. **When to Use**: Clear trigger conditions
3. **Workflow**: Step-by-step phases
4. **Examples**: Realistic use cases
5. **Common Pitfalls**: Known issues and solutions
6. **Related Skills**: Cross-references

Optional sections:
- **Configuration**: Environment variables, config files
- **Testing**: Validation commands
- **Troubleshooting**: Debugging tips

### reference.md Structure
Required sections:
1. **API Documentation**: Functions, endpoints, parameters
2. **Implementation Details**: Key functions, algorithms
3. **Error Handling**: Error types and handling strategies
4. **Testing**: Test cases and validation

Optional sections:
- **Configuration**: Detailed config options
- **Performance**: Optimization notes
- **Dependencies**: External requirements

## Workflow Implementation

### Phase 1: Discovery
**Purpose**: Understand the problem space and requirements

**Steps**:
1. Check existing skills: `ls .claude/skills/`
2. Research APIs/docs: Read external documentation
3. Document requirements: Create temporary notes
4. Identify constraints: Rate limits, auth, etc.

**Output**: Clear understanding of what needs to be built

### Phase 2: Implementation
**Purpose**: Build and validate the capability

**Steps**:
1. Create proof-of-concept: Quick validation
2. Add error handling: Cover edge cases
3. Test with realistic data: Avoid toy examples
4. Refine based on feedback: Iterate until solid

**Output**: Working, tested implementation

### Phase 3: Documentation
**Purpose**: Make the skill reusable and self-documenting

**Steps**:
1. Create skill directory: `mkdir -p .claude/skills/skill-name`
2. Write SKILL.md: User-facing workflow
3. Write reference.md: Technical details
4. Add examples: Concrete use cases

**Output**: Complete skill documentation

### Phase 4: Integration
**Purpose**: Integrate into memory and make available

**Steps**:
1. Test in real scenario: Validate with production-like data
2. Update MEMORY.md: Add to skills list
3. Log to daily notes: Document decision rationale
4. Announce availability: Let user know it's ready

**Output**: Skill ready for use, memory updated

## Memory Integration

### MEMORY.md Update Pattern

Add to "Skills Acquired" section:

```markdown
## Skills Acquired (N)

**[Category]**: skill-1, skill-2, skill-name

### skill-name
- **Purpose**: [One-line description]
- **Created**: 2026-02-05
- **Usage**: [When to use it]
- **Location**: `.claude/skills/skill-name/`
```

### Daily Log Entry Pattern

Add to current day's log:

```markdown
## Skills Created

### skill-name
**Purpose**: [What it does]

**Decision**: Created because:
- [Reason 1]
- [Reason 2]

**Options considered**:
- ✅ New skill (chosen - reusable, clear workflow)
- ❌ Ad-hoc implementation (rejected - not reusable)

**Testing**:
- [Test 1]: ✅ Passed
- [Test 2]: ✅ Passed

**Status**: Production-ready ✅

**Files created**:
- `.claude/skills/skill-name/SKILL.md`
- `.claude/skills/skill-name/reference.md`
```

## Quality Gates

### Before Creating Skill
- [ ] Task is repeatable (will be used more than once)
- [ ] Has clear workflow steps
- [ ] Doesn't duplicate existing skill
- [ ] Benefits from documentation

### Before Saving Skill
- [ ] Implementation tested with realistic data
- [ ] Error handling covers edge cases
- [ ] SKILL.md has clear trigger conditions
- [ ] reference.md documents all technical details
- [ ] Examples demonstrate key use cases
- [ ] No manual intervention needed to run

### After Creating Skill
- [ ] MEMORY.md updated with new capability
- [ ] Daily log documents creation decision
- [ ] Skill tested in real scenario
- [ ] User notified of new capability

## Naming Conventions

### Directory Names
- Format: `lowercase-with-hyphens`
- Be specific: `github-pr-automation` not `github`
- Action-oriented: `deploy-frontend` not `frontend-deployment`

### File Names
- SKILL.md: Always this exact name
- reference.md: Always this exact name
- Examples: Descriptive, e.g., `example-api-integration.md`

### Skill Categories

Group related skills in MEMORY.md:

- **Development**: Code generation, refactoring, testing
- **Integration**: External API/service integration
- **Automation**: Task automation, CI/CD, deployment
- **Analysis**: Code analysis, debugging, monitoring
- **Documentation**: Doc generation, API docs

## Testing Patterns

### Unit Testing
Test individual functions in isolation:
```bash
bun test lib/skill-implementation.test.js
```

### Integration Testing
Test skill workflow end-to-end:
```bash
# Run through full workflow
# Validate outputs
# Check error handling
```

### Validation Commands
Add to reference.md:
```markdown
## Validation

\`\`\`bash
# Command to verify skill works
./teleportation-cli.cjs skill-name --validate
\`\`\`
```

## Error Handling Standards

### Required Error Coverage
1. **Network errors**: Timeouts, connection failures
2. **Authentication errors**: Invalid credentials, expired tokens
3. **Validation errors**: Invalid input, missing parameters
4. **Rate limiting**: API quota exceeded
5. **Unexpected responses**: Malformed data, server errors

### Error Message Format
```javascript
throw new Error(`[Skill Name] ${errorType}: ${details}`);
```

Example:
```javascript
throw new Error(`[GitHub Integration] Auth failed: Invalid token`);
```

## Performance Considerations

### Optimize for
- **Fast feedback**: Show progress for long operations
- **Minimal API calls**: Cache when possible
- **Graceful degradation**: Fall back on failure
- **Resource cleanup**: Close connections, clear temp files

### Avoid
- **Synchronous blocking**: Use async operations
- **Unbounded loops**: Always have exit conditions
- **Memory leaks**: Clean up resources
- **Silent failures**: Always log errors

## Skill Lifecycle

### Creation
1. Identify need
2. Implement and test
3. Document thoroughly
4. Integrate into memory

### Maintenance
1. Update when APIs change
2. Add examples as use cases emerge
3. Refine based on user feedback
4. Keep documentation current

### Deprecation
1. Mark as deprecated in SKILL.md
2. Document replacement skill
3. Keep for backward compatibility
4. Eventually move to archive/

## Related Documentation

- `memory/MEMORY.md` - Core knowledge base
- `memory/daily/TEMPLATE.md` - Daily log template
- `CLAUDE.md` - Project-wide Claude guidance
- `.claude/skills/autonomous-improver/` - Uses skills for continuous improvement
