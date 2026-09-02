#!/usr/bin/env node
import { runHostExtensionClientDryRun } from '../lib/daemon/host-extension-client.mjs';

process.stdout.write(`${JSON.stringify(await runHostExtensionClientDryRun())}\n`);
