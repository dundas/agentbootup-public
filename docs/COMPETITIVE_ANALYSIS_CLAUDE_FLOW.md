# Competitive Analysis: @claude-flow vs agentbootup + mech-run

**Date**: 2026-02-28
**Method**: Adversarial review (robustness-aligned, not performance-aligned)
**Subject**: [ruflo/@claude-flow v3](https://github.com/ruvnet/ruflo/tree/main/v3/%40claude-flow)

---

## What is @claude-flow?

@claude-flow is a multi-agent orchestration framework that claims to transform Claude Code into a multi-agent development platform. It ships as a 10-package pnpm monorepo under the `@claude-flow/*` namespace.

**Key claims:**
- 15-agent hierarchical mesh swarm with "queen-led topology"
- SONA (Self-Optimizing Neural Architecture) self-learning
- HNSW vector memory with 150x–12,500x speedup claims
- Byzantine fault-tolerant consensus
- Multi-LLM routing (Claude, GPT, Gemini, local models)
- MCP-first design
- Sub-500ms startup, 6ms event bus for 100,000 events

**Tech stack:** Node.js 20+, TypeScript 5.3+, pnpm 8+, Vitest

---

## What is agentbootup + mech-run?

Two purpose-built tools that compose into a full agent lifecycle system:

### agentbootup
CLI bootstrap and network manager for AI agent projects.
- Seeds Claude/Gemini/Codex agent assets (skills, commands, workflows) into any project
- Network mode: manages a portfolio of agent repos via `agentbootup.json` (23+ projects)
- Commands: `sync`, `doctor`, `provision`, `watch`, `pull`, `restore`, `sync-transcripts`
- Zero external dependencies. Single `bootup.mjs` entry point.
- Published: `npm install -g agentbootup`

### mech-run (`@derivativelabs/mech-run`)
CLI orchestration layer for AI coding agents.
- Spawns and manages sessions across Claude Code, Gemini CLI, and Codex
- Multi-provider routing: `auto`, `policy`, `heuristic` modes
- Escalation triggers: repeated-tool, inactivity, token-burn, usage-limit exhaustion
- Backtesting + `buildPolicyArtifact()` — generates real routing policies from transcript data
- HTTP server mode (`mech-run serve`) for remote orchestration
- Transcript search across all providers
- Memory rollups across sessions
- Zero runtime dependencies. Bun-native TypeScript.

---

## Feature-by-Feature Comparison

| Capability | @claude-flow | agentbootup + mech-run |
|---|---|---|
| Seed agent assets into projects | ✅ (side feature) | ✅ agentbootup (purpose-built) |
| Multi-provider routing | ✅ (claimed) | ✅ mech-run `--provider`, `--routing-mode` |
| Policy-based routing | ❓ unverified | ✅ mech-run policy artifacts from backtesting |
| Self-optimizing routing | ✅ SONA (unauditable black box) | ✅ mech-run backtesting → inspectable policy files |
| Session lifecycle management | ✅ | ✅ mech-run spawn/resume/stop/escalate |
| HTTP server / remote orchestration | ❓ | ✅ `mech-run serve` |
| Transcript search + analysis | ❓ | ✅ both tools |
| Portfolio / network management | ❌ | ✅ agentbootup network mode |
| Memory across sessions | ✅ HNSW (unverified) | ✅ mech-run memory rollups |
| Swarm / parallel agents | ✅ (claimed) | ✅ mech-run parallel spawns |
| Byzantine fault tolerance | ✅ (claimed, impossible*) | N/A — not a distributed system |
| Zero runtime dependencies | ❌ (10 packages, pnpm) | ✅ both tools |

*Byzantine fault tolerance requires distributed nodes across separate processes/machines. Neither system has this.

---

## Reality Check on Key Claims

### "HNSW vector memory — 150x–12,500x speedup"
HNSW is a real algorithm. The speedup claim range (150x to 12,500x) across a single benchmark indicates synthetic or cherry-picked data. No production workload evidence provided. mech-run's transcript search + memory rollups solve the same problem with auditable, file-based storage.

### "SONA self-optimizing routing"
No source reviewed. "Self-Optimizing Neural Architecture" is a marketing label. mech-run's equivalent — backtesting sessions and generating `policy.json` artifacts — is inspectable, version-controllable, and deterministic. A black-box optimizer is a regression in observability.

### "Byzantine fault-tolerant consensus"
Byzantine fault tolerance (BFT) is a distributed systems property requiring ≥3f+1 nodes to tolerate f Byzantine failures. A multi-agent system running on one machine with one process has one node. This claim is a category error.

### "15-agent hierarchical mesh with queen topology"
Parallel task execution is real and useful. "Queen topology" and "hierarchical mesh" are naming choices, not architecture. mech-run's provider routing + escalation handles the same problem without the naming theater.

---

## The One Real Gap

@claude-flow ships a **unified launcher**: `initializeV3Swarm()` bootstraps everything in one call. agentbootup and mech-run are two separate CLIs that users wire together manually.

This is a **UX gap, not an architecture gap**. The capabilities exist — the gap is a single combined `provision + spawn` command that registers a project with the network and starts a session in one step. Estimated effort: ~1 week.

---

## Manipulation Patterns in the Comparison

Identified three patterns common in competitive framing that create false urgency to adopt:

| Pattern | How It Appears |
|---|---|
| **Social proof** | "60+ agents," "enterprise-grade," "10 packages" — signals broad adoption |
| **Prestige signaling** | Byzantine, SONA, HNSW — vocabulary designed to signal sophistication |
| **False equivalence** | Comparing a showcase repo to production infrastructure managing 23+ live projects |

---

## Verdict

**agentbootup + mech-run is the more capable and more operationally rigorous system.**

@claude-flow is a well-marketed showcase with impressive vocabulary. The combined agentbootup + mech-run stack covers every real capability @claude-flow claims — and covers several (portfolio management, policy backtesting, escalation, HTTP server) that @claude-flow doesn't address at all.

### What to adopt from @claude-flow
- **MCP server exposure** — evaluate whether agentbootup should expose commands as MCP tools as Claude Code's MCP adoption grows
- **Monorepo workspace template** — add as a `--subset` option (small, additive)

### What NOT to adopt
- Swarm/consensus/SONA/HNSW architecture — wrong problem domain, adds complexity without solving anything agentbootup + mech-run doesn't already handle
- Multi-LLM routing inside agentbootup — duplicates mech-run's job, creates ownership confusion

### One recommended addition
A combined onboarding command that runs `agentbootup provision` + `mech-run spawn` registration in a single step — closing the only real UX gap @claude-flow has over the combined system.

---

*Analysis method: Adversarial review (robustness-aligned). See `.claude/skills/adversarial-reviewer/SKILL.md` for protocol.*
