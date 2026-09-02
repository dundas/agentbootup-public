#!/usr/bin/env bun
/**
 * PRD-0054 PR-6 burn-in evaluation loop daemon.
 *
 * Measures the standalone bootup burn-in gate for cross-machine memory
 * convergence: (A) a contiguous 7-day window of zero blocked_conflict on both
 * machines, recomputed from the ledger every tick; (B) ACTIVE evidence — one
 * verified edit→converge→apply round-trip in EACH direction + one deletion-
 * tombstone propagation. Failures escalate to decisive via ADMP; they are NOT
 * "quiet".
 *
 * Run once to start:
 *   bun scripts/burn-in-daemon.ts
 *
 * Launch: bun scripts/burn-in-daemon.ts (or via agent-process createAgent API).
 * Daemon-registry/CLI wiring ('agentbootup daemon install burn-in') is a
 * follow-up task — not yet implemented.
 *
 * Configuration (env; use absolute paths — tilde is not expanded by the shell):
 *   AGENTBOOTUP_BURNIN_BRAIN=bootup
 *   AGENTBOOTUP_BURNIN_LOCAL_DIR=/absolute/path/to/bootup
 *   AGENTBOOTUP_BURNIN_MINI_SSH=user@mini-host      # required for remote reads/writes
 *   AGENTBOOTUP_BURNIN_KNOWN_HOSTS=/absolute/path/to/known_hosts # pre-provisioned host key (required)
 *   AGENTBOOTUP_BURNIN_REMOTE_DIR=/absolute/path/to/bootup
 *   AGENTBOOTUP_BURNIN_STORE=server://bootup
 *   AGENTBOOTUP_BURNIN_STATE_ROOT=/absolute/path/to/agentbootup/burn-in-state
 *   AGENTBOOTUP_BURNIN_CANONICAL_REF=refs/heads/main
 *   AGENTBOOTUP_BURNIN_CANONICAL_COMMIT=<reviewed-immutable-commit>
 *   AGENTBOOTUP_BURNIN_HEALTH_INTERVAL_MS=900000    # 15 min (Loop A)
 *   AGENTBOOTUP_BURNIN_PROBE_INTERVAL_MS=43200000  # 12h   (Loop B — 2x/day)
 *   AGENTBOOTUP_BURNIN_PROPAGATION_WAIT_MS=7200000 # 12 min (2× converge + buffer)
 *   AGENTBOOTUP_BURNIN_SEVEN_DAY_MS=604800000       # 7 days (sign-off bar)
 *   AGENTBOOTUP_BURNIN_STALE_HEALTH_MS=3600000      # 1h (stale health threshold)
 *   AGENTBOOTUP_BURNIN_BRAIN_MSG=/path/to/brain-msg.ts  # escalation helper (optional; no default)
 *
 * Default-off behavior: if converge is `disabled` on either machine, Loop A
 * records the row (a reset event — no false clean) and Loop B skips (nothing to
 * converge). The harness exercises the already-shipped convergence; it does not
 * enable it. See tasks/0054-pr6-burn-in-eval-loop-design.md.
 */

import { createAgent, HeartbeatService } from '@derivativelabs/agent-process';
import { $ } from 'bun';
import { appendRow, readRows, rollup, lastHealthObservationTs, signOffPostedInWindow, recoverCorruptLedger, type LedgerRow } from './burn-in/ledger';
import { readLocalHealth, readRemoteHealth, qualifyHealth, healthLedgerState, conflictEscalation } from './burn-in/health';
import { roundTrip, tombstoneProbe, type MachineTarget } from './burn-in/probe';
import { runProbeCycle } from './burn-in/probe-runner';
import { loadBurnInConfig } from './burn-in/config';
import { preflightBurnIn } from './burn-in/preflight';

const CONFIG = loadBurnInConfig();
const BRAIN = CONFIG.brain;
const LOCAL_DIR = CONFIG.localDir;
const MINI_SSH = CONFIG.miniSsh;
const MINI_DIR = CONFIG.miniDir;
const LEDGER = CONFIG.ledger;
const HEALTH_INTERVAL = Number(process.env.AGENTBOOTUP_BURNIN_HEALTH_INTERVAL_MS ?? 15 * 60_000);
const PROBE_INTERVAL = Number(process.env.AGENTBOOTUP_BURNIN_PROBE_INTERVAL_MS ?? 12 * 60 * 60_000);
const PROPAGATION_WAIT = Number(process.env.AGENTBOOTUP_BURNIN_PROPAGATION_WAIT_MS ?? 12 * 60_000);
const SEVEN_DAY_MS = Number(process.env.AGENTBOOTUP_BURNIN_SEVEN_DAY_MS ?? 7 * 24 * 60 * 60_000);
const STALE_HEALTH_MS = Number(process.env.AGENTBOOTUP_BURNIN_STALE_HEALTH_MS ?? 60 * 60_000); // 1h: health older than this is stale (roborev)

const macbook: MachineTarget = { machine: 'macbook', dir: LOCAL_DIR };
const mini: MachineTarget = { machine: 'mini', ssh: MINI_SSH, knownHosts: CONFIG.knownHosts, dir: MINI_DIR };

let tickCounter = 0;
let probeRun = 0; // for alternating round-trip direction + daily tombstone
// sign-off latch is now ledger-derived (signOffPostedInWindow) so a daemon
// restart after readiness does NOT re-send the escalation (roborev).

function log(msg: string): void { console.log(`[burn-in] ${new Date().toISOString()} ${msg}`); }

/** Best-effort ADMP escalation to decisive. Returns true on confirmed send,
 *  false on failure (roborev: the sign-off latch must only engage after a
 *  confirmed send, otherwise a failed escalation is permanently suppressed). */
async function escalate(subject: string, body: string): Promise<boolean> {
  const brainMsg = process.env.AGENTBOOTUP_BURNIN_BRAIN_MSG?.trim();
  if (!brainMsg) {
    log(`escalation not configured: ${subject}`);
    return false;
  }
  try {
    await $`bun ${brainMsg} send --to decisive --type bug_report --subject ${subject} --body ${JSON.stringify({ brain: BRAIN, ...JSON.parse(body) })}`.quiet();
    log(`escalated: ${subject}`);
    return true;
  } catch (err) {
    log(`escalation FAILED for "${subject}": ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Loop A: health gate ─────────────────────────────────────────────────────
const healthLoop = new HeartbeatService({
  name: 'burn-in-health',
  interval: HEALTH_INTERVAL,
  runOnStart: true,
  handler: async () => {
    const tick = ++tickCounter;
    const ts = new Date().toISOString();
    if (recoverCorruptLedger(LEDGER, tick).recovered) log('ledger corruption recovered — clean window reset');

    // Gap detection (adversarial SO-9): if the previous ledger row is older than
    // 3× the health interval, the harness (or the machine) was down with no
    // evidence during the gap — that must NOT count as clean. Record a reset
    // note so the rollup's contiguous clock restarts from here.
    // Gap detection (roborev): derive the last health observation from the
    // PERSISTENT ledger, not in-process memory. A daemon restart must not clear
    // the gap detector — if the process was down long enough to miss health
    // ticks, the next run must still emit a reset note (otherwise the clock can
    // fabricate a clean window across the downtime).
    const priorRows = readRows(LEDGER);
    const lastHealth = lastHealthObservationTs(priorRows);
    if (lastHealth && Date.parse(ts) - Date.parse(lastHealth) > 3 * HEALTH_INTERVAL) {
      appendRow(LEDGER, { ts, tick, kind: 'note', note: `health gap > 3× interval (last health ${lastHealth}) — reset contiguous clock`, reset: true });
      log(`health gap detected since ${lastHealth} — reset note recorded`);
    }

    const local = readLocalHealth(BRAIN);
    const remote = await readRemoteHealth(BRAIN, MINI_SSH, { knownHosts: CONFIG.knownHosts });

    // Freshness check (roborev): a stale 'ok' JSON left by a dead converge
    // daemon must not count as clean. If lastCycleAt is null or older than
    // STALE_HEALTH_MS, record 'stale' (not in CLEAN_STATES -> reset event).
    const freshState = (h: Parameters<typeof qualifyHealth>[0]): string => healthLedgerState(h, CONFIG.store, Date.now(), STALE_HEALTH_MS);

    appendRow(LEDGER, { ts, tick, kind: 'health', machine: 'macbook', state: freshState(local), blockedSince: local?.memoryConverge.blockedSince ?? null });
    appendRow(LEDGER, { ts, tick, kind: 'health', machine: 'mini', state: freshState(remote), blockedSince: remote?.memoryConverge.blockedSince ?? null });

    // Single snapshot for both rollup and latch check (roborev HIGH race:
    // two separate readRows(LEDGER) calls could see a reset land between them,
    // sending SIGN-OFF READY on stale state).
    const ledgerRows = readRows(LEDGER);
    const r = rollup(ledgerRows);
    const days = (r.contiguousCleanMs / (24 * 60 * 60_000)).toFixed(2);
    log(`health tick=${tick} macbook=${freshState(local)} mini=${freshState(remote)} contiguousClean=${days}d lastReset=${r.lastResetReason ?? 'never'}`);

    if (local && local.memoryConverge.state === 'blocked_conflict') {
      await escalate(`burn-in blocked_conflict on macbook (${BRAIN})`, JSON.stringify(conflictEscalation('macbook', local)));
    }
    if (remote && remote.memoryConverge.state === 'blocked_conflict') {
      await escalate(`burn-in blocked_conflict on mini (${BRAIN})`, JSON.stringify(conflictEscalation('mini', remote)));
    }

    if (r.signOffReady(SEVEN_DAY_MS)) {
      // Durable latch: check the ledger, not in-process memory (roborev: a restart
      // after readiness must not re-send the escalation). signOffPostedInWindow
      // returns true only if a signOffPosted note exists after the last reset.
      if (!signOffPostedInWindow(ledgerRows)) {
        // Only latch after a CONFIRMED send (roborev: if escalate() fails and we
        // latch anyway, the sign-off is permanently lost — the ledger suppresses
        // all retries. On failure, leave the latch open so the next tick retries.)
        const sent = await escalate(`burn-in SIGN-OFF READY for ${BRAIN}`, JSON.stringify({ contiguousCleanDays: Number(days), roundtrip: r.roundtrip, tombstone: r.tombstone }));
        if (sent) {
          appendRow(LEDGER, { ts, tick, kind: 'note', note: 'sign-off posted', signOffPosted: true });
          log('SIGN-OFF READY — posted to decisive (one-shot, ledger-latched); consider lowering to smoke cadence (OQ-2).');
        } else {
          log('SIGN-OFF READY — escalation FAILED; will retry next tick (latch NOT engaged)');
        }
      } else {
        log(`health tick=${tick} contiguousClean=${days}d — sign-off already posted (ledger latch held)`);
      }
    }
  },
});

// ── Loop B: active round-trip + tombstone probe ────────────────────────────
const probeLoop = new HeartbeatService({
  name: 'burn-in-probe',
  interval: PROBE_INTERVAL,
  runOnStart: false,
  handler: async () => {
    const tick = ++tickCounter;
    const ts = new Date().toISOString();
    const local = readLocalHealth(BRAIN);
    const remote = MINI_SSH ? await readRemoteHealth(BRAIN, MINI_SSH, { knownHosts: CONFIG.knownHosts }) : null;

    // Self-disable: if converge is not running on either side, there is nothing
    // to probe. Record a note (not a clean tick) and skip.
    // Gate probes on BOTH a clean state AND null blockedSince (roborev: a
    // machine stuck with state ok but blockedSince set must not generate probes).
    const armed = (h: Parameters<typeof qualifyHealth>[0]): boolean => qualifyHealth(h, CONFIG.store, Date.now(), STALE_HEALTH_MS).clean;
    if (!armed(local) || !armed(remote)) {
      appendRow(LEDGER, { ts, tick, kind: 'note', note: 'probe skipped — converge not armed on both machines' });
      log(`probe skipped tick=${tick} (converge not armed on both machines)`);
      return;
    }

    const result = await runProbeCycle({
      tick,
      runRoundTrip: () => probeRun % 2 === 0 ? roundTrip(macbook, mini, PROPAGATION_WAIT) : roundTrip(mini, macbook, PROPAGATION_WAIT),
      runTombstone: probeRun % 2 === 1 ? () => tombstoneProbe(macbook, mini, PROPAGATION_WAIT) : undefined,
      append: (row) => appendRow(LEDGER, row),
      rows: () => readRows(LEDGER),
    });
    if (result.exception) {
      log(`probe transport failure tick=${tick} — clean window reset`);
      await escalate(`burn-in probe transport failure (${BRAIN})`, JSON.stringify({ tick }));
      return;
    }
    const go = result.roundtrip!;
    log(`roundtrip tick=${tick} ${go.direction} propagated=${go.propagated}`);
    if (!go.propagated) await escalate(`burn-in round-trip NOT propagated (${go.direction})`, JSON.stringify({ marker: go.marker, hashIn: go.hashIn, hashOut: go.hashOut }));
    const tb = result.tombstone;
    if (tb) {
      log(`tombstone tick=${tick} goneOnRemote=${tb.goneOnRemote}`);
      if (!tb.goneOnRemote) await escalate(`burn-in tombstone NOT propagated (${BRAIN})`, JSON.stringify({ marker: tb.marker, deletedOn: tb.deletedOn }));
    }
    probeRun++;
  },
});

const agent = createAgent({
  name: 'burn-in',
  port: 8901, // outside the inbox-daemon pool (8767-8867) to avoid EADDRINUSE (roborev/@claude)
  services: [healthLoop, probeLoop],
});

if (!(await preflightBurnIn(CONFIG))) {
  throw new Error('burn-in preflight failed: runtime attestation is not ready');
}
log(`starting standalone burn-in loop: ${JSON.stringify(CONFIG.receipt)}`);
log(`Loop A health every ${HEALTH_INTERVAL / 60_000}min; Loop B probe every ${PROBE_INTERVAL / 3_600_000}h; propagation wait ${PROPAGATION_WAIT / 60_000}min; sign-off bar ${SEVEN_DAY_MS / 86_400_000}d`);

await agent.start();
