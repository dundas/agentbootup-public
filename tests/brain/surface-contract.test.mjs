import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const surfaceText = () => fs.readFileSync(path.resolve('schemas/surface.v1.yaml'), 'utf-8');

function parseTopLevelYamlKeys(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trimEnd();
    const keyMatch = line.match(/^([A-Za-z0-9_"/.-]+):(?:\s+(.*))?$/);
    if (!keyMatch) continue;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const key = keyMatch[1];
    const value = keyMatch[2];
    const parent = stack[stack.length - 1].obj;
    if (value === undefined || value === '' || value === '>' || value === '|') {
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
      continue;
    }
    parent[key] = value;
  }
  return root;
}

test('surface.v1.yaml publishes OpenAPI 3.1 contract', () => {
  const text = surfaceText();
  assert.match(text, /openapi:\s*3\.1\.0/);
  assert.match(text, /version:\s*1\.0\.0/);
  const parsed = parseTopLevelYamlKeys(text);
  assert.equal(parsed.openapi, '3.1.0');
  assert.ok(parsed.info);
  assert.ok(parsed.paths);
  assert.ok(parsed.components);
});

test('surface.v1.yaml exposes required route spawn fields', () => {
  const text = surfaceText();
  for (const field of ['provider', 'model', 'taskType', 'timeoutMs', 'requireHumanGate']) {
    assert.match(text, new RegExp(`\\b${field}:`));
  }
});

test('surface.v1.yaml exposes orchestrate request fields', () => {
  const text = surfaceText();
  for (const field of ['goal', 'cwd', 'approvalMode', 'confidenceThreshold', 'brainId', 'mode', 'sessionId', 'maxTurns']) {
    assert.match(text, new RegExp(`\\b${field}:`));
  }
});

test('surface.v1.yaml defines CLI-renderable error response', () => {
  const text = surfaceText();
  assert.match(text, /ErrorResponse:/);
  assert.match(text, /required:\s*\[error, message\]/);
  assert.match(text, /invalid_request/);
});
