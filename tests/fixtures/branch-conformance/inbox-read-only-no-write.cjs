// Conformance fixture: a --read-only inbox run must write NOTHING outside the RW root
// and must never touch ~/.brain (PRD-0038 Task 6.3 / WS-1 sandbox boundary).
//
// Mirrors the repo-self-contained inbox runtime's read-only behavior: read credentials
// from the ENVIRONMENT only, "fetch + list" (no network here — the point is the write
// surface), and produce output WITHOUT writing any file or touching the home dir. The
// write-observer preload asserts zero disallowed writes for this fixture.

// Read config from env only — never ~/.brain.
const agentId = process.env.ADMP_AGENT_ID || 'unset';
const apiKey = process.env.ADMP_API_KEY || '';

// A read-only run lists to stdout. It must NOT write state, NOT ack, NOT create files.
process.stdout.write(`inbox(read-only) for ${agentId}: 0 message(s) listed; creds=${apiKey ? 'present' : 'absent'}\n`);

// Intentionally: no fs.writeFileSync, no mkdir, no ~/.brain access. Any write here would
// be observed and fail the fixture — which is exactly the invariant we are locking in.
