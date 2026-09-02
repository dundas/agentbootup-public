// Each segment must start AND end with alphanumeric/underscore (no leading/trailing hyphens).
// Pattern: segment = alphanum_start (middle* alphanum_end)?
//          middle  = [A-Za-z0-9_-]
const BRAIN_ID_PATTERN = /^[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?)*$/;
export const MAX_BRAIN_ID_LENGTH = 128;

export function isValidBrainId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_BRAIN_ID_LENGTH &&
    BRAIN_ID_PATTERN.test(value)
  );
}
