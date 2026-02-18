#!/usr/bin/env bun
/**
 * Minimal Brain Example
 *
 * Demonstrates the @dundas/agent-runtime API.
 * This is what a brain looks like with the runtime — ~30 lines instead of ~300.
 */

import { createAgent } from '../src/index';
import { HeartbeatService } from '../src/services/heartbeat';
import { MessageService } from '../src/services/message';
import { ADMPTransport } from '../src/transports/admp';
import type { ServiceContext, TransportMessage } from '../src/service';

// ─── Business Logic ─────────────────────────────────────────

async function runHeartbeat(ctx: ServiceContext) {
  console.log(`[${ctx.agentName}] Heartbeat — checking systems...`);
  // Your heartbeat logic here: health checks, data processing, etc.
}

async function handleSkillPublished(message: TransportMessage, ctx: ServiceContext) {
  const body = message.body as { skill: string; storageKey: string };
  console.log(`[${ctx.agentName}] New skill available: ${body.skill}`);
  // Pull from Mech Storage + install to .claude/skills/
}

async function handleStatusRequest(message: TransportMessage, ctx: ServiceContext) {
  console.log(`[${ctx.agentName}] Status requested by ${message.from}`);
  if (ctx.transport) {
    await ctx.transport.sendMessage({
      to: message.from,
      subject: 'status_response',
      body: { status: 'operational' },
    });
  }
}

// ─── Agent Setup ────────────────────────────────────────────

const agent = createAgent({
  name: 'example-brain',
  port: 8080,

  // Optional: ADMP for inter-agent messaging
  transport: new ADMPTransport({
    hubUrl: process.env.ADMP_HUB_URL || 'https://agentdispatch.fly.dev',
    agentId: 'agent://example-brain',
    agentType: 'example',
    groups: ['portfolio-skills'],
  }),

  services: [
    // Periodic heartbeat
    new HeartbeatService({
      interval: 30 * 60 * 1000, // 30 minutes
      handler: runHeartbeat,
    }),

    // Message routing
    new MessageService({
      handlers: {
        'skill-published': handleSkillPublished,
        'status_request': handleStatusRequest,
      },
    }),
  ],
});

await agent.start();
