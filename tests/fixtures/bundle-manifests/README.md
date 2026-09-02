# Bundle manifest golden corpus

Frozen inputs and their expected `normalizeBundleManifest()` output.

`normalizeBundleManifest()` is the single door every bundle passes through: `bundle
publish`, `bundle install`, `bundle sync`, `bundle report`, and the doctor sweep all
call it. Its output shape is therefore a *format contract* with 107 manifests on disk
across the fleet and with every install ledger already written.

These fixtures exist so that a change to the normalizer fails loudly instead of
silently re-interpreting a manifest someone shipped last month. Two legacy shapes are
deliberately represented, both measured in this repo on 2026-07-09:

| shape | count | fixture |
|---|---|---|
| `bundle_name` + `source`/`target` | 93 | `modern.json` |
| legacy `skill` alias for `bundle_name` | 14 | `legacy-skill-alias.json` |
| legacy `path` alias for `source`/`target` | (fleet-wide; decisive's census) | `legacy-path-alias.json` |

None of the 107 declare `metadata.version` — see PRD-0047 §7.

**Updating a golden file is a deliberate act.** If a diff appears here, the question is
not "how do I make the test pass" but "which manifests on disk did I just re-interpret,
and can older agentbootup still read what I now write?"
