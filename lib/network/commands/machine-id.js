import { hasFlag } from '../args.js';
import { getMachineId } from '../../machine-id/machine-id.js';

function printUsage(io) {
  io.stdout('Usage: agentbootup machine-id [--json]');
}

export async function runMachineIdCommand(args, io) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printUsage(io);
    return 0;
  }

  try {
    const machineId = await getMachineId();
    if (hasFlag(args, '--json')) {
      io.stdout(JSON.stringify({ machine_id: machineId }));
    } else {
      io.stdout(machineId);
    }
    return 0;
  } catch (err) {
    io.stderr(`machine-id failed: ${err.message}`);
    return 1;
  }
}
