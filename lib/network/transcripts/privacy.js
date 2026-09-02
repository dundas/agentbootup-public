import fs from 'fs';

const DEFAULT_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{36,255}/,
  /-----BEGIN\s+[A-Z ]+-----/,
];

export function scanTranscriptForSensitiveContent(filepath, patterns = DEFAULT_PATTERNS) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const matches = patterns
    .map((pattern) => normalizePattern(pattern))
    .filter((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(content);
    })
    .map((pattern) => pattern.toString());
  return {
    flagged: matches.length > 0,
    matches,
  };
}

function normalizePattern(pattern) {
  if (pattern instanceof RegExp) {
    return new RegExp(pattern.source, pattern.flags.replaceAll('g', ''));
  }
  return new RegExp(String(pattern));
}
