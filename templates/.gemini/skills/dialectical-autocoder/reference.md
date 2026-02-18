# Dialectical Autocoding - Reference

## Methodology Background

Dialectical autocoding is based on the concept of **adversarial cooperation**—two agents working together through structured opposition to produce higher quality output than either could alone.

## Core Concepts

### The Dialectical Process

```
Thesis     → Player proposes implementation
Antithesis → Coach critiques against requirements
Synthesis  → Improved implementation emerges
```

This mirrors the Hegelian dialectic applied to software development.

### Why Two Agents?

Single-agent autocoding suffers from:
- **Confirmation bias**: Agent validates its own work
- **Context pollution**: Past mistakes influence future attempts
- **Scope creep**: Agent adds features not in requirements
- **Premature satisfaction**: "Good enough" acceptance

Two-agent adversarial loop addresses these through:
- **External validation**: Coach doesn't share player's biases
- **Fresh context**: Each turn starts clean
- **Requirements anchoring**: Coach enforces scope
- **Evidence demands**: Claims require proof

### The Roles

#### Player (Implementation Agent)
- Creative problem-solving
- Code generation
- Test writing
- Evidence gathering

The player is optimistic: "I can solve this."

#### Coach (Validation Agent)
- Requirements comparison
- Gap identification
- Evidence verification
- Approval gating

The coach is skeptical: "Prove it works."

### Turn Mechanics

#### Fresh Context Per Turn
Each agent turn starts with:
- Requirements document (constant)
- Previous verdict and feedback (structured)
- Clean slate for approach

**Technical Implementation:**
- Each turn launches a NEW agent instance via Gemini CLI execution
- Previous conversation history is NOT passed to new instance
- Only structured data carries forward:
  - Requirements path (constant anchor)
  - Previous coach verdict and specific feedback
  - Files changed (for coach to review)
- Agent instances are stateless between turns

This prevents:
- Compounding errors
- Anchoring to failed approaches
- Context window pollution

#### Bounded Iterations
Fixed turn limits force:
- Progress each turn
- Escalation when stuck
- Human involvement for edge cases

Without bounds, loops can:
- Run indefinitely
- Accumulate confusion
- Waste resources

### The Requirements Document

The requirements document serves as:
- **Shared contract** between player and coach
- **Source of truth** for disputes
- **Scope boundary** for implementation
- **Acceptance criteria** for completion

Both agents defer to requirements. If requirements are ambiguous:
1. Pause the loop
2. Clarify with human
3. Update requirements
4. Resume

## Comparison with Single-Agent Approaches

### Self-Review Pattern
```
Agent implements → Agent reviews → Agent approves
```
**Problem:** Agent reviews through same lens it implemented

### Dialectical Pattern
```
Player implements → Coach reviews → Coach approves (or rejects)
```
**Advantage:** Independent perspective catches blind spots

## Success Metrics

### Per-Turn Progress
Each turn should show:
- Fewer issues than previous turn
- No repeat issues (same feedback twice = stuck)
- Increasing evidence quality

### Session Success
A successful dialectical session:
- Reaches APPROVED within turn limit
- Produces complete implementation
- Has full test coverage
- Meets all requirements with evidence

### Failure Indicators
Red flags that require escalation:
- Same issues repeated 2+ turns
- Turn 4+ with REJECTED (not just REVISE)
- Requirements contradictions discovered
- Technical impossibility identified

## Integration Patterns

### With TDD Workflow
```
Task → Player (TDD) → Coach → APPROVED → Commit
```
The dialectical loop wraps the TDD cycle.

### With Task Processor
```
Parent Task:
  ├── Subtask 1: [dialectical loop]
  ├── Subtask 2: [dialectical loop]
  └── Subtask 3: [dialectical loop]
```
Each subtask can use dialectical autocoding.

### With PR Workflow
```
Dialectical APPROVED → Create PR → Human Review → Merge
```
Coach approval is pre-PR validation.

## Common Patterns

### The "One More Thing" Loop
Coach keeps finding new issues each turn.

**Fix:** Coach must review against complete requirements upfront, not incrementally.

### The "Scope Creep" Problem
Player adds unrequested features.

**Fix:** Coach rejects anything not in requirements, even if "better."

### The "Moving Goalposts" Problem
Coach changes expectations between turns.

**Fix:** Coach anchors to requirements document, not personal preferences.

### The "Stuck Loop" Problem
Same feedback repeats without progress.

**Fix:** After 2 identical turns, escalate. Either requirements need change or approach does.

## Prompt Templates

### Session Start
```
Starting dialectical autocoding session.

Requirements: [document path]
Max turns: 5
Current turn: 1

Player (tdd-developer): Read requirements and implement.
Coach (coach): Will review after player completes.
```

### Turn Transition
```
Turn [N] → Turn [N+1]

Previous verdict: REVISE
Issues to address: [list]

Player: Fix the listed issues with fresh approach.
Coach: Re-validate with fresh perspective.
```

### Escalation
```
Dialectical loop reached turn limit without APPROVED.

Session summary: [turn history]
Unresolved issues: [list]
Blocking factors: [analysis]

Requesting human guidance:
1. Are requirements achievable?
2. Should approach change?
3. Accept current state?
```

## Quality Checklist

### Pre-Session
- [ ] Requirements document exists
- [ ] Acceptance criteria are clear
- [ ] Test infrastructure works
- [ ] Turn limit is set

### Per-Turn (Player)
- [ ] Read requirements completely
- [ ] Addressed ALL previous feedback
- [ ] Tests pass
- [ ] Evidence provided

### Per-Turn (Coach)
- [ ] Compared to ALL requirements
- [ ] Evidence verified
- [ ] Feedback is specific
- [ ] Verdict is justified

### Post-Session
- [ ] Turn history documented
- [ ] Final implementation reviewed
- [ ] PR created (if APPROVED)
- [ ] Lessons captured (if ESCALATED)

## Resource Considerations

### Token Usage
Each dialectical session consumes tokens for:
- Requirements document (read each turn)
- Player implementation (code generation)
- Coach review (code analysis)
- Test output (validation)

**Estimated costs per turn:**
- Small feature: ~10k-15k tokens
- Medium feature: ~15k-25k tokens
- Large feature: ~25k-40k tokens

**Typical session (3 turns):** 30k-75k tokens total

### Time Estimates
| Phase | Duration |
|-------|----------|
| Player turn | 2-5 minutes |
| Coach turn | 1-3 minutes |
| Full session (3 turns) | 10-25 minutes |
| Max session (5 turns) | 15-40 minutes |

### Optimization Tips
1. **Clear requirements** reduce turns needed
2. **Specific acceptance criteria** speed coach review
3. **Smaller features** complete faster (split large PRDs)
4. **Good test infrastructure** provides quick feedback

## Anti-Pattern Examples

### Case Study: The Scope Creep Loop
```
Requirements: "Add user login"
Turn 1: Player adds login + registration + password reset
Coach: REJECTED - "Registration not in requirements"
Turn 2: Player removes registration, adds OAuth
Coach: REJECTED - "OAuth not in requirements"
...
```
**Fix:** Player must implement ONLY what's specified

### Case Study: The Vague Requirements Loop
```
Requirements: "Make it fast"
Turn 1: Player optimizes database queries
Coach: REVISE - "How fast? No target specified"
Turn 2: Player adds caching
Coach: REVISE - "Still no measurable target"
...
```
**Fix:** Pause loop, clarify requirements with human first

### Case Study: The Perfect is Enemy of Good
```
Turn 1: Player implements with 90% coverage
Coach: REVISE - "Coverage should be 95%"
Turn 2: Player hits 94%
Coach: REVISE - "Still not 95%"
Turn 3: Player hits 95%
Coach: REVISE - "Edge case X not tested"
...
```
**Fix:** Coach should identify ALL issues in first review, not incrementally

## References

- Paper: "Adversarial Cooperation in Code Synthesis"
- See `.gemini/agents/coach.md`
- See `.gemini/agents/tdd-developer.md`
- See `.gemini/skills/task-processor/SKILL.md`
