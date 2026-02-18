# AgentBootup.com: Hosting Strategy & Roadmap

## Executive Summary
This document outlines the architectural and business strategy to transition **AgentBootup** from a CLI tool into a managed SaaS platform (`agentbootup.com`). The goal is to allow users to spin up secure, persistent OpenClaw (formerly ClawdBot/MoltBot) agents in the cloud without technical configuration.

## 1. Backend Infrastructure Selection

**Selected Provider:** **Fly.io** (utilizing the **Sprites** pattern)

### Rationale
*   **Security (Firecracker MicroVMs):** Fly.io uses hardware-virtualized Firecracker VMs. This provides strong isolation between users. If one agent is compromised via prompt injection, it cannot access the host node or other users' agents.
*   **Stateful Persistence:** Agents require long-term memory (`MEMORY.md`). Fly Volumes allows us to mount persistent storage that survives restarts and deployments.
*   **Economics (Sleep/Wake):** Using the "Sprites" pattern, agents can "scale to zero" or hibernate when not processing messages, significantly reducing costs compared to always-on VPS instances.
*   **Global Low Latency:** Agents can be deployed in regions closest to the user, improving responsiveness for voice/real-time interactions.

*Analysis of Alternatives:*
*   *Daytona.io:* Optimized for ephemeral *development* environments (IDEs), not long-running autonomous agent processes.
*   *VPS (DigitalOcean/Linode):* Requires heavy management of OS security, updates, and isolation. Harder to scale to thousands of users securely.

## 2. Technical Architecture

### A. The "Golden Image" (Agent Container)
We will create a specialized Docker image serving as the runtime environment.
*   **Base:** Node.js (Latest LTS).
*   **Core Software:** OpenClaw (latest stable release).
*   **Pre-Seeded Skills:** The image will include `agentbootup`'s `templates/.gemini/skills` pre-installed.
*   **Entrypoint:** A wrapper script that:
    1.  Checks for the persistent volume at `/data`.
    2.  Restores `MEMORY.md` and sessions from `/data`.
    3.  Starts the OpenClaw Gateway.

### B. The Orchestrator (AgentBootup.com)
A web application (Next.js/Remix) acting as the control plane.
*   **User Flow:** User Sign Up -> Add API Keys (stored encrypted) -> "Spawn Agent".
*   **Provisioning Logic:**
    1.  Call Fly Machines API to create a new Volume (`user-<id>-data`).
    2.  Call Fly Machines API to boot the Golden Image with the Volume mounted.
    3.  Inject `CLAWDBOT_GATEWAY_TOKEN` as a secure environment variable.

### C. Security Architecture (The "Green Box")
To address the vulnerabilities found in self-hosted setups:
1.  **Network Isolation:** The Agent Machine binds *only* to the Fly.io private IPv6 network (6PN). No public IPv4 address is assigned.
2.  **Secure Proxy:** `agentbootup.com` runs a lightweight proxy. Users access their agent's dashboard via `agentbootup.com/dashboard/<agent-id>`, which tunnels authenticated traffic to the private machine.
3.  **Secret Management:** API Keys (OpenAI, Anthropic) are injected at runtime into the VM's environment, never written to disk in plain text.

## 3. Implementation Phases

### Phase 1: Dockerization (POC)
*   Create a `Dockerfile` in the repo.
*   Ensure `bootup.mjs` can run in "headless" mode to seed the container during build.
*   Test manual deployment to Fly.io.

### Phase 2: Persistence & State
*   Configure OpenClaw to write logs/memory to a specific mount path.
*   Verify that `MEMORY.md` survives a machine restart.

### Phase 3: The Dashboard (MVP)
*   Build a simple web UI to trigger the Fly API.
*   Implement the secure proxy tunnel for the WebSocket connection.

## 4. Addressing "ClawdBot" Vulnerabilities
*   **Exposed Control Panels:** Solved by Private Networking (6PN) + Proxy. The panel is never on the open internet.
*   **Prompt Injection/File Access:** Solved by MicroVM isolation. The agent only sees its own container filesystem, not the host.
*   **API Key Theft:** Solved by ephemeral injection. Keys are memory-only or strictly scoped.

## Next Steps
1.  Review this plan.
2.  Authorize the creation of the `Dockerfile` to begin Phase 1.
