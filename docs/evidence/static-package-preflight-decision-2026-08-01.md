# Static Package Preflight Necessity Decision — 2026-08-01

## Decision

Do not add a static package resolver in this slice. PR #375 and its retired
`fix/packaged-runtime-adapter-verification` branch are historical provenance,
not dependencies or release candidates.

The material, reproducible gap was release-version drift: npm 0.8.29 was a
valid 0.8.29 tarball, but it predated the convergence CLI source. Static local
import resolution would not have detected that product/release mismatch.

## Authoritative executable evidence

On current main commit `7eee85abe3fcdaae57d3fd82ba7d7a3122f13c6b`,
`node scripts/check-packed-runtime-adapters.mjs` creates a tarball, installs it
into an isolated consumer, verifies packed and installed package version parity,
imports the runtime-adapter and transcript-archive modules, and invokes the
installed `agentbootup` bin shim with `config set-converge on` in a clean HOME.
It verifies the persisted `memoryConvergeEnabled: true` configuration. The
command passed, importing 9 runtime-adapter and 10 transcript-archive modules.

`bootup.mjs` uses dynamic routing for top-level commands. The installed CLI
smoke—not an ESM graph preflight—is authoritative for that route. The smoke is
authoritative only for the tested archive/runtime modules and `config
set-converge` CLI surface; new published CLI entrypoints require their own real
packed CLI smoke.

## Explicit non-scope for any future static slice

If a distinct, reproducible static gap appears, a separate PR may implement
only relative ESM imports and package-owned `exports` targets. It must preserve
import attributes, reject dynamic imports, and emit explicit unsupported
diagnostics for CommonJS and external `package.json#imports` aliases. It must
not claim coverage for `bootup.mjs` or other dynamic-import entrypoints.
