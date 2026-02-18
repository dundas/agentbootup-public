#!/usr/bin/env node
/**
 * OpenAPI to LLM-Optimized Docs Generator
 *
 * Converts OpenAPI 3.x specs into compact, token-efficient documentation
 * optimized for AI agents and LLMs.
 *
 * Usage:
 *   node scripts/openapi-to-llm.mjs --input openapi.json --output docs/api-llm.txt
 *   node scripts/openapi-to-llm.mjs --input openapi.yaml --output docs/api-llm.txt --json public/openapi.json
 *
 * Options:
 *   --input   Path to OpenAPI spec (JSON or YAML)
 *   --output  Path for LLM-optimized text output
 *   --json    Optional: also export clean JSON spec
 *   --verbose Show detailed output
 */

import fs from 'fs';
import path from 'path';

// Type abbreviations for token efficiency
const TYPE_ABBREV = {
  'string': 'str',
  'integer': 'int',
  'boolean': 'bool',
  'number': 'num',
  'array': 'arr',
  'object': 'obj',
};

function parseArgs(argv) {
  const args = { input: null, output: null, json: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) args.input = argv[++i];
    else if (a === '--output' && argv[i + 1]) args.output = argv[++i];
    else if (a === '--json' && argv[i + 1]) args.json = argv[++i];
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--help' || a === '-h') {
      console.log(`
OpenAPI to LLM Docs Generator

Usage:
  node scripts/openapi-to-llm.mjs --input <spec> --output <file>

Options:
  --input   OpenAPI spec file (JSON or YAML)
  --output  Output path for LLM-optimized text
  --json    Optional: export clean JSON spec
  --verbose Show processing details
`);
      process.exit(0);
    }
  }
  return args;
}

function loadSpec(inputPath) {
  const content = fs.readFileSync(inputPath, 'utf-8');
  const ext = path.extname(inputPath).toLowerCase();

  if (ext === '.yaml' || ext === '.yml') {
    // Simple YAML parsing for common cases
    // For complex YAML, consider using js-yaml package
    try {
      // Try JSON first (some .yaml files are actually JSON)
      return JSON.parse(content);
    } catch {
      throw new Error('YAML parsing requires js-yaml package. Install with: npm install js-yaml');
    }
  }

  return JSON.parse(content);
}

function abbrevType(type) {
  return TYPE_ABBREV[type] || type;
}

function resolveRef(spec, ref) {
  if (!ref || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let current = spec;
  for (const part of parts) {
    current = current?.[part];
  }
  return current;
}

function schemaToCompact(spec, schema, depth = 0) {
  if (!schema) return 'any';

  // Handle $ref
  if (schema.$ref) {
    const resolved = resolveRef(spec, schema.$ref);
    if (resolved) return schemaToCompact(spec, resolved, depth);
    const refName = schema.$ref.split('/').pop();
    return refName;
  }

  // Handle oneOf/anyOf/allOf
  if (schema.oneOf) {
    return schema.oneOf.map(s => schemaToCompact(spec, s, depth)).join('|');
  }
  if (schema.anyOf) {
    return schema.anyOf.map(s => schemaToCompact(spec, s, depth)).join('|');
  }
  if (schema.allOf) {
    // Merge allOf schemas
    const merged = {};
    for (const s of schema.allOf) {
      const resolved = s.$ref ? resolveRef(spec, s.$ref) : s;
      if (resolved?.properties) {
        Object.assign(merged, resolved.properties);
      }
    }
    return schemaToCompact(spec, { type: 'object', properties: merged }, depth);
  }

  const type = schema.type;

  if (type === 'array') {
    const items = schemaToCompact(spec, schema.items, depth);
    return `${items}[]`;
  }

  if (type === 'object' || schema.properties) {
    if (depth > 1) return 'obj';

    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const parts = [];

    for (const [key, val] of Object.entries(props)) {
      const isRequired = required.has(key);
      const propType = schemaToCompact(spec, val, depth + 1);
      parts.push(`${key}${isRequired ? '*' : ''}:${propType}`);
    }

    if (schema.additionalProperties) {
      parts.push('[key]:any');
    }

    return `{${parts.join(', ')}}`;
  }

  // Handle enum
  if (schema.enum) {
    return schema.enum.map(v => JSON.stringify(v)).join('|');
  }

  return abbrevType(type || 'any');
}

function extractFirstSentence(text) {
  if (!text) return '';
  const match = text.match(/^[^.!?\n]+[.!?]?/);
  return match ? match[0].trim() : text.slice(0, 80);
}

function generateLLMDocs(spec) {
  const lines = [];

  // Header
  const info = spec.info || {};
  lines.push(`# ${info.title || 'API'} v${info.version || '1.0'}`);
  lines.push(`Base: ${spec.servers?.[0]?.url || '/'}`);

  // Auth
  const securitySchemes = spec.components?.securitySchemes || {};
  const authTypes = Object.entries(securitySchemes)
    .map(([name, scheme]) => {
      if (scheme.type === 'http' && scheme.scheme === 'bearer') return 'Bearer token';
      if (scheme.type === 'apiKey') return `API key in ${scheme.in}`;
      return scheme.type;
    });
  if (authTypes.length) {
    lines.push(`Auth: ${authTypes.join(', ')}`);
  }

  lines.push('');

  // Group by tags
  const pathsByTag = {};
  const paths = spec.paths || {};

  for (const [pathUrl, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        const tag = op.tags?.[0] || 'Other';
        if (!pathsByTag[tag]) pathsByTag[tag] = [];
        pathsByTag[tag].push({ pathUrl, method: method.toUpperCase(), op });
      }
    }
  }

  // Generate docs per tag
  for (const [tag, endpoints] of Object.entries(pathsByTag)) {
    lines.push(`## ${tag}`);
    lines.push('');

    for (const { pathUrl, method, op } of endpoints) {
      // Endpoint header
      const summary = op.summary || op.operationId || '';
      lines.push(`### ${method} ${pathUrl}`);
      if (summary) lines.push(summary);

      // Required scope (extract from description if present)
      const scopeMatch = op.description?.match(/\*\*Required scope[s]?:\*\*\s*`([^`]+)`/i);
      if (scopeMatch) {
        lines.push(`Scope: ${scopeMatch[1]}`);
      }

      // Parameters
      const params = op.parameters || [];
      const pathParams = params.filter(p => p.in === 'path');
      const queryParams = params.filter(p => p.in === 'query');
      const headerParams = params.filter(p => p.in === 'header' && p.name !== 'Authorization');

      if (pathParams.length) {
        const paramStr = pathParams
          .map(p => `${p.name}${p.required ? '*' : ''}:${abbrevType(p.schema?.type || 'str')}`)
          .join(', ');
        lines.push(`Path: ${paramStr}`);
      }

      if (queryParams.length) {
        const paramStr = queryParams
          .map(p => `${p.name}${p.required ? '*' : ''}:${abbrevType(p.schema?.type || 'str')}`)
          .join(', ');
        lines.push(`Query: ${paramStr}`);
      }

      if (headerParams.length) {
        const paramStr = headerParams
          .map(p => `${p.name}:${abbrevType(p.schema?.type || 'str')}`)
          .join(', ');
        lines.push(`Headers: ${paramStr}`);
      }

      // Request body
      const body = op.requestBody?.content?.['application/json']?.schema;
      if (body) {
        const bodySchema = schemaToCompact(spec, body);
        lines.push(`Body: ${bodySchema}`);
      }

      // Response
      const successResponse = op.responses?.['200'] || op.responses?.['201'];
      if (successResponse) {
        const respSchema = successResponse.content?.['application/json']?.schema;
        if (respSchema) {
          const respCompact = schemaToCompact(spec, respSchema);
          lines.push(`Returns: ${respCompact}`);
        }
      }

      lines.push('');
    }
  }

  // Legend
  lines.push('---');
  lines.push('Legend: * = required, str = string, int = integer, bool = boolean, arr = array, obj = object');

  return lines.join('\n');
}

function run() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    console.error('Error: --input is required');
    process.exit(1);
  }

  if (!args.output) {
    console.error('Error: --output is required');
    process.exit(1);
  }

  // Load spec
  if (args.verbose) console.log('Loading:', args.input);
  const spec = loadSpec(args.input);

  // Generate LLM docs
  if (args.verbose) console.log('Generating LLM-optimized docs...');
  const llmDocs = generateLLMDocs(spec);

  // Write LLM docs
  const outputDir = path.dirname(args.output);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(args.output, llmDocs, 'utf-8');
  console.log('Wrote LLM docs:', args.output);

  // Optionally write JSON
  if (args.json) {
    const jsonDir = path.dirname(args.json);
    if (!fs.existsSync(jsonDir)) {
      fs.mkdirSync(jsonDir, { recursive: true });
    }
    fs.writeFileSync(args.json, JSON.stringify(spec, null, 2), 'utf-8');
    console.log('Wrote JSON spec:', args.json);
  }

  // Stats
  const specSize = JSON.stringify(spec).length;
  const llmSize = llmDocs.length;
  const reduction = ((1 - llmSize / specSize) * 100).toFixed(1);
  console.log(`\nSize reduction: ${specSize} -> ${llmSize} chars (${reduction}% smaller)`);
}

try {
  run();
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
