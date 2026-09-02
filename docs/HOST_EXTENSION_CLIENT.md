# Host-extension client

`agentbootup/host-extension-client.mjs` is the stable public local SDK entrypoint,
backed by `lib/daemon/host-extension-client.mjs` and
`lib/daemon/brain-asset-sync.mjs`. It is the integration seam
for an already admitted AgentBootup remote-local daemon. It is transport-only:
the integrating service owns its service ID, handler, payload meaning, policy,
and any action it takes.

```js
import { startManagedHostExtensionDaemon } from 'agentbootup/host-extension-client.mjs';

await startManagedHostExtensionDaemon({
  installHostExtensions(client) {
    client.register({
      serviceId: 'example.local-service/v1',
      async *handleRequest({ correlationId, payload, signal }) {
        // Validate and act on payload in the service, not in AgentBootup.
        yield { correlationId, result: 'service-owned opaque readback' };
      },
    });
  },
});
```

The installer is an explicit local programmatic dependency. It is never read
from environment or remote input and receives only the frozen `{ register }`
client—never Plane sessions, approvals, runtime authority, or transport
control.

The descriptor is deliberately closed: protocol version and the three
capabilities (`opaque_request`, `opaque_event`, `terminal_delivery`) are fixed;
there is no endpoint URL, action, owner, policy, approval, worktree, or runtime
configuration field. `register()` does not queue while offline:

- `unavailable` — no currently admitted fenced relay;
- `rejected_before_delivery` — malformed local registration or relay rejection;
- `registered` — the exact descriptor was sent on the admitted connector.

For a terminal relay receipt, `hostExtensionDeliveryOutcome()` returns
`delivered`, `rejected_before_delivery`, or `delivery_uncertain`.
`delivered` means transport delivery only; it never proves the service executed
an action.

Run a deterministic local contract fixture with the published CLI (or the
equivalent source script):

```sh
agentbootup host-extension dry-run
# source checkout:
node scripts/host-extension-client-dry-run.mjs
```

To run an installer in the managed daemon, pass an explicit local module. The
module must export either a named `installHostExtensions` function or its
default function. Its only argument is the same frozen registration client;
it cannot receive connector, Plane, approval, or runtime controls.

```js
// local-extension.mjs
export function installHostExtensions(client) {
  client.register({ serviceId: 'example.local-service/v1', async *handleRequest() {} });
}
```

```sh
agentbootup host-extension serve --module ./local-extension.mjs --jsonl
```

`serve` is long-running, so it rejects `--json`; use `--jsonl` for automation.
Each stdout line is an independently parseable envelope with `version`, an
increasing `sequence`, an ISO `timestamp`, an `event` (`starting`,
`registration`, `terminal`, `installer_error`, or `error`), and event `data`.
Daemon diagnostics always go to stderr in JSONL mode. The Plane-backed runtime
requires Bun: invoking `agentbootup ... serve` from the normal Node-installed
binary hands the command to Bun automatically (or returns a machine-readable
runtime error when Bun is unavailable). It deliberately does not emit a
`stopped` record: shutdown is controlled by normal process signals and the
managed daemon has no separate observable terminal lifecycle event. A terminal
receipt is not execution proof. Module paths must be regular local files and
may not be symbolic links (directly or through a parent directory); this keeps
the explicit local-module trust boundary auditable. Invalid paths are rejected
before import; `dry-run` never imports a local module or opens a remote
connection.
