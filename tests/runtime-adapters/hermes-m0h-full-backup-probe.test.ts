import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Hermes M0-H full-backup failure evidence', () => {
  test('executes the production injection seam and observes retained partial output', async () => {
    const python = Bun.which('python3');
    if (!python) throw new Error('python3 is required for the full-backup failure seam test');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-full-failure-')));
    roots.push(root);
    const output = path.join(root, 'incomplete.zip');
    const script = path.resolve('scripts/runtime-adapters/hermes-m0h-full-backup-probe.py');
    const program = [
      'import importlib.util,json,pathlib,sys',
      'spec=importlib.util.spec_from_file_location("probe",sys.argv[1])',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'class Backup:',
      ' def __init__(self): self._safe_copy_db=lambda src,dst: True',
      ' def run_backup(self,args):',
      '  outcomes=[self._safe_copy_db(pathlib.Path("a"),pathlib.Path("b")),self._safe_copy_db(pathlib.Path("c"),pathlib.Path("d"))]',
      '  pathlib.Path(args.output).write_bytes(b"partial-native-archive")',
      '  print("Backup incomplete:" if not all(outcomes) else "Backup complete:")',
      'backup=Backup()',
      'original=backup._safe_copy_db',
      'result,captured,injected=module.exercise_incomplete_backup(backup,pathlib.Path(sys.argv[2]))',
      'print(json.dumps({"captured":captured.strip(),"injected":injected,"partial":pathlib.Path(sys.argv[2]).read_text(),"restored":backup._safe_copy_db is original,"result":result}))',
    ].join('\n');
    const child = Bun.spawn([python, '-B', '-c', program, script, output], {
      cwd: globalThis.process.cwd(),
      env: { PATH: globalThis.process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      captured: 'Backup incomplete:',
      injected: true,
      partial: 'partial-native-archive',
      restored: true,
      result: null,
    });
  });
});
