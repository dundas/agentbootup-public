---
name: dialectical-autocoder
description: Orchestrate adversarial player-coach loop for high-quality code synthesis. Based on dialectical autocoding methodology.
config:
  max_turns: 5
  escalate_on_timeout: true
  fresh_context: true
---

# Dialectical Autocoder

## Overview

This skill implements an adversarial cooperation pattern between two agents:
- **Player** (tdd-developer): Implements code, writes tests, solves problems
- **Coach** (coach): Validates against requirements, critiques, demands evidence

The loop continues until the coach approves or max turns are reached.

## Prerequisites

**Required:**
- Requirements document (PRD, spec, or detailed task description)
- Clear acceptance criteria
- Test infrastructure configured

**Agents Used:**
- `.gemini/agents/tdd-developer.md` - Player role
- `.gemini/agents/coach.md` - Coach role

## Pre-Flight Checklist

Before starting a dialectical session, verify:
- [ ] Requirements document exists and is complete
- [ ] Acceptance criteria are explicit and testable
- [ ] Test infrastructure is configured (test runner works)
- [ ] Project has git initialized (for commit tracking)
- [ ] tdd-developer and coach agents are available
- [ ] No blocking technical issues exist

## Orchestrator Implementation

When Gemini CLI executes this skill, it orchestrates the player-coach loop using `run_shell_command` to launch fresh agent instances each turn.

### Technical Flow

```
1. Load requirements document into context
2. Initialize: turn_count = 0, max_turns = 5, verdict = null

3. WHILE verdict != "APPROVED" AND turn_count < max_turns:
   a. turn_count += 1

   b. Launch Player (fresh instance):
      gemini --approval-mode=yolo "You are the PLAYER..."
      Prompt includes:
      - Requirements document path
      - Previous coach feedback (if turn > 1)
      - List of issues to address
      - Request: implement and provide evidence

   c. Capture player output:
      - Files changed
      - Test results
      - Implementation summary
      - Evidence provided

   d. Launch Coach (fresh instance):
      gemini --approval-mode=yolo "You are the COACH..."
      Prompt includes:
      - Requirements document path
      - Player's implementation summary
      - Files to review
      - Test output
      - Request: validate and issue verdict

   e. Parse coach verdict from output:
      Look for: <!-- VERDICT:APPROVED|REVISE|REJECTED -->

   f. If verdict == "APPROVED": break loop

4. IF verdict != "APPROVED":
   Trigger escalation protocol

5. Document turn history
```

### Delegation Examples

**Player Turn:**
```bash
# Prefer positional prompts; `-p/--prompt` is deprecated.
gemini --approval-mode=yolo "$(cat <<'EOF'
You are the PLAYER in a dialectical autocoding session.

Requirements: [path/to/requirements.md]
Turn: 2 of 5

Previous coach feedback:
- Rate limiting not implemented
- Account lockout missing

Your task:
1. Read the requirements document
2. Address the coach's feedback
3. Implement with TDD approach
4. Run tests and ensure they pass
5. Report: files changed, tests added, evidence

Do NOT review your own work. The coach will validate.
EOF
)"
```

**Coach Turn:**
```bash
# Prefer positional prompts; `-p/--prompt` is deprecated.
gemini --approval-mode=yolo "$(cat <<'EOF'
You are the COACH in a dialectical autocoding session.

Requirements: [path/to/requirements.md]
Turn: 2 of 5

Player's implementation summary:
- Added rate limiting to auth endpoints
- Added account lockout after 10 failures
- 12 new tests passing

Files to review: [list of files]
Test output: [test results]

Your task:
1. Compare implementation to EACH requirement
2. Verify evidence provided
3. Identify any gaps or issues
4. Issue verdict with structured marker

End your review with exactly one of:
<!-- VERDICT:APPROVED -->
<!-- VERDICT:REVISE -->
<!-- VERDICT:REJECTED -->
EOF
)"
```

### Fresh Context Implementation

"Fresh context" means each agent turn uses a NEW Gemini CLI execution:
- Previous conversation history is NOT included
- Only structured data carries forward:
  - Requirements document (constant)
  - Previous verdict and specific feedback
  - Files changed (for coach review)
- This prevents:
  - Context pollution from failed approaches
  - Anchoring to previous attempts
  - Accumulating confusion in long sessions

### Turn Limit Enforcement

The orchestrator MUST:
1. Initialize turn counter at session start: `turn = 0`
2. Increment BEFORE each player turn: `turn += 1`
3. Check limit BEFORE starting new turn: `if turn > max_turns: escalate()`
4. Log each turn: "Turn X of Y - Player/Coach phase"
5. Automatically trigger escalation if limit exceeded
6. Never allow more than max_turns iterations

## Key Concepts

### Fresh Context Each Turn
Each turn starts with fresh context to prevent:
- Context pollution from previous attempts
- Anchoring to failed approaches
- Accumulating confusion

The requirements document serves as the constant anchor across turns.

### Bounded Turns
The loop has explicit limits:
- **Default:** 5 turns maximum
- **Escalation:** If not approved by max turns, requires human review
- Each turn must show measurable progress

### Requirements as Contract
The requirements document is the source of truth:
- Player implements TO the requirements
- Coach validates AGAINST the requirements
- Disputes resolved by referring to requirements
- Ambiguity in requirements = pause and clarify

## Workflow

### Phase 1: Initialization
1. Identify or create the requirements document
2. Extract acceptance criteria
3. Set turn limit (default: 5)
4. Initialize turn counter

### Phase 2: Dialectical Loop

```
TURN 1:
├── Player: Read requirements, implement solution
├── Player: Write tests, run tests, commit
├── Coach: Review against requirements
├── Coach: Issue verdict (REJECTED/REVISE/APPROVED)
└── If not APPROVED → continue to Turn 2

TURN 2:
├── Player: Address coach feedback (fresh context)
├── Player: Fix issues, add tests, run tests
├── Coach: Re-review with fresh perspective
├── Coach: Issue verdict
└── If not APPROVED → continue to Turn 3

... (repeat until APPROVED or max turns)

FINAL:
├── If APPROVED: Proceed to merge
├── If max turns reached: Escalate to human
└── Document the turn history
```

### Phase 3: Completion
When coach issues APPROVED:
1. Create PR with full implementation
2. Include turn history in PR description
3. Link to requirements document
4. Ready for human merge approval

## Orchestration Commands

### Starting a Dialectical Session

```markdown
## Starting Dialectical Autocoding Session

**Requirements:** [path to PRD or spec]
**Max Turns:** 5
**Turn:** 1 of 5

### Player Task
Using the tdd-developer agent, implement the requirements:
1. Read the requirements document thoroughly
2. Implement the solution with TDD approach
3. Run all tests and ensure they pass
4. Commit your changes
5. Report what you've implemented

### Coach Review
After player completes, using the coach agent:
1. Review implementation against requirements
2. Check all acceptance criteria
3. Demand evidence for claims
4. Issue verdict: REJECTED, REVISE, or APPROVED
```

### Turn Transition Template

```markdown
## Turn [N] of [MAX]

### Previous Turn Summary
- **Verdict:** [REVISE/REJECTED]
- **Issues to address:**
  1. [Issue 1]
  2. [Issue 2]

### Player Task (Fresh Context)
Address the coach's feedback:
- Requirements document: [path]
- Issues to fix: [list from coach]
- Evidence to provide: [what coach demanded]

Implement fixes and provide evidence.

### Coach Review
Re-review with fresh perspective:
- Verify issues are actually fixed
- Check for new issues introduced
- Validate evidence provided
- Issue new verdict
```

## Turn Limits and Escalation

### Turn Budget
| Turn | Expected State |
|------|---------------|
| 1 | Initial implementation, likely REVISE |
| 2 | Major issues fixed, minor remain |
| 3 | Most issues resolved |
| 4 | Polish and edge cases |
| 5 | Must be APPROVED or escalate |

### Escalation Protocol
If Turn 5 results in REVISE or REJECTED:

1. **Document the impasse**
   - What requirements can't be met?
   - What's blocking approval?
   - Is this a requirements problem or implementation problem?

2. **Human review required**
   - Present turn history
   - Highlight unresolved issues
   - Ask for guidance or requirements clarification

3. **Options for human**
   - Clarify/modify requirements
   - Accept current state with known issues
   - Provide implementation guidance
   - Assign to different approach

## Integration with Task Processor

Dialectical autocoding can be used within task-processor workflows:

```markdown
### Task 1.1: Implement Feature X
- **Agent:** dialectical-autocoder
- **Requirements:** docs/PRD_feature_x.md
- **Max Turns:** 5

The dialectical loop runs as a sub-workflow:
1. Player implements (tdd-developer)
2. Coach validates (coach)
3. Loop until approved
4. Then mark task complete
```

## Best Practices

### For Players
1. Read requirements completely before coding
2. Implement incrementally, test as you go
3. Provide clear evidence for each requirement
4. Address ALL coach feedback, not just some
5. Don't argue with coach—fix or clarify

### For Coaches
1. Anchor everything to requirements
2. Be specific about what's wrong
3. Demand concrete evidence
4. Don't move goalposts between turns
5. Credit progress, not just criticize

### For Orchestration
1. Keep turn history for context
2. Enforce fresh context strictly
3. Don't skip escalation at max turns
4. Document final state clearly
5. Requirements clarification pauses the loop

## Example Session

### Turn 1

**Player Output:**
```
Implemented user authentication per PRD section 3.2:
- Login endpoint at /api/auth/login
- JWT token generation
- Password hashing with bcrypt
- Tests: 15 passing

Evidence:
- Test: `bun test src/auth/__tests__/login.test.ts`
- All 15 assertions pass
```

**Coach Review:**
```
## Coach Review: Turn 1

### Requirements Checked
- [x] Login endpoint exists
- [x] JWT tokens generated
- [x] Password hashing used
- [ ] Rate limiting NOT IMPLEMENTED (PRD 3.2.4)
- [ ] Account lockout NOT IMPLEMENTED (PRD 3.2.5)

### Verdict: REVISE

**To proceed, player must:**
- [ ] Implement rate limiting (5 attempts/minute)
- [ ] Implement account lockout after 10 failed attempts
- [ ] Add tests for both features
```

### Turn 2

**Player Output:**
```
Addressed coach feedback:
- Added rate limiting: 5 attempts per minute per IP
- Added account lockout: 10 failures = 30 min lock
- Added 12 new tests for these features
- Total: 27 tests passing

Evidence:
- Rate limit test: blocks 6th attempt within 1 minute
- Lockout test: locks account after 10 failures
- Unlock test: account accessible after 30 minutes
```

**Coach Review:**
```
## Coach Review: Turn 2

### Requirements Checked
- [x] Login endpoint exists
- [x] JWT tokens generated
- [x] Password hashing used
- [x] Rate limiting implemented (5/min verified)
- [x] Account lockout implemented (10 attempts verified)
- [x] All edge cases tested

### Verdict: APPROVED

All requirements met with evidence.
Ready for PR creation.
```

## Output Artifacts

### Turn History Document
After session completes, save:

```markdown
# Dialectical Session: [Feature Name]

**Requirements:** [path]
**Total Turns:** [N]
**Final Verdict:** [APPROVED/ESCALATED]

## Turn-by-Turn Summary

### Turn 1
- Player: [summary of implementation]
- Coach: REVISE - [issues found]

### Turn 2
- Player: [what was fixed]
- Coach: APPROVED

## Final Implementation
- Files created: [list]
- Tests added: [count]
- Coverage: [percentage]

## Lessons Learned
- [Any patterns or issues for future reference]
```

## Error Handling

### Requirements Ambiguity
If coach and player disagree on requirement interpretation:
1. Pause the loop
2. Document the ambiguity
3. Request human clarification
4. Resume with clarified requirements

### Stuck Loop
If same issues repeat across turns:
1. Check if requirements are achievable
2. Check if player understands feedback
3. Consider requirements modification
4. Escalate if no progress after 2 turns

### Technical Blockers
If implementation is blocked by technical issues:
1. Document the blocker
2. Pause dialectical loop
3. Resolve blocker separately
4. Resume loop with fresh context

## References
- See `.gemini/agents/coach.md` for coach agent details
- See `.gemini/agents/tdd-developer.md` for player agent details
- See `.gemini/skills/task-processor/SKILL.md` for task integration
- See `reference.md` for methodology background
