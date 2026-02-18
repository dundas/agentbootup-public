---
name: task-processor-parallel
description: Process tasks using async background subagents for massive parallelization and speedup.
---

# Parallel Task Processor with Async Subagents

## Prerequisites

**Required:**
- Gemini CLI (0.x+)
- Git repository with remote configured
- GitHub CLI (`gh`) installed and authenticated: `gh auth login`
- GitHub repository (PR automation features require GitHub)

**Optional:**
- CI/CD configured for automated checks
- Sufficient API quota for parallel subagents

**Non-GitHub Hosting:** If using GitLab, Bitbucket, or other platforms, the PR automation features won't work. You can still use parallel task processing, but create PRs manually.

## Overview
Leverages Gemini CLI's capability to run independent instances via the shell to process multiple tasks in parallel, dramatically reducing implementation time.

## Key Features
- **Parallel Execution**: Spawn multiple subagents to work on independent tasks simultaneously
- **Context Isolation**: Each subagent starts with a clean context window
- **PR Automation**: Automated gap analysis and PR comments after each phase

## Parallelization Strategy

### Level 1: Phase-Level Parallelization
Launch multiple phases in parallel when no dependencies exist. Use `run_shell_command` to spawn background Gemini CLI instances:

```bash
# Batch 1: Independent phases (run in parallel)
# Note: `-p/--prompt` is deprecated in newer Gemini CLI versions; prefer the positional prompt.
gemini --approval-mode=yolo "Implement Phase 1..." < /dev/null &
gemini --approval-mode=yolo "Implement Phase 5..." < /dev/null &
gemini --approval-mode=yolo "Implement Phase 8..." < /dev/null &
```

### Level 2: Sub-Task Parallelization
Within a single phase, parallelize independent sub-tasks using the same pattern. Ensure each subagent has a specific Task ID to prevent overlap.

## Execution Protocol

### 1. Analyze Dependencies
[... existing dependency analysis logic ...]

### 2. Create Execution Batches
[... existing batch logic ...]

### 3. Spawn Subagents

**Using `run_shell_command` for background execution:**

To launch multiple phases in parallel, use the shell delegation pattern:

```bash
gemini --approval-mode=yolo "$(cat <<'EOF'
You are the tdd-developer. Your Task ID is 1.0.
Implement Phase 1: Comparison.
Work through tasks 1.1 through 1.7 from tasks/[task-file].md.
Follow test-driven development and commit after each task.
EOF
)" < /dev/null &

gemini --approval-mode=yolo "$(cat <<'EOF'
You are the tdd-developer. Your Task ID is 5.0.
Implement Phase 5: Performance...
EOF
)" < /dev/null &
```

### 4. Monitor Progress

**Check Subagent Status:**
Use standard shell commands to monitor background processes or check the filesystem for updates (e.g., new commits or PRs).

```bash
# Check if gemini processes are running
ps aux | grep gemini
```

### 5. Collect Results

When a subagent completes, it notifies the orchestrator:
```typescript
// Subagent 1 completes Phase 1
Result: {
  phase: 1,
  pr_number: 16,
  files_changed: 6,
  tests_added: 50,
  gap_analysis: "docs/PR_16_GAP_ANALYSIS.md",
  status: "ready_for_review"
}

// Orchestrator receives notification
// Triggers next dependent phase (Phase 2)
```

### 6. Automated PR Workflow (Per Subagent)

Each subagent follows this protocol when its phase completes:

1. **Run Tests**: Full test suite for the phase
2. **Create Branch**: `git checkout -b feat/phase-X-name`
3. **Push**: `git push -u origin feat/phase-X-name`
4. **Create PR**: Using `gh pr create`
5. **Wait for CI**: 30-second delay
6. **Check Status**: `gh pr view` + `gh pr checks`
7. **Generate Gap Analysis**: Create `docs/PR_X_GAP_ANALYSIS.md`
8. **Push Gap Analysis**: Commit and push
9. **Add PR Comment**: Detailed changes summary
10. **Notify Orchestrator**: Return results

## Example: Full Autonomous Run

```bash
# User starts the processor
skill: task-processor-parallel

# Orchestrator analyzes dependencies
→ Identifies 5 execution batches
→ Creates parallelization plan

# Batch 1: Launch 3 phases in parallel
→ Spawn Phase 1 subagent (tdd-developer)
→ Spawn Phase 5 subagent (tdd-developer)
→ Spawn Phase 8 subagent (tdd-developer)

# Orchestrator: "3 subagents launched, monitoring progress..."

# [After Phase 5 completes first - shortest effort]
# Phase 5 completes first (shortest)
→ Subagent 5 creates PR #20
→ Subagent 5 runs gap analysis
→ Subagent 5 notifies orchestrator: "Phase 5 done, PR #20 ready"

# Phase 1 completes
→ Subagent 1 creates PR #16
→ Subagent 1 runs gap analysis
→ Subagent 1 notifies orchestrator: "Phase 1 done, PR #16 ready"
→ Orchestrator triggers Phase 2 (depends on Phase 1)

# Phase 8 completes
→ Subagent 8 creates PR #23
→ Subagent 8 runs gap analysis
→ Subagent 8 notifies orchestrator: "Phase 8 done, PR #23 ready"

# Batch 2: Launch Phase 2 (depends on Phase 1 - just completed)
→ Spawn Phase 2 subagent (tdd-developer)

# ... Continue through all batches ...

# All phases complete
→ Orchestrator: "All 9 PRs created and reviewed!"
→ User reviews PRs and merges
```

## Benefits

### Time Savings
- **Sequential**: Sum of all phase efforts
- **Parallel**: Longest path through dependency graph
- **Savings**: ~25% reduction in total effort

### Efficiency
- No idle time waiting for sequential tasks
- Better resource utilization
- Continuous progress across multiple fronts

### Flexibility
- Can pause/resume individual subagents
- Can prioritize critical phases
- Can adjust parallelization on the fly

## Limitations & Considerations

### Max Concurrent Subagents
Recommended limits to avoid overwhelming resources:

| Scenario | Max Parallel | Reason |
|----------|--------------|--------|
| Small tasks (< 30 min each) | 4-5 | Token budget, context quality |
| Medium tasks (1-2 hours) | 2-3 | Avoid merge conflicts |
| Large tasks (half day+) | 1-2 | Resource contention |

**Guidelines:**
- Start conservative (2-3 parallel) and increase if stable
- Track usage/costs in your provider dashboard or billing console
- If subagents produce poor results, reduce parallelism
- Complex codebases benefit from less parallelism

### Context Cost
- Each subagent has its own context window
- More parallel agents = higher token usage
- Keep parallelism low if cost-sensitive

### Merge Conflicts
- Parallel work may touch same files
- Mitigate: Design tasks to minimize overlap
- Use clear file ownership per phase

### CI Load
- Multiple PRs may overload CI
- Mitigate: Stagger PR creation
- Use draft PRs to delay CI

## Troubleshooting Parallel Subagents

### Subagent Fails or Produces Poor Results

**Symptoms:**
- Subagent returns incomplete work
- Code doesn't compile or tests fail
- Subagent seems "lost" or unfocused

**Diagnosis:**
1. Check task complexity - may be too large for single subagent
2. Check task dependencies - may need output from another phase
3. Check context - subagent may lack necessary codebase knowledge

**Solutions:**
- Break task into smaller sub-tasks
- Run the phase sequentially instead of parallel
- Provide more context in the subagent prompt
- Reduce number of parallel subagents

### Subagent Hangs or Times Out

**Symptoms:**
- A background `gemini` process runs for unusually long time
- No progress updates

**Solutions:**
1. Check process status with `jobs -l` (or `ps aux | grep gemini`)
2. If stuck, cancel and retry with smaller scope
3. Consider running that phase sequentially

### Merge Conflicts Between Parallel Phases

**Symptoms:**
- `git push` fails with conflict errors
- PRs can't be merged

**Solutions:**
1. Identify which files conflict
2. Determine which phase's changes are correct
3. Manually resolve conflicts
4. Re-run validation on merged code
5. **Prevention:** Assign clear file ownership per phase

### Inconsistent State Across Phases

**Symptoms:**
- Phase A created interface X
- Phase B expected different interface
- Integration fails

**Solutions:**
1. Define interfaces/contracts BEFORE parallel execution
2. Create shared types/interfaces in a prerequisite phase
3. Re-run dependent phase after fixing interface

### Debugging Checklist

When parallel execution fails:
- [ ] Check each subagent's output for errors
- [ ] Verify no file conflicts between phases
- [ ] Ensure dependencies were correctly identified
- [ ] Check if task was too complex for parallelization
- [ ] Review if phases had hidden dependencies
- [ ] Consider falling back to sequential execution

## Production Completion Criteria

Each subagent must ensure its phase is **production-ready** before reporting complete:

1. **All sub-tasks implemented**: Code written and committed
2. **All tests pass**: Full test suite for the phase passes
3. **End-to-end works**: The phase's functionality works in the full flow
4. **No blocking issues**: Fix all issues discovered, don't defer them

### Critical Rule for Subagents

When a subagent encounters an issue during validation:

- **DO NOT** report the phase as complete with caveats
- **DO NOT** say "phase done, but there's an unrelated issue"
- **DO** fix all blocking issues before reporting complete
- **DO** re-validate end-to-end after each fix
- **DO** only report complete when production-ready

### Orchestrator Validation

After all phases complete, the orchestrator must:

1. Run full integration test suite across all phases
2. Validate the complete end-to-end user flow
3. Ensure all PRs are mergeable without conflicts
4. If ANY issue found, assign to appropriate subagent to fix
5. Only declare "all phases complete" when production-ready

## AI Instructions

1. **Analyze dependencies** before spawning subagents
2. **Create execution batches** based on dependency graph
3. **Spawn subagents** as background shell jobs (append `&`)
4. **Monitor progress** with `jobs -l` (or `ps`)
5. **Collect results** as subagents complete (use `wait`)
6. **Trigger dependent phases** when prerequisites met
7. **Track PR status** for all parallel phases
8. **Update task list** with real-time progress
9. **Validate end-to-end** before declaring any phase complete
10. **Fix all blocking issues** in-place, never defer them

## References
- See `reference.md`
- Gemini CLI documentation on shell delegation and subagents
- See `.gemini/skills/task-processor-auto/SKILL.md` for PR automation details

---

*Skill created for autonomous agent implementation with async subagents*
