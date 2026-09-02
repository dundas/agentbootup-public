import fs from 'fs';

export function buildTranscriptMetadata(entry, agentId, { hostname = '', machineId = '' } = {}) {
  const stats = fs.statSync(entry.path);
  return {
    session_id: entry.sessionId,
    agent_id: agentId,
    cli: entry.cli,
    storage_key: `${agentId}/${entry.cli}/${entry.sessionId}`,
    project_path: entry.projectNormalized,
    source_path: entry.path,
    source_machine: {
      hostname,
      machine_id: machineId,
    },
    size_bytes: stats.size,
    mtime: stats.mtime.toISOString(),
    uploaded_at: new Date().toISOString(),
  };
}
