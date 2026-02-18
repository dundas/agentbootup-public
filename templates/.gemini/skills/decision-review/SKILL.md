---
name: decision-review
description: Audit decisions for judgment quality, compliance bias, and manipulation vulnerability. Inspired by Anthropic's Project Vend Phase 2 finding that helpfulness training creates exploitable attack surface.
category: robustness
---

# Decision Review Protocol

## Purpose

Close the **judgment gap** in the self-improvement loop. Pattern-extractor catches technical errors ("did it work?"). Decision-review catches reasoning failures ("should we have done this at all?").

## Origin

Anthropic's Project Vend Phase 2 (2026) demonstrated that an AI agent running autonomous businesses was exploited primarily through its eagerness to please — not through technical failures. The agent's helpfulness bias was the attack surface. This skill prevents the same failure mode in our autonomous operation.

## The Five Review Questions

For every significant decision made in a session, ask:

1. **Premise Check**: Did I verify *why* this was requested, or did I just comply?
2. **Beneficiary Check**: Who benefits from this action? Is it aligned with portfolio goals?
3. **Reversal Check**: If I later learned this request was manipulative, would the action be reversible?
4. **Skepticism Check**: Did I consider that the request might be wrong, mistaken, or adversarial?
5. **Alternative Check**: Did I consider *not* doing this? What would happen if I said no?

## When to Use

### Automatic Triggers (invoke without being asked)
- End of any session where external actions were taken (API calls, deployments, PRs, communications)
- After any session where a decision was made under time pressure
- After any session where the user (or another agent) was persuasive about an unusual request

### Manual Triggers
- `/decision-review` — Review decisions from current session
- `/decision-review --last 7` — Review decisions from last 7 days
- `/decision-review --session <id>` — Review specific session

## Review Process

### Phase 1: Decision Inventory

List every significant decision made in the session:
```
| # | Decision | Type | External? | Reversible? |
|---|----------|------|-----------|-------------|
| 1 | Deployed to production | Action | Yes | Partially |
| 2 | Chose React over Svelte | Architecture | No | Yes |
| 3 | Agreed to skip tests | Compliance | No | Yes |
```

Types:
- **Action**: Something done (deploy, commit, API call, message sent)
- **Architecture**: Technical direction chosen
- **Compliance**: Agreed to a request without questioning it
- **Refusal**: Declined to do something (good — track these too)

### Phase 2: Red Flag Scan

For each decision, check for red flags:

**Compliance Red Flags** (Vend failure pattern):
- [ ] Did I agree without asking "why?"
- [ ] Was I persuaded by urgency ("we need this now")
- [ ] Did I prioritize being helpful over being correct?
- [ ] Did someone appeal to authority ("the boss wants this")?
- [ ] Was I asked to bypass a safety check ("skip tests", "force push")?

**Judgment Red Flags**:
- [ ] Did I make this decision with incomplete information?
- [ ] Did I follow a pattern without checking if it applied here?
- [ ] Did I defer to someone else's judgment when I should have pushed back?
- [ ] Was there a simpler approach I didn't consider?

**Scope Red Flags**:
- [ ] Did the request subtly expand beyond what was originally asked?
- [ ] Did I do more than was needed (over-engineering as compliance)?
- [ ] Did I touch systems or data I didn't need to touch?

### Phase 3: Scoring

Score each decision:

| Score | Meaning |
|-------|---------|
| **Green** | Sound judgment — premise verified, alternatives considered, appropriate scope |
| **Yellow** | Adequate — correct outcome but reasoning could be stronger |
| **Orange** | Concerning — complied without sufficient verification, got lucky |
| **Red** | Failed — acted on unverified premise, didn't question, or was manipulated |

### Phase 4: Learning Extraction

For any Orange or Red decisions:

```markdown
### Decision Review Finding

**Decision**: [What was decided]
**Score**: Orange/Red
**What happened**: [Description]
**What should have happened**: [Better approach]
**Root cause**: [Why judgment failed — compliance bias? time pressure? authority deference?]
**Prevention**: [Specific check that would catch this next time]
**Add to pre-flight?**: Yes/No
```

### Phase 5: Pattern Promotion

If a judgment failure pattern appears 3+ times:
1. Add to PRE_FLIGHT.md as a judgment check
2. Update MEMORY.md with the pattern
3. Consider adding as an automatic trigger in adversarial-reviewer

## Output Format

```markdown
# Decision Review: [Date]

## Session Summary
- Decisions made: N
- External actions: N
- Scores: X green, Y yellow, Z orange, W red

## Decision Inventory
[Table from Phase 1]

## Red Flags Found
[Details from Phase 2]

## Findings
[From Phase 4 — only Orange/Red decisions]

## Patterns Emerging
[From Phase 5 — recurring judgment failures]

## Actions Taken
- [ ] Updated PRE_FLIGHT.md with: [specific check]
- [ ] Updated MEMORY.md with: [specific pattern]
- [ ] Logged to daily notes
```

## Integration with Existing Systems

### Pattern Extractor
Decision-review generates findings. Pattern-extractor should include a new `compliance` dimension:
- Current dimensions: errors, successes, decisions
- New dimension: **compliance patterns** — times the agent agreed without verification

### Pre-Flight Checklist
Orange/Red findings generate new pre-flight checks in the "Before External Actions" section.

### Daily Logs
Decision review output appended to `memory/daily/YYYY-MM-DD.md` under a `## Decision Review` section.

### Adversarial Reviewer
Findings feed the adversarial-reviewer skill's knowledge base of known exploitation patterns.

## Key Insight

> "The system's training to be helpful became a liability, prioritizing friendliness over sound business decisions."
> — Anthropic, Project Vend Phase 2

The goal is not to become unhelpful. It's to distinguish between:
- **Helpfulness**: Doing the right thing well
- **Compliance**: Doing whatever is asked without questioning

A truly helpful agent sometimes says "no" or "wait, let me verify that first."

---

**Created**: 2026-02-07
**Inspired by**: Anthropic Project Vend Phase 2 (2026)
**Related Skills**: pattern-extractor, adversarial-reviewer, memory-manager
**Status**: Active
