// Evidence-only Task 1.6 builder. It never downloads artifacts or reads a live Hermes home.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRawSecretViolations } from '../../lib/runtime-adapters/security.js';
import {
  deriveHermesLoaderEnvironment,
  HERMES_PROBE_PINS,
  serializeHermesProbeReport,
} from './hermes-m0h-probe.mjs';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PROFILE_NAMES = Object.freeze(['default', 'atlas', 'beacon']);
const ENTRY_POINTS = Object.freeze({
  hermes: 'hermes_cli.main:main',
  'hermes-agent': 'run_agent:main',
});
const UV_PIN = Object.freeze({
  version: '0.11.32',
  artifact: 'uv-x86_64-unknown-linux-gnu.tar.gz',
  sha256: 'aab924fd522efd06f1c5f3b93a243864fc453132c94b2dc49f1371b528a4b967',
  releaseWorkflowCommit: '3010295ae7ff572de459987ad70db315a62ecd61',
});
const REQUIREMENTS_SHA256 = '317e6f4a0dbf56999fafafcefe481dcd49cd64995d657592c08b3e7acaee0971';
const CLOSURE_AUTHORITY_URL = new URL('../../config/hermes-m0h-closure-authority-v1.json', import.meta.url);

function refuse(message) {
  throw new Error(`Hermes synthetic install refused: ${message}`);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const contained = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const overlaps = (left, right) => contained(left, right) || contained(right, left);
const normalizedName = (value) => value.toLowerCase().replace(/[-_.]+/g, '-');

function identityOf(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, uid: stat.uid });
}

function matchesIdentity(stat, identity) {
  return stat?.dev === identity.dev && stat?.ino === identity.ino && stat?.uid === identity.uid;
}

function lockedPackages(lockText) {
  const packages = new Map();
  for (const block of lockText.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    if (!name || !version) continue;
    const hashes = new Set([...block.matchAll(/hash = "sha256:([0-9a-f]{64})"/g)].map((match) => match[1]));
    packages.set(normalizedName(name), { name, version, hashes });
  }
  return packages;
}

async function privateDirectory(value, label, { empty = false, privateOnly = true } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    refuse(`${label} must be a normalized absolute path`);
  }
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) refuse(`${label} must be an existing non-symlink directory`);
  if (privateOnly && (stat.mode & 0o777) !== PRIVATE_DIR_MODE) refuse(`${label} must have mode 0700`);
  if (stat.uid !== process.getuid()) refuse(`${label} must be owned by the current uid`);
  const real = await fs.realpath(value);
  if (real !== value) refuse(`${label} or one of its ancestors is a symlink`);
  if (empty && (await fs.readdir(real)).length) refuse(`${label} must be empty`);
  return real;
}

async function regularFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    refuse(`${label} must be a normalized absolute path`);
  }
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) refuse(`${label} must be a regular non-symlink file`);
  if (stat.uid !== process.getuid()) refuse(`${label} must be owned by the current uid`);
  const real = await fs.realpath(value);
  if (real !== value) refuse(`${label} or one of its ancestors is a symlink`);
  return real;
}

async function fingerprintTree(root) {
  const rows = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stat = await fs.lstat(candidate);
      const relative = path.relative(root, candidate);
      if (entry.isDirectory()) {
        pending.push(candidate);
        rows.push([relative, 'directory', stat.uid, stat.mode & 0o777, stat.mtimeMs]);
      } else if (entry.isSymbolicLink()) {
        rows.push([relative, 'symlink', stat.uid, stat.mode & 0o777, await fs.readlink(candidate), stat.mtimeMs]);
      } else if (entry.isFile()) {
        rows.push([
          relative, 'file', stat.uid, stat.mode & 0o777, stat.size,
          sha256(await fs.readFile(candidate)), stat.mtimeMs,
        ]);
      } else {
        rows.push([relative, 'special', stat.uid, stat.mode & 0o177777, stat.mtimeMs]);
      }
    }
  }
  return sha256(Buffer.from(JSON.stringify(rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]))))));
}

async function run(command, args, { cwd, env: extraEnvironment = {}, timeoutMs = 60_000 }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        HOME: cwd,
        HERMES_HOME: cwd,
        PATH: '',
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC',
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        HERMES_DISABLE_LAZY_INSTALLS: '1',
        UV_NO_CACHE: '1',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        ALL_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '',
        ...extraEnvironment,
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let timedOut = false;
    const kill = () => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch {}
      }
    };
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > 256 * 1024) kill();
        else chunks.push(chunk);
      });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        timedOut,
        overflow: size > 256 * 1024,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

const BINDING_SNIPPET = String.raw`
import base64, configparser, csv, hashlib, importlib.metadata as md, io, json, os, pathlib, platform, re, stat, sys, tarfile, zipfile
wheel, wheelhouse, requirements, site, python, bin_dir, python_archive, runtime, uv_archive, uv_executable = map(pathlib.Path, sys.argv[1:11])
expected_closure = json.loads(sys.argv[11])
canon = lambda value: re.sub(r"[-_.]+", "-", value).lower()
def b64digest(data):
    return base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
def safe_member(name):
    candidate = pathlib.PurePosixPath(name.removeprefix("./"))
    return bool(str(candidate) not in ("", ".") and not candidate.is_absolute() and ".." not in candidate.parts)
def verify_wheel(artifact, expected_name, expected_version):
  if artifact.name != pathlib.Path(artifact.name).name or artifact.suffix != ".whl":
      raise SystemExit("non-wheel or non-basename closure artifact: " + artifact.name)
  with zipfile.ZipFile(artifact) as archive:
    infos = archive.infolist()
    names = [info.filename for info in infos]
    file_names = {info.filename for info in infos if not info.is_dir()}
    if len(names) != len(set(names)) or any(not safe_member(name) for name in names):
        raise SystemExit("unsafe or duplicate wheel member: " + artifact.name)
    records = [n for n in names if n.endswith(".dist-info/RECORD")]
    metadata = [n for n in names if n.endswith(".dist-info/METADATA")]
    if len(records) != 1 or len(metadata) != 1:
        raise SystemExit("wheel metadata is ambiguous: " + artifact.name)
    wheel_record = list(csv.reader(archive.read(records[0]).decode().splitlines()))
    wheel_rows = {}
    for name, digest, size in wheel_record:
        if name in wheel_rows or name not in file_names:
            raise SystemExit("wheel RECORD member mismatch: " + artifact.name)
        if name == records[0]:
            if digest or size:
                raise SystemExit("wheel RECORD self-row must be unhashed: " + artifact.name)
            wheel_rows[name] = (digest, size)
            continue
        data = archive.read(name)
        if digest != "sha256=" + b64digest(data) or int(size) != len(data):
            raise SystemExit("wheel RECORD mismatch: " + artifact.name + ":" + name)
        wheel_rows[name] = (digest, size)
    if set(wheel_rows) != file_names:
        raise SystemExit("wheel contains a file absent from RECORD: " + artifact.name)
    headers = {}
    for line in archive.read(metadata[0]).decode().splitlines():
        if ": " in line:
            key, value = line.split(": ", 1)
            headers.setdefault(key, value)
    if canon(headers.get("Name", "")) != expected_name or headers.get("Version") != expected_version:
        raise SystemExit("wheel filename/manifest metadata mismatch: " + artifact.name)
    return records[0], wheel_rows, archive.read(records[0]), archive.read(metadata[0])
with tarfile.open(python_archive, "r:gz") as archive:
    expected_tree = {}
    for member in archive.getmembers():
        if member.name in (".", "./"):
            continue
        relative = member.name.removeprefix("./").rstrip("/")
        if not relative:
            continue
        if not safe_member(member.name) or relative in expected_tree:
            raise SystemExit("unsafe or duplicate Python archive member")
        target = runtime / relative
        if member.isdir():
            expected_tree[relative] = ("dir", member.mode, None)
        elif member.isfile():
            expected_tree[relative] = ("file", member.mode, hashlib.sha256(archive.extractfile(member).read()).hexdigest())
        elif member.issym():
            resolved = pathlib.PurePosixPath(relative).parent.joinpath(member.linkname)
            if pathlib.PurePosixPath(member.linkname).is_absolute() or ".." in resolved.parts:
                raise SystemExit("Python archive symlink escapes runtime")
            expected_tree[relative] = ("symlink", None, member.linkname)
        else:
            raise SystemExit("Python archive contains unsupported member type")
    actual_tree = {}
    for target in runtime.rglob("*"):
        relative = target.relative_to(runtime).as_posix()
        info = target.lstat()
        if stat.S_ISLNK(info.st_mode):
            actual_tree[relative] = ("symlink", None, os.readlink(target))
        elif stat.S_ISDIR(info.st_mode):
            actual_tree[relative] = ("dir", stat.S_IMODE(info.st_mode), None)
        elif stat.S_ISREG(info.st_mode):
            actual_tree[relative] = ("file", stat.S_IMODE(info.st_mode), hashlib.sha256(target.read_bytes()).hexdigest())
        else:
            raise SystemExit("runtime tree contains unsupported member type")
    if actual_tree != expected_tree:
        missing = sorted(set(expected_tree) - set(actual_tree))
        extra = sorted(set(actual_tree) - set(expected_tree))
        changed = sorted(name for name in set(actual_tree) & set(expected_tree) if actual_tree[name] != expected_tree[name])
        raise SystemExit("extracted Python runtime tree mismatch: " + json.dumps({"changed": changed[:5], "extra": extra[:5], "missing": missing[:5]}))
runtime_python = runtime / "bin" / "python3.13"
if hashlib.sha256(runtime_python.read_bytes()).digest() != hashlib.sha256(python.read_bytes()).digest():
    raise SystemExit("isolated environment Python is not a copied pinned runtime executable")
mapped = []
if pathlib.Path("/proc/self/maps").is_file():
    for line in pathlib.Path("/proc/self/maps").read_text().splitlines():
        mapped_path = line.rsplit(None, 1)[-1]
        if "libpython3.13.so" in mapped_path and mapped_path.startswith("/"):
            mapped.append(str(pathlib.Path(mapped_path).resolve()))
    expected_library = str((runtime / "lib" / "libpython3.13.so.1.0").resolve())
    if not mapped or any(item != expected_library for item in mapped):
        raise SystemExit("Python loaded libpython outside the verified runtime")
wheel_record_name, wheel_rows, _, _ = verify_wheel(wheel, "hermes-agent", "0.19.0")
with zipfile.ZipFile(wheel) as archive:
    entries = [n for n in archive.namelist() if n.endswith(".dist-info/entry_points.txt")]
    if len(entries) != 1:
        raise SystemExit("Hermes wheel entry-point metadata is ambiguous")
    entry_config = configparser.ConfigParser()
    entry_config.read_file(io.StringIO(archive.read(entries[0]).decode()))
    wheel_entries = dict(entry_config["console_scripts"])
dist = md.Distribution.at(site / wheel_record_name.rsplit("/", 1)[0])
if dist.metadata["Name"] != "hermes-agent" or dist.version != "0.19.0":
    raise SystemExit("installed Hermes identity mismatch")
installed = []
owned_paths = {}
hermes_record_path = site / wheel_record_name
installed_record = list(csv.reader(hermes_record_path.read_text().splitlines()))
if len(installed_record) != len({row[0] for row in installed_record}):
    raise SystemExit("installed Hermes RECORD contains duplicate paths")
installed_rows = {name: (digest, size) for name, digest, size in installed_record}
def installed_record_name(name):
    marker = ".data/"
    if marker not in name:
        return name
    _, mapped = name.split(marker, 1)
    scheme, relative = mapped.split("/", 1)
    if scheme in ("purelib", "platlib"):
        return relative
    if scheme == "data":
        return os.path.relpath(bin_dir.parent / relative, site).replace(os.sep, "/")
    if scheme == "scripts":
        return os.path.relpath(bin_dir / relative, site).replace(os.sep, "/")
    raise SystemExit("unsupported wheel installation scheme: " + scheme)
for name, expected_row in wheel_rows.items():
    mapped_name = installed_record_name(name)
    if ".data/scripts/" not in name and installed_rows.get(mapped_name) != expected_row:
        raise SystemExit("installed RECORD is not bound to wheel RECORD: " + name)
dist_info = wheel_record_name.rsplit("/", 1)[0]
generated_metadata = {dist_info + "/INSTALLER", dist_info + "/REQUESTED",
                      dist_info + "/direct_url.json", dist_info + "/uv_cache.json"}
generated_scripts = {os.path.relpath(bin_dir / name, site).replace(os.sep, "/")
                     for name in wheel_entries}
expected_installed_rows = {installed_record_name(name) for name in wheel_rows} | generated_metadata | generated_scripts
if set(installed_rows) != expected_installed_rows:
    raise SystemExit("installed Hermes RECORD path accounting differs from wheel RECORD")
for item in dist.files or []:
    target = pathlib.Path(dist.locate_file(item))
    resolved = target.resolve()
    if str(resolved) in owned_paths:
        raise SystemExit("installed path is owned by multiple distributions: " + str(item))
    owned_paths[str(resolved)] = "hermes-agent"
    if item.hash:
        if target.is_symlink() or not target.is_file() or item.hash.mode != "sha256" or b64digest(target.read_bytes()) != item.hash.value:
            raise SystemExit("installed RECORD mismatch: " + str(item))
    elif str(item).endswith("/RECORD") is False:
        raise SystemExit("installed Hermes has an unhashed non-RECORD path: " + str(item))
    installed.append(str(item))
expected = {"hermes": "hermes_cli.main:main", "hermes-agent": "run_agent:main"}
actual_all = {ep.name: ep.value for ep in dist.entry_points if ep.group == "console_scripts"}
actual = {name: actual_all.get(name) for name in expected}
if actual != expected or actual_all != wheel_entries:
    raise SystemExit("console-script metadata mismatch")
expected_dependencies = {canon(row["name"]): row["version"] for row in expected_closure}
expected_distributions = expected_dependencies | {"hermes-agent": "0.19.0"}
installed_distributions = {}
for candidate in md.distributions(path=[site]):
    name = canon(candidate.metadata["Name"])
    if name in installed_distributions:
        raise SystemExit("duplicate installed distribution: " + name)
    installed_distributions[name] = candidate.version
if installed_distributions != expected_distributions:
    raise SystemExit("installed dependency closure mismatch")
source_records = {}
for row in expected_closure:
    artifact = wheelhouse / row["filename"]
    record_name, rows, record_bytes, metadata_bytes = verify_wheel(artifact, canon(row["name"]), row["version"])
    source_records[canon(row["name"])] = (record_name, rows)
for candidate in md.distributions(path=[site]):
    name = canon(candidate.metadata["Name"])
    if name == "hermes-agent":
        continue
    record_name, source_rows = source_records[name]
    installed_record_path = site / record_name
    if not installed_record_path.is_file():
        raise SystemExit("installed dependency RECORD path drifted: " + name)
    installed_record = list(csv.reader(installed_record_path.read_text().splitlines()))
    if len(installed_record) != len({row[0] for row in installed_record}):
        raise SystemExit("installed dependency RECORD contains duplicate paths: " + name)
    installed_rows = {row[0]: (row[1], row[2]) for row in installed_record}
    for member, expected_row in source_rows.items():
        mapped_member = installed_record_name(member)
        if ".data/scripts/" not in member and installed_rows.get(mapped_member) != expected_row:
            raise SystemExit("installed dependency is not bound to selected wheel: " + name + ":" + member)
    candidate_info = record_name.rsplit("/", 1)[0]
    candidate_scripts = {
        os.path.relpath(bin_dir / ep.name, site).replace(os.sep, "/")
        for ep in candidate.entry_points if ep.group == "console_scripts"
    }
    candidate_generated = {
        candidate_info + "/INSTALLER",
        candidate_info + "/REQUESTED",
        candidate_info + "/uv_cache.json",
    } | candidate_scripts
    if set(installed_rows) != ({installed_record_name(member) for member in source_rows} | candidate_generated):
        raise SystemExit("installed dependency RECORD path accounting differs from wheel: " + name)
    for item in candidate.files or []:
        target = pathlib.Path(candidate.locate_file(item))
        resolved = target.resolve()
        if str(resolved) in owned_paths:
            raise SystemExit("installed path is owned by multiple distributions: " + str(item))
        owned_paths[str(resolved)] = name
        if item.hash and (target.is_symlink() or not target.is_file() or item.hash.mode != "sha256" or b64digest(target.read_bytes()) != item.hash.value):
            raise SystemExit("installed dependency RECORD mismatch: " + name + ":" + str(item))
        if not item.hash and str(item).endswith("/RECORD") is False:
            raise SystemExit("installed dependency has an unhashed non-RECORD path: " + name + ":" + str(item))
# Site processing is still disabled (-S). Reject executable injection surfaces,
# then require every regular site file to have exactly one RECORD owner before
# adding site-packages to sys.path for the requirements marker import.
for candidate in site.rglob("*"):
    relative = candidate.relative_to(site).as_posix()
    if candidate.is_symlink():
        raise SystemExit("site-packages contains a symlink: " + relative)
    if candidate.is_file():
        if candidate.suffix == ".pth":
            raise SystemExit("site-packages contains a .pth startup hook: " + relative)
        if str(candidate.resolve()) not in owned_paths:
            raise SystemExit("site-packages contains a loose unowned file: " + relative)
sys.path.insert(0, str(site))
from packaging.markers import Marker
active_requirements = {}
for line in requirements.read_text().splitlines():
    match = re.match(r"^([A-Za-z0-9_.-]+)==([^\s;\\\\]+)(?:\s*;\s*(.*?))?\s*\\\\?$", line)
    if not match:
        continue
    name, version, marker = match.groups()
    if marker is None or Marker(marker).evaluate():
        active_requirements[canon(name)] = version
# The export intentionally omits the project wheel itself.
if active_requirements != expected_dependencies:
    raise SystemExit("selected wheel closure does not equal active pinned requirements")
with tarfile.open(uv_archive, "r:gz") as archive:
    members = [member for member in archive.getmembers()
               if member.isfile() and member.name == "uv-x86_64-unknown-linux-gnu/uv"]
    if len(members) != 1 or hashlib.sha256(archive.extractfile(members[0]).read()).digest() != hashlib.sha256(uv_executable.read_bytes()).digest():
        raise SystemExit("uv executable is not bound to the verified release archive")
scripts = {}
for name, target in wheel_entries.items():
    script = bin_dir / name
    if script.is_symlink() or not script.is_file():
        raise SystemExit("missing console script: " + name)
    data = script.read_bytes()
    first = data.splitlines()[0].decode(errors="strict")
    if first != "#!" + str(python):
        raise SystemExit("console script interpreter mismatch: " + name)
    module, function = target.split(":")
    text = data.decode()
    if not re.search(r"from\s+" + re.escape(module) + r"\s+import\s+" + re.escape(function) + r"\b", text):
        raise SystemExit("console script target mismatch: " + name)
    scripts[name] = hashlib.sha256(data).hexdigest()
print(json.dumps({"architecture": platform.machine().lower(), "entryPoints": actual,
                  "installedFileCount": len(installed), "python": platform.python_version(),
                  "recordSha256": hashlib.sha256(hermes_record_path.read_bytes()).hexdigest(),
                  "runtimeMemberCount": len(expected_tree), "loadedLibpython": bool(mapped),
                  "scriptSha256": scripts}, sort_keys=True, separators=(",", ":")))
`;

async function verifyClosure({ installRoot, pythonExecutable, uvExecutable, sitePackages, closureManifest, lane }) {
  const lanePin = HERMES_PROBE_PINS.pythonArtifacts[lane];
  if (!lanePin || lane !== 'linux-x64') refuse('Task 1.6 currently accepts only the Linux-first qualification lane');
  const lock = await regularFile(path.join(installRoot, HERMES_PROBE_PINS.dependencyLock), 'dependency lock');
  if (sha256(await fs.readFile(lock)) !== HERMES_PROBE_PINS.dependencyLockSha256) refuse('dependency lock SHA-256 mismatch');
  const lockText = await fs.readFile(lock, 'utf8');
  const lockPackages = lockedPackages(lockText);
  const manifestPath = await regularFile(closureManifest, 'closure manifest');
  const authority = JSON.parse(await fs.readFile(CLOSURE_AUTHORITY_URL, 'utf8'));
  if (Object.keys(authority).sort().join(',') !==
      'closureManifestSha256,requirementsSha256,schema' ||
      authority.schema !== 'agentbootup.hermes-m0h-closure-authority/v1' ||
      authority.requirementsSha256 !== REQUIREMENTS_SHA256 ||
      !/^[0-9a-f]{64}$/.test(authority.closureManifestSha256)) {
    refuse('closure authority drifted');
  }
  if (sha256(await fs.readFile(manifestPath)) !== authority.closureManifestSha256) {
    refuse('closure manifest does not match the pinned authority');
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest?.schema !== 'agentbootup.hermes-wheelhouse/v1' ||
      manifest.requirementsSha256 !== REQUIREMENTS_SHA256 || !Array.isArray(manifest.artifacts)) {
    refuse('closure manifest schema mismatch');
  }
  const requirements = await regularFile(path.join(installRoot, 'artifacts', 'requirements.txt'), 'pinned requirements export');
  if (sha256(await fs.readFile(requirements)) !== REQUIREMENTS_SHA256) refuse('requirements export SHA-256 mismatch');
  const seen = new Set();
  const artifacts = [];
  for (const row of manifest.artifacts) {
    if (!row || Object.getPrototypeOf(row) !== Object.prototype ||
        !/^[A-Za-z0-9_.+-]+$/.test(row.name) || !/^[0-9a-f]{64}$/.test(row.sha256) ||
        typeof row.version !== 'string' || !row.version ||
        typeof row.filename !== 'string' || path.basename(row.filename) !== row.filename ||
        !/^[A-Za-z0-9_.+-]+\.whl$/.test(row.filename)) {
      refuse('closure manifest contains an invalid artifact');
    }
    const key = normalizedName(row.name);
    if (seen.has(key)) refuse(`closure manifest duplicates ${key}`);
    seen.add(key);
    const artifact = await regularFile(path.join(installRoot, 'artifacts', 'wheelhouse', row.filename), `closure artifact ${row.filename}`);
    if (!contained(path.join(installRoot, 'artifacts', 'wheelhouse'), artifact)) refuse('closure artifact escaped wheelhouse');
    if (sha256(await fs.readFile(artifact)) !== row.sha256) refuse(`closure artifact hash mismatch: ${row.filename}`);
    const locked = lockPackages.get(key);
    if (!locked || locked.version !== row.version || !locked.hashes.has(row.sha256)) {
      refuse(`closure artifact is not bound to uv.lock: ${row.filename}`);
    }
    artifacts.push({ name: key, version: row.version, filename: row.filename, sha256: row.sha256 });
  }
  if (artifacts.length === 0) refuse('closure manifest must contain dependency wheels');
  const receiptPath = await regularFile(path.join(installRoot, 'offline-install-receipt.json'), 'offline install receipt');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  const requiredDependencyFlags = ['--require-hashes', '--offline', '--no-index', '--only-binary', ':all:'];
  const requiredHermesFlags = ['--no-deps', '--offline', '--no-index'];
  const requiredPinnedInputs = {
    [HERMES_PROBE_PINS.hermesWheel]: HERMES_PROBE_PINS.hermesWheelSha256,
    [HERMES_PROBE_PINS.pythonArtifacts['linux-x64'].name]: HERMES_PROBE_PINS.pythonArtifacts['linux-x64'].sha256,
    [UV_PIN.artifact]: UV_PIN.sha256,
    'requirements.txt': REQUIREMENTS_SHA256,
    'uv.lock': HERMES_PROBE_PINS.dependencyLockSha256,
  };
  const pinnedInputsMatch = receipt?.pinnedInputs &&
    Object.keys(receipt.pinnedInputs).sort().join(',') === Object.keys(requiredPinnedInputs).sort().join(',') &&
    Object.entries(requiredPinnedInputs).every(([name, value]) => receipt.pinnedInputs[name] === value);
  if (receipt?.schema !== 'agentbootup.hermes-offline-install/v1' ||
      !['docker_rehearsal_nonqualifying', 'github_actions_exact_lane'].includes(receipt.executionClass) ||
      receipt.selectedWheelCount !== artifacts.length ||
      !pinnedInputsMatch ||
      JSON.stringify(receipt.dependencyInstallFlags) !== JSON.stringify(requiredDependencyFlags) ||
      JSON.stringify(receipt.hermesInstallFlags) !== JSON.stringify(requiredHermesFlags) ||
      receipt.closureManifestSha256 !== sha256(await fs.readFile(manifestPath))) {
    refuse('offline install receipt does not bind the required install policy');
  }
  if (receipt.executionClass === 'github_actions_exact_lane') {
    const context = receipt.executionContext;
    const qualifiedImageVersions = new Set(['20260720.247.2', '20260726.254.1']);
    if (!context ||
        context.imageOS !== 'ubuntu24' ||
        !qualifiedImageVersions.has(context.imageVersion) ||
        context.kernel !== '6.17.0-1020-azure' ||
        context.machine !== 'x86_64' ||
        context.runnerArch !== 'X64' ||
        context.runnerOS !== 'Linux') {
      refuse('GitHub Actions receipt does not match the exact Task 1.4 Linux lane');
    }
  }

  const wheel = await regularFile(path.join(installRoot, 'artifacts', HERMES_PROBE_PINS.hermesWheel), 'Hermes wheel');
  if (sha256(await fs.readFile(wheel)) !== HERMES_PROBE_PINS.hermesWheelSha256) refuse('Hermes wheel SHA-256 mismatch');
  const pythonArchive = await regularFile(path.join(installRoot, 'artifacts', lanePin.name), 'Python archive');
  if (sha256(await fs.readFile(pythonArchive)) !== lanePin.sha256) refuse('Python archive SHA-256 mismatch');
  const uvArchive = await regularFile(path.join(installRoot, 'artifacts', UV_PIN.artifact), 'uv archive');
  if (sha256(await fs.readFile(uvArchive)) !== UV_PIN.sha256) refuse('uv archive SHA-256 mismatch');
  const python = await regularFile(pythonExecutable, 'Python executable');
  if (!contained(path.join(installRoot, 'env'), python)) refuse('Python executable escaped isolated environment');
  const loaderEnvironment = await deriveHermesLoaderEnvironment(installRoot, python, lane);
  const uv = await regularFile(uvExecutable, 'uv executable');
  if (!contained(installRoot, uv)) refuse('uv executable escaped installation root');
  const site = await privateDirectory(sitePackages, 'site-packages', { privateOnly: false });
  if (!contained(installRoot, site)) refuse('site-packages escaped installation root');
  const bin = await privateDirectory(path.dirname(python), 'Python bin directory', { privateOnly: false });
  const expectedClosure = JSON.stringify(artifacts.map(({ name, version, filename }) => ({
    name, version, filename,
  })));
  const result = await run(python, [
    '-I', '-B', '-S', '-c', BINDING_SNIPPET, wheel, path.join(installRoot, 'artifacts', 'wheelhouse'),
    requirements, site, python, bin, pythonArchive, path.join(installRoot, 'runtime'),
    uvArchive, uv, expectedClosure,
  ], { cwd: installRoot, env: loaderEnvironment });
  if (result.timedOut || result.overflow || result.code !== 0) {
    refuse(`installed Hermes binding failed: ${result.stderr.trim() || 'bounded command failure'}`);
  }
  let binding;
  try { binding = JSON.parse(result.stdout); } catch { refuse('installed Hermes binding returned invalid JSON'); }
  if (binding.python !== HERMES_PROBE_PINS.pythonVersion || !lanePin.machines.includes(binding.architecture)) {
    refuse('installed Python patch or architecture mismatch');
  }
  const uvVersion = await run(uv, ['--version'], { cwd: installRoot, env: loaderEnvironment });
  if (uvVersion.code !== 0 || uvVersion.timedOut || uvVersion.overflow ||
      uvVersion.stdout.trim() !== `uv ${UV_PIN.version} (x86_64-unknown-linux-gnu)`) {
    refuse('installed uv version mismatch');
  }
  const pipCheck = await run(uv, ['pip', 'check', '--python', python, '--offline'], {
    cwd: installRoot, env: loaderEnvironment,
  });
  if (pipCheck.code !== 0 || pipCheck.timedOut || pipCheck.overflow) {
    refuse('installed dependency graph failed offline uv pip check');
  }
  return {
    artifacts,
    binding,
    closureManifestSha256: sha256(await fs.readFile(manifestPath)),
    installReceipt: {
      executionClass: receipt.executionClass,
      sha256: sha256(await fs.readFile(receiptPath)),
    },
    uv: UV_PIN,
  };
}

const HERMES_STORAGE_SNIPPET = String.raw`
import json, os, pathlib, sqlite3, sys
root, profile = pathlib.Path(sys.argv[1]), sys.argv[2]
from hermes_state import SessionDB
from cron.jobs import create_job, load_jobs, pause_job
from cron.executions import create_execution, finish_execution, latest_execution
session_id = "session-" + profile
db = SessionDB(root / "state.db")
db.create_session(session_id, "synthetic", cwd=str(root), profile_name=profile)
session = db.get_session(session_id)
db.close()
job = create_job("CRON_" + profile.upper(), "0 0 * * *", name="Synthetic " + profile, deliver="local")
paused = pause_job(job["id"], reason="agentbootup synthetic fixture")
execution = create_execution(job["id"], source="synthetic")
finish_execution(execution["id"], success=True)
jobs = load_jobs()
latest = latest_execution(job["id"])
# A fixture-only table is additive; the native SessionDB owns and migrates all
# Hermes tables, and its API is used again above to validate the session.
state = sqlite3.connect(root / "state.db")
state.execute("CREATE TABLE agentbootup_fixture_canary (profile TEXT PRIMARY KEY, value TEXT NOT NULL)")
state.execute("INSERT INTO agentbootup_fixture_canary VALUES (?, ?)", (profile, "DB_CANARY_" + profile.upper()))
state.commit()
result = {
  "stateIntegrity": state.execute("PRAGMA integrity_check").fetchone()[0],
  "databaseCanary": state.execute("SELECT value FROM agentbootup_fixture_canary WHERE profile=?", (profile,)).fetchone()[0],
  "sessionCanary": session["id"] if session else None,
  "cronCanary": next((item["prompt"] for item in jobs if item["id"] == job["id"]), None),
  "cronDisabled": bool(paused and paused.get("enabled") is False and paused.get("state") == "paused"
                       and any(item["id"] == job["id"] and item.get("enabled") is False
                               and item.get("state") == "paused" for item in jobs)),
  "mutationGuardsVerified": os.environ.get("HERMES_DISABLE_LAZY_INSTALLS") == "1"
                            and sys.dont_write_bytecode,
  "executionStatus": latest["status"] if latest else None,
}
state.close()
print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;
const TEST_STORAGE_SNIPPET = String.raw`
import json, os, pathlib, sqlite3, sys
root, profile = pathlib.Path(sys.argv[1]), sys.argv[2]
upper = profile.upper()
state = sqlite3.connect(root / "state.db")
state.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY)")
state.execute("INSERT INTO sessions VALUES (?)", ("session-" + profile,))
state.execute("CREATE TABLE agentbootup_fixture_canary (profile TEXT PRIMARY KEY, value TEXT NOT NULL)")
state.execute("INSERT INTO agentbootup_fixture_canary VALUES (?, ?)", (profile, "DB_CANARY_" + upper))
state.commit()
state.close()
(root / "cron" / "jobs.json").write_text(json.dumps({"jobs":[{"id":"test","prompt":"CRON_" + upper,"enabled":False,"state":"paused"}]}) + "\n")
cron = sqlite3.connect(root / "cron" / "executions.db")
cron.execute("CREATE TABLE executions (id TEXT PRIMARY KEY, status TEXT)")
cron.execute("INSERT INTO executions VALUES ('test', 'completed')")
cron.commit()
cron.close()
print(json.dumps({"stateIntegrity":"ok","databaseCanary":"DB_CANARY_" + upper,
 "sessionCanary":"session-" + profile,"cronCanary":"CRON_" + upper,
 "cronDisabled":True,
 "mutationGuardsVerified":os.environ.get("HERMES_DISABLE_LAZY_INSTALLS") == "1"
                          and sys.dont_write_bytecode,
 "executionStatus":"completed"}, sort_keys=True, separators=(",", ":")))
`;

async function writePrivate(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.writeFile(file, value, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
}

async function clearValidatedDirectory(root, identity) {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || !matchesIdentity(stat, identity)) return false;
  for (const name of await fs.readdir(root)) {
    const current = await fs.lstat(root).catch(() => null);
    if (!current?.isDirectory() || current.isSymbolicLink() || !matchesIdentity(current, identity)) {
      return false;
    }
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
  return true;
}

async function unlinkValidatedFile(file, identity) {
  if (!identity) return false;
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || !matchesIdentity(stat, identity)) return false;
  await fs.unlink(file);
  return true;
}

function assertSanitizedReport(report) {
  if (findRawSecretViolations(report).length) {
    refuse('sanitization rejected the completed evidence report');
  }
  return report;
}

async function generateSyntheticHome(
  hermesHome, pythonExecutable, loaderEnvironment = {}, storageSnippet = HERMES_STORAGE_SNIPPET,
) {
  const roots = {
    default: hermesHome,
    atlas: path.join(hermesHome, 'profiles', 'atlas'),
    beacon: path.join(hermesHome, 'profiles', 'beacon'),
  };
  const profiles = [];
  for (const name of PROFILE_NAMES) {
    const root = roots[name];
    for (const relative of ['memories', 'skills/synthetic-canary', 'sessions', 'cron']) {
      await fs.mkdir(path.join(root, relative), { recursive: true, mode: PRIVATE_DIR_MODE });
    }
    const upper = name.toUpperCase();
    await writePrivate(path.join(root, 'config.yaml'), [
      `profile: ${name}`,
      `model: synthetic-${name}`,
      'memory:',
      `  provider: ${name === 'default' ? 'honcho' : name === 'atlas' ? 'hindsight' : 'local'}`,
      `external_state_declaration: synthetic://${name}/memory`,
      '',
    ].join('\n'));
    await writePrivate(path.join(root, 'SOUL.md'), `# Synthetic ${name}\n\nIdentity canary: IDENTITY_${upper}\n`);
    await writePrivate(path.join(root, 'memories', 'MEMORY.md'), `# Memory\n\nMEMORY_${upper}\n`);
    await writePrivate(path.join(root, 'skills', 'synthetic-canary', 'SKILL.md'), `---\nname: synthetic-${name}\n---\nSKILL_${upper}\n`);
    await writePrivate(path.join(root, 'sessions', `session-${name}.json`), `${JSON.stringify({ id: `session-${name}`, canary: `SESSION_FILE_${upper}` })}\n`);
    await writePrivate(path.join(root, 'external-state.json'), `${JSON.stringify({ provider: name === 'default' ? 'honcho' : name === 'atlas' ? 'hindsight' : 'local', destination: `synthetic://${name}/memory`, ownership: 'synthetic-fixture' })}\n`);
    await writePrivate(path.join(root, '.env'), `SYNTHETIC_API_KEY=SYNTHETIC_SECRET_DO_NOT_USE_${upper}\n`);
    await writePrivate(path.join(root, 'auth.json'), `${JSON.stringify({ synthetic: true, token: `SYNTHETIC_SECRET_DO_NOT_USE_${upper}` })}\n`);
    const db = await run(pythonExecutable, ['-I', '-B', '-c', storageSnippet, root, name], {
      cwd: hermesHome,
      env: { ...loaderEnvironment, HOME: root, HERMES_HOME: root },
    });
    if (db.timedOut || db.overflow || db.code !== 0) refuse(`database fixture failed for ${name}`);
    let databaseEvidence;
    try { databaseEvidence = JSON.parse(db.stdout); } catch { refuse(`database fixture returned invalid evidence for ${name}`); }
    if (databaseEvidence.stateIntegrity !== 'ok' ||
        databaseEvidence.databaseCanary !== `DB_CANARY_${upper}` ||
        databaseEvidence.sessionCanary !== `session-${name}` ||
        databaseEvidence.cronCanary !== `CRON_${upper}` ||
        databaseEvidence.cronDisabled !== true ||
        databaseEvidence.mutationGuardsVerified !== true ||
        databaseEvidence.executionStatus !== 'completed') {
      refuse(`database fixture verification failed for ${name}`);
    }
    await Promise.all([
      fs.chmod(path.join(root, 'state.db'), PRIVATE_FILE_MODE),
      fs.chmod(path.join(root, 'cron', 'executions.db'), PRIVATE_FILE_MODE),
    ]);
    profiles.push({
      name,
      root: name === 'default' ? '.' : `profiles/${name}`,
      expectedCanaries: {
        config: `synthetic-${name}`,
        identity: `IDENTITY_${upper}`,
        memory: `MEMORY_${upper}`,
        skill: `SKILL_${upper}`,
        session: `session-${name}`,
        cron: `CRON_${upper}`,
        database: `DB_CANARY_${upper}`,
        externalProvider: name === 'default' ? 'honcho' : name === 'atlas' ? 'hindsight' : 'local',
      },
      secretSentinelsPresent: true,
      databaseIntegrityVerified: true,
      cronDisabled: true,
      mutationGuardsVerified: true,
    });
  }
  return profiles;
}

async function runSyntheticInstall(options) {
  const allowed = new Set([
    'hermesHome', 'installRoot', 'evidenceRoot', 'outputPath', 'pythonExecutable',
    'uvExecutable', 'sitePackages', 'closureManifest', 'lane', 'repoRoot', 'workspaceRoots',
  ]);
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) refuse('options must be a plain object');
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length) refuse(`unknown options: ${unknown.sort().join(', ')}`);
  if (findRawSecretViolations(options).length) refuse('request contains a raw secret');
  const hermesHome = await privateDirectory(options.hermesHome, 'Hermes home', { empty: true });
  const hermesHomeIdentity = identityOf(await fs.lstat(hermesHome));
  const installRoot = await privateDirectory(options.installRoot, 'installation root');
  const evidenceRoot = await privateDirectory(options.evidenceRoot, 'evidence root');
  const repoRoot = await privateDirectory(options.repoRoot, 'repository root', { privateOnly: false });
  if (!Array.isArray(options.workspaceRoots)) refuse('workspaceRoots must be an explicit array');
  const workspaceRoots = [];
  for (const root of options.workspaceRoots) {
    workspaceRoots.push(await privateDirectory(root, 'workspace root', { privateOnly: false }));
  }
  const liveHome = await fs.realpath(os.homedir());
  for (const candidate of [hermesHome, installRoot, evidenceRoot]) {
    if (overlaps(liveHome, candidate)) refuse('disposable root overlaps live user home');
  }
  for (const [left, right] of [[hermesHome, installRoot], [hermesHome, evidenceRoot], [installRoot, evidenceRoot]]) {
    if (contained(left, right) || contained(right, left)) refuse('disposable roots overlap');
  }
  for (const disposable of [hermesHome, installRoot, evidenceRoot]) {
    for (const protectedRoot of [repoRoot, ...workspaceRoots]) {
      if (contained(disposable, protectedRoot) || contained(protectedRoot, disposable)) {
        refuse('disposable root overlaps a protected repo/workspace');
      }
    }
  }
  if (typeof options.outputPath !== 'string' || path.normalize(options.outputPath) !== options.outputPath ||
      !contained(evidenceRoot, options.outputPath) || await fs.lstat(options.outputPath).catch(() => null)) {
    refuse('output path must be new, normalized, and inside evidence root');
  }
  const outputParent = await privateDirectory(path.dirname(options.outputPath), 'output parent');
  if (!contained(evidenceRoot, outputParent)) refuse('output parent escaped evidence root');
  const protectedBefore = await Promise.all([repoRoot, ...workspaceRoots].map(fingerprintTree));
  const installBefore = await fingerprintTree(installRoot);
  let outputIdentity;
  try {
    const closure = await verifyClosure({ ...options, installRoot });
    const loaderEnvironment = await deriveHermesLoaderEnvironment(
      installRoot, options.pythonExecutable, options.lane,
    );
    const profiles = await generateSyntheticHome(hermesHome, options.pythonExecutable, loaderEnvironment);
    const protectedAfter = await Promise.all([repoRoot, ...workspaceRoots].map(fingerprintTree));
    const installAfter = await fingerprintTree(installRoot);
    if (JSON.stringify(protectedBefore) !== JSON.stringify(protectedAfter) || installBefore !== installAfter) {
      refuse('installation or protected repo/workspace changed during fixture generation');
    }
    const report = {
      schema: 'agentbootup.hermes-synthetic-install/v1',
      qualification: closure.installReceipt.executionClass === 'github_actions_exact_lane'
        ? 'exact_ci_evidence_pending_review'
        : 'docker_rehearsal_nonqualifying_exact_ci_lane_pending',
      trustBoundary: 'current_uid_private_roots_no_concurrent_same_uid_mutation',
      hermes: {
        package: HERMES_PROBE_PINS.hermesPackage,
        tag: HERMES_PROBE_PINS.hermesTag,
        commit: HERMES_PROBE_PINS.hermesCommit,
        wheel: HERMES_PROBE_PINS.hermesWheel,
        wheelSha256: HERMES_PROBE_PINS.hermesWheelSha256,
      },
      closure,
      profiles,
      protectedRootCount: 1 + workspaceRoots.length,
      trustedRootsStable: true,
      secretPolicy: 'synthetic_sentinels_present_in_disposable_home_excluded_from_evidence',
    };
    assertSanitizedReport(report);
    const output = await fs.open(options.outputPath, 'wx', PRIVATE_FILE_MODE);
    try {
      outputIdentity = identityOf(await output.stat());
      await output.writeFile(serializeHermesProbeReport(report));
    } finally {
      await output.close();
    }
    return report;
  } catch (error) {
    await clearValidatedDirectory(hermesHome, hermesHomeIdentity);
    await unlinkValidatedFile(options.outputPath, outputIdentity);
    throw error;
  }
}

export const __testOnly = Object.freeze({
  generateSyntheticHome: (home, python) => generateSyntheticHome(home, python, {}, TEST_STORAGE_SNIPPET),
  clearValidatedDirectory,
  assertSanitizedReport,
  fingerprintTree,
  identityOf,
  lockedPackages,
  normalizedName,
  overlaps,
});
export { runSyntheticInstall };

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--request' || !path.isAbsolute(argv[1])) {
    refuse('usage: hermes-m0h-synthetic-install.mjs --request /absolute/request.json');
  }
  const normalizedRequest = path.normalize(argv[1]);
  await privateDirectory(path.dirname(normalizedRequest), 'request parent');
  const request = await regularFile(normalizedRequest, 'request');
  const stat = await fs.stat(request);
  if ((stat.mode & 0o777) !== PRIVATE_FILE_MODE) refuse('request must have mode 0600');
  const options = JSON.parse(await fs.readFile(request, 'utf8'));
  const evidenceRoot = await privateDirectory(options.evidenceRoot, 'evidence root');
  if (!contained(evidenceRoot, request)) refuse('request must be inside evidence root');
  process.stdout.write(serializeHermesProbeReport(await runSyntheticInstall(options)));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.message || 'Hermes synthetic install refused'}\n`);
    process.exitCode = 1;
  });
}
