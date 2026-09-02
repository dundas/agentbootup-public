import { HttpError, ensureIdentifier } from '../errors';

export function decodeAndValidateIdentifier(
  raw: string,
  field = 'identifier',
  maxLength = 200,
): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw ?? '');
  } catch {
    throw new HttpError(400, 'invalid_request', `${field} is not valid URL-encoded.`);
  }

  try {
    return ensureIdentifier(decoded, field, maxLength);
  } catch {
    throw new HttpError(
      400,
      'invalid_request',
      `${field} must be 1-${maxLength} identifier-safe characters.`,
    );
  }
}
