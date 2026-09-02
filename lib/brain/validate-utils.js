export function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
