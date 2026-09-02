// Soak test fixture: cooperative long-running process. Exits on SIGTERM.
// Used by spawnDaemon(false) in daemon-restart.soak.test.ts.
// For stubborn (SIGTERM-ignoring) behaviour, spawnDaemon(true) uses a shell
// one-liner: sh -c 'trap "" TERM; while true; do sleep 0.5; done'

process.on('SIGTERM', () => { process.exit(0); });

process.stdout.write('ready\n');

// Self-destruct after 60s — ensures leaked processes from a crashed test cycle
// fail loudly rather than accumulating silently until afterAll.
setTimeout(() => { process.exit(1); }, 60_000).unref();

// Keep the event loop alive.
setInterval(() => {}, 500);
