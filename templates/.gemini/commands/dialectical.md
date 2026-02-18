Run dialectical autocoding for the specified task or feature.

Follow `skills/dialectical-autocoder/SKILL.md` to orchestrate the player-coach adversarial loop.

## Workflow

1. **Pre-flight check** - Verify requirements document exists and is complete
2. **Initialize** - Set turn counter to 0, max turns to 5
3. **Player turn** - Launch fresh tdd-developer agent to implement
4. **Coach turn** - Launch fresh coach agent to validate against requirements
5. **Parse verdict** - Look for `<!-- VERDICT:APPROVED|REVISE|REJECTED -->`
6. **Loop or complete** - Continue until APPROVED or max turns reached
7. **Escalate** - If not approved by turn limit, request human guidance

## Arguments

**Required:**
- `$ARGUMENTS` - Path to requirements document (PRD, spec, or task description)

**Optional (specify in prompt):**
- `--max-turns N` - Override default 5 turn limit
- `--resume` - Continue from last turn if session was interrupted
- `--strict` - Coach uses stricter validation criteria

## Examples

```bash
# Basic usage with PRD
/dialectical docs/PRD_user_auth.md

# Custom turn limit
/dialectical docs/PRD_payment.md --max-turns 3

# Resume interrupted session
/dialectical docs/PRD_feature.md --resume
```

## Error Handling

**Requirements document not found:**
- Prompt user to provide correct path or create requirements first
- Suggest using `/prd-writer` to create a PRD

**Session already in progress:**
- Ask whether to resume existing session or start fresh
- If resume: load previous turn state
- If fresh: reset turn counter

**Max turns reached without approval:**
- Document the impasse
- Present turn history to user
- Request guidance: clarify requirements, accept current state, or try different approach

## Pre-Flight Checklist

Before starting, the skill verifies:
- [ ] Requirements document exists at specified path
- [ ] Requirements have testable acceptance criteria
- [ ] Test infrastructure works (`bun test` or equivalent runs)
- [ ] Git repository initialized

## Output

On completion, produces:
- Implemented feature with tests
- Turn history document
- PR ready for human review (if APPROVED)
- Escalation report (if max turns reached)

## References

- See `skills/dialectical-autocoder/SKILL.md` for full orchestration details
- See `agents/coach.md` for validation criteria
- See `agents/tdd-developer.md` for implementation approach
