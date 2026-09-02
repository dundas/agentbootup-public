import fs from 'fs';
import path from 'path';

export function resolveEnvSchemaPath(projectPath) {
  return path.join(projectPath, 'brain', '.env.schema');
}

function ensureStringArray(value, key) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`Invalid env schema: ${key} must be an array of non-empty strings`);
  }
}

export function loadEnvSchema(projectPath) {
  const schemaPath = resolveEnvSchemaPath(projectPath);
  if (!fs.existsSync(schemaPath)) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Invalid env schema JSON at ${schemaPath}`);
  }

  const required = parsed.required || [];
  const optional = parsed.optional || [];
  const secrets = parsed.secrets || [];
  ensureStringArray(required, 'required');
  ensureStringArray(optional, 'optional');
  ensureStringArray(secrets, 'secrets');

  return {
    path: schemaPath,
    required,
    optional,
    secrets,
    allowed: new Set([...required, ...optional]),
  };
}
