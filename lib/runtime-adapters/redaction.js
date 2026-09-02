import {
  findRawSecretViolations,
  SECRET_IN_PATH,
  SECRET_VALUE_PATTERNS,
} from './security.js';

const HEURISTIC_REPLACEMENT = 'REDACTED_HEURISTIC';

function normalizeDenylist(input, fallback = new Set()) {
  if (input instanceof Set) return input;
  if (input == null) return fallback;
  if (input.state === 'failed') return null;
  if (input.values instanceof Set) return input.values;
  throw new TypeError('denylist must be a Set or a discriminated denylist result');
}

function replacementFor(value, sourceMap, derivedSourceMap, protectedValues) {
  const source = sourceMap?.get(value) ?? derivedSourceMap?.get(value);
  const preferred = source === 'env' ? 'REDACTED_ENV' : source === 'denylist' ? 'REDACTED_DENYLIST' : 'REDACTED';
  const candidates = [preferred, 'REDACTED', '[redacted]', '<redacted>', '***'];
  return candidates.find((candidate) => ![...protectedValues].some((secret) => secret && candidate.includes(secret))) ?? '***';
}

function exactReplacer(values, sourceMap, derivedSourceMap, onReplacement) {
  const ordered = [...values].filter(Boolean).sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (ordered.length === 0) return (text) => ({ text, replacements: 0 });
  const trie = new Map();
  for (const value of ordered) {
    let node = trie;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (!node.has(character)) node.set(character, new Map());
      node = node.get(character);
    }
    node.set(null, value);
  }
  return (text) => {
    let replacements = 0;
    let replaced = '';
    let cursor = 0;
    while (cursor < text.length) {
      let node = trie;
      let scan = cursor;
      let match = null;
      while (scan < text.length && node.has(text[scan])) {
        node = node.get(text[scan]);
        scan += 1;
        if (node.has(null)) match = node.get(null);
      }
      if (!match) {
        replaced += text[cursor];
        cursor += 1;
        continue;
      }
      replacements += 1;
      const source = sourceMap?.get(match) ?? derivedSourceMap?.get(match);
      onReplacement?.(source === 'env' ? 'env' : source === 'denylist' ? 'denylist' : 'exact');
      replaced += replacementFor(match, sourceMap, derivedSourceMap, values);
      cursor += match.length;
    }
    return { text: replaced, replacements };
  };
}

function parseViolationPath(path) {
  if (typeof path !== 'string' || !path.startsWith('$')) return null;
  const tokens = [];
  let cursor = 1;
  while (cursor < path.length) {
    if (path[cursor] === '.') {
      const match = /^\.([A-Za-z0-9_$-]+)/.exec(path.slice(cursor));
      if (!match) return null;
      if (['__proto__', 'prototype', 'constructor'].includes(match[1])) return null;
      tokens.push(match[1]);
      cursor += match[0].length;
      continue;
    }
    if (path[cursor] === '[') {
      const match = /^\[(\d+)\]/.exec(path.slice(cursor));
      if (!match) return null;
      tokens.push(Number(match[1]));
      cursor += match[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

/**
 * Redact values identified by findRawSecretViolations(). The detector returns
 * paths rather than match spans, so string values are replaced as a whole.
 */
export function redactViolations(value, paths, options = {}) {
  if (!Array.isArray(paths)) throw new TypeError('violation paths must be an array');
  const warn = options.warn ?? (() => {});
  let replacements = 0;
  const invalidPaths = [];
  for (const violationPath of [...new Set(paths)]) {
    const tokens = parseViolationPath(violationPath);
    if (!tokens) {
      invalidPaths.push(violationPath);
      warn({ code: 'invalid_redaction_path', path: violationPath });
      continue;
    }
    if (tokens.length === 0) {
      value = HEURISTIC_REPLACEMENT;
      replacements += 1;
      options.onReplacement?.('heuristic');
      continue;
    }
    let parent = value;
    for (let index = 0; index < tokens.length - 1; index += 1) {
      if (parent == null || typeof parent !== 'object' || !Object.prototype.hasOwnProperty.call(parent, tokens[index])) {
        parent = null;
        break;
      }
      parent = Reflect.get(parent, tokens[index]);
    }
    const leaf = tokens.at(-1);
    if (parent == null || typeof parent !== 'object' || !Object.prototype.hasOwnProperty.call(parent, leaf)) {
      invalidPaths.push(violationPath);
      warn({ code: 'invalid_redaction_path', path: violationPath });
      continue;
    }
    Reflect.set(parent, leaf, HEURISTIC_REPLACEMENT);
    replacements += 1;
    options.onReplacement?.('heuristic');
  }
  return { value, replacements, invalidPaths };
}

function replaceJsonStrings(value, replaceExact, warn, onReplacement, depth = 0, seen = new Set()) {
  if (depth > 100) throw new TypeError('redaction object depth exceeded');
  if (typeof value === 'string') {
    const exact = replaceExact(value);
    let next = exact.text;
    let replacements = exact.replacements;
    let heuristicHits = 0;
    let unresolvedViolations = 0;
    const trimmed = next.trimStart();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && depth < 20) {
      let nested;
      try {
        nested = JSON.parse(next);
      } catch {
        nested = null;
      }
      if (nested !== null) {
        const nestedResult = replaceJsonStrings(nested, replaceExact, warn, onReplacement, depth + 1, seen);
        const violations = findRawSecretViolations(nestedResult.value);
        const heuristic = redactViolations(nestedResult.value, violations, { warn, onReplacement });
        if (nestedResult.replacements > 0 || nestedResult.heuristicHits > 0 || heuristic.replacements > 0) {
          next = JSON.stringify(heuristic.value);
          replacements += nestedResult.replacements;
          heuristicHits += nestedResult.heuristicHits + heuristic.replacements;
        }
        unresolvedViolations += nestedResult.unresolvedViolations + heuristic.invalidPaths.length;
      }
    }
    return { value: next, replacements, heuristicHits, unresolvedViolations };
  }
  if (value == null || typeof value !== 'object') {
    return { value, replacements: 0, heuristicHits: 0, unresolvedViolations: 0 };
  }
  if (seen.has(value)) throw new TypeError('redaction input contains a cycle');
  seen.add(value);
  let replacements = 0;
  let heuristicHits = 0;
  let unresolvedViolations = 0;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = replaceJsonStrings(value[index], replaceExact, warn, onReplacement, depth + 1, seen);
      value[index] = result.value;
      replacements += result.replacements;
      heuristicHits += result.heuristicHits;
      unresolvedViolations += result.unresolvedViolations;
    }
  } else {
    for (const key of Object.keys(value)) {
      const result = replaceJsonStrings(value[key], replaceExact, warn, onReplacement, depth + 1, seen);
      value[key] = result.value;
      replacements += result.replacements;
      heuristicHits += result.heuristicHits;
      unresolvedViolations += result.unresolvedViolations;
    }
  }
  seen.delete(value);
  return { value, replacements, heuristicHits, unresolvedViolations };
}

function replacePatternAll(text, pattern, replacement) {
  let output = '';
  let cursor = 0;
  while (cursor < text.length) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text.slice(cursor));
    if (!match) return output + text.slice(cursor);
    output += text.slice(cursor, cursor + match.index);
    output += replacement(match[0]);
    cursor += match.index + Math.max(match[0].length, 1);
  }
  return output;
}

function redactRawHeuristics(text, onReplacement) {
  let next = text;
  let hits = 0;
  let cannotProve = false;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    next = replacePatternAll(next, pattern, (match) => {
      hits += 1;
      onReplacement?.('heuristic');
      if (/BEGIN .*PRIVATE KEY/i.test(match)) cannotProve = true;
      return HEURISTIC_REPLACEMENT;
    });
  }
  const lines = next.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!SECRET_IN_PATH.test(lines[index])) continue;
    lines[index] = HEURISTIC_REPLACEMENT;
    hits += 1;
    onReplacement?.('heuristic');
  }
  return { text: lines.join('\n'), hits, cannotProve };
}

function containsExactValue(text, values) {
  for (const value of values) if (value && text.includes(value)) return true;
  return false;
}

function blocked(cleanContent, replacements, heuristicHits, blockReason) {
  return { cleanContent, replacements, heuristicHits, blocked: true, blockReason };
}

export function redactContent(content, options = {}) {
  if (typeof content !== 'string') throw new TypeError('redaction content must be a string');
  const sourceValues = normalizeDenylist(options.denylist);
  if (sourceValues === null) return blocked('', 0, 0, 'redaction_denylist_failed');
  const derivedValues = normalizeDenylist(options.derivedDenylist, new Set());
  if (derivedValues === null) return blocked('', 0, 0, 'redaction_denylist_failed');
  const allValues = new Set([...sourceValues, ...derivedValues]);
  const replaceExact = exactReplacer(allValues, options.sourceMap, options.derivedSourceMap, options.onReplacement);
  const format = options.format;

  if (format === 'text' || format === 'txt' || format === 'raw') {
    const exact = replaceExact(content);
    const heuristic = redactRawHeuristics(exact.text, options.onReplacement);
    if (containsExactValue(heuristic.text, allValues)) {
      return blocked(heuristic.text, exact.replacements, heuristic.hits, 'redaction_exact_value_remains');
    }
    if (heuristic.cannotProve || findRawSecretViolations(heuristic.text).length > 0) {
      return blocked(heuristic.text, exact.replacements, heuristic.hits, 'redaction_cannot_prove_scrubbed');
    }
    return {
      cleanContent: heuristic.text,
      replacements: exact.replacements,
      heuristicHits: heuristic.hits,
      blocked: false,
      blockReason: null,
    };
  }

  if (format !== 'jsonl' && format !== 'json') {
    return blocked('', 0, 0, 'redaction_unsupported_format');
  }

  if (format === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const exact = replaceExact(content);
      const heuristic = redactRawHeuristics(exact.text, options.onReplacement);
      if (exact.replacements > 0 || heuristic.hits > 0 || containsExactValue(heuristic.text, allValues) ||
          findRawSecretViolations(heuristic.text).length > 0) {
        return blocked(heuristic.text, exact.replacements, heuristic.hits, 'redaction_malformed_json_suspicious');
      }
      return { cleanContent: content, replacements: 0, heuristicHits: 0, blocked: false, blockReason: null };
    }
    const exact = replaceJsonStrings(parsed, replaceExact, options.warn, options.onReplacement);
    const violations = findRawSecretViolations(exact.value);
    const heuristic = redactViolations(exact.value, violations, {
      warn: options.warn, onReplacement: options.onReplacement,
    });
    const changed = exact.replacements + exact.heuristicHits + heuristic.replacements;
    const cleanContent = changed > 0 ? JSON.stringify(heuristic.value) : content;
    const heuristicHits = exact.heuristicHits + heuristic.replacements;
    if (exact.unresolvedViolations > 0 || heuristic.invalidPaths.length > 0 ||
        findRawSecretViolations(heuristic.value).length > 0 || containsExactValue(cleanContent, allValues)) {
      return blocked(cleanContent, exact.replacements, heuristicHits, 'redaction_cannot_prove_scrubbed');
    }
    return {
      cleanContent, replacements: exact.replacements, heuristicHits, blocked: false, blockReason: null,
    };
  }

  const lines = content.split('\n');
  let replacements = 0;
  let heuristicHits = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index];
    if (original === '' && index === lines.length - 1) continue;
    let parsed;
    try {
      parsed = JSON.parse(original);
    } catch {
      const exact = replaceExact(original);
      const heuristic = redactRawHeuristics(exact.text, options.onReplacement);
      replacements += exact.replacements;
      heuristicHits += heuristic.hits;
      if (exact.replacements > 0 || heuristic.hits > 0 || containsExactValue(heuristic.text, allValues) ||
          findRawSecretViolations(heuristic.text).length > 0) {
        lines[index] = heuristic.text;
        return blocked(lines.join('\n'), replacements, heuristicHits, 'redaction_malformed_jsonl_suspicious');
      }
      continue;
    }
    const exact = replaceJsonStrings(parsed, replaceExact, options.warn, options.onReplacement);
    const violations = findRawSecretViolations(exact.value);
    const heuristic = redactViolations(exact.value, violations, {
      warn: options.warn, onReplacement: options.onReplacement,
    });
    const changed = exact.replacements + exact.heuristicHits + heuristic.replacements;
    replacements += exact.replacements;
    heuristicHits += exact.heuristicHits + heuristic.replacements;
    if (exact.unresolvedViolations > 0 || heuristic.invalidPaths.length > 0) {
      return blocked(lines.join('\n'), replacements, heuristicHits, 'redaction_cannot_prove_scrubbed');
    }
    if (changed > 0) lines[index] = JSON.stringify(heuristic.value);
    if (findRawSecretViolations(heuristic.value).length > 0 || containsExactValue(lines[index], allValues)) {
      return blocked(lines.join('\n'), replacements, heuristicHits, 'redaction_cannot_prove_scrubbed');
    }
  }
  return { cleanContent: lines.join('\n'), replacements, heuristicHits, blocked: false, blockReason: null };
}
