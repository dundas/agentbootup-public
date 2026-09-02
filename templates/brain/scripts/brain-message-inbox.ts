#!/usr/bin/env bun
/**
 * brain-message-inbox — repo-self-contained ADMP inbox runtime (PRD-0038 WS-1 / Task 6).
 *
 * Distributed by agentbootup into every brain at brain/scripts/brain-message-inbox.ts
 * (manifest role:runtime). Repo-self-contained: NO cross-repo import, NO npm dependency,
 * NO `~/.brain` access. Credentials come from the ENVIRONMENT (vault-redeemed at launch),
 * never from disk — this is what lets a sandboxed/teleported brain read its inbox with
 * zero host state.
 *
 * Usage:
 *   bun brain/scripts/brain-message-inbox.ts [--read-only] [--json] [--limit N]
 *   bun brain/scripts/brain-message-inbox.ts --help
 *
 * Env (ADMP):
 *   ADMP_BASE_URL   hub base (default https://agentdispatch.fly.dev)
 *   ADMP_AGENT_ID   this agent's id
 *   ADMP_API_KEY    api-key auth (X-Api-Key) — the repo-self-contained read path
 *   ADMP_SECRET_KEY signature auth — see the SEAM note below (not implemented here)
 *
 * Exit codes:
 *   0   success
 *   10  required credentials missing/empty in env (provisioned != configured)
 *   1   runtime/transport error
 *
 * --read-only guarantees: pull + list ONLY. No ack, no read-state mutation, no writes
 * outside the current working directory, no `~/.brain` access.
 *
 * SEAM: signature (HMAC) auth lives in the AgentDispatch CLI; this repo-local runtime
 * implements the api-key read path. Wire signature auth here if/when a brain needs it.
 */

const HELP = `brain-message-inbox — read this brain's ADMP inbox (repo-self-contained)

Usage:
  bun brain/scripts/brain-message-inbox.ts [--read-only] [--json] [--limit N]
  bun brain/scripts/brain-message-inbox.ts --help

Options:
  --read-only   Pull + list only — no ack, no writes, no ~/.brain (default behavior)
  --json        Emit raw JSON instead of a table
  --limit N     Show at most N messages
  -h, --help    Show this help

Env: ADMP_BASE_URL, ADMP_AGENT_ID, and ADMP_API_KEY (api-key auth).
Exit 10 when required credentials are missing in the environment.`;

interface Args {
  help: boolean;
  readOnly: boolean;
  json: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, readOnly: false, json: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--read-only') args.readOnly = true;
    else if (a === '--json') args.json = true;
    else if (a === '--limit') {
      // Only consume the next token as the value if it isn't another flag — so a
      // forgotten value (`--limit --json`) doesn't swallow the following flag.
      const next = argv[i + 1];
      const raw = next !== undefined && !next.startsWith('--') ? argv[++i] : next;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        args.limit = Math.floor(n);
      } else {
        console.error(`[brain-message-inbox] ignoring invalid --limit value ${JSON.stringify(raw)} (want a positive integer)`);
        args.limit = null;
      }
    }
  }
  return args;
}

interface AdmpConfig {
  baseUrl: string;
  agentId: string;
  apiKey: string;
}

/**
 * Resolve config from the environment only (never ~/.brain). Returns null when required
 * credentials are absent — the caller exits 10 (provisioned != configured).
 */
function resolveConfig(env: Record<string, string | undefined>): AdmpConfig | null {
  const baseUrl = (env.ADMP_BASE_URL || 'https://agentdispatch.fly.dev').replace(/\/$/, '');
  const agentId = (env.ADMP_AGENT_ID || '').trim();
  const apiKey = (env.ADMP_API_KEY || '').trim();
  if (!agentId || !apiKey) return null;
  return { baseUrl, agentId, apiKey };
}

async function fetchInbox(cfg: AdmpConfig, fetchImpl = fetch): Promise<unknown[]> {
  const url = `${cfg.baseUrl}/api/agents/${encodeURIComponent(cfg.agentId)}/inbox`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { 'X-Api-Key': cfg.apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`inbox fetch failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { messages?: unknown[] } | unknown[];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.messages)) return body!.messages!;
  // A 200 with an unrecognized body (e.g. an error envelope served with 200) is NOT an
  // empty inbox — warn so it is not silently reported as "0 messages".
  if (body && typeof body === 'object' && Object.keys(body).length > 0) {
    console.error('[brain-message-inbox] warning: inbox response had no recognized "messages" array — treating as empty');
  }
  return [];
}

export async function main(argv: string[], env = process.env, fetchImpl = fetch): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = resolveConfig(env);
  if (!cfg) {
    console.error('[brain-message-inbox] required credentials missing in env (need ADMP_AGENT_ID and ADMP_API_KEY).');
    return 10;
  }

  try {
    let messages = await fetchInbox(cfg, fetchImpl);
    if (args.limit != null) messages = messages.slice(0, args.limit);
    if (args.json) {
      console.log(JSON.stringify(messages, null, 2));
    } else {
      console.log(`Inbox for ${cfg.agentId}: ${messages.length} message(s)`);
      for (const m of messages as Array<Record<string, unknown>>) {
        console.log(`  [${m.type ?? 'message'}] ${m.subject ?? m.id ?? ''} (from ${m.from ?? '?'})`);
      }
    }
    // NOTE: `args.readOnly` is intentionally inert — this runtime is read-only BY
    // CONSTRUCTION (there is no ack/write code path). The flag is accepted so callers can
    // assert intent and so the smoke command is self-documenting; no mutating mode exists.
    void args.readOnly;
    return 0;
  } catch (err) {
    console.error(`[brain-message-inbox] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
