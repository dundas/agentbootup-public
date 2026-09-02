# Inbound Chat & Approval Architecture — design input

**Date:** 2026-08-14
**Status:** research-backed design input — not a PRD, not a decision
**Contract:** `dundas/agentmount` @ `8a63ade` (`agent-mount/v1`)

Written after primary research in r/hermesagent (approximately 86,216 members at
research time) and r/openclaw (approximately 131,971 at research time) on 2026-08-14,
plus a first-hand walkthrough of the Hermex iOS onboarding and a competitive scan.

> **Scope correction — 2026-08-16.** The constrained local-connector transport is
> now the immediate external MVP under [PRD-0072](../tasks/0072-prd-remote-local-brain-chat.md).
> Its first slice is an AgentBootup daemon-initiated outbound connector and a fixed
> local Mech Plane messaging adapter that preserves the actual agent's tools, events,
> and environment approval policy; it provides TLS, encrypted persistence, durable
> authorization/fencing, and no public runtime credential or destination. Its relay may
> handle live content transiently to serve the authenticated client, but may not persist,
> cache, or log it; it must not claim end-to-end encryption. The mobile-specific profile described below—E2EE,
> QR/device pairing UX, push, offline encrypted queues, and multi-device key
> management—remains later work. The immediate product promise is to remotely operate
> the actual agent through its protocol, not expose a generic tunnel, raw
> machine-control proxy, or public local route.

---

## 1. Three constraints that fully determine the design

**C1 — Home machines have no inbound reachability.** NAT, dynamic IPs, sleeping
laptops. Any design where the *phone* reaches the *machine* requires a tunnel, VPN,
port-forward, or reverse proxy. Every such option is setup friction, a security
exposure, or both. **Therefore the machine must dial out.**

**C2 — Push notifications structurally require a server.** Only a server holding the
APNs certificate can wake an iPhone. A machine behind NAT cannot push. **Therefore
something must sit in the middle.** The purist "no relay" position is incompatible
with the single most valuable mobile feature.

**C3 — This audience will not send agent traffic in plaintext through a third party.**
Direct quote, highest-voted comment in a 168-comment client launch thread: *"Is this
gonna be open source? I'm not a big fan of just using a 3rd party app to connect to my
AI agent that knows so much about me / my life."*

For a two-step mobile experience, those three make one shape the best default.
VPNs and tunnels can also be secure, but add client setup, operational
dependency, or both; they are not the default product path.

## 2. The shape

**An outbound-connected, end-to-end encrypted broker whose keys the user holds.**

```
phone  ⇄  broker  ⇄  connector  →  localhost:9119  →  Hermes
         (ciphertext)   (outbound WS)
```

- The **connector** holds a persistent outbound WebSocket. Not polling — polling adds
  latency to the one interaction that matters (approvals) and burns cycles otherwise.
- The connector talks to Hermes over the gateway it **already exposes on localhost**.
  It works against **unmodified Hermes** — no fork, no upstream dependency on Nous.
- The **broker** relays ciphertext only. Keys are exchanged device-to-device through
  a short-lived, single-use pairing ceremony; the QR code is bootstrap material, not
  a durable shared secret. Devices must be individually revocable. The broker never
  holds content keys, but it *does* see operational metadata — timing, sizes, and
  routing — and must authenticate devices, enforce queue quotas/expiry, rate-limit,
  and log only redacted operational evidence. Say so publicly rather than claiming
  zero-knowledge.
- An encrypted queue holds messages while the phone is offline.
- **Push payloads carry no content** — only "something needs you." The app fetches and
  decrypts locally. This is the Signal pattern, which this audience already trusts.

### Two flows

**Phone-initiated:** phone → encrypted envelope → broker → pokes connector over the
open socket → connector decrypts → calls Hermes on localhost → Hermes streams →
connector encrypts chunks → broker → phone (live if foreground, queued if not).

**Agent-initiated (the one that matters):** Hermes reaches an irreversible effect or a
cron job completes → connector emits an encrypted envelope plus a contentless push →
broker → APNs → lock screen → user taps → app fetches, decrypts locally, renders
*"Send this email to the client?"* with Approve / Deny → decision returns encrypted →
connector releases or denies the gate.

## 3. This maps onto `agent-mount/v1` — the hard parts are already specified

Do not redesign these. They exist in `dundas/agentmount`:

| Problem | Contract element |
|---|---|
| Socket drops mid-stream; need ordered resumable replay | `@agentmount/contracts/chat` — durable, resumable chat events ordered by `(generation, sequence)` |
| User never taps the approval; must not hang or silently proceed | `intentResolutionDeadlineMs` + the `sweepIntents` adapter, whose only documented outcome is `"indeterminate"` |
| Retry after a flaky socket must not send the email twice | `idempotencyRequired: true` per functionality |
| Which actions deserve a push at all | `reversible: false` → compiler forces `minimumConformanceLevel: "L4"` (`src/compiler.ts:275`) + `approvalMode: "environment"` |

That last row is the product rule: **the contract already knows exactly which moments
deserve a lock-screen interrupt.** Nothing has ever surfaced them on a phone.

Relevant field shapes (`agentmount/src/core.ts`): `kind: "read" | "proposal" | "effect"`,
`approvalMode: "none" | "runtime" | "environment"`, `reversible: boolean`,
`minimumConformanceLevel: "L0".."L4"`.

## 4. Where the connector should live

**Not a Circle Computer desktop app.** Circle Computer PRD-0048 already ruled this out — *"V1 does not
require a Circle desktop application"* — and the reasoning is stronger here:

- **Most Hermes installs are headless** — VPS, lid-closed Mac mini, homelab, Pi.
  r/hermesagent has a dedicated VPS megathread. A GUI app that must be logged in
  excludes a large share of the market.
- **A second process is the specific thing this audience rejects.** The competing
  client that drew *"Downloading immediately!!"* pitched *"no extra relay service to run
  alongside your stack, no second process to keep alive."*

The agentbootup daemon already solves the hard operational parts: launchd/systemd
lifecycle, reboot survival, credential storage (ClearAuth, device login, revocation),
a hosted service, headless, cross-platform, `npm i -g agentbootup`.

**MVP recommendation:** begin with a clearly isolated connector module supervised by
the existing daemon, rather than introducing a second distributable solely for
architectural purity. Split it into a separately shipped process only when independent
updates, crash containment, or privilege separation have demonstrated value. A second
binary otherwise creates its own lifecycle, update, observability, and security burden.

**Honest gap:** the daemon today is built for *periodic reconciliation* — the converge
leg runs every 5 minutes. An approval that arrives 5 minutes late is useless. A
persistent low-latency socket with reconnect-and-resume is genuinely new work.

## 5. Competitive context

**Nobody has push approvals.** Hermex (the dominant client, MIT, 730+ stars, 4.7 App
Store) has **no push at all** — the top reply on its launch thread is *"I hope
notifications are on the roadmap!"* HMAI has local notifications only. This is not an
oversight they can patch: **a VPN/tunnel architecture cannot deliver push**, because it
depends on the phone holding a connection open.

Four connection architectures exist in the wild today:

1. **Built-in gateway/dashboard** (`:9119`) — Conduit, The Abyss. No WebUI needed.
2. **Reverse proxy / tunnel** — Cloudflare Tunnel, Traefik + Authelia.
3. **VPN** — Tailscale/Netbird. What Hermex requires, and the source of its 8-step onboarding.
4. **Outbound relay** — `dylan-buck/Hermes-iOS` (app → relay → connector → Hermes). The
   only one that removes the second app from the user's phone. Closest prior art.

**Direct product competitors:** `agent-life.ai` — same OSS-core-plus-paid-cloud model,
$9/$29/$79, supports Hermes/OpenClaw/ZeroClaw, zero-knowledge, **no mobile, no push**;
and `brainpack` (OSS CLI, git-based, 16 platforms, free). Nous also shipped
`hermes export` / `hermes import` — free, built-in, single-file, credentials stripped.

**agent-life has zero traction in these communities** — no mentions across
r/hermesagent or r/openclaw in any query. The market is loud (845-pt setup posts); they
simply never showed up. That is a distribution failure, and it is the gap to exploit.

## 6. Onboarding target

Current Hermex path, walked first-hand: paste a prompt into your agent → it clones a
Node app → installs deps → generates a password → installs a VPN → authenticates it →
configures `tailscale serve` or falls back to binding `0.0.0.0` → sets up auto-start →
install a second app on the phone → sign into the same tailnet → keep it connected →
type in a URL and password. **Eight-plus steps, two apps, and security-critical
configuration delegated to a non-deterministic agent.**

Target:

1. Install the app. It shows a QR code.
2. Run one command on the machine (or paste one line to the agent) and scan it.

**Two steps.** The QR carries broker address + pairing secret; key exchange happens
between the user's two devices. That is the Plex / Sonos / 1Password bar.

It must also *stay* smooth: reconnect after reboot without re-pairing; no VPN to
toggle when travelling; pair a second machine and the phone shows one agent with two
hosts; and when the machine is genuinely asleep, say *"host offline, last seen 14:20"*
rather than spinning.

## 7. Business shape

The client will be free — it always is, and an official Nous client is likely coming
(a commenter reports mobile code already in their repo). The **broker** is the durable
asset because it is operational: uptime, APNs cert rotation, key management at pairing,
queue durability.

Free/paid boundary should be **whose infrastructure carries the packet**, not a feature
list: run your own broker and everything is free forever; use the hosted one and it is
~$10/mo. That satisfies the open-source requirement, matches the $0 client anchor, and
charges only for real COGS.

**Backup is not the upsell.** Three independent confirmations: Nous gave it away free
(`hermes export`), the $9 competitor selling it has no users, and the community answers
the question with git — *"if you aren't automatically backing up your openclaw to
Github… what are you even doing?"* The one explicit backup thread scored **4 points**.

## 8. Open questions for the owning brain

- When do independent updates, crash containment, or privilege separation justify a
  separately shipped connector process?
- Self-hostable broker at launch, or hosted-only first? The audience's open-source
  expectation may make self-hostable a launch requirement rather than a follow-up.
- Does the phone get a chat surface at all in v1, or only approvals + status + capture?
  Chat is commodity; approvals are the wedge.

## 9. Security principles validated after this draft

- The connector's outbound-only topology is the right default for a machine without
  inbound reachability; it removes the need to open a firewall port, but does not by
  itself create end-to-end encryption or replace authorization.
- The broker and connector must treat every command as untrusted: authenticate and
  authorize each action, bound message sizes and queues, expire/revoke long-lived
  sessions, and do not treat one socket handshake as unlimited authority.
- An approval must bind an opaque environment-issued challenge or authorization ID,
  the AgentMount canonical argument `bindingDigest`, the separately resolved mount,
  functionality, resource, principal, epoch/generation and assurance, the current
  agent/host authorization fence, and an expiry. No response or timeout may silently
  approve an effect; the only safe unresolved result is `indeterminate`.
- A server-mediated hosted route must never accept a client-provided URL, provider,
  runtime, `cwd`, or credential. Its destination is server-selected and bound to the
  current authorization fence.

Primary references: [NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final),
[OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html),
[OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html),
and [RFC 9449 (DPoP)](https://datatracker.ietf.org/doc/html/rfc9449).
