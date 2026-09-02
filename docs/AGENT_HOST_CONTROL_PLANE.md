# AgentHost Protocol v1 Control Plane

This is Agentbootup's desired-state authority for `agenthost.protocol.v1`. It
models an enrolled host and resolves an authorized `(brainId, hostId,
deploymentGeneration)` target. It is not a transport, relay, tunnel, endpoint
URL, remote shell, desktop protocol, generic port forwarder, or LivePort
integration.

The older Runtime Lease API remains a separate hosted-runtime mechanism. Its
ingress references must not be used as AgentHost Protocol v1 host credentials.

## Authority boundary

| Concern | Owner |
| --- | --- |
| Brain identity, desired host assignment, generation, enrollment, session grant | Agentbootup control plane |
| Host private key and local process supervision | Enrolled host / AgentHost |
| Protocol session execution | AgentHost |
| Environment-native capability and effect approval | AgentMount |
| Later transport binding | Separate, human-approved transport adapter |

Each host discloses exactly one supported tuple:

| Isolation class | Key custody | Ownership |
| --- | --- | --- |
| `managed-cloud-sandbox` | `managed-service` | `managed-by-agentbootup` |
| `user-owned-local-host` | `user-device` | `owned-by-user` |

The control plane stores only a SHA-256 fingerprint of a host public key. It
never accepts, syncs, exports, logs, or returns a host/device private key.

## Authenticated lifecycle

All routes currently remain on the existing admin-authenticated server surface.
External personal API keys are denied until Agentbootup has durable per-brain
ownership scopes. This is deliberate default-deny, not a substitute for user
authorization.

The mutable control-plane surface is single-writer for this phase. Mech Storage
does not currently expose the conditional-write primitive required to safely
run enrollment/replacement mutations on multiple server replicas; a future
scaled deployment must add that storage-level fence first. Reads fail closed if
the host and desired-state records disagree.

1. Create a one-time enrollment challenge with a host ID, public-key
   fingerprint, and disclosure tuple.
2. Deliver the returned enrollment secret to the host through an authenticated
   out-of-band ceremony. Agentbootup stores only its hash.
3. Redeem it once with the creating credential. A new active host advances the
   brain's generation; replacing a host revokes the prior one first.
4. Resolve the active target. Resolution returns no network address.
5. Issue a 30–600 second session grant bound to the exact target, caller
   credential, and subset of `turn.submit`, `event.stream`, and
   `session.cancel`.

Revoking an active host increments generation and clears the active target;
therefore every prior session grant fails generation validation even if it has
not yet expired.

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/brains/:brainId/agent-hosts/enrollment-challenges` | Create one-time enrollment material; response is the only plaintext enrollment-secret delivery. |
| `POST` | `/v1/brains/:brainId/agent-hosts/enrollments/:enrollmentId/redeem` | Consume a challenge and activate the fenced host. |
| `DELETE` | `/v1/brains/:brainId/agent-hosts/:hostId` | Revoke the active host and advance generation. |
| `GET` | `/v1/brains/:brainId/agent-host-target` | Resolve the typed active host target; never returns an endpoint URL. |
| `POST` | `/v1/brains/:brainId/agent-host-session-grants` | Issue a short-lived, scoped grant for the resolved generation. |

No route accepts an `endpoint`, `tunnel`, `port`, `hostPrivateKey`,
`deviceSecret`, `environmentGrant`, or `LivePort` parameter.

## Portability exclusion

`.agenthost/**`, `.agent-host/**`, `brain/.agenthost/**`,
`brain/.agent-host/**`, and AgentHost host/device/transport
credential filenames are hard-denied by both local brain-asset selection and
the server asset-push validator. A `.gitignore` negation cannot re-allow them.
They have no secret-sync exception and no export or restore pathway.

## Remaining gate

Task 4 provides the only permitted data-path proof: one authenticated client,
one enrolled local host, and the five Protocol v1 operations over an in-process
or loopback adapter. It must demonstrate stale generation, revoked host,
cursor theft/expiry, duplicate submit, and cancellation-race failures before
any remote transport decision.
