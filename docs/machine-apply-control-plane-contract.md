# Machine-Apply Control-Plane Contract (Proposal v2)

**Status:** PROPOSAL v2 — contract-only, no implementation. Revises v1 (`#421`, `3715c302`) per two architectural corrections: (1) identities/roles are defined by the **fleet owner**, not an external service's registry; (2) AgentBootup must "just work" with **zero required external-service dependencies** — future external consumers cannot be forced to adopt AgentDispatch or Mech Storage. Awaiting Decisive approval before any mutation-bearing execute slice begins.
**Author:** bootup (pi session)
**Correlates:** decision `msg-1786335414360-dt10qx` (PROCEED_WITH_CONTRACT_ONLY), morning check-in `msg-1786356228251-ggi9o5`, contract v1 `msg-1786335594131-5fydzu`.

## 1. Ruling this proposal satisfies

Decisive decision `msg-1786335414360-dt10qx`:

> Do not use the local canonical-state store, including for the disposable SeedID Mac-mini canary. AgentBootup remains the transactional plan/materialize/rollback transport and must not become the approval authority.

Reconciled with the product constraint (the fleet owner's correction):

> AgentBootup must "just work" for any installer — future external consumers cannot be required to adopt portfolio-internal services (AgentDispatch, Mech Storage) to use `machine add`. Identities and roles are defined by the **owner of the fleet**, not by an external service's registry.

**How the two reconcile:** the control plane is an **interface**, not a service. AgentBootup-the-transport calls a `MachineApplyAuthority` adapter through a defined contract and never self-certifies (satisfies Decisive). A **self-contained reference authority ships with AgentBootup** so it works with zero external dependencies (satisfies "just works"). The fleet owner configures identities/roles. External services become *optional adapter backends* the fleet owner can plug in — never a required dependency.

**No apply execution, target contact, identity mint, remote transport, daemon start, approval consumption, or canary mutation is authorized yet.** This document proposes a contract only.

## 2. Required contract (from Decisive, unchanged)

1. Immutable approval record keyed by `approval_record_id` and exact `binding_hash`.
2. Single-use nonce with server-enforced expiry and atomic consume.
3. Full-tuple CAS over `source_descriptor`, `source_commit`, `selected_assets`, `asset_policy_hash`, `machine_id`, `target_path`, `server_head`, `fence`, `rollback`.
4. Registered signer and machine public identities with roles.
5. Atomic append-only receipt chain tied to the approval record.
6. Redacted status read and stable fail-closed errors.

## 3. Architecture: interface, not service (the v1→v2 change)

### 3a. The control plane is an adapter interface

AgentBootup defines a `MachineApplyAuthority` interface — the contract between the transactional transport (AgentBootup) and the approval authority. The transport calls the authority; it never performs authority actions itself. Any implementation that satisfies the interface is a valid authority.

```
interface MachineApplyAuthority {
  // Identity (required surface 4)
  registerIdentity({ identity_id, kind: 'brain'|'machine', public_key_pem?, role, registered_by })
  getIdentity(identity_id) -> { identity_id, kind, role, public_key_pem, registered_at }

  // Approval record (surface 1)
  createApprovalRecord({ approval_record_id, binding_hash, binding, nonce, issued_at, expires_at, issuer_identity, signature })
  verifyApprovalRecord({ approval_record_id, approval }) -> { valid, binding_hash, expires_at, nonce_state }

  // Atomic consume (surfaces 2 + 3) — one transaction
  consumeApproval({ approval_record_id, nonce, binding_hash, fence, server_head, machine_id })
    -> { consumed, consumed_at, fencing_token }

  // Append-only receipt chain (surface 5)
  appendReceipt({ approval_record_id, approval_nonce, signer_identity, signer_role, phase, assertions, previous_receipt_hash, signature })
    -> { receipt_hash, created_at }

  // Redacted status (surface 6)
  getStatus(approval_record_id) -> { approval_record_id, binding_hash, nonce_state, receipts: redacted[], fence_summary, current_server_head }
}
```

The transport's `acquireApplyPreflight` (merged, `#420`) stays unchanged; its deps get wired to a concrete `MachineApplyAuthority` implementation. The contract primitives (`planBinding`, `buildApplyBinding`, `assertPlanFreshness`, merged `#419`/`#420`) remain the shared canonical hash — **the authority runs `planBinding` itself**, so transport and authority agree on `binding_hash` independently. AgentBootup never self-certifies.

### 3b. Self-contained reference authority ships with AgentBootup ("just works")

A **reference implementation** of `MachineApplyAuthority` is shipped with AgentBootup so a fresh installer needs **zero external services**:

- **Storage:** a dedicated local store — a single SQLite file (or a small local daemon) at a fleet-root path, e.g. `<fleet-root>/.agentbootup/apply-authority.db` (or `~/.agentbootup/apply-authority.db` for a single-operator fleet). This is a **dedicated authority store**, NOT the brain canonical-state store (memory sync) that Decisive's ruling rejected overloading. The two are deliberately separate concerns.
- **Atomicity:** SQLite gives true atomic compare-and-set for the nonce consume (`UPDATE nonce SET used_at=now() WHERE id=? AND used_at IS NULL`) in a single transaction with the receipt append — no read-then-write race. This is the atomicity the v1 proposal wrongly sourced from an external Postgres cluster; SQLite delivers it locally with no cluster.
- **Identity source:** the fleet owner's config. Brain identities come from the existing `agentbootup.json` `agent_id` (already the canonical brain-name system). Roles (`approval_issuer`, `coordinator`) and the target `machine`-type identity are declared in a fleet-owner config file. The reference authority reads/registers them. No external hub required.
- **No forced dependencies:** no AgentDispatch, no Mech Storage, no Postgres cluster, no Redis. A consumer runs `agentbootup machine add` and it works against the local reference authority.

### 3c. Optional adapter backends (the fleet owner's choice, never required)

The interface is the contract; the reference authority is the default. A fleet owner *may* plug in an alternative adapter:

- **AgentDispatch + Mech Storage adapter** — for the portfolio's *own* multi-brain fleet, *if we choose* to centralize approval authority in the existing hub. This is a deployment choice for our fleet, **not** a requirement any external consumer inherits. (v1's mistake was recommending this as the owner; it is correctly demoted to an optional backend.)
- **Remote/custom adapter** — any service that implements `MachineApplyAuthority`. The fleet owner points AgentBootup at it via config.

The adapter boundary means the portfolio can run a centralized authority for its own fleet while every external consumer runs the shipped reference authority — same transport, same contract, different backend by config.

### 3d. Why this satisfies both the ruling and the product constraint

| Decisive's concern | How v2 satisfies it |
|---|---|
| Don't use the local canonical-state store | The reference authority is a **dedicated** store, not the brain memory/state store. Decisive rejected overloading the brain state store; the authority is a separate concern. |
| AgentBootup must not become the approval authority | AgentBootup-the-transport calls the authority via the interface and never self-certifies. The reference authority is a **separate concern** invoked by — not identical to — the transport. `planBinding` runs in the authority, not in the transport's binding step. The trust boundary is the **interface** (logical separation), which may or may not also be a process boundary — see open question 2. |
| Server-side CAS-capable store | SQLite (or the configured adapter) provides it. "Server-side" = "outside the transport process," satisfied by a dedicated authority store. |

| Product concern | How v2 satisfies it |
|---|---|
| Just works, zero forced external deps | Reference authority ships with AgentBootup; SQLite is embedded; no AgentDispatch/Mech/Postgres/Redis required. |
| Identities defined by the fleet owner | Brain names = existing `agent_id`; roles + target machine declared in owner config; no external registry forced. |
| External consumers not forced to adopt portfolio services | AgentDispatch/Mech are optional adapters, not the contract. |

## 4. Identities (corrected: roles on existing brain names, not a parallel registry)

The fleet owner defines identities; there is no parallel identity system.

- **Brain identities = the existing brain names.** `agentbootup.json` `agent_id` is already the canonical fleet identity (`decisive`, `bootup`, `helloconvo`). Where a fleet uses a hub, these are already registered Ed25519 identities. The contract does **not** create a new registry of brains.
- **Roles = owner-assigned metadata on brains.** The fleet owner assigns `approval_issuer` (who can sign approval records — e.g. `decisive`) and `coordinator` (who drives apply) to existing brain identities in a fleet-owner config. This is the only genuinely new identity field, and it's owner-configured, not hub-issued.
- **Target machine = a `machine`-type identity, distinct from a brain.** Per Decisive's ruling ("the target must create/use host-local identity and separate enrollment"), the canary Mac mini has its own identity — the existing `machine-id` UUID (`lib/machine-id/machine-id.js`), not a brain name. It registers with the authority as `kind: 'machine'`, host-local, separate enrollment. This is the one identity genuinely different from a brain name, by design.
- **Registration path:** brains register via the existing system (`agentbootup.json` + optional hub registration); the target machine registers its host-local identity via the authority's `registerIdentity({kind:'machine'})`. The fleet owner's config is the source of truth for role assignments. No external service is required for any of this.

## 5. Open questions for Decisive (revised)

1. **Interface-as-contract + shipped reference authority** — approve this architecture (interface + self-contained reference authority + optional adapters) over v1's "AgentDispatch as owner"? (Recommendation: yes — satisfies the ruling and "just works.")
2. **Trust boundary / deployment form of the reference authority** — is the reference authority an **embedded in-process library** (logical/interface separation only — same OS user and trust domain as the transport, simplest "just works") or a **separate local process/daemon** (genuine trust boundary, closer to Decisive's "server-side" framing, more to run)? This is the one place "just works" and "must not self-certify" are in tension: an embedded authority satisfies the letter (the transport calls the interface and never self-certifies) but the separation is logical, not a process boundary. **Recommendation:** ship both — embedded by default for "just works," with an opt-in daemon mode that provides a real trust boundary for fleets that want it. Also: storage location (fleet-root `.agentbootup/apply-authority.db` vs `~/.agentbootup/`).
3. **Atomicity** — approve SQLite single-transaction atomic consume (`UPDATE ... WHERE used_at IS NULL` inside the tx with the receipt append) as the default; the AgentDispatch NoSQL→Postgres migration becomes an *optional adapter* concern, not a contract requirement?
4. **Role assignment config** — where does the fleet owner declare `approval_issuer`/`coordinator` roles? Extend `agentbootup.json` with a `roles` block, or a separate `fleet-roles.json`? (Recommendation: extend `agentbootup.json` to keep one source of truth.)
5. **Canary scope (restored from v1 Q6)** — confirm the bounded disposable SeedID Mac-mini canary uses this same control plane (no local-store carve-out), per the ruling which named the canary explicitly. And confirm the canary Mac mini uses its existing `machine-id` UUID as a `machine`-type identity registered with the authority (host-local, separate enrollment), not a brain name.
6. **Optional AgentDispatch/Mech adapter for our fleet** — do we (the portfolio) want to build the centralized adapter for our own multi-brain fleet, or run the reference authority per-fleet? (This is a portfolio deployment choice, not a contract blocker.)

## 6. Explicitly NOT authorized (restated)

No apply execution, target contact, identity mint, remote transport, daemon start, approval consumption, or canary mutation. This document proposes a contract; it implements nothing. AgentBootup will not begin the execute slice until Decisive approves this contract.

## 7. Changes from v1 (`#421`)

- **Owner:** "AgentDispatch + Mech Storage" (v1) → "interface + shipped reference authority; AgentDispatch/Mech demoted to an optional adapter" (v2).
- **External dependency:** v1 forced AgentDispatch/Mech on all consumers; v2 forces nothing — reference authority is embedded (SQLite).
- **Identities:** v1 implied a parallel registry; v2 makes explicit that brain names stay as the existing `agent_id` system, roles are owner-configured metadata, and only the target machine is a new `machine`-type identity.
- **Atomicity source:** v1 sourced from an external Postgres cluster; v2 sources from embedded SQLite (the same `WHERE used_at IS NULL` atomicity, locally) and makes the Postgres migration an optional-adapter concern.
- **Required surfaces:** unchanged — all 6 from Decisive's decision are still covered, now by the reference authority + interface.
