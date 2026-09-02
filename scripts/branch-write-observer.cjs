const fs = require('fs');
const path = require('path');

const logPath = process.env.AGENTBOOTUP_BRANCH_WRITE_LOG;
if (!logPath) {
  throw new Error('AGENTBOOTUP_BRANCH_WRITE_LOG is required');
}

const original = {
  appendFileSync: fs.appendFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  rmSync: fs.rmSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs),
  promises: {
    appendFile: fs.promises.appendFile.bind(fs.promises),
    writeFile: fs.promises.writeFile.bind(fs.promises),
    mkdir: fs.promises.mkdir.bind(fs.promises),
    rm: fs.promises.rm.bind(fs.promises),
    unlink: fs.promises.unlink.bind(fs.promises),
  },
};

function normalizeTarget(target) {
  if (typeof target !== 'string') return null;
  return path.resolve(target); // nosemgrep: path-join-resolve-traversal -- clean-room conformance harness resolves local fixture write targets only to compare them against the temporary RW root
}

function record(op, target) {
  const normalized = normalizeTarget(target);
  if (!normalized || normalized === logPath) return;
  original.appendFileSync(logPath, `${JSON.stringify({ op, path: normalized })}\n`, 'utf8');
}

function wrapSync(fnName, opName) {
  const originalFn = original[fnName];
  fs[fnName] = function wrapped(target, ...rest) {
    record(opName, target);
    return originalFn(target, ...rest);
  };
}

function wrapPromise(fnName, opName) {
  const originalFn = original.promises[fnName];
  fs.promises[fnName] = async function wrapped(target, ...rest) {
    record(opName, target);
    return originalFn(target, ...rest);
  };
}

wrapSync('writeFileSync', 'writeFileSync');
wrapSync('appendFileSync', 'appendFileSync');
wrapSync('mkdirSync', 'mkdirSync');
wrapSync('rmSync', 'rmSync');
wrapSync('unlinkSync', 'unlinkSync');

wrapPromise('writeFile', 'writeFile');
wrapPromise('appendFile', 'appendFile');
wrapPromise('mkdir', 'mkdir');
wrapPromise('rm', 'rm');
wrapPromise('unlink', 'unlink');
