import fs from 'node:fs';
import path from 'node:path';
import { assertSafeBrainId, attestRuntime } from './runtime.mjs';
import { getDaemonDir } from '../../lib/process/pid-utils.js';

const marker = /^memory\/daily\/burn-in-probe-[a-z-]+-\d+\.md$/;
function root(value) { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('unsafe runtime root'); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- value passed the absolute-path gate; resolve only normalizes trailing separators before canonical identity comparison.
  const lexical = path.resolve(value); if (!fs.existsSync(lexical) || fs.lstatSync(lexical).isSymbolicLink()) throw new Error('unsafe runtime root'); const stable = fs.realpathSync(lexical); if (lexical !== stable) throw new Error('unsafe runtime root'); return stable; }
function rel(value) { if (typeof value !== 'string' || !marker.test(value)) throw new Error('unsafe marker'); return value; }
function file(runtimeRoot, relative) { return path.join(root(runtimeRoot), ...rel(relative).split('/')); }
function args(argv, names) { if (argv.length !== names.length * 2) throw new Error('invalid arguments'); const out = Object.create(null); for (let i=0;i<argv.length;i+=2) { if (!names.includes(argv[i]) || out[argv[i]] !== undefined || !argv[i+1] || /[\x00-\x1f\x7f]/.test(argv[i+1])) throw new Error('invalid arguments'); out[argv[i]]=argv[i+1]; } return out; }
export function runRemoteHelper(argv, stdin = '') {
  const op = argv.shift();
  if (op === 'root') { const a=args(argv, ['--root']); root(a['--root']); return { ok:true }; }
  if (op === 'attest') { const a=args(argv, ['--root','--brain','--ref','--commit']); return attestRuntime(a['--root'], { brain: assertSafeBrainId(a['--brain']), canonicalRef:a['--ref'], canonicalCommit:a['--commit'] }); }
  if (op === 'health') { const a=args(argv, ['--brain']); const p=path.join(getDaemonDir(), `brain-sync-health-${assertSafeBrainId(a['--brain'])}.json`); return fs.lstatSync(p).isSymbolicLink() ? { ok:false } : { ok:true, health: JSON.parse(fs.readFileSync(p,'utf8')) }; }
  const a=args(argv, op === 'write' ? ['--root','--marker'] : ['--root','--marker']); const p=file(a['--root'],a['--marker']);
  if (op === 'write') { fs.mkdirSync(path.dirname(p), { recursive:true }); fs.writeFileSync(p, stdin, 'utf8'); return { ok:true }; }
  if (op === 'read') { try { const s=fs.lstatSync(p); if (!s.isFile() || s.isSymbolicLink()) return { status:'error' }; return { status:'present', content:fs.readFileSync(p,'utf8') }; } catch (e) { return e?.code === 'ENOENT' ? { status:'absent' } : { status:'error' }; } }
  if (op === 'delete') { try { fs.rmSync(p); } catch (e) { if (e?.code !== 'ENOENT') throw e; } return { ok:true }; }
  throw new Error('invalid operation');
}
