<!-- AUTO-GENERATED from .claude/skills/pattern-extractor/SKILL.md -->
# Rule: Pattern Extractor

## Goal

Transform experience into actionable knowledge without manual intervention.

## Output

See documentation

## Process

### 1. Transcript Analysis
- Load transcripts from specified time range (uses transcript-query)
- Parse tool uses, errors, user feedback, outcomes
- Build timeline of activities

### 2. Pattern Detection

**Error Patterns**:
```
Analyze for:
- Tool errors (Read failed, Edit failed, Bash failed)
- Repeated mistakes (same error multiple times)
- Error sequences (Error A → leads to → Error B)
- Root causes (what triggered the error chain)
```

**Success Patterns**:
```
Analyze for:
- Successful completions (task done, tests pass, user approves)
- Techniques that worked (tool sequences, approaches)
- Fast resolutions (problem → solution quickly)
- User praise (positive feedback patterns)
```

**Decision Patterns**:
```
Analyze for:
- Architecture decisions (chose X over Y because Z)
- Trade-offs considered (pros/cons lists)
- Rationale documented (why this approach)
- Alternatives rejected (what was considered but not chosen)
```

### 3. Pattern Categorization

**Anti-Patterns** (things to avoid):
- Frequency: How often does this mistake occur?
- Impact: What's the cost (time lost, bugs introduced)?
- Root cause: Why does this happen?
- Prevention: How to stop it?

**Best Practices** (things to replicate):
- Success rate: How reliably does this work?
- Context: When is this applicable?
- Steps: What's the procedure?
- Metrics: How to measure success?

**Decisions** (for future reference):
- Problem: What was being solved?
- Solution: What was chosen?
- Reasoning: Why was this the best option?
- Outcome: Did it work?

### 4. Knowledge Base Update

**Update technical-patterns.md**:
```markdown

---

*This is an auto-generated reference. For full documentation with examples, see `.claude/skills/pattern-extractor/SKILL.md` and `reference.md`.*
