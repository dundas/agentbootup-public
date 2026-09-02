import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const probe = path.join(process.cwd(), 'scripts/runtime-adapters/hermes-m0h-database-probe.py');

async function loadContract() {
  const python = Bun.which('python3');
  if (!python) throw new Error('python3 is required for the database probe tests');
  const code = [
    'import ast,json,sys',
    'tree=ast.parse(open(sys.argv[1],encoding="utf-8").read())',
    'values={node.targets[0].id:ast.literal_eval(node.value) for node in tree.body if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name) and node.targets[0].id in {"DB_ORACLES","EXPECTED"}}',
    'print(json.dumps({"oracles":values["DB_ORACLES"],"expected":{key:{"objectCount":value["objectCount"],"schemaSha256":value["schemaSha256"]} for key,value in values["EXPECTED"].items()}}))',
  ].join(';');
  const child = Bun.spawn([python, '-I', '-B', '-c', code, probe], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  return JSON.parse(stdout);
}

describe('Hermes M0-H database safety evidence', () => {
  test('pins both database schemas and six append-only restore oracles', async () => {
    const contract = await loadContract();
    expect(contract.oracles).toHaveLength(6);
    expect(new Set(contract.oracles).size).toBe(6);
    expect(Object.keys(contract.expected).sort()).toEqual([
      'cron_executions',
      'session_database',
    ]);
    expect(contract.expected.session_database.objectCount).toBe(43);
    expect(contract.expected.cron_executions.objectCount).toBe(3);
    expect(contract.expected.session_database.schemaSha256).toHaveLength(64);
    expect(contract.expected.cron_executions.schemaSha256).toHaveLength(64);
  }, 15_000);

  test('uses SQLite backup and independently rejects raw WAL-era main-file copies', async () => {
    const source = await fs.readFile(probe, 'utf8');
    expect(source).toContain('backup._safe_copy_db');
    expect(source).toContain('PRAGMA integrity_check');
    expect(source).toContain('PRAGMA foreign_key_check');
    expect(source).toContain('committedWalCanariesMissed');
    expect(source).toContain('destinationDeleted');
    expect(source).toContain('discard_unqualified');
    expect(source).not.toContain('SessionDB(');
  });

  test('keeps reports free of local paths, raw sidecar names, and fixture secrets', async () => {
    const source = await fs.readFile(probe, 'utf8');
    expect(source).not.toContain('/Users/kefentse');
    expect(source).not.toContain('/home/runner');
    expect(source).not.toContain('SYNTHETIC_SECRET_DO_NOT_USE_');
    expect(source).toContain('structured result contains forbidden path, sidecar, or canary material');
    expect(source).toContain('bounded_cleanup');
  });

  test('executable SQLite seam preserves committed WAL state atomically and excludes uncommitted state', async () => {
    const python = Bun.which('python3');
    if (!python) throw new Error('python3 is required for the database seam test');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-db-seam-'));
    const code = `
import importlib.util,json,shutil,sqlite3,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("database_probe",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
database=Path(sys.argv[2])
with sqlite3.connect(database) as connection:
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY)")
    connection.execute("CREATE TABLE agentbootup_fixture_canary(profile TEXT, value TEXT)")
    connection.execute("INSERT INTO sessions VALUES ('session-default')")
    connection.execute("INSERT INTO agentbootup_fixture_canary VALUES ('default','fixture')")
    connection.commit()
    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
writer=module.open_wal_canary(database,"default","session_database")
raw=database.with_name("raw.db")
safe=database.with_name("safe.db")
shutil.copyfile(database,raw)
source=sqlite3.connect(database)
destination=sqlite3.connect(safe)
source.backup(destination)
destination.close()
source.close()
def counts(target):
    with sqlite3.connect(target) as connection:
        return {
            "committed":connection.execute("SELECT count(*) FROM agentbootup_fixture_canary WHERE profile='probe-committed-default'").fetchone()[0],
            "uncommitted":connection.execute("SELECT count(*) FROM agentbootup_fixture_canary WHERE profile='probe-uncommitted-default'").fetchone()[0],
            "pair":connection.execute("SELECT count(*) FROM agentbootup_fixture_canary WHERE profile IN ('probe-pair-a-default','probe-pair-b-default')").fetchone()[0],
            "integrity":connection.execute("PRAGMA integrity_check").fetchone()[0],
        }
result={"raw":counts(raw),"safe":counts(safe)}
writer.rollback()
writer.close()
print(json.dumps(result,sort_keys=True))
`;
    try {
      const child = Bun.spawn([python, '-I', '-B', '-c', code, probe, path.join(root, 'state.db')], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        raw: { committed: 0, integrity: 'ok', pair: 0, uncommitted: 0 },
        safe: { committed: 1, integrity: 'ok', pair: 2, uncommitted: 0 },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test('safe-copy failure deletes the destination and leaves the source valid', async () => {
    const python = Bun.which('python3');
    if (!python) throw new Error('python3 is required for the database failure seam test');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-db-failure-'));
    const code = `
import importlib.util,json,sqlite3,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("database_probe",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
source=Path(sys.argv[2])
destination=Path(sys.argv[3])
with sqlite3.connect(source) as connection:
    connection.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY)")
    connection.execute("CREATE TABLE agentbootup_fixture_canary(profile TEXT, value TEXT)")
    connection.execute("INSERT INTO sessions VALUES ('session-default')")
    connection.execute("INSERT INTO agentbootup_fixture_canary VALUES ('default','fixture')")
class Backup:
    sqlite3=sqlite3
    @staticmethod
    def _safe_copy_db(source_path,destination_path):
        try:
            origin=sqlite3.connect(source_path)
            target=sqlite3.connect(destination_path)
            origin.backup(target)
            target.close()
            origin.close()
            return True
        except Exception:
            destination_path.unlink(missing_ok=True)
            return False
print(json.dumps(module.backup_failure_evidence(Backup,source,destination),sort_keys=True))
`;
    try {
      const child = Bun.spawn([
        python, '-I', '-B', '-c', code, probe,
        path.join(root, 'source.db'), path.join(root, 'destination.db'),
      ], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        destinationDeleted: true,
        returnedFalse: true,
        sourceStillValid: true,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
