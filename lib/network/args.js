export function getFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return '';
  return args[idx + 1] || '';
}

export function hasFlag(args, flag) {
  return args.includes(flag);
}

// Intentionally skips the value token unconditionally (even empty string) so that
// flag+value pairs like --cwd '' never contribute tokens to the positional list.
// This differs from extractCwd which ignores empty-string values rather than consuming them.
export function getPositionalArgs(args, flagsWithValue = ['--cwd', '--path', '--interval', '--env']) {
  const out = [];
  const withValue = new Set(flagsWithValue);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (withValue.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith('-')) out.push(arg);
  }

  return out;
}

export function getFlagList(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return [];

  const values = [];
  for (let i = idx + 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-')) break;
    values.push(arg);
  }
  return values;
}

export function parseNetworkExecutionFlags(args) {
  return {
    all: hasFlag(args, '--all'),
    cli: getFlagValue(args, '--cli'),
    since: getFlagValue(args, '--since'),
    last: getFlagValue(args, '--last'),
    commit: hasFlag(args, '--commit'),
  };
}

export function extractCwd(args, defaultCwd = process.cwd()) {
  let cwd = defaultCwd;
  let pathValue = null;
  let cwdValue = null;
  const remaining = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && args[i + 1]) {
      pathValue = args[i + 1];
      i++;
    } else if (args[i] === '--cwd' && args[i + 1]) {
      cwdValue = args[i + 1];
      i++;
    } else {
      remaining.push(args[i]);
    }
  }

  if (pathValue !== null) cwd = pathValue;
  else if (cwdValue !== null) cwd = cwdValue;

  return { cwd, args: remaining };
}
