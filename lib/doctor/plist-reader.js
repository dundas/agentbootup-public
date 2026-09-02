/**
 * LaunchAgent plist reader (PRD-0063 Task 2.1).
 *
 * Parses the XML plist format macOS `~/Library/LaunchAgents/*.plist` uses, extracting
 * `Label`, `ProgramArguments`, and `EnvironmentVariables` (PRD-0063 FR-2). A dependency-free
 * recursive-descent parser — chosen over shelling out to `PlistBuddy` per key (the PRD's
 * "correctness beats cleverness": a real parser is correct, and it keeps the suite hermetic
 * and subprocess-free even on the live run). Validated against every live
 * `com.dundas.agentbootup-*` plist.
 *
 * The reader is injectable (`deps.readFile`) so tests point at fixture plists and never
 * touch the live machine. A malformed plist, or one with no resolvable `ProgramArguments`,
 * surfaces as `{ invalid: true, reason }` so the caller can emit a `plist_invalid` verdict
 * that does NOT vanish from results (PRD-0063 FR-3 / Task 2.3).
 */

import fsp from 'fs/promises';

const NAMED_ENTITIES = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeEntities(text) {
  if (!text || !text.includes('&')) return text;
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|lt|gt|amp|quot|apos);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[`&${body};`] ?? match;
  });
}

/**
 * Tokenize an XML plist into a flat token stream: open/close/self elements and text.
 * Skips the XML prolog, DOCTYPE, comments, and PIs — none are value-bearing for a plist.
 * @param {string} xml
 * @returns {Array<{type: 'open'|'close'|'self'|'text', name?: string, value?: string}>}
 */
function tokenize(xml) {
  const tokens = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    if (xml[i] !== '<') {
      const next = xml.indexOf('<', i);
      const text = next === -1 ? xml.slice(i) : xml.slice(i, next);
      tokens.push({ type: 'text', value: text });
      i = next === -1 ? n : next;
      continue;
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<!', i)) {
      const end = xml.indexOf('>', i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const isClose = xml[i + 1] === '/';
    const contentStart = i + (isClose ? 2 : 1);
    const end = xml.indexOf('>', contentStart);
    if (end === -1) throw new Error('plist: unterminated tag');
    let tagBody = xml.slice(contentStart, end);
    const isSelf = tagBody.endsWith('/');
    if (isSelf) tagBody = tagBody.slice(0, -1);
    tagBody = tagBody.trim();
    if (!tagBody) throw new Error('plist: empty tag');
    const name = tagBody.match(/^[A-Za-z_][\w.:-]*/)?.[0] ?? tagBody;
    tokens.push({ type: isSelf ? 'self' : isClose ? 'close' : 'open', name });
    i = end + 1;
  }
  return tokens;
}

/**
 * Advance past text tokens that are whitespace-only. Inter-element whitespace in a
 * plist is insignificant (element content), but whitespace inside `<string>` is
 * preserved — so this is called only at structural boundaries, never inside `readText`.
 */
function skipWhitespace(tokens, cursor) {
  while (tokens[cursor.idx]?.type === 'text' && tokens[cursor.idx].value.trim() === '') {
    cursor.idx += 1;
  }
}

/**
 * Parse a single plist value element starting at `tokens[cursor.idx]`.
 * @returns {{ value: any, nextIdx: number }}
 */
function parseValue(tokens, cursor) {
  skipWhitespace(tokens, cursor);
  const tok = tokens[cursor.idx];
  if (!tok) throw new Error('plist: unexpected end of input');

  if (tok.type === 'self') {
    cursor.idx += 1;
    if (tok.name === 'true') return { value: true };
    if (tok.name === 'false') return { value: false };
    throw new Error(`plist: unsupported self-closing element <${tok.name}/>`);
  }

  if (tok.type !== 'open') {
    throw new Error(`plist: expected an element, got ${tok.type}`);
  }

  const name = tok.name;
  cursor.idx += 1;

  switch (name) {
    case 'dict': {
      const result = {};
      skipWhitespace(tokens, cursor);
      while (tokens[cursor.idx]?.type === 'open' && tokens[cursor.idx].name === 'key') {
        cursor.idx += 1; // consume <key>
        const keyText = readText(tokens, cursor);
        expectClose(tokens, cursor, 'key');
        skipWhitespace(tokens, cursor);
        if (tokens[cursor.idx]?.type !== 'open' && tokens[cursor.idx]?.type !== 'self') {
          throw new Error('plist: <key> not followed by a value element');
        }
        const { value } = parseValue(tokens, cursor);
        result[keyText] = value;
        skipWhitespace(tokens, cursor);
      }
      expectClose(tokens, cursor, 'dict');
      return { value: result };
    }
    case 'array': {
      const result = [];
      skipWhitespace(tokens, cursor);
      while (tokens[cursor.idx]?.type === 'open' || tokens[cursor.idx]?.type === 'self') {
        const { value } = parseValue(tokens, cursor);
        result.push(value);
        skipWhitespace(tokens, cursor);
      }
      expectClose(tokens, cursor, 'array');
      return { value: result };
    }
    case 'string': {
      const value = readText(tokens, cursor);
      expectClose(tokens, cursor, 'string');
      return { value };
    }
    case 'integer': {
      const raw = readText(tokens, cursor).trim();
      expectClose(tokens, cursor, 'integer');
      const num = Number(raw);
      return { value: Number.isFinite(num) ? num : raw };
    }
    case 'real': {
      const raw = readText(tokens, cursor).trim();
      expectClose(tokens, cursor, 'real');
      const num = Number(raw);
      return { value: Number.isFinite(num) ? num : raw };
    }
    case 'data': {
      const value = readText(tokens, cursor);
      expectClose(tokens, cursor, 'data');
      return { value }; // raw base64 — not needed for LaunchAgents
    }
    case 'date': {
      const value = readText(tokens, cursor).trim();
      expectClose(tokens, cursor, 'date');
      return { value };
    }
    default:
      throw new Error(`plist: unsupported element <${name}>`);
  }
}

function readText(tokens, cursor) {
  const tok = tokens[cursor.idx];
  if (tok?.type === 'text') {
    cursor.idx += 1;
    return decodeEntities(tok.value);
  }
  return '';
}

function expectClose(tokens, cursor, name) {
  skipWhitespace(tokens, cursor);
  const tok = tokens[cursor.idx];
  if (!tok || tok.type !== 'close' || tok.name !== name) {
    throw new Error(`plist: expected </${name}>, got ${tok ? tok.type : 'end'}`);
  }
  cursor.idx += 1;
}

/**
 * Parse an XML plist string into a JS value (the top-level `<dict>`).
 * @param {string} xml
 * @returns {object}
 */
export function parsePlistXml(xml) {
  if (typeof xml !== 'string' || xml.length === 0) {
    throw new Error('plist: empty or non-string input');
  }
  const tokens = tokenize(xml);
  const cursor = { idx: 0 };

  // Find the <plist> root.
  while (cursor.idx < tokens.length && tokens[cursor.idx].name !== 'plist') {
    cursor.idx += 1;
  }
  if (cursor.idx >= tokens.length) throw new Error('plist: no <plist> root element');
  cursor.idx += 1; // consume <plist>

  // The value element follows (whitespace text tokens are skipped by parseValue's element checks).
  const { value } = parseValue(tokens, cursor);
  return value ?? {};
}

/**
 * Read a LaunchAgent plist and extract the fields the runtime-source check needs.
 * @param {string} filePath
 * @param {{ readFile?: (path: string) => Promise<string> }} [deps]
 * @returns {Promise<{ label: string, programArguments: string[], environment: Record<string,string> } | { invalid: true, reason: string }>}
 */
export async function readLaunchAgentPlist(filePath, deps = {}) {
  const readFile = deps.readFile ?? fsp.readFile;
  let xml;
  try {
    xml = await readFile(filePath, 'utf8');
  } catch (err) {
    return { invalid: true, reason: `unreadable: ${err?.code ?? err?.message ?? String(err)}` };
  }
  let parsed;
  try {
    parsed = parsePlistXml(xml);
  } catch (err) {
    return { invalid: true, reason: `unparseable: ${err?.message ?? String(err)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { invalid: true, reason: 'top-level value is not a dict' };
  }
  const label = typeof parsed.Label === 'string' ? parsed.Label : '';
  const programArguments = Array.isArray(parsed.ProgramArguments)
    ? parsed.ProgramArguments.filter((v) => typeof v === 'string')
    : null;
  const environment = parsed.EnvironmentVariables && typeof parsed.EnvironmentVariables === 'object'
    && !Array.isArray(parsed.EnvironmentVariables)
    ? Object.fromEntries(
        Object.entries(parsed.EnvironmentVariables).filter(([, v]) => typeof v === 'string'),
      )
    : {};
  if (!label) return { invalid: true, reason: 'missing or non-string Label' };
  if (!programArguments || programArguments.length === 0) {
    return { invalid: true, reason: 'missing or empty ProgramArguments' };
  }
  return { label, programArguments, environment };
}